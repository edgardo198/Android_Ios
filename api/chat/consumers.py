import json

from asgiref.sync import async_to_sync
from channels.generic.websocket import WebsocketConsumer
from django.core.files.base import ContentFile
from django.db.models import Exists, OuterRef, Q
from django.db.models.functions import Coalesce

from .models import Connection, Message, Usuario
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
    content_file_from_base64,
    create_media_message_from_file,
    get_connection_for_user,
    get_recipient,
    send_group,
    send_push_notification,
)


class ChatConsumer(WebsocketConsumer):
    MESSAGE_PAGE_SIZE = 15

    def connect(self):
        user = self.scope["user"]
        if not user.is_authenticated:
            self.close()
            return

        self.username = user.username
        async_to_sync(self.channel_layer.group_add)(self.username, self.channel_name)
        self.accept()

    def disconnect(self, close_code):
        if hasattr(self, "username"):
            async_to_sync(self.channel_layer.group_discard)(self.username, self.channel_name)

    def receive(self, text_data):
        try:
            data = json.loads(text_data)
        except json.JSONDecodeError:
            self._send_error("Invalid JSON format.")
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

    def _send_error(self, message):
        self.send(
            text_data=json.dumps(
                {
                    "source": "error",
                    "message": message,
                }
            )
        )

    def _get_user(self):
        return self.scope["user"]

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
        try:
            page = int(raw_page or 0)
        except (TypeError, ValueError):
            self._send_error("Pagina invalida.")
            return None

        if page < 0:
            self._send_error("Pagina invalida.")
            return None

        return page

    def _extract_base64(self, raw_value):
        if not raw_value:
            return None
        return raw_value.split(",", 1)[1] if "," in raw_value else raw_value

    def _build_message_payload(self, message, current_user, friend):
        return build_message_payload(message, current_user, friend)

    def _broadcast_message(self, message, sender, recipient, push_body=None):
        self.send_group(
            sender.username,
            "message.send",
            self._build_message_payload(message, sender, recipient),
        )

        if push_body and recipient.pushToken:
            self.send_push_notification(recipient.pushToken, sender.username, push_body)

        self.send_group(
            recipient.username,
            "message.send",
            self._build_message_payload(message, recipient, sender),
        )

    def _create_media_message(self, data, media_type):
        user = self._get_user()
        connection = self._get_connection(data.get("connectionId"), require_accepted=True)
        if not connection:
            return

        base64_value = data.get("base64")
        filename = data.get("filename")

        try:
            file_obj = content_file_from_base64(base64_value, filename)
            message, recipient = create_media_message_from_file(
                user,
                connection,
                file_obj,
                media_type,
                broadcast=False,
            )
            self._broadcast_message(message, user, recipient, MEDIA_CONFIG[media_type]["push"])
        except ChatServiceError as error:
            self._send_error(error.message)
            return

    def receive_message_list(self, data):
        user = self._get_user()
        connection = self._get_connection(data.get("connectionId"), require_accepted=True)
        if not connection:
            return

        page = self._normalize_page(data.get("page"))
        if page is None:
            return

        start = page * self.MESSAGE_PAGE_SIZE
        end = start + self.MESSAGE_PAGE_SIZE
        messages_qs = Message.objects.filter(connection=connection).order_by("-created")
        messages = messages_qs[start:end]
        messages_count = messages_qs.count()
        next_page = page + 1 if messages_count > end else None
        recipient = self._get_recipient(connection, user)

        payload = {
            "messages": MessageSerializer(messages, context={"user": user}, many=True).data,
            "next": next_page,
            "friend": UsuarioSerializer(recipient).data,
        }
        self.send_group(user.username, "message.list", payload)

    def receive_message_send(self, data):
        user = self._get_user()
        connection = self._get_connection(data.get("connectionId"), require_accepted=True)
        if not connection:
            return

        message_text = (data.get("message") or "").strip()
        if not message_text:
            self._send_error("El mensaje no puede estar vacio.")
            return

        message = Message.objects.create(
            connection=connection,
            user=user,
            text=message_text,
            is_new=True,
        )

        recipient = self._get_recipient(connection, user)
        self._broadcast_message(message, user, recipient, message_text)

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
        message_id = data.get("messageId")
        if not message_id:
            self._send_error("No se proporciono messageId.")
            return

        try:
            message = Message.objects.select_related("connection", "user").get(id=message_id)
        except Message.DoesNotExist:
            self._send_error("Mensaje no encontrado.")
            return

        connection = message.connection
        if connection.sender_id != user.id and connection.receiver_id != user.id:
            self._send_error("No tienes acceso a este mensaje.")
            return

        message.is_new = False
        message.save(update_fields=["is_new"])

        recipient = self._get_recipient(connection, user)
        self.send_group(
            user.username,
            "message.read",
            {"message": MessageSerializer(message, context={"user": user}).data},
        )
        self.send_group(
            recipient.username,
            "message.read",
            {"message": MessageSerializer(message, context={"user": recipient}).data},
        )

    def receive_friend_list(self, data):
        user = self._get_user()
        latest_message = Message.objects.filter(connection=OuterRef("id")).order_by("-created")[:1]
        connections = Connection.objects.filter(
            Q(sender=user) | Q(receiver=user),
            accepted=True,
        ).annotate(
            latest_text=latest_message.values("text"),
            latest_image=latest_message.values("image"),
            latest_audio=latest_message.values("audio"),
            latest_video=latest_message.values("video"),
            latest_document=latest_message.values("document"),
            latest_created=latest_message.values("created"),
            latest_is_new=latest_message.values("is_new"),
            latest_user_id=latest_message.values("user_id"),
        ).order_by(Coalesce("latest_created", "updated").desc())

        serialized = FriendSerializer(connections, context={"user": user}, many=True)
        self.send_group(user.username, "friend.list", serialized.data)

    def receive_message_type(self, data):
        recipient_username = data.get("username")
        if not recipient_username:
            self._send_error("No se proporciono username.")
            return

        user = self._get_user()
        self.send_group(
            recipient_username,
            "message.type",
            {"username": user.username},
        )

    def receive_request_accept(self, data):
        user = self._get_user()
        username = data.get("username")
        if not username:
            self._send_error("No se proporciono username.")
            return

        try:
            connection = Connection.objects.select_related("sender", "receiver").get(
                sender__username=username,
                receiver=user,
            )
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
        if not username:
            self._send_error("No se proporciono username.")
            return

        if username == user.username:
            self._send_error("No puedes enviarte una solicitud a ti mismo.")
            return

        try:
            receiver = Usuario.objects.get(username=username)
        except Usuario.DoesNotExist:
            self._send_error("Usuario no encontrado.")
            return

        connection, _ = Connection.objects.get_or_create(sender=user, receiver=receiver)
        serialized = RequestSerializer(connection)

        self.send_group(connection.sender.username, "request.connect", serialized.data)
        self.send_group(connection.receiver.username, "request.connect", serialized.data)

    def receive_request_list(self, data):
        user = self._get_user()
        connections = Connection.objects.filter(receiver=user, accepted=False)
        serialized = RequestSerializer(connections, many=True)
        self.send_group(user.username, "request.list", serialized.data)

    def receive_search(self, data):
        user = self._get_user()
        query = (data.get("query") or "").strip()
        if not query:
            self.send_group(user.username, "search", [])
            return

        users = Usuario.objects.filter(
            Q(username__istartswith=query)
            | Q(first_name__istartswith=query)
            | Q(last_name__istartswith=query)
        ).exclude(username=user.username).annotate(
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
        )

        serialized = SearchSerializer(users, many=True)
        self.send_group(user.username, "search", serialized.data)

    def receive_miniatura(self, data):
        user = self._get_user()
        base64_value = self._extract_base64(data.get("base64"))
        filename = data.get("filename")

        if not base64_value or not filename:
            self._send_error("Imagen o nombre de archivo invalidos.")
            return

        try:
            image_bytes = base64.b64decode(base64_value)
            user.miniatura.save(filename, ContentFile(image_bytes, name=filename), save=True)
        except (ValueError, TypeError, binascii.Error):
            self._send_error("La imagen recibida no tiene un formato valido.")
            return
        except Exception:
            self._send_error("No se pudo guardar la imagen.")
            return

        serialized = UsuarioSerializer(user)
        self.send_group(user.username, "miniatura", serialized.data)

    def send_group(self, group, source, data):
        send_group(group, source, data)

    def broadcast_group(self, event):
        self.send(
            text_data=json.dumps(
                {
                    "source": event.get("source"),
                    "data": event.get("data"),
                }
            )
        )

    def send_push_notification(self, push_token, title, message):
        send_push_notification(push_token, title, message)
