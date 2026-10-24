import json
from datetime import timedelta
from uuid import uuid4

from asgiref.sync import async_to_sync
from channels.generic.websocket import WebsocketConsumer
from django.db import transaction
from django.db.models import Count, Exists, F, OuterRef, Q
from django.db.models.functions import Coalesce
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from .models import Connection, Message, Usuario
from .typing import (TYPING_FRAME_MAX_BYTES, event_payload, metadata_is_current,
                     record_event, start_allowed, valid_draft)
from .serializers import (
    FriendSerializer,
    MessageSerializer,
    RequestSerializer,
    SearchSerializer,
    UsuarioSerializer,
)
from .services import (
    ChatServiceError,
    MEDIA_CONFIG,
    build_message_payload,
    broadcast_message,
    content_file_from_base64,
    create_media_message_from_file,
    create_text_message,
    get_connection_for_user,
    get_recipient,
    history_metadata,
    send_group,
    save_avatar,
    send_push_notification,
    parse_positive_id,
    user_group_name,
    validate_history_revision,
    validate_media_file,
)


class ChatConsumer(WebsocketConsumer):
    MESSAGE_HISTORY_LIMIT = 50
    TYPING_TTL_SECONDS = 5

    def connect(self):
        user = self.scope["user"]
        if not user.is_authenticated or not user.is_active:
            self.close()
            return

        self.username = user.username
        self.auth_version = self.scope.get('auth_version', user.auth_version)
        if not Usuario.objects.filter(pk=user.pk, is_active=True, auth_version=self.auth_version).exists():
            self.close(code=4401)
            return
        self.user_group = user_group_name(self.username)
        async_to_sync(self.channel_layer.group_add)(self.user_group, self.channel_name)
        self.accept()

    def disconnect(self, close_code):
        self._clear_typing_routes()
        if hasattr(self, "user_group"):
            async_to_sync(self.channel_layer.group_discard)(self.user_group, self.channel_name)

    def receive(self, text_data=None, bytes_data=None):
        if not self._session_is_current():
            return
        if not isinstance(text_data, str):
            self._send_error('Se requiere un mensaje JSON de texto.')
            return
        try:
            data = json.loads(text_data)
        except json.JSONDecodeError:
            self._send_error("Invalid JSON format.")
            return

        if not isinstance(data, dict) or not isinstance(data.get('source'), str):
            self._send_error('Formato de mensaje invalido.')
            return
        if data['source'] == 'message.type' and len(text_data.encode('utf-8', errors='replace')) > TYPING_FRAME_MAX_BYTES:
            self._send_error('El aviso de escritura es demasiado grande.')
            return

        handlers = {
            "friend.list": self.receive_friend_list,
            "message.list": self.receive_message_list,
            "message.send": self.receive_message_send,
            "message.send_image": self.receive_message_send_image,
            "message.send_audio": self.receive_message_send_audio,
            "message.send_video": self.receive_message_send_video,
            "message.send_document": self.receive_message_send_document,
            "message.type": self.receive_message_type,
            "typing.settings": self.receive_typing_settings,
            "message.read": self.receive_message_read,
            "request.accept": self.receive_request_accept,
            "request.connect": self.receive_request_connect,
            "request.list": self.receive_request_list,
            "search": self.receive_search,
            "miniatura": self.receive_miniatura,
        }

        handler = handlers.get(data.get("source"))
        if not handler:
            self._send_error("Fuente no soportada.")
            return

        handler(data)

    def _send_error(self, message, *, data=None, code=None, details=None):
        payload = {'source': 'error', 'message': message}
        if code:
            payload['code'] = code
        payload.update(details or {})
        if data is not None:
            correlation = {'clientId': data.get('clientId'), 'connectionId': data.get('connectionId')}
            payload.update(correlation)
            payload['data'] = {'message': message, **correlation, **(details or {})}
            if code:
                payload['data']['code'] = code
        self.send(text_data=json.dumps(payload))

    def _get_user(self):
        return self.scope["user"]

    def _session_is_current(self):
        user = self._get_user()
        # Unit consumers and untouched legacy connections have version zero.
        version = getattr(self, 'auth_version', self.scope.get('auth_version', user.auth_version))
        current = Usuario.objects.filter(pk=user.pk).values('is_active', 'auth_version').first()
        if current and current['is_active'] and current['auth_version'] == version:
            return True
        if current and current['auth_version'] > version:
            self.send(text_data=json.dumps({'source': 'auth.invalidated',
                                            'data': {'authVersion': current['auth_version']}}))
        self.close(code=4401)
        return False

    def auth_invalidated(self, event):
        version = event.get('authVersion')
        bound = getattr(self, 'auth_version', self.scope.get('auth_version', self._get_user().auth_version))
        if type(version) is int and version > bound:
            self.send(text_data=json.dumps({'source': 'auth.invalidated', 'data': {'authVersion': version}}))
            self.close(code=4401)

    def _get_connection(self, connection_id, *, require_accepted=False):
        try:
            return get_connection_for_user(
                self._get_user(),
                connection_id,
                require_accepted=require_accepted,
            )
        except ChatServiceError as error:
            self._send_error(error.message)
            return None

    def _get_recipient(self, connection, user):
        return get_recipient(connection, user)

    def _normalize_page(self, raw_page):
        if raw_page is None:
            return 0
        if isinstance(raw_page, bool) or not isinstance(raw_page, (int, str)):
            self._send_error('Pagina invalida.')
            return None
        try:
            page = int(raw_page)
        except (TypeError, ValueError):
            self._send_error("Pagina invalida.")
            return None

        if page < 0 or page > 1000000:
            self._send_error("Pagina invalida.")
            return None

        return page

    def _build_message_payload(self, message, current_user, friend):
        return build_message_payload(message, current_user, friend)

    def _broadcast_message(self, message, sender, recipient, push_body=None):
        broadcast_message(
            message, sender, recipient, push_body,
            send_event=self.send_group, notify=self.send_push_notification,
        )

    def _create_media_message(self, data, media_type):
        user = self._get_user()
        connection = self._get_connection(data.get("connectionId"), require_accepted=True)
        if not connection:
            return

        base64_value = data.get("base64")
        filename = data.get("filename")

        try:
            file_obj = content_file_from_base64(base64_value, filename, media_type=media_type)
            message, recipient = create_media_message_from_file(
                user,
                connection,
                file_obj,
                media_type,
                broadcast=False,
                history_revision=data.get('historyRevision'),
            )
            self._broadcast_message(message, user, recipient, MEDIA_CONFIG[media_type]["push"])
        except ChatServiceError as error:
            self._send_error(error.message, data=data, code=error.code, details=error.details)
            return

    def receive_message_list(self, data):
        user = self._get_user()
        connection = self._get_connection(data.get("connectionId"), require_accepted=True)
        if not connection:
            return

        page = self._normalize_page(data.get("page"))
        if page is None:
            return
        if page != 0:
            self._send_error('Solo se muestran los ultimos 50 mensajes de esta conversacion.')
            return

        messages = Message.objects.filter(connection=connection, pk__gt=connection.history_cleared_through).order_by('-created', '-id')[:self.MESSAGE_HISTORY_LIMIT]
        recipient = self._get_recipient(connection, user)

        payload = {
            **history_metadata(connection),
            'connectionId': connection.pk,
            'page': 0,
            'limit': self.MESSAGE_HISTORY_LIMIT,
            'requestId': data.get('requestId'),
            "messages": MessageSerializer(messages, context={"user": user}, many=True).data,
            "next": None,
            "friend": UsuarioSerializer(recipient).data,
        }
        self.broadcast_group({'source': 'message.list', 'data': payload})

    def receive_message_send(self, data):
        user = self._get_user()
        try:
            connection = get_connection_for_user(user, data.get('connectionId'), require_accepted=True)
            message, created = create_text_message(user, connection, data.get('message'), data.get('clientId'),
                                                   history_revision=data.get('historyRevision'))
        except ChatServiceError as error:
            self._send_error(error.message, data=data, code=error.code, details=error.details)
            return

        recipient = self._get_recipient(connection, user)
        # A direct reply confirms persistence without relying on Redis/group
        # delivery. A disconnected sender must not block the other participant.
        try:
            payload = self._build_message_payload(message, user, recipient)
            self.broadcast_group({'source': 'message.ack' if payload.get('historyCleared') else 'message.send', 'data': payload})
        finally:
            if created:
                self._broadcast_message(message, user, recipient, message.text)

    def receive_message_send_image(self, data):
        self._create_media_message(data, "image")

    def receive_message_send_audio(self, data):
        self._create_media_message(data, "audio")

    def receive_message_send_video(self, data):
        self._create_media_message(data, "video")

    def receive_message_send_document(self, data):
        self._create_media_message(data, "document")

    def receive_message_read(self, data):
        user = self._get_user()
        if data.get('connectionId') is not None:
            connection = self._get_connection(data['connectionId'], require_accepted=True)
            if not connection:
                return
            unread = Message.objects.filter(connection=connection, is_new=True, pk__gt=connection.history_cleared_through).exclude(user=user)
            ids = list(unread.values_list('id', flat=True))
            if not ids:
                return
            Message.objects.filter(pk__in=ids).update(is_new=False)
            payload = {'connectionId': connection.pk, 'messageIds': ids}
            self.send_group(user.username, 'message.read', payload)
            self.send_group(self._get_recipient(connection, user).username, 'message.read', payload)
            self.receive_friend_list({})
            return
        message_id = data.get("messageId")
        if not message_id:
            self._send_error("No se proporciono messageId.")
            return

        try:
            message_id = parse_positive_id(message_id, 'messageId')
            message = Message.objects.select_related("connection", "user").get(id=message_id)
        except ChatServiceError as error:
            self._send_error(error.message)
            return
        except Message.DoesNotExist:
            self._send_error("Mensaje no encontrado.")
            return

        connection = message.connection
        if connection.sender_id != user.id and connection.receiver_id != user.id:
            self._send_error("No tienes acceso a este mensaje.")
            return
        if not connection.accepted:
            self._send_error('La conexion aun no ha sido aceptada.')
            return
        if message.pk <= connection.history_cleared_through:
            self._send_error('El mensaje ya no está disponible en el historial.')
            return
        if message.user_id == user.pk:
            self._send_error('Solo el destinatario puede marcar el mensaje como leido.')
            return
        if not message.is_new:
            return

        message.is_new = False
        message.save(update_fields=["is_new"])

        recipient = self._get_recipient(connection, user)
        self.send_group(
            user.username,
            "message.read",
            {'connectionId': connection.pk, "message": MessageSerializer(message, context={"user": user}).data},
        )
        self.send_group(
            recipient.username,
            "message.read",
            {'connectionId': connection.pk, "message": MessageSerializer(message, context={"user": recipient}).data},
        )

    def receive_friend_list(self, data):
        user = self._get_user()
        latest_message = Message.objects.filter(connection=OuterRef("id"), pk__gt=OuterRef('history_cleared_through')).order_by('-created', '-id')[:1]
        connections = Connection.objects.filter(
            Q(sender=user) | Q(receiver=user),
            accepted=True,
        ).select_related('sender', 'receiver').annotate(
            unread_count=Count('messages', filter=Q(messages__is_new=True, messages__pk__gt=F('history_cleared_through')) & ~Q(messages__user=user)),
            latest_id=latest_message.values('id'),
            latest_text=latest_message.values("text"),
            latest_image=latest_message.values("image"),
            latest_audio=latest_message.values("audio"),
            latest_video=latest_message.values("video"),
            latest_document=latest_message.values("document"),
            latest_created=latest_message.values("created"),
            latest_is_new=latest_message.values("is_new"),
            latest_user_id=latest_message.values("user_id"),
        ).order_by(Coalesce("latest_created", "updated").desc(), '-id')

        serialized = FriendSerializer(connections, context={"user": user}, many=True)
        self.send_group(user.username, "friend.list", serialized.data)

    def receive_typing_settings(self, data):
        user = Usuario.objects.filter(pk=self._get_user().pk, is_active=True).first()
        if user:
            self.send_group(user.username, 'typing.settings',
                            {'liveTypingEnabled': user.typing_draft_enabled,
                             'liveTypingRevision': user.typing_draft_revision})

    def receive_message_type(self, data):
        recipient_username = data.get("username")
        if recipient_username is not None and (not isinstance(recipient_username, str)
                                              or not recipient_username or len(recipient_username) > 150):
            self._send_error('Usuario de escritura invalido.')
            return
        is_typing = data.get('isTyping', True)
        if not isinstance(is_typing, bool):
            self._send_error('isTyping debe ser verdadero o falso.')
            return
        if not valid_draft(data.get('draft')):
            self._send_error('El borrador debe tener como maximo 500 caracteres.')
            return
        draft_revision = data.get('draftRevision')
        if draft_revision is not None and (type(draft_revision) is not int or draft_revision < 0):
            self._send_error('Revision de escritura invalida.')
            return
        client_sequence = data.get('clientSequence')
        if client_sequence is not None and (type(client_sequence) is not int or not 0 < client_sequence <= 2 ** 31 - 1):
            self._send_error('Secuencia de escritura invalida.')
            return
        user = self._get_user()
        if not user.is_authenticated:
            self._send_error('Debes iniciar sesion para indicar que estas escribiendo.')
            return
        try:
            if data.get('connectionId') is not None:
                connection = get_connection_for_user(user, data['connectionId'], require_accepted=True)
            else:
                # Old clients sent only the recipient username. Resolve it here,
                # then use the same participant and history checks as the new protocol.
                if not recipient_username:
                    raise ChatServiceError('No se proporciono connectionId.')
                connection = Connection.objects.select_related('sender', 'receiver').filter(
                    Q(sender=user, receiver__username=recipient_username)
                    | Q(receiver=user, sender__username=recipient_username),
                    accepted=True,
                ).order_by('created', 'id').first()
                if connection is None:
                    raise ChatServiceError('No tienes una conexion aceptada con este usuario.')
            recipient = self._get_recipient(connection, user)
            sender = connection.sender if connection.sender_id == user.pk else connection.receiver
            if recipient_username is not None and recipient_username != recipient.username:
                raise ChatServiceError('El usuario no corresponde a esta conversacion.')
            if not sender.is_active or not recipient.is_active:
                raise ChatServiceError('La cuenta ya no esta disponible para esta conversacion.')
            validate_history_revision(connection, data.get('historyRevision'))
            bound_version = getattr(self, 'auth_version', self.scope.get('auth_version', user.auth_version))
            if sender.auth_version != bound_version:
                self.close(code=4401)
                return
        except ChatServiceError as error:
            self._send_error(error.message, data=data, code=error.code, details=error.details)
            return
        if not hasattr(self, '_typing_stream_id'):
            self._typing_stream_id = str(uuid4())
            self._typing_client_sequences = {}
            self._typing_routes = set()
        if client_sequence is not None:
            if client_sequence <= self._typing_client_sequences.get(connection.pk, 0):
                return
            self._typing_client_sequences[connection.pk] = client_sequence
        # A stale sender device must refresh its preference before publishing
        # text. Generic legacy indicators continue working without opt-in.
        if (draft_revision is not None and draft_revision != sender.typing_draft_revision
                or is_typing and data.get('draft') is not None
                and (not sender.typing_draft_enabled or draft_revision != sender.typing_draft_revision)):
            self.send_group(sender.username, 'typing.settings',
                            {'liveTypingEnabled': sender.typing_draft_enabled,
                             'liveTypingRevision': sender.typing_draft_revision})
            return
        if is_typing and not start_allowed(sender.pk):
            return
        metadata = record_event(
            sender, connection, stream_id=self._typing_stream_id, is_typing=is_typing,
            expires_at=(timezone.now() + timedelta(seconds=self.TYPING_TTL_SECONDS)).isoformat() if is_typing else None,
            only_current_stream=not is_typing,
        )
        if metadata:
            self._typing_routes.add(connection.pk)
            self.send_group(recipient.username, 'message.type', event_payload(
                sender, connection, metadata,
                draft=data.get('draft') if is_typing and sender.typing_draft_enabled else None,
            ))

    def _clear_typing_routes(self):
        # A disconnected older device cannot stop a newer device's stream.
        routes = getattr(self, '_typing_routes', ())
        if not routes:
            return
        try:
            user = Usuario.objects.filter(pk=self._get_user().pk, is_active=True).first()
            if not user:
                return
            for identifier in routes:
                try:
                    connection = get_connection_for_user(user, identifier, require_accepted=True)
                    peer = self._get_recipient(connection, user)
                    if not peer.is_active:
                        continue
                    metadata = record_event(user, connection, stream_id=self._typing_stream_id,
                                            is_typing=False, expires_at=None, only_current_stream=True,
                                            require_existing=True)
                    if metadata:
                        self.send_group(peer.username, 'message.type', event_payload(user, connection, metadata))
                except ChatServiceError:
                    continue
        except Exception:
            # Recipient-side TTL also clears a stream when storage is unavailable.
            pass

    def receive_request_accept(self, data):
        user = self._get_user()
        username = data.get("username")
        if not isinstance(username, str) or not username:
            self._send_error("No se proporciono username.")
            return

        try:
            connection = Connection.objects.select_related("sender", "receiver").filter(
                sender__username=username,
                receiver=user,
                accepted=False,
            ).order_by('created', 'id').first()
            if connection is None:
                raise Connection.DoesNotExist
        except Connection.DoesNotExist:
            self._send_error("La solicitud de conexion no existe.")
            return

        connection.accepted = True
        connection.save(update_fields=["accepted", "updated"])

        serialized_request = RequestSerializer(connection)
        self.send_group(connection.sender.username, "request.accept", serialized_request.data)
        self.send_group(connection.receiver.username, "request.accept", serialized_request.data)

        self.send_group(
            connection.sender.username,
            "friend.new",
            FriendSerializer(connection, context={"user": connection.sender}).data,
        )
        self.send_group(
            connection.receiver.username,
            "friend.new",
            FriendSerializer(connection, context={"user": connection.receiver}).data,
        )

    def receive_request_connect(self, data):
        user = self._get_user()
        username = data.get("username")
        if not isinstance(username, str) or not username:
            self._send_error("No se proporciono username.")
            return

        if username == user.username:
            self._send_error("No puedes enviarte una solicitud a ti mismo.")
            return

        try:
            receiver = Usuario.objects.get(username=username, is_active=True)
        except Usuario.DoesNotExist:
            self._send_error("Usuario no encontrado.")
            return

        # Lock the same user pair in the same order on databases supporting row
        # locks so simultaneous reciprocal requests cannot create two chats.
        with transaction.atomic():
            list(Usuario.objects.select_for_update().filter(pk__in=[user.pk, receiver.pk]).order_by('pk'))
            connection = Connection.objects.filter(
                Q(sender=user, receiver=receiver) | Q(sender=receiver, receiver=user)
            ).order_by('-accepted', 'created', 'id').first()
            if connection and connection.accepted:
                self._send_error('Ya tienes una conexion con este usuario.')
                return
            if connection is None:
                connection = Connection.objects.create(sender=user, receiver=receiver)
        serialized = RequestSerializer(connection)

        self.send_group(connection.sender.username, "request.connect", serialized.data)
        self.send_group(connection.receiver.username, "request.connect", serialized.data)

    def receive_request_list(self, data):
        user = self._get_user()
        connections = Connection.objects.filter(receiver=user, accepted=False).select_related('sender', 'receiver').order_by('-created', '-id')
        serialized = RequestSerializer(connections, many=True)
        self.send_group(user.username, "request.list", serialized.data)

    def receive_search(self, data):
        user = self._get_user()
        query = data.get('query', '')
        if not isinstance(query, str) or len(query) > 150:
            self._send_error('Consulta de busqueda invalida.')
            return
        query = query.strip()
        if not query:
            self.broadcast_group({'source': 'search', 'data': []})
            return

        users = Usuario.objects.filter(
            Q(username__istartswith=query)
            | Q(first_name__istartswith=query)
            | Q(last_name__istartswith=query)
        ).filter(is_active=True).exclude(pk=user.pk).annotate(
            pending_them=Exists(
                Connection.objects.filter(
                    sender=user,
                    receiver=OuterRef("id"),
                    accepted=False,
                )
            ),
            pending_me=Exists(
                Connection.objects.filter(
                    sender=OuterRef("id"),
                    receiver=user,
                    accepted=False,
                )
            ),
            connected=Exists(
                Connection.objects.filter(
                    Q(sender=user, receiver=OuterRef("id"))
                    | Q(receiver=user, sender=OuterRef("id")),
                    accepted=True,
                )
            ),
        ).order_by('username')[:50]

        serialized = SearchSerializer(users, many=True)
        self.broadcast_group({'source': 'search', 'data': serialized.data})

    def receive_miniatura(self, data):
        user = self._get_user()

        try:
            image_file = content_file_from_base64(data.get("base64"), data.get("filename"), media_type='image')
            validate_media_file(image_file, 'image')
            save_avatar(user, image_file)
        except ChatServiceError as error:
            self._send_error(error.message)
            return
        except Exception:
            self._send_error("No se pudo guardar la imagen.")
            return

        serialized = UsuarioSerializer(user)
        self.send_group(user.username, "miniatura", serialized.data)

    def send_group(self, group, source, data):
        send_group(group, source, data)

    def broadcast_group(self, event):
        if not self._session_is_current():
            return
        source, data = event.get('source'), event.get('data')
        if source == 'typing.settings':
            current = Usuario.objects.filter(pk=self._get_user().pk).values(
                'typing_draft_enabled', 'typing_draft_revision').first()
            if (not isinstance(data, dict) or type(data.get('liveTypingEnabled')) is not bool
                    or type(data.get('liveTypingRevision')) is not int or current is None
                    or data['liveTypingEnabled'] != current['typing_draft_enabled']
                    or data['liveTypingRevision'] != current['typing_draft_revision']):
                return
            data = {key: data[key] for key in ('liveTypingEnabled', 'liveTypingRevision')}
        if source == 'message.type':
            # Typing is ephemeral. A delayed start must not restore an indicator
            # after its TTL, a shared clear, account deactivation or friendship revocation.
            if (not isinstance(data, dict) or not isinstance(data.get('isTyping'), bool)
                    or type(data.get('revision')) is not int or data['revision'] < 0
                    or 'expiresAt' not in data):
                return
            try:
                connection = get_connection_for_user(self._get_user(), data.get('connectionId'), require_accepted=True)
                sender = self._get_recipient(connection, self._get_user())
                if (data.get('username') != sender.username or not connection.sender.is_active
                        or not connection.receiver.is_active):
                    return
                validate_history_revision(connection, data.get('revision'))
                if data['isTyping']:
                    expiry = parse_datetime(data.get('expiresAt')) if isinstance(data.get('expiresAt'), str) else None
                    now = timezone.now()
                    if (expiry is None or timezone.is_naive(expiry) or expiry <= now
                            or expiry > now + timedelta(seconds=self.TYPING_TTL_SECONDS + 1)):
                        return
                elif data.get('expiresAt') is not None:
                    return
            except (ChatServiceError, ValueError, TypeError):
                return
            keys = ('connectionId', 'username', 'isTyping', 'revision', 'expiresAt')
            if any(key in data for key in ('draft', 'draftRevision', 'sequence', 'streamId')):
                if not metadata_is_current(sender, connection, data) or not valid_draft(data.get('draft')):
                    return
                if data.get('draft') is not None and (not data['isTyping'] or not sender.typing_draft_enabled):
                    return
                keys += ('draft', 'draftRevision', 'sequence', 'streamId')
                if any(key not in data for key in keys):
                    return
            data = {key: data[key] for key in keys}
        # A group event may have been queued before the DELETE committed.
        # Revalidate sends at delivery and never include hidden content in ACKs.
        if source == 'message.send' and isinstance(data, dict) and isinstance(data.get('message'), dict):
            message = data['message']
            try:
                connection = get_connection_for_user(self._get_user(), data.get('connectionId'), require_accepted=True)
            except ChatServiceError:
                return
            data = {**data, **history_metadata(connection)}
            if isinstance(message.get('id'), int) and message['id'] <= connection.history_cleared_through:
                if not message.get('is_me') or not message.get('clientId'):
                    return
                source = 'message.ack'
                data = {**history_metadata(connection), 'historyCleared': True,
                        'messageId': message['id'], 'clientId': message['clientId']}
        self.send(
            text_data=json.dumps(
                {
                    "source": source,
                    "data": data,
                }
            )
        )

    def send_push_notification(self, push_token, title, message):
        send_push_notification(push_token, title, message)
