from django.contrib.auth import authenticate
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError, OperationalError, connection, transaction
from time import sleep
from rest_framework import status
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenRefreshView
from .models import Usuario
from .typing import notify_live_typing_settings
from .authentication import token_auth_version
from .media_access import authorized_attachment, attachment_response, create_access_ticket, download_user, private_headers
from .serializers import (ActiveTokenRefreshSerializer, CurrentUsuarioSerializer, PasswordResetConfirmSerializer,
                          PasswordResetRequestSerializer, PushTokenSerializer, SignUpSerializer)
from .password_reset import (CONFIRM_DETAIL, INVALID_DETAIL, REQUEST_DETAIL, UNAVAILABLE_DETAIL,
                             confirm_allowed, queue_password_reset, recovery_configuration_ready,
                             request_allowed, reset_password)
from .services import (
    ChatServiceError,
    build_message_payload,
    clear_connection_history,
    create_media_message_from_file,
    get_connection_for_user,
)


def normalize_credential(value):
    return value.strip() if isinstance(value, str) else ''


def get_auth_for_user(user):
    refresh = RefreshToken.for_user(user)
    refresh['auth_version'] = user.auth_version
    return {
        'user': CurrentUsuarioSerializer(user).data,
        'tokens': {
            'access': str(refresh.access_token),
            'refresh': str(refresh),
        }
    }


class SignInView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request):
        if not hasattr(request.data, 'get'):
            return Response({'detail': 'Formato de credenciales invalido.'}, status=status.HTTP_400_BAD_REQUEST)
        username = normalize_credential(request.data.get('username'))
        password = request.data.get('password')
        password = password if isinstance(password, str) else ''

        if not username or not password:
            return Response({"detail": "Username and password required."}, status=status.HTTP_400_BAD_REQUEST)

        matched_user = Usuario.objects.filter(username=username).first()
        if matched_user is None:
            matched_user = Usuario.objects.filter(username__iexact=username).first()
        auth_username = matched_user.username if matched_user else username
        user = authenticate(username=auth_username, password=password)
        if not user:
            return Response({"detail": "Invalid credentials."}, status=status.HTTP_401_UNAUTHORIZED)

        user_data = get_auth_for_user(user)
        return Response(user_data, status=status.HTTP_200_OK)


class SignUpView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request):
        new_user = SignUpSerializer(data=request.data)
        new_user.is_valid(raise_exception=True)
        try:
            with transaction.atomic():
                user = new_user.save()
        except IntegrityError:
            field = 'email' if Usuario.objects.filter(email_key=new_user.validated_data['email']).exists() else 'username'
            message = 'Este correo ya está en uso.' if field == 'email' else 'Este nombre de usuario ya esta en uso.'
            return Response({field: [message]}, status=status.HTTP_400_BAD_REQUEST)
        except DjangoValidationError as error:
            return Response(error.message_dict, status=status.HTTP_400_BAD_REQUEST)

        user_data = get_auth_for_user(user)
        return Response(user_data, status=status.HTTP_201_CREATED)


class CurrentUserView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response({'user': CurrentUsuarioSerializer(request.user).data})

    def patch(self, request):
        # SQLite cannot upgrade a read snapshot if another WebSocket writer
        # committed meanwhile. Keep password hashing outside the transaction and
        # retry the whole short transaction, never a broken atomic block.
        for attempt in range(3):
            try:
                response = self._patch_attempt(request)
                if response is not None:
                    return response
            except OperationalError as error:
                if connection.vendor != 'sqlite' or not any(word in str(error).lower() for word in ('locked', 'busy')):
                    break
            except IntegrityError:
                return Response({'email': ['Este correo ya está en uso.']}, status=status.HTTP_400_BAD_REQUEST)
            except DjangoValidationError as error:
                return Response(error.message_dict, status=status.HTTP_400_BAD_REQUEST)
            if attempt < 2:
                sleep(0.02 * (attempt + 1))
        return Response({'detail': 'No se pudo guardar el perfil. Intenta nuevamente en unos segundos.'},
                        status=status.HTTP_503_SERVICE_UNAVAILABLE)

    def _patch_attempt(self, request):
        candidate = Usuario.objects.filter(pk=request.user.pk).first()
        if not self._session_matches(request, candidate):
            return Response({'detail': 'La sesión venció. Inicia sesión nuevamente.'}, status=status.HTTP_401_UNAUTHORIZED)
        serializer = PushTokenSerializer(candidate, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        validated_password, validated_email = candidate.password, candidate.email
        with transaction.atomic():
            user = Usuario.objects.select_for_update().filter(pk=request.user.pk).first()
            if not self._session_matches(request, user):
                return Response({'detail': 'La sesión venció. Inicia sesión nuevamente.'}, status=status.HTTP_401_UNAUTHORIZED)
            # A concurrent reset/email update cannot reuse a previously verified
            # password. Restart validation against the latest account instead.
            if user.password != validated_password or user.email != validated_email:
                return None
            serializer.instance = user
            previous_typing_revision = user.typing_draft_revision
            serializer.save()
            if user.typing_draft_revision != previous_typing_revision:
                transaction.on_commit(lambda: notify_live_typing_settings(user.pk))
        return Response({'user': CurrentUsuarioSerializer(user).data})

    @staticmethod
    def _session_matches(request, user):
        return (user is not None and user.is_active
                and (request.auth is None or token_auth_version(request.auth) == user.auth_version))


class PasswordResetRequestView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request):
        # Availability is global and checked before account lookup or mail queue.
        if not recovery_configuration_ready():
            return Response({'detail': UNAVAILABLE_DETAIL}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        serializer = PasswordResetRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        email = serializer.validated_data['email']
        try:
            if request_allowed(request, email) and not queue_password_reset(email):
                return Response({'detail': UNAVAILABLE_DETAIL}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        except Exception:
            return Response({'detail': UNAVAILABLE_DETAIL}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        return Response({'detail': REQUEST_DETAIL})


class PasswordResetConfirmView(APIView):
    permission_classes = [AllowAny]
    authentication_classes = []

    def post(self, request):
        serializer = PasswordResetConfirmSerializer(data=request.data)
        if not serializer.is_valid():
            if 'uid' in serializer.errors or 'token' in serializer.errors:
                return Response({'detail': INVALID_DETAIL}, status=status.HTTP_400_BAD_REQUEST)
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        try:
            allowed = confirm_allowed(request)
        except Exception:
            return Response({'detail': UNAVAILABLE_DETAIL}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        if not allowed:
            return Response({'detail': 'Demasiados intentos. Espera unos minutos.'}, status=status.HTTP_429_TOO_MANY_REQUESTS)
        try:
            user = reset_password(**serializer.validated_data)
        except OperationalError:
            return Response({'detail': 'Intenta nuevamente en unos segundos.'}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        if user is None:
            return Response({'detail': INVALID_DETAIL}, status=status.HTTP_400_BAD_REQUEST)
        return Response({'detail': CONFIRM_DETAIL, 'username': user.username})


class ActiveTokenRefreshView(TokenRefreshView):
    serializer_class = ActiveTokenRefreshSerializer


class MessageMediaUploadView(APIView):
    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser]

    def post(self, request):
        media_type = normalize_credential(request.data.get('type')).lower()
        uploaded_file = request.FILES.get('file')

        if not media_type:
            return Response(
                {"detail": "Tipo de archivo requerido."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if not uploaded_file:
            return Response(
                {"detail": "Archivo requerido."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            connection = get_connection_for_user(
                request.user,
                request.data.get('connectionId'),
                require_accepted=True,
            )
            message, recipient = create_media_message_from_file(
                request.user,
                connection,
                uploaded_file,
                media_type,
                history_revision=request.data.get('historyRevision'),
            )
        except ChatServiceError as error:
            return Response(
                {"detail": error.message, **({'code': error.code} if error.code else {}), **error.details},
                status=error.status_code,
            )

        payload = build_message_payload(message, request.user, recipient)
        return Response(payload, status=status.HTTP_201_CREATED)


class ConnectionHistoryView(APIView):
    permission_classes = [IsAuthenticated]

    def delete(self, request, connection_id):
        try:
            response = Response(clear_connection_history(request.user, connection_id))
            return private_headers(response)
        except ChatServiceError as error:
            return private_headers(Response({'detail': error.message}, status=error.status_code))
        except OperationalError:
            return private_headers(Response({'detail': 'Intenta nuevamente en unos segundos.', 'code': 'retry'}, status=503))


class MessageMediaAccessView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, message_id, kind):
        return private_headers(Response(create_access_ticket(request.user, message_id, kind)))

    def finalize_response(self, request, response, *args, **kwargs):
        return private_headers(super().finalize_response(request, response, *args, **kwargs))


class MessageMediaDownloadView(APIView):
    permission_classes = [AllowAny]

    def perform_content_negotiation(self, request, force=False):
        # Native players may accept only audio/video, not JSON. FileResponse sets
        # the media type; errors can still use the standard JSON renderer.
        return super().perform_content_negotiation(request, force=True)

    def get(self, request, message_id, kind):
        user = download_user(request, message_id, kind)
        _message, field = authorized_attachment(user, message_id, kind)
        return attachment_response(request, field, kind)

    def head(self, request, message_id, kind):
        return self.get(request, message_id, kind)

    def finalize_response(self, request, response, *args, **kwargs):
        return private_headers(super().finalize_response(request, response, *args, **kwargs))
