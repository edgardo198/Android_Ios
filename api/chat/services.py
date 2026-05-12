import base64
import binascii

import requests
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.core.files.base import ContentFile

from .models import Connection, Message
from .serializers import MessageSerializer, UsuarioSerializer


class ChatServiceError(Exception):
    def __init__(self, message, status_code=400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send"

MEDIA_CONFIG = {
    "image": {
        "field": "image",
        "message": "Imagen Recibida",
        "push": "Imagen",
        "error": "No se pudo guardar la imagen.",
    },
    "audio": {
        "field": "audio",
        "message": "Audio Recibido",
        "push": "Audio",
        "error": "No se pudo guardar el audio.",
    },
    "video": {
        "field": "video",
        "message": "Video Recibido",
        "push": "Video",
        "error": "No se pudo guardar el video.",
    },
    "document": {
        "field": "document",
        "message": "Documento Recibido",
        "push": "Documento",
        "error": "No se pudo guardar el documento.",
    },
}


def get_connection_for_user(user, connection_id, *, require_accepted=False):
    if not connection_id:
        raise ChatServiceError("No se proporciono connectionId.")

    try:
        connection = Connection.objects.select_related("sender", "receiver").get(id=connection_id)
    except Connection.DoesNotExist as error:
        raise ChatServiceError("No se pudo encontrar la conexion.", status_code=404) from error

    if connection.sender_id != user.id and connection.receiver_id != user.id:
        raise ChatServiceError("No tienes acceso a esta conexion.", status_code=403)

    if require_accepted and not connection.accepted:
        raise ChatServiceError("La conexion aun no ha sido aceptada.", status_code=400)

    return connection


def get_recipient(connection, user):
    return connection.sender if connection.sender_id != user.id else connection.receiver


def build_message_payload(message, current_user, friend):
    serialized_message = MessageSerializer(message, context={"user": current_user})
    serialized_friend = UsuarioSerializer(friend)
    return {
        "message": serialized_message.data,
        "friend": serialized_friend.data,
    }


def send_group(group, source, data):
    channel_layer = get_channel_layer()
    if channel_layer is None:
        return

    async_to_sync(channel_layer.group_send)(
        group,
        {
            "type": "broadcast_group",
            "source": source,
            "data": data,
        },
    )


def send_push_notification(push_token, title, message):
    payload = {
        "to": push_token,
        "sound": "default",
        "title": title,
        "body": message,
    }
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
    }

    try:
        response = requests.post(PUSH_ENDPOINT, json=payload, headers=headers, timeout=10)
        response.raise_for_status()
    except requests.exceptions.RequestException as error:
        print(f"Error enviando la notificacion: {error}")


def broadcast_message(message, sender, recipient, push_body=None):
    send_group(
        sender.username,
        "message.send",
        build_message_payload(message, sender, recipient),
    )

    if push_body and recipient.pushToken:
        send_push_notification(recipient.pushToken, sender.username, push_body)

    send_group(
        recipient.username,
        "message.send",
        build_message_payload(message, recipient, sender),
    )


def content_file_from_base64(raw_value, filename):
    if not raw_value or not filename:
        raise ChatServiceError("Archivo o nombre de archivo invalido.")

    base64_value = raw_value.split(",", 1)[1] if "," in raw_value else raw_value

    try:
        file_bytes = base64.b64decode(base64_value)
    except (ValueError, TypeError, binascii.Error) as error:
        raise ChatServiceError("El archivo recibido no tiene un formato valido.") from error

    return ContentFile(file_bytes, name=filename)


def create_media_message_from_file(user, connection, file_obj, media_type, *, broadcast=True):
    config = MEDIA_CONFIG.get(media_type)
    if not config:
        raise ChatServiceError("Tipo de archivo no soportado.")

    filename = getattr(file_obj, "name", None)
    if not filename:
        raise ChatServiceError("Archivo o nombre de archivo invalido.")

    message = None
    try:
        message = Message.objects.create(
            connection=connection,
            user=user,
            text=config["message"],
            is_new=True,
        )
        getattr(message, config["field"]).save(filename, file_obj, save=True)
    except Exception as error:
        if message is not None:
            message.delete()
        raise ChatServiceError(config["error"]) from error

    recipient = get_recipient(connection, user)
    if broadcast:
        broadcast_message(message, user, recipient, config["push"])
    return message, recipient
