"""Private attachment URLs, short-lived access and bounded local downloads."""

import asyncio
import mimetypes
import re
from datetime import timedelta
from pathlib import Path
from urllib.parse import urlencode

from django.conf import settings
from django.core import signing
from django.core.exceptions import SuspiciousFileOperation
from django.http import FileResponse, Http404, HttpResponse
from django.shortcuts import get_object_or_404
from django.urls import reverse
from django.utils import timezone
from rest_framework.exceptions import AuthenticationFailed, PermissionDenied

from .models import Message, Usuario
from .image_archive import restore_image

MEDIA_KINDS = ('image', 'audio', 'video', 'document')
TICKET_SALT = 'chat.private-media.v1'


def media_url(message_id, kind):
    return reverse('message_media', kwargs={'message_id': message_id, 'kind': kind})


def ticket_lifetime():
    return min(900, max(1, int(getattr(settings, 'CHAT_MEDIA_ACCESS_TTL_SECONDS', 900))))


def private_headers(response):
    response['Cache-Control'] = 'private, no-store'
    response['X-Content-Type-Options'] = 'nosniff'
    response['Referrer-Policy'] = 'no-referrer'
    return response


def authorized_attachment(user, message_id, kind):
    if kind not in MEDIA_KINDS:
        raise Http404
    message = get_object_or_404(Message.objects.select_related('connection'), pk=message_id)
    connection = message.connection
    if not user.is_active or user.pk not in (connection.sender_id, connection.receiver_id) or not connection.accepted:
        raise PermissionDenied('No tienes acceso a este archivo.')
    if message.pk <= connection.history_cleared_through:
        raise Http404
    field = getattr(message, kind)
    if not field:
        raise Http404
    return message, field


def local_attachment_path(field):
    # Resolve symlinks too: even a corrupted legacy name cannot escape storage.
    try:
        root = Path(getattr(field.storage, 'location', settings.MEDIA_ROOT)).resolve()
        path = Path(field.storage.path(field.name)).resolve()
        path.relative_to(root)
        if not path.is_file() and not restore_image(field, path):
            raise Http404
        return path
    except (ValueError, OSError, NotImplementedError, SuspiciousFileOperation):
        raise Http404 from None


def create_access_ticket(user, message_id, kind):
    message, field = authorized_attachment(user, message_id, kind)
    local_attachment_path(field)
    ttl = ticket_lifetime()
    ticket = signing.dumps({'user': user.pk, 'message': message.pk, 'kind': kind,
                            'authVersion': user.auth_version}, salt=TICKET_SALT)
    return {
        'url': media_url(message.pk, kind) + '?' + urlencode({'ticket': ticket}),
        'expiresIn': ttl,
        'expiresAt': (timezone.now() + timedelta(seconds=ttl)).isoformat(),
    }


def download_user(request, message_id, kind):
    # An authenticated stranger must not inherit a participant's ticket identity.
    if request.user.is_authenticated:
        return request.user
    ticket = request.query_params.get('ticket')
    if not ticket or len(ticket) > 2048:
        raise AuthenticationFailed('Este archivo requiere un acceso temporal valido.')
    try:
        claims = signing.loads(ticket, salt=TICKET_SALT, max_age=ticket_lifetime())
        if not isinstance(claims, dict) or claims.get('message') != message_id or claims.get('kind') != kind:
            raise signing.BadSignature
        user_id = claims.get('user')
        if isinstance(user_id, bool) or not isinstance(user_id, int):
            raise signing.BadSignature
        user = Usuario.objects.get(pk=user_id, is_active=True)
        version = claims.get('authVersion', 0)
        if type(version) is not int or version < 0 or version != user.auth_version:
            raise signing.BadSignature
    except (signing.BadSignature, ValueError, TypeError, Usuario.DoesNotExist):
        raise AuthenticationFailed('El acceso al archivo expiro o no es valido.') from None
    return user


def parse_byte_range(header, size):
    if not header or not header.startswith('bytes='):
        return None
    match = re.fullmatch(r'bytes=(\d*)-(\d*)', header.strip()) if len(header) <= 128 else None
    if not match or not size or not any(match.groups()):
        raise ValueError
    first, last = match.groups()
    if first:
        start = int(first)
        end = min(int(last), size - 1) if last else size - 1
        if start >= size or end < start:
            raise ValueError
    else:
        suffix = int(last)
        if not suffix:
            raise ValueError
        start, end = max(0, size - suffix), size - 1
    return start, end


class BoundedFile:
    """FileResponse reads exactly a single requested range, never the tail."""

    def __init__(self, handle, length):
        self.handle = handle
        self.remaining = length
        self.name = handle.name

    def read(self, size=-1):
        length = self.remaining if size < 0 else min(size, self.remaining)
        data = self.handle.read(length) if length else b''
        self.remaining -= len(data)
        return data

    def close(self):
        self.handle.close()


async def attachment_chunks(file):
    # Daphne/ASGI must receive an async iterator; adapting FileResponse's default
    # synchronous iterator would otherwise collect an entire video in memory.
    try:
        while chunk := await asyncio.to_thread(file.read, 64 * 1024):
            yield chunk
    finally:
        await asyncio.to_thread(file.close)


def attachment_response(request, field, kind):
    path = local_attachment_path(field)
    try:
        handle = path.open('rb')
    except OSError:
        raise Http404 from None
    try:
        handle.seek(0, 2)
        size = handle.tell()
        handle.seek(0)
        # HTTP Range applies only to GET. Without validators, If-Range falls back
        # to a full response rather than risking a stale partial representation.
        byte_range = parse_byte_range(request.headers.get('Range'), size) if request.method == 'GET' and not request.headers.get('If-Range') else None
    except ValueError:
        handle.close()
        response = HttpResponse(status=416)
        response['Content-Range'] = f'bytes */{size}'
        response['Accept-Ranges'] = 'bytes'
        return private_headers(response)
    except Exception:
        handle.close()
        raise

    filename = re.sub(r'[^\w.\-]', '_', path.name).lstrip('.') or 'archivo'
    content_type = mimetypes.guess_type(filename)[0] or 'application/octet-stream'
    start, end = byte_range or (0, size - 1)
    length = end - start + 1
    handle.seek(start)
    bounded_file = BoundedFile(handle, length)
    response = FileResponse(bounded_file, status=206 if byte_range else 200,
                            as_attachment=kind == 'document', filename=filename, content_type=content_type)
    response['Content-Length'] = str(length)
    response['Accept-Ranges'] = 'bytes'
    if byte_range:
        response['Content-Range'] = f'bytes {start}-{end}/{size}'
    if request.method == 'HEAD':
        # Preserve representation headers without keeping an unused file open.
        handle.close()
        response.streaming_content = ()
    else:
        response.streaming_content = attachment_chunks(bounded_file)
    return private_headers(response)
