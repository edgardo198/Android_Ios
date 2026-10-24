"""Bounded photo persistence for the free Render trial's ephemeral filesystem."""
import os
import tempfile
from pathlib import Path

from django.conf import settings
from django.db import transaction
from django.db.models import Sum

from .models import AvatarImageArchive, ImageArchiveBudget, MessageImageArchive


class ImageArchiveFull(Exception):
    pass


def _image_bytes(field):
    limit = settings.CHAT_MEDIA_MAX_BYTES['image']
    with field.storage.open(field.name, 'rb') as photo:
        content = photo.read(limit + 1)
    if not content or len(content) > limit:
        raise ImageArchiveFull('La imagen supera el tamaño permitido para guardarla.')
    return content


def _reserve_image_bytes(size, replacing_user=None):
    # Called inside the same transaction that saves the image and its owner.
    ImageArchiveBudget.objects.select_for_update().get(pk=1)
    messages = MessageImageArchive.objects.aggregate(total=Sum('size'))['total'] or 0
    avatars = AvatarImageArchive.objects.all()
    if replacing_user is not None:
        avatars = avatars.exclude(user_id=replacing_user)
    used = messages + (avatars.aggregate(total=Sum('size'))['total'] or 0)
    if used + size > settings.CHAT_IMAGE_ARCHIVE_MAX_BYTES:
        raise ImageArchiveFull('El almacenamiento de fotos de prueba está lleno. No se guardó la imagen.')


def archive_image(message):
    if not settings.CHAT_ARCHIVE_IMAGES or not message.image:
        return
    content = _image_bytes(message.image)
    with transaction.atomic():
        _reserve_image_bytes(len(content))
        MessageImageArchive.objects.create(message=message, filename=message.image.name,
                                           content=content, size=len(content))


def archive_avatar(user):
    if not settings.CHAT_ARCHIVE_IMAGES or not user.miniatura:
        return
    content = _image_bytes(user.miniatura)
    with transaction.atomic():
        _reserve_image_bytes(len(content), replacing_user=user.pk)
        AvatarImageArchive.objects.update_or_create(user=user, defaults={
            'filename': user.miniatura.name, 'content': content, 'size': len(content)})


def _write_cached_image(content, path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as photo:
            temporary = photo.name
            photo.write(bytes(content))
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def restore_image(field, path):
    if field.field.name != 'image' or not field.instance.pk:
        return False
    archive = MessageImageArchive.objects.filter(message_id=field.instance.pk,
                                                 filename=field.name).first()
    if archive is None:
        return False
    # The caller has already authorized the user and confined the path to MEDIA_ROOT.
    # Atomic replacement prevents concurrent requests seeing a partial image.
    _write_cached_image(archive.content, path)
    return True


def restore_avatar(filename, path):
    archive = AvatarImageArchive.objects.filter(filename=filename, user__miniatura=filename,
                                                user__is_active=True).first()
    if archive is None:
        return False
    _write_cached_image(archive.content, path)
    return True
