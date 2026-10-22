import base64
import binascii
import hashlib
import logging
import re
from uuid import UUID

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.files.base import ContentFile
from django.db import DatabaseError, transaction
from django.db.models import Max
from django.forms import ImageField
from django.utils import timezone

from .models import Connection, Message
from .serializers import MessageSerializer, UsuarioSerializer


class ChatServiceError(Exception):
    def __init__(self, message, status_code=400, *, code=None, details=None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code
        self.details = details or {}


SAFE_FILENAME_PATTERN = re.compile(r"[^A-Za-z0-9._ -]+")
logger = logging.getLogger(__name__)

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

MEDIA_EXTENSIONS = {
    'image': {'.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'},
    'audio': {'.m4a', '.mp4', '.mp3', '.aac', '.wav', '.ogg', '.opus', '.webm', '.3gp', '.caf', '.amr'},
    'video': {'.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv', '.3gp'},
    'document': {'.pdf', '.txt', '.csv', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.zip', '.rar', '.7z'},
}


def user_group_name(username):
    # Django usernames may contain Unicode, @ or + and reach 150 characters;
    # Channels groups allow fewer characters and require names under 100 bytes.
    return 'chat.user.' + hashlib.sha256(username.encode('utf-8')).hexdigest()


def parse_positive_id(value, field_name):
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise ChatServiceError(f'{field_name} invalido.')
    try:
        identifier = int(value)
    except (ValueError, TypeError) as error:
        raise ChatServiceError(f'{field_name} invalido.') from error
    if identifier <= 0 or identifier > 9223372036854775807:
        raise ChatServiceError(f'{field_name} invalido.')
    return identifier


def get_connection_for_user(user, connection_id, *, require_accepted=False):
    if not connection_id:
        raise ChatServiceError("No se proporciono connectionId.")

    connection_id = parse_positive_id(connection_id, 'connectionId')
    try:
        connection = Connection.objects.select_related("sender", "receiver").get(id=connection_id)
    except (ValueError, TypeError) as error:
        raise ChatServiceError("connectionId invalido.") from error
    except Connection.DoesNotExist as error:
        raise ChatServiceError("No se pudo encontrar la conexion.", status_code=404) from error

    if connection.sender_id != user.id and connection.receiver_id != user.id:
        raise ChatServiceError("No tienes acceso a esta conexion.", status_code=403)

    if require_accepted and not connection.accepted:
        raise ChatServiceError("La conexion aun no ha sido aceptada.", status_code=400)

    return connection


def get_recipient(connection, user):
    return connection.sender if connection.sender_id != user.id else connection.receiver


def history_metadata(connection):
    return {
        'connectionId': connection.pk,
        'clearedThrough': connection.history_cleared_through,
        'revision': connection.history_revision,
        'clearedAt': connection.history_cleared_at.isoformat() if connection.history_cleared_at else None,
    }


def validate_history_revision(connection, revision):
    if revision is None and connection.history_revision == 0:
        return
    valid = (not isinstance(revision, bool) and isinstance(revision, (str, int))
             and len(str(revision)) <= 19 and str(revision).isascii() and str(revision).isdigit())
    if not valid or int(revision) != connection.history_revision:
        raise ChatServiceError('El historial cambió. Actualiza la conversación antes de enviar.', 409,
                               code='history_cleared', details=history_metadata(connection))


def locked_connection_for_user(user, connection_id):
    connection = Connection.objects.select_for_update().select_related('sender', 'receiver').get(pk=connection_id)
    if user.pk not in (connection.sender_id, connection.receiver_id):
        raise ChatServiceError('No tienes acceso a esta conexión.', 403)
    if not connection.accepted:
        raise ChatServiceError('La conexión aún no ha sido aceptada.')
    return connection


def clear_connection_history(user, connection_id):
    authorized = get_connection_for_user(user, connection_id, require_accepted=True)
    with transaction.atomic():
        connection = locked_connection_for_user(user, authorized.pk)
        cutoff = Message.objects.filter(connection=connection).aggregate(last=Max('pk'))['last'] or 0
        connection.history_cleared_through = max(cutoff, connection.history_cleared_through)
        connection.history_revision += 1
        connection.history_cleared_at = timezone.now()
        connection.save(update_fields=['history_cleared_through', 'history_revision', 'history_cleared_at'])
        result = history_metadata(connection)
        recipients = (connection.sender.username, connection.receiver.username)

        def announce():
            for recipient in recipients:
                try:
                    send_group(recipient, 'message_history_cleared', result)
                except Exception:
                    logger.exception('No se pudo sincronizar el borrado de la conversación %s.', connection.pk)
            try:
                from notifications.services import enqueue_history_clear_notice
                enqueue_history_clear_notice(connection.pk)
            except Exception:
                logger.warning('No se pudo sincronizar el aviso de borrado.')
        transaction.on_commit(announce)
        return result


def normalize_client_id(raw_value):
    if raw_value is None:
        return None
    if not isinstance(raw_value, str) or len(raw_value) != 36:
        raise ChatServiceError('clientId debe ser un UUID valido.')
    try:
        identifier = UUID(raw_value)
    except ValueError as error:
        raise ChatServiceError('clientId debe ser un UUID valido.') from error
    if raw_value.lower() != str(identifier):
        raise ChatServiceError('clientId debe ser un UUID valido.')
    return identifier


def create_text_message(user, connection, raw_text, client_id=None, *, history_revision=None):
    if user.pk not in (connection.sender_id, connection.receiver_id):
        raise ChatServiceError('No tienes acceso a esta conexion.', status_code=403)
    if not connection.accepted:
        raise ChatServiceError('La conexion aun no ha sido aceptada.')
    if not isinstance(raw_text, str):
        raise ChatServiceError('El mensaje debe contener texto.')
    text = raw_text.strip()
    if not text:
        raise ChatServiceError('El mensaje no puede estar vacio.')
    if len(text) > 10000:
        raise ChatServiceError('El mensaje supera el tamano permitido.')
    identifier = normalize_client_id(client_id)
    try:
        with transaction.atomic():
            connection = locked_connection_for_user(user, connection.pk)
            existing = Message.objects.filter(user=user, client_id=identifier).first() if identifier else None
            if existing and existing.pk <= connection.history_cleared_through and existing.connection_id == connection.pk:
                if existing.text != text or existing.image or existing.audio or existing.video or existing.document:
                    raise ChatServiceError('clientId ya se uso para un mensaje diferente.')
                return existing, False
            validate_history_revision(connection, history_revision)
            if identifier is None:
                message = Message.objects.create(connection=connection, user=user, text=text, is_new=True)
                return message, True
            # The database constraint also protects simultaneous retries from
            # separate connections/workers; get_or_create recovers a race.
            message, created = Message.objects.get_or_create(
                user=user,
                client_id=identifier,
                defaults={'connection': connection, 'text': text, 'is_new': True},
            )
            if not created and (
                message.connection_id != connection.pk or message.text != text
                or message.image or message.audio or message.video or message.document
            ):
                raise ChatServiceError('clientId ya se uso para un mensaje diferente.')
    except DatabaseError as error:
        logger.exception('No se pudo guardar el mensaje de texto.')
        raise ChatServiceError('No se pudo guardar el mensaje.') from error
    return message, created


def build_message_payload(message, current_user, friend):
    connection = Connection.objects.get(pk=message.connection_id)
    metadata = history_metadata(connection)
    if message.pk <= connection.history_cleared_through:
        return {**metadata, 'historyCleared': True, 'messageId': message.pk,
                'clientId': str(message.client_id) if message.client_id else None}
    serialized_message = MessageSerializer(message, context={"user": current_user})
    serialized_friend = UsuarioSerializer(friend)
    return {
        **metadata,
        "connectionId": message.connection_id,
        "message": serialized_message.data,
        "friend": serialized_friend.data,
    }


def send_group(group, source, data):
    channel_layer = get_channel_layer()
    if channel_layer is None:
        return

    async_to_sync(channel_layer.group_send)(
        user_group_name(group),
        {
            "type": "broadcast_group",
            "source": source,
            "data": data,
        },
    )


def send_push_notification(push_token, title, message):
    # Compatibility shim for older local clients. No external push service is
    # contacted; delivery is exclusively the self-hosted device notice journal.
    return None


def broadcast_message(message, sender, recipient, push_body=None, *, send_event=None, notify=None):
    # A saved message remains successful even if realtime delivery is down.
    # Attempt each recipient independently so one failure cannot block the other.
    send_event = send_event or send_group
    notify = notify or send_push_notification
    for current_user, friend in ((sender, recipient), (recipient, sender)):
        try:
            payload = build_message_payload(message, current_user, friend)
            if payload.get('historyCleared'):
                continue
            send_event(
                current_user.username,
                "message.send",
                payload,
            )
        except Exception:
            logger.exception("Realtime delivery failed for message %s", message.pk)

    if push_body and recipient.pushToken and Message.objects.filter(pk=message.pk, pk__gt=Connection.objects.get(pk=message.connection_id).history_cleared_through).exists():
        notify(recipient.pushToken, sender.username, push_body)
    try:
        from notifications.services import enqueue_message_notice
        enqueue_message_notice(message.pk)
    except Exception:
        # The saved message remains valid; reconnect reconciliation recovers it.
        logger.warning('No se pudo preparar un aviso de mensaje.')



def sanitize_upload_filename(filename, fallback="archivo"):
    value = str(filename or "").replace("\x00", "").replace("\\", "/").strip()
    value = value.rsplit("/", 1)[-1].strip()
    value = SAFE_FILENAME_PATTERN.sub("_", value).strip(" .")
    value = value or fallback
    if len(value) > 100:
        stem, dot, extension = value.rpartition('.')
        value = stem[:99 - len(extension)] + dot + extension if dot and len(extension) < 20 else value[:100]
    return value


def content_file_from_base64(raw_value, filename, *, media_type=None):
    if not isinstance(raw_value, str) or not isinstance(filename, str) or not raw_value or not filename:
        raise ChatServiceError("Archivo o nombre de archivo invalido.")

    base64_value = raw_value.split(",", 1)[1] if "," in raw_value else raw_value
    # Reject oversized payloads before allocating the decoded byte buffer.
    max_size = settings.CHAT_MEDIA_MAX_BYTES.get(media_type, max(settings.CHAT_MEDIA_MAX_BYTES.values()))
    if len(base64_value) > 4 * ((max_size + 2) // 3):
        raise ChatServiceError('El archivo supera el tamano permitido.', status_code=413)

    try:
        file_bytes = base64.b64decode(base64_value, validate=True)
    except (ValueError, TypeError, binascii.Error) as error:
        raise ChatServiceError("El archivo recibido no tiene un formato valido.") from error

    if not file_bytes:
        raise ChatServiceError("El archivo recibido esta vacio.")

    return ContentFile(file_bytes, name=sanitize_upload_filename(filename))


def validate_media_file(file_obj, media_type):
    if media_type not in MEDIA_CONFIG:
        raise ChatServiceError('Tipo de archivo no soportado.')
    size = getattr(file_obj, 'size', None)
    if not size:
        raise ChatServiceError('El archivo recibido esta vacio.')
    if size > settings.CHAT_MEDIA_MAX_BYTES[media_type]:
        raise ChatServiceError('El archivo supera el tamano permitido.', status_code=413)
    filename = sanitize_upload_filename(getattr(file_obj, 'name', None))
    extension = '.' + filename.rsplit('.', 1)[-1].lower() if '.' in filename else ''
    if extension not in MEDIA_EXTENSIONS[media_type]:
        raise ChatServiceError('El formato del archivo no es compatible con este tipo de mensaje.')
    content_type = getattr(file_obj, 'content_type', '') or ''
    if media_type != 'document' and content_type and content_type != 'application/octet-stream':
        compatible_prefixes = ('audio/', 'video/') if media_type == 'audio' else (f'{media_type}/',)
        if not content_type.lower().startswith(compatible_prefixes):
            raise ChatServiceError('El tipo del archivo no coincide con el mensaje.')
    if media_type == 'image':
        try:
            checked_image = ImageField().clean(file_obj)
            detected_gif = checked_image.image.format == 'GIF'
            declared_gif = content_type.lower() == 'image/gif'
            if (extension == '.gif' or detected_gif or declared_gif) and (
                extension != '.gif' or not detected_gif or
                (content_type and content_type.lower() not in ('image/gif', 'application/octet-stream'))
            ):
                raise ChatServiceError('El contenido y la extensión del archivo deben corresponder a un GIF.')
        except ValidationError as error:
            raise ChatServiceError('El archivo recibido no es una imagen valida.') from error
        finally:
            file_obj.seek(0)
    return filename


def create_media_message_from_file(user, connection, file_obj, media_type, *, broadcast=True, history_revision=None):
    if user.pk not in (connection.sender_id, connection.receiver_id):
        raise ChatServiceError('No tienes acceso a esta conexion.', status_code=403)
    if not connection.accepted:
        raise ChatServiceError('La conexion aun no ha sido aceptada.')
    config = MEDIA_CONFIG.get(media_type)
    if not config:
        raise ChatServiceError("Tipo de archivo no soportado.")

    filename = validate_media_file(file_obj, media_type)

    message = None
    try:
        with transaction.atomic():
            connection = locked_connection_for_user(user, connection.pk)
            validate_history_revision(connection, history_revision)
            message = Message(
                connection=connection,
                user=user,
                text=config["message"],
                is_new=True,
            )
            getattr(message, config["field"]).save(filename, file_obj, save=False)
            message.save()
    except ChatServiceError:
        raise
    except Exception as error:
        logger.exception('No se pudo guardar el archivo del mensaje.')
        if message is not None:
            media_field = getattr(message, config['field'])
            if media_field and media_field._committed:
                media_field.delete(save=False)
        raise ChatServiceError(config["error"]) from error

    recipient = get_recipient(connection, user)
    if broadcast:
        broadcast_message(message, user, recipient, config["push"])
    return message, recipient
