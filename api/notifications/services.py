import secrets
from datetime import timedelta
from time import monotonic
from uuid import UUID

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.conf import settings
from django.core.cache import cache
from django.db import OperationalError, transaction
from django.db.models import CharField, Exists, F, Max, Min, OuterRef, Q
from django.db.models.functions import Cast
from django.utils import timezone
from rest_framework.exceptions import AuthenticationFailed, ValidationError

from chat.authentication import token_auth_version
from chat.models import Connection, Message, Usuario
from .authentication import authenticate_device, token_digest
from .models import Device, DeviceSocket, Event

_sweep_clock = 0


def user_group(user_id):
    return f'notices.user.{user_id}'


def device_group(device_id):
    return f'notices.device.{device_id}'


def group_event(group, event):
    layer = get_channel_layer()
    if layer:
        async_to_sync(layer.group_send)(group, event)


def parse_device_id(raw):
    try:
        if not isinstance(raw, str) or len(raw) != 36:
            raise ValueError
        value = UUID(raw)
        if str(value) != raw.lower():
            raise ValueError
        return value
    except (ValueError, TypeError):
        raise ValidationError({'deviceId': ['Identificador de dispositivo inválido.']}) from None


def register_device(user, token, data):
    if not isinstance(data, dict) or data.get('platform') != 'android':
        raise ValidationError({'platform': ['Selecciona un dispositivo Android.']})
    identifier = parse_device_id(data.get('deviceId'))
    try:
        added = cache.add(f'notices.register.{user.pk}', 1, timeout=60)
        count = 1 if added else cache.incr(f'notices.register.{user.pk}')
    except Exception:
        raise OperationalError('Notice registration storage unavailable.') from None
    if count > 30:
        raise ValidationError({'detail': 'Demasiados registros. Intenta nuevamente en un minuto.'})
    raw = 'ndv_' + secrets.token_urlsafe(32)
    now = timezone.now()
    with transaction.atomic():
        current = Usuario.objects.select_for_update().get(pk=user.pk)
        if not current.is_active or token is not None and token_auth_version(token) != current.auth_version:
            raise AuthenticationFailed('La sesión ya no está activa.')
        device = Device.objects.select_for_update().filter(user=current, device_id=identifier).first()
        active = Device.objects.filter(user=current, auth_version=current.auth_version,
                                       revoked_at__isnull=True, expires_at__gt=now)
        if (not device or not active.filter(pk=device.pk).exists()) and active.count() >= settings.NOTIFICATIONS_MAX_DEVICES:
            raise ValidationError({'detail': 'Alcanzaste el máximo de dispositivos de recepción.'})
        cursor = Event.objects.filter(user=current).aggregate(last=Max('pk'))['last'] or 0
        receive_since = now
        message_after_id = Message.objects.aggregate(last=Max('pk'))['last'] or 0
        if (device and device.revoked_at is None and device.expires_at > now
                and device.auth_version == current.auth_version):
            cursor = device.last_acked
            receive_since = device.receive_since
            message_after_id = device.message_after_id
        values = {'platform': 'android', 'token_digest': token_digest(raw), 'auth_version': current.auth_version,
                  'expires_at': now + timedelta(days=settings.NOTIFICATIONS_TOKEN_DAYS), 'revoked_at': None,
                  'last_acked': cursor, 'last_delivered': cursor, 'receive_since': receive_since,
                  'message_after_id': message_after_id}
        if device:
            Device.objects.filter(pk=device.pk).update(**values)
            DeviceSocket.objects.filter(device=device).delete()
            for name, value in values.items():
                setattr(device, name, value)
        else:
            device = Device.objects.create(user=current, device_id=identifier, **values)
        transaction.on_commit(lambda: group_event(device_group(device.pk), {'type': 'notification_recheck'}))
    return {'deviceId': str(identifier), 'deviceToken': raw, 'expiresAt': device.expires_at.isoformat()}


def revoke_device(user, identifier, bound_device=None, jwt_token=None):
    identifier = parse_device_id(identifier)
    query = Device.objects.filter(user=user, device_id=identifier)
    if bound_device is not None:
        query = query.filter(pk=bound_device.pk, token_digest=bound_device.token_digest)
    with transaction.atomic():
        current = Usuario.objects.select_for_update().get(pk=user.pk)
        if not current.is_active or jwt_token is not None and token_auth_version(jwt_token) != current.auth_version:
            raise AuthenticationFailed('La sesión ya no está activa.')
        device = query.select_for_update().first()
        if device:
            Device.objects.filter(pk=device.pk).update(revoked_at=timezone.now())
            DeviceSocket.objects.filter(device=device).delete()
            transaction.on_commit(lambda: group_event(device_group(device.pk), {'type': 'notification_recheck'}))


def revoke_user_devices(user_id, auth_version):
    Device.objects.filter(user_id=user_id).exclude(auth_version=auth_version).update(revoked_at=timezone.now())
    DeviceSocket.objects.filter(device__user_id=user_id).exclude(device__auth_version=auth_version).delete()
    # Reset also removes the revoked user's notice metadata, never messages/calls.
    Event.objects.filter(user_id=user_id).exclude(auth_version=auth_version).delete()
    group_event(user_group(user_id), {'type': 'auth_invalidated', 'authVersion': auth_version})


def _enqueue(user, connection, kind, object_id, *, revision=0, version=0):
    if not Device.objects.filter(user=user, auth_version=user.auth_version, revoked_at__isnull=True,
                                 expires_at__gt=timezone.now()).exists():
        return
    _event, created = Event.objects.get_or_create(
        user=user, event_key=f'{kind}:{object_id}:{revision}:{version}:{user.auth_version}',
        defaults={'connection': connection, 'kind': kind, 'object_id': str(object_id), 'revision': revision,
                  'version': version, 'auth_version': user.auth_version,
                  'expires_at': timezone.now() + timedelta(days=settings.NOTIFICATIONS_EVENT_DAYS)})
    if created:
        transaction.on_commit(lambda: group_event(user_group(user.pk), {'type': 'notification_available'}))


def enqueue_message_notice(message_id):
    message = Message.objects.select_related('connection__sender', 'connection__receiver', 'user').filter(pk=message_id).first()
    if not message:
        return
    connection = message.connection
    if not connection.accepted or message.pk <= connection.history_cleared_through:
        return
    recipient = connection.receiver if message.user_id == connection.sender_id else connection.sender
    if message.user_id not in (connection.sender_id, connection.receiver_id) or not recipient.is_active:
        return
    _enqueue(recipient, connection, 'message', message.pk, revision=connection.history_revision)


def enqueue_history_clear_notice(connection_id):
    connection = Connection.objects.select_related('sender', 'receiver').filter(pk=connection_id, accepted=True).first()
    if connection:
        for user in (connection.sender, connection.receiver):
            if user.is_active:
                _enqueue(user, connection, 'history.cleared', connection.pk, revision=connection.history_revision)


def enqueue_call_notice(call_id):
    from calls.models import Call
    call = Call.objects.select_related('caller', 'callee', 'connection').filter(pk=call_id).first()
    if call:
        for user in (call.caller, call.callee):
            if user.is_active:
                _enqueue(user, call.connection, 'call', call.pk, version=call.version)


def register_socket(channel_name, raw_token):
    with transaction.atomic():
        device = authenticate_device(raw_token)
        # A token rotation locks this same row before changing its digest and
        # removing old sockets. A stale heartbeat cannot recreate its presence.
        device = Device.objects.select_for_update(of=('self',)).select_related('user').filter(
            pk=device.pk, token_digest=token_digest(raw_token), revoked_at__isnull=True,
            expires_at__gt=timezone.now()).first()
        if not device or not device.user.is_active or device.auth_version != device.user.auth_version:
            raise AuthenticationFailed('La recepción de este dispositivo ya no está autorizada.')
        DeviceSocket.objects.update_or_create(channel_name=channel_name, defaults={
            'device': device, 'expires_at': timezone.now() + timedelta(seconds=settings.NOTIFICATIONS_PRESENCE_SECONDS)})
        return device


def drop_socket(channel_name):
    DeviceSocket.objects.filter(channel_name=channel_name).delete()


def native_receiver_online(user_id):
    now = timezone.now()
    return DeviceSocket.objects.filter(device__user_id=user_id, expires_at__gt=now,
        device__revoked_at__isnull=True, device__expires_at__gt=now, device__user__is_active=True,
        device__auth_version=F('device__user__auth_version')).exists()


def reconcile_events(device):
    # Recover a committed message/state even if its best-effort hook could not
    # write notices during a brief DB/cache outage. Only bounded IDs are read.
    start = Device.objects.filter(user=device.user, auth_version=device.auth_version,
        revoked_at__isnull=True, expires_at__gt=timezone.now()).aggregate(first=Min('receive_since'))['first']
    if start is None:
        return
    start = max(start, timezone.now() - timedelta(days=settings.NOTIFICATIONS_EVENT_DAYS))
    cutoff = Device.objects.filter(user=device.user, auth_version=device.auth_version,
        revoked_at__isnull=True, expires_at__gt=timezone.now()).aggregate(first=Min('message_after_id'))['first'] or 0
    existing = Event.objects.filter(user=device.user, auth_version=device.auth_version,
                                   kind='message', object_id=Cast(OuterRef('pk'), CharField()))
    messages = Message.objects.filter(
        Q(connection__sender=device.user) | Q(connection__receiver=device.user),
        connection__accepted=True, created__gte=start, is_new=True,
        pk__gt=F('connection__history_cleared_through')).filter(pk__gt=cutoff).exclude(user=device.user).annotate(
        noticed=Exists(existing)).filter(noticed=False).order_by('pk').values_list('pk', flat=True)[:100]
    for message_id in messages:
        enqueue_message_notice(message_id)
    from calls.models import Call
    calls = Call.objects.filter(Q(caller=device.user) | Q(callee=device.user),
        connection__accepted=True, expires_at__gt=timezone.now()).exclude(status='ended')
    for call_id in calls.values_list('pk', flat=True)[:2]:
        enqueue_call_notice(call_id)
    clears = Connection.objects.filter(Q(sender=device.user) | Q(receiver=device.user),
        accepted=True, history_cleared_at__gte=start).values_list('pk', flat=True)[:100]
    for connection_id in clears:
        enqueue_history_clear_notice(connection_id)


def _event_payload(event, device):
    user = device.user
    connection = event.connection
    if (not connection.accepted or not connection.sender.is_active or not connection.receiver.is_active
            or user.pk not in (connection.sender_id, connection.receiver_id)):
        return None
    base = {'id': str(event.pk), 'type': event.kind, 'connectionId': connection.pk,
            'revision': connection.history_revision}
    if event.kind == 'message':
        message = Message.objects.filter(pk=event.object_id, connection=connection, is_new=True,
                                          pk__gt=connection.history_cleared_through).exclude(user=user).first()
        if not message or event.revision != connection.history_revision:
            return None
        if message.created < device.receive_since or message.pk <= device.message_after_id:
            return None
        media = next((field for field in ('image', 'audio', 'video', 'document') if getattr(message, field)), 'text')
        return {**base, 'messageId': message.pk, 'mediaType': media, 'title': 'Nuevo mensaje'}
    if event.kind == 'history.cleared':
        if event.revision != connection.history_revision:
            return None
        return {**base, 'clearedThrough': connection.history_cleared_through,
                'clearedAt': connection.history_cleared_at.isoformat() if connection.history_cleared_at else None}
    if event.kind == 'call':
        from calls.models import Call
        call = Call.objects.filter(pk=event.object_id, connection=connection).filter(Q(caller=user) | Q(callee=user)).first()
        if not call or call.version != event.version or call.history_deleted:
            return None
        if call.status != 'ended' and call.expires_at <= timezone.now():
            return None
        incoming = call.callee_id == user.pk
        return {**base, 'callId': str(call.pk), 'kind': call.kind, 'status': call.status,
                'version': call.version, 'expiresAt': call.expires_at.isoformat(),
                'direction': 'incoming' if incoming else 'outgoing',
                'title': 'Llamada entrante' if incoming and call.status == 'ringing' else 'Estado de llamada'}
    return None


def event_batch(raw_token):
    device = authenticate_device(raw_token)
    reconcile_events(device)
    rows = list(Event.objects.select_related('connection__sender', 'connection__receiver').filter(
        user=device.user, auth_version=device.auth_version, pk__gt=device.last_acked).order_by('pk')[:101])
    visible_rows = rows[:100]
    events = [_event_payload(row, device) for row in visible_rows if row.expires_at > timezone.now()]
    events = [event for event in events if event is not None]
    cursor = visible_rows[-1].pk if visible_rows else device.last_acked
    # Delivery bookkeeping is per device and never changes Message.is_new.
    if cursor > device.last_delivered:
        Device.objects.filter(pk=device.pk, token_digest=device.token_digest,
                              last_delivered__lt=cursor).update(last_delivered=cursor)
    authenticate_device(raw_token)
    return {'type': 'notification.events', 'events': events, 'cursor': str(cursor), 'hasMore': len(rows) > 100}


def acknowledge(raw_token, cursor):
    if (not isinstance(cursor, str) or not cursor.isascii() or not cursor.isdigit()
            or len(cursor) > 19 or int(cursor) > 9223372036854775807):
        raise ValidationError('Cursor inválido.')
    value = int(cursor)
    with transaction.atomic():
        device = authenticate_device(raw_token)
        device = Device.objects.select_for_update(of=('self',)).select_related('user').get(pk=device.pk)
        if (device.token_digest != token_digest(raw_token) or device.revoked_at is not None
                or device.expires_at <= timezone.now() or not device.user.is_active
                or device.auth_version != device.user.auth_version):
            raise AuthenticationFailed('La recepción de este dispositivo ya no está autorizada.')
        if value > device.last_delivered:
            raise ValidationError('No se puede confirmar un aviso que no fue entregado.')
        if value > device.last_acked:
            Device.objects.filter(pk=device.pk, token_digest=device.token_digest).update(last_acked=value)
    return str(max(device.last_acked, value))


def _delete_retired_devices(candidate_ids, retention):
    with transaction.atomic():
        # Registration locks the same Device row. Recheck retirement after the
        # lock, so a phone reactivated after candidate selection is preserved.
        locked = list(Device.objects.select_for_update().filter(pk__in=candidate_ids)
                      .order_by('pk').values_list('pk', flat=True))
        Device.objects.filter(pk__in=locked).filter(
            Q(revoked_at__lte=retention) | Q(expires_at__lte=retention)).delete()


def sweep_expired(*, force=True):
    """Bounded notice/presence retention, called by the existing expiry worker."""
    global _sweep_clock
    clock = monotonic()
    if not force and clock - _sweep_clock < 60:
        return
    _sweep_clock = clock
    now = timezone.now()
    DeviceSocket.objects.filter(expires_at__lte=now).delete()
    old = list(Event.objects.filter(expires_at__lte=now).values_list('pk', flat=True)[:500])
    if old:
        Event.objects.filter(pk__in=old).delete()
    retention = now - timedelta(days=30)
    obsolete = list(Device.objects.filter(Q(revoked_at__lte=retention) | Q(expires_at__lte=retention))
                    .values_list('pk', flat=True)[:500])
    if obsolete:
        _delete_retired_devices(obsolete, retention)
