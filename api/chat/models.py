from pathlib import Path

from django.contrib.auth.models import AbstractUser
from django.core.exceptions import ValidationError
from django.db import models
from django.utils.text import slugify


def cargar_miniatura(instance, filename):
    identifier = instance.pk or slugify(instance.username) or 'usuario'
    return f'miniatura/{identifier}{Path(filename).suffix.lower()}'


def email_users(email, *, exclude_pk=None, limit=2):
    """Resolve normalized addresses consistently on SQLite and PostgreSQL."""
    key = email.strip().lower()
    users = Usuario.objects.all()
    if exclude_pk is not None:
        users = users.exclude(pk=exclude_pk)
    matches = list(users.filter(email_key=key).order_by('pk')[:limit])
    if len(matches) >= limit:
        return matches
    # SQL LOWER() on SQLite folds ASCII only. Historical ambiguous/non-normalized
    # rows are rare and must be checked in Python, including Unicode addresses.
    for user in users.filter(email_key__isnull=True).exclude(email='').order_by('pk').iterator():
        if user.email.strip().lower() == key:
            matches.append(user)
            if len(matches) >= limit:
                break
    return matches


class Usuario(AbstractUser):
    # A nullable key preserves historical blank/ambiguous email values. All new
    # email assignments reserve their normalized key, including concurrent ones.
    email_key = models.CharField(max_length=254, unique=True, null=True, blank=True, editable=False)
    auth_version = models.PositiveIntegerField(default=0, editable=False)
    typing_draft_enabled = models.BooleanField(default=False)
    typing_draft_revision = models.PositiveIntegerField(default=0, editable=False)
    miniatura = models.ImageField(
        upload_to=cargar_miniatura,
        null=True,
        blank=True
    )

    pushToken = models.CharField(max_length=255, null=True, blank=True)

    def save(self, *args, **kwargs):
        update_fields = kwargs.get('update_fields')
        writes_email = update_fields is None or 'email' in update_fields
        previous = None
        if not self._state.adding and writes_email:
            previous = type(self).objects.filter(pk=self.pk).values('email').first()
        if writes_email and (self._state.adding or previous is None or self.email != previous['email']):
            self.email = self.email.strip().lower() if isinstance(self.email, str) else ''
            self.email_key = self.email or None
            if self.email and email_users(self.email, exclude_pk=self.pk, limit=1):
                raise ValidationError({'email': ['Este correo ya está en uso.']})
            if update_fields is not None:
                kwargs['update_fields'] = set(update_fields) | {'email_key'}
        super().save(*args, **kwargs)


class Connection(models.Model):
    sender = models.ForeignKey(
        Usuario,
        related_name='sent_connections',
        on_delete=models.CASCADE
    )
    receiver = models.ForeignKey(
        Usuario,
        related_name='received_connections',
        on_delete=models.CASCADE
    )
    accepted = models.BooleanField(default=False)
    # Keep persisted client IDs as a delivery ledger while hiding cleared rows.
    history_cleared_through = models.PositiveBigIntegerField(default=0)
    history_revision = models.PositiveBigIntegerField(default=0)
    history_cleared_at = models.DateTimeField(null=True, blank=True)
    updated = models.DateTimeField(auto_now=True)
    created = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.sender.username + ' -> ' + self.receiver.username

class Message(models.Model):
    connection = models.ForeignKey(
        Connection,
        related_name='messages',
        on_delete=models.CASCADE
    )
    user = models.ForeignKey(
        Usuario,
        related_name='my_messages',
        on_delete=models.CASCADE
    )
    text = models.TextField()
    client_id = models.UUIDField(null=True, blank=True)
    created = models.DateTimeField(auto_now_add=True)

    image = models.ImageField(upload_to='messages/images/', null=True, blank=True)
    audio = models.FileField(upload_to='messages/audio/', null=True, blank=True)
    video = models.FileField(upload_to='videos/', null=True, blank=True)
    document = models.FileField(upload_to='documents/', null=True, blank=True)
    is_new = models.BooleanField(default=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['user', 'client_id'], name='chat_message_user_client_unique'),
        ]

    def __str__(self):
        return f"{self.user.username}: {self.text or 'Imagen/Audio'}"


class MessageImageArchive(models.Model):
    """Trial-sized durable copy; never included in message serialization."""

    message = models.OneToOneField(Message, primary_key=True, on_delete=models.CASCADE,
                                  related_name='image_archive')
    filename = models.CharField(max_length=100)
    content = models.BinaryField(editable=False)
    size = models.PositiveIntegerField()


class ImageArchiveBudget(models.Model):
    # A singleton row serializes uploads across conversations on PostgreSQL.
    id = models.PositiveSmallIntegerField(primary_key=True, default=1)
