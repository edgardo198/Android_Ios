"""Bounded photo persistence for the free Render trial's ephemeral filesystem."""
import os
import tempfile
from pathlib import Path

from django.conf import settings
from django.db import transaction
from django.db.models import Sum

from .models import ImageArchiveBudget, MessageImageArchive


class ImageArchiveFull(Exception):
    pass


def archive_image(message):
    if not settings.CHAT_ARCHIVE_IMAGES or not message.image:
        return
    limit = settings.CHAT_MEDIA_MAX_BYTES['image']
    with message.image.storage.open(message.image.name, 'rb') as photo:
        content = photo.read(limit + 1)
    if not content or len(content) > limit:
        raise ImageArchiveFull('La imagen supera el tamaño permitido para guardarla.')
    with transaction.atomic():
        # Initialized by migration, not lazily created by concurrent uploads.
        ImageArchiveBudget.objects.select_for_update().get(pk=1)
        used = MessageImageArchive.objects.aggregate(total=Sum('size'))['total'] or 0
        if used + len(content) > settings.CHAT_IMAGE_ARCHIVE_MAX_BYTES:
            raise ImageArchiveFull('El almacenamiento de fotos de prueba está lleno. No se envió la imagen.')
        MessageImageArchive.objects.create(message=message, filename=message.image.name,
                                           content=content, size=len(content))


def restore_image(field, path):
    if field.field.name != 'image' or not field.instance.pk:
        return False
    archive = MessageImageArchive.objects.filter(message_id=field.instance.pk,
                                                 filename=field.name).first()
    if archive is None:
        return False
    # The caller has already authorized the user and confined the path to MEDIA_ROOT.
    # Atomic replacement prevents concurrent requests seeing a partial image.
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as photo:
            temporary = photo.name
            photo.write(bytes(archive.content))
        os.replace(temporary, path)
        return True
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)
