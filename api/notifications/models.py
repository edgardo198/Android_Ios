from django.conf import settings
from django.db import models
from django.utils import timezone


class Device(models.Model):
    """A revocable notice-only credential. Raw secrets are never persisted."""
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    device_id = models.UUIDField()
    platform = models.CharField(max_length=7, default='android')
    token_digest = models.CharField(max_length=64, unique=True, editable=False)
    auth_version = models.PositiveIntegerField()
    expires_at = models.DateTimeField(db_index=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    last_acked = models.PositiveBigIntegerField(default=0)
    last_delivered = models.PositiveBigIntegerField(default=0)
    receive_since = models.DateTimeField(default=timezone.now)
    message_after_id = models.PositiveBigIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['user', 'device_id'], name='notices_user_device_unique')]


class DeviceSocket(models.Model):
    channel_name = models.CharField(max_length=100, primary_key=True)
    device = models.ForeignKey(Device, on_delete=models.CASCADE)
    expires_at = models.DateTimeField(db_index=True)


class Event(models.Model):
    """Durable IDs/order only; no message, draft, SDP, ICE or credentials."""
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    connection = models.ForeignKey('chat.Connection', on_delete=models.CASCADE)
    kind = models.CharField(max_length=16)
    object_id = models.CharField(max_length=36)
    revision = models.PositiveBigIntegerField(default=0)
    version = models.PositiveIntegerField(default=0)
    auth_version = models.PositiveIntegerField(default=0)
    event_key = models.CharField(max_length=100)
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField(db_index=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['user', 'event_key'], name='notices_user_event_unique')]
        indexes = [models.Index(fields=['user', 'id'], name='notices_user_order')]
