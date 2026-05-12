from django.contrib.auth import authenticate
from rest_framework import status
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.tokens import RefreshToken
from .models import Usuario
from .serializers import UsuarioSerializer, SignUpSerializer
from .services import (
    ChatServiceError,
    build_message_payload,
    create_media_message_from_file,
    get_connection_for_user,
)


def normalize_credential(value):
    return value.strip() if isinstance(value, str) else ''


def get_auth_for_user(user):
    refresh = RefreshToken.for_user(user)
    return {
        'user': UsuarioSerializer(user).data,
        'tokens': {
            'access': str(refresh.access_token),
            'refresh': str(refresh),
        }
    }


class SignInView(APIView):
    permission_classes = [AllowAny]

    def post(self, request):
        username = normalize_credential(request.data.get('username'))
        password = request.data.get('password')
        password = password if isinstance(password, str) else ''

        if not username or not password:
            return Response({"detail": "Username and password required."}, status=status.HTTP_400_BAD_REQUEST)

        matched_user = Usuario.objects.filter(username__iexact=username).first()
        auth_username = matched_user.username if matched_user else username
        user = authenticate(username=auth_username, password=password)
        if not user:
            return Response({"detail": "Invalid credentials."}, status=status.HTTP_401_UNAUTHORIZED)

        user_data = get_auth_for_user(user)
        return Response(user_data, status=status.HTTP_200_OK)


class SignUpView(APIView):
    permission_classes = [AllowAny]

    def post(self, request):
        new_user = SignUpSerializer(data=request.data)
        new_user.is_valid(raise_exception=True)
        user = new_user.save()

        user_data = get_auth_for_user(user)
        return Response(user_data, status=status.HTTP_201_CREATED)


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
            )
        except ChatServiceError as error:
            return Response(
                {"detail": error.message},
                status=error.status_code,
            )

        payload = build_message_payload(message, request.user, recipient)
        return Response(payload, status=status.HTTP_201_CREATED)
