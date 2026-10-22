import uuid

from django.conf import settings
from django.db import models


class Call(models.Model):
    """Call lifecycle only. SDP, ICE, tokens and media are never persisted."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    connection = models.ForeignKey('chat.Connection', on_delete=models.CASCADE)
    caller = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='outgoing_calls')
    callee = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='incoming_calls')
    client_id = models.UUIDField()
    caller_device_id = models.UUIDField()
    accepted_device_id = models.UUIDField(null=True, blank=True)
    kind = models.CharField(max_length=5, choices=[('audio', 'Audio'), ('video', 'Video')])
    status = models.CharField(max_length=10, default='ringing', choices=[(s, s) for s in ('ringing', 'connecting', 'active', 'ended')])
    reason = models.CharField(max_length=24, blank=True)
    version = models.PositiveIntegerField(default=1)
    offer_sent = models.BooleanField(default=False)
    answer_sent = models.BooleanField(default=False)
    caller_connected = models.BooleanField(default=False)
    callee_connected = models.BooleanField(default=False)
    caller_seen = models.DateTimeField(null=True, blank=True)
    callee_seen = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField(db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    connected_at = models.DateTimeField(null=True, blank=True)
    ended_at = models.DateTimeField(null=True, blank=True)
    history_deleted = models.BooleanField(default=False, db_index=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['caller', 'client_id'], name='calls_caller_client_unique')]


class BusyParticipant(models.Model):
    # Database uniqueness arbitrates simultaneous/crossed invitations even on SQLite.
    user = models.OneToOneField(settings.AUTH_USER_MODEL, primary_key=True, on_delete=models.CASCADE)
    call = models.ForeignKey(Call, on_delete=models.CASCADE, related_name='busy_participants')


class CallSocket(models.Model):
    channel_name = models.CharField(max_length=100, primary_key=True)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    device_id = models.UUIDField()
    expires_at = models.DateTimeField(db_index=True)


class CallHistoryRevision(models.Model):
    user = models.OneToOneField(settings.AUTH_USER_MODEL, primary_key=True, on_delete=models.CASCADE)
    revision = models.PositiveBigIntegerField(default=0)
