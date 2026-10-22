import uuid
import logging
from datetime import timedelta

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.conf import settings
from django.core import signing
from django.db import IntegrityError, OperationalError, transaction
from django.db.models import F, Q
from django.db.models.functions import Coalesce
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from chat.models import Connection, Usuario
from .models import BusyParticipant, Call, CallHistoryRevision, CallSocket

logger = logging.getLogger(__name__)


class CallError(Exception):
    def __init__(self, message, code='invalid', status=400):
        super().__init__(message)
        self.code, self.status = code, status


def parse_uuid(value, label='Identificador'):
    try:
        if not isinstance(value, (str, uuid.UUID)):
            raise ValueError
        return uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        raise CallError(f'{label} inválido.') from None


def group_name(user_id):
    return f'calls.user.{user_id}'


def payload(call):
    def person(user):
        return {'id': user.pk, 'username': user.username, 'name': user.get_full_name() or user.username}
    return {
        'id': str(call.pk), 'clientId': str(call.client_id), 'kind': call.kind, 'status': call.status,
        'caller': person(call.caller), 'callee': person(call.callee),
        'connectionId': call.connection_id, 'callerDeviceId': str(call.caller_device_id),
        'acceptedDeviceId': str(call.accepted_device_id) if call.accepted_device_id else None,
        'reason': call.reason, 'version': call.version,
        'expiresAt': call.expires_at.isoformat(),
        'activeAt': call.connected_at.isoformat() if call.connected_at else None,
        'endedAt': call.ended_at.isoformat() if call.ended_at else None,
        'durationSeconds': duration_seconds(call),
    }


def duration_seconds(call):
    if not call.connected_at:
        return 0
    end = call.ended_at if call.status == 'ended' else timezone.now()
    if end is None:
        return 0
    return max(0, int((end - call.connected_at).total_seconds()))


def history_payload(call, user):
    result = 'failed'
    if call.connected_at or (call.caller_connected and call.callee_connected):
        result = 'answered'
    elif call.reason in ('missed', 'rejected', 'cancelled'):
        result = call.reason
    lifecycle = payload(call)
    # History contains no device identifiers, idempotency IDs, SDP or ICE.
    allowed = ('id', 'kind', 'caller', 'callee', 'connectionId', 'status', 'reason', 'activeAt', 'endedAt', 'durationSeconds')
    row = {field: lifecycle[field] for field in allowed}
    row.update({
        'direction': 'outgoing' if call.caller_id == user.pk else 'incoming',
        'peer': lifecycle['callee'] if call.caller_id == user.pk else lifecycle['caller'],
        'result': result,
        'createdAt': call.created_at.isoformat(),
    })
    return row


def call_history(user, *, limit='50', cursor=None):
    if not isinstance(limit, (str, int)) or isinstance(limit, bool) or not str(limit).isascii() or not str(limit).isdigit() or len(str(limit)) > 2 or not 1 <= int(limit) <= 50:
        raise CallError('El tamaño del historial debe estar entre 1 y 50.', 'invalid_limit')
    limit = int(limit)
    expire_calls()
    with transaction.atomic():
        # A shared delete locks every affected user in sorted order. A page
        # needs only its own user, so its revision and rows form one snapshot.
        list(Usuario.objects.select_for_update().filter(pk=user.pk))
        revision = current_history_revision(user.pk)
        return history_page(user, limit, cursor, revision)


def current_history_revision(user_id):
    return CallHistoryRevision.objects.filter(user_id=user_id).values_list('revision', flat=True).first() or 0


def history_page(user, limit, cursor, revision):
    calls = Call.objects.filter(status='ended', history_deleted=False).filter(Q(caller=user) | Q(callee=user)).select_related('caller', 'callee').annotate(
        history_at=Coalesce('ended_at', 'created_at'),
    )
    if cursor is not None:
        try:
            if not isinstance(cursor, str) or not cursor or len(cursor) > 2048:
                raise ValueError
            data = signing.loads(cursor, salt='calls.history.v2', max_age=86400)
            if not isinstance(data, dict) or set(data) != {'version', 'user', 'at', 'id', 'revision'} or data['version'] != 2 or data['user'] != user.pk or data['revision'] != revision:
                raise ValueError
            at = parse_datetime(data['at']) if isinstance(data['at'], str) else None
            if at is None or timezone.is_naive(at):
                raise ValueError
            call_id = parse_uuid(data['id'])
        except (signing.BadSignature, ValueError, TypeError, OverflowError, CallError):
            raise CallError('El cursor del historial es inválido o venció. Abre el historial de nuevo.', 'invalid_cursor') from None
        calls = calls.filter(Q(history_at__lt=at) | Q(history_at=at, pk__lt=call_id))
    rows = list(calls.order_by('-history_at', '-pk')[:limit + 1])
    visible = rows[:limit]
    next_cursor = None
    if len(rows) > limit:
        last = visible[-1]
        next_cursor = signing.dumps({'version': 2, 'user': user.pk, 'revision': revision, 'at': last.history_at.isoformat(), 'id': str(last.pk)}, salt='calls.history.v2', compress=True)
    return {'results': [history_payload(call, user) for call in visible], 'nextCursor': next_cursor, 'revision': revision}


def delete_call_history(user, call_id=None):
    participants = Q(caller=user) | Q(callee=user)
    selected = Call.objects.filter(participants)
    if call_id is not None:
        selected = selected.filter(pk=parse_uuid(call_id))
        call = selected.first()
        if call is None:
            raise CallError('No se encontró esta llamada.', 'not_found', 404)
        if call.status != 'ended':
            raise CallError('Termina la llamada antes de borrar su historial.', 'state', 409)
    selected = selected.filter(status='ended', history_deleted=False)
    # Capture exact terminal IDs before acquiring locks: a call that ends while
    # this request waits must remain in history as a newer entry.
    entries = list(selected.values_list('pk', 'caller_id', 'callee_id'))
    user_ids = sorted({user.pk} | {participant for _id, caller, callee in entries for participant in (caller, callee)})
    with transaction.atomic():
        list(Usuario.objects.select_for_update().filter(pk__in=user_ids).order_by('pk'))
        ids = [entry[0] for entry in entries]
        entries = list(Call.objects.select_for_update().filter(pk__in=ids, status='ended', history_deleted=False).values_list('pk', 'caller_id', 'callee_id'))
        ids = [entry[0] for entry in entries]
        if not ids:
            return {'deletedCount': 0, 'callIds': [] if call_id is not None else None,
                    'revision': current_history_revision(user.pk)}
        Call.objects.filter(pk__in=ids, status='ended').update(history_deleted=True)
        affected = sorted({participant for _id, caller, callee in entries for participant in (caller, callee)})
        revisions = {}
        for user_id in affected:
            CallHistoryRevision.objects.get_or_create(user_id=user_id)
            CallHistoryRevision.objects.filter(user_id=user_id).update(revision=F('revision') + 1)
            revisions[user_id] = current_history_revision(user_id)
        call_ids = [str(call_id)] if call_id is not None else None

        def announce():
            layer = get_channel_layer()
            if layer:
                for user_id in affected:
                    try:
                        async_to_sync(layer.group_send)(group_name(user_id), {
                            'type': 'call.history_cleared', 'callIds': call_ids,
                            'revision': revisions[user_id],
                        })
                    except Exception as error:
                        logger.warning('No se pudo sincronizar el borrado del historial (%s).', type(error).__name__)
        transaction.on_commit(announce)
        return {'deletedCount': len(ids), 'callIds': call_ids, 'revision': revisions[user.pk]}


def publish(call):
    event = {'type': 'call.state', 'call': payload(call)}
    recipients = (call.caller_id, call.callee_id)

    def send():
        try:
            from notifications.services import enqueue_call_notice
            enqueue_call_notice(call.pk)
        except Exception:
            logger.warning('No se pudo preparar un aviso de llamada.')
        layer = get_channel_layer()
        for user_id in recipients:
            try:
                if layer:
                    async_to_sync(layer.group_send)(group_name(user_id), event)
            except Exception:
                logger.warning('No se pudo sincronizar el estado de la llamada.')
    transaction.on_commit(send)


def lock_users(caller_id, callee_id):
    # Consistent ordering prevents PostgreSQL deadlocks for crossed invitations.
    list(Usuario.objects.select_for_update().filter(pk__in=[caller_id, callee_id]).order_by('pk'))


def finish(call, reason):
    if call.status == 'ended':
        return call
    call.status, call.reason, call.ended_at = 'ended', reason, timezone.now()
    call.version += 1
    call.save(update_fields=['status', 'reason', 'ended_at', 'version'])
    BusyParticipant.objects.filter(call=call).delete()
    publish(call)
    return call


def terminate_revoked_calls(user_id, call_ids):
    """End only calls captured for the recovered account before revocation."""
    for call_id in call_ids:
        initial = Call.objects.filter(pk=call_id).filter(Q(caller_id=user_id) | Q(callee_id=user_id)).first()
        if initial is None:
            continue
        with transaction.atomic():
            lock_users(initial.caller_id, initial.callee_id)
            call = Call.objects.select_for_update().select_related('caller', 'callee').get(pk=initial.pk)
            if call.status != 'ended':
                finish(call, 'session_revoked')


def expire_calls():
    now = timezone.now()
    ids = list(Call.objects.filter(expires_at__lte=now).exclude(status='ended').values_list('pk', flat=True))
    count = 0
    for call_id in ids:
        initial = Call.objects.filter(pk=call_id).first()
        if not initial:
            continue
        with transaction.atomic():
            lock_users(initial.caller_id, initial.callee_id)
            call = Call.objects.select_for_update().select_related('caller', 'callee').get(pk=call_id)
            if call.status != 'ended' and call.expires_at <= timezone.now():
                reason = 'missed' if call.status == 'ringing' else 'connection_timeout' if call.status == 'connecting' else 'disconnected'
                finish(call, reason)
                count += 1
    CallSocket.objects.filter(expires_at__lte=now).delete()
    return count


def checked_relationship(call):
    valid = Connection.objects.filter(pk=call.connection_id, accepted=True).filter(
        Q(sender_id=call.caller_id, receiver_id=call.callee_id) | Q(sender_id=call.callee_id, receiver_id=call.caller_id)
    ).exists()
    if not valid or not Usuario.objects.filter(pk__in=[call.caller_id, call.callee_id], is_active=True).count() == 2:
        raise CallError('Esta conversación ya no permite llamadas.', 'unavailable', 403)


def create_call(user, data):
    if not isinstance(data, dict):
        raise CallError('Datos de llamada inválidos.')
    client_id = parse_uuid(data.get('clientId'), 'Identificador del intento')
    device_id = parse_uuid(data.get('deviceId'), 'Identificador del dispositivo')
    kind = data.get('kind')
    if kind not in ('audio', 'video'):
        raise CallError('Selecciona una llamada de audio o video.')
    connection_id = data.get('connectionId')
    if (isinstance(connection_id, bool) or not isinstance(connection_id, (int, str))
            or len(str(connection_id)) > 19 or not str(connection_id).isascii() or not str(connection_id).isdigit()
            or not 0 < int(connection_id) <= 9223372036854775807):
        raise CallError('Conversación inválida.')
    connection_id = int(connection_id)
    expire_calls()
    connection = Connection.objects.select_related('sender', 'receiver').filter(pk=connection_id, accepted=True).filter(Q(sender=user) | Q(receiver=user)).first()
    if not connection:
        raise CallError('No puedes llamar desde esta conversación.', 'forbidden', 403)
    other = connection.receiver if connection.sender_id == user.pk else connection.sender
    if other.pk == user.pk or not user.is_active or not other.is_active:
        raise CallError('El contacto no está disponible.', 'unavailable', 403)
    try:
        with transaction.atomic():
            lock_users(user.pk, other.pk)
            existing = Call.objects.select_related('caller', 'callee').filter(caller=user, client_id=client_id).first()
            if existing:
                if existing.connection_id != connection.pk or existing.kind != kind or existing.caller_device_id != device_id:
                    raise CallError('El intento ya corresponde a otra llamada.', 'conflict', 409)
                return existing
            if BusyParticipant.objects.filter(user_id__in=[user.pk, other.pk]).exists():
                raise CallError('Tú o tu contacto ya tienen una llamada.', 'busy', 409)
            from notifications.services import native_receiver_online
            if (not CallSocket.objects.filter(user=other, expires_at__gt=timezone.now()).exists()
                    and not native_receiver_online(other.pk)):
                raise CallError('El contacto debe estar conectado para recibir llamadas.', 'offline', 409)
            call = Call.objects.create(connection=connection, caller=user, callee=other, kind=kind,
                                       client_id=client_id, caller_device_id=device_id,
                                       expires_at=timezone.now() + timedelta(seconds=settings.CALLS_RING_SECONDS))
            BusyParticipant.objects.bulk_create([BusyParticipant(user=user, call=call), BusyParticipant(user=other, call=call)])
            publish(call)
            return call
    except IntegrityError:
        existing = Call.objects.select_related('caller', 'callee').filter(caller=user, client_id=client_id).first()
        if existing and existing.connection_id == connection.pk and existing.kind == kind and existing.caller_device_id == device_id:
            return existing
        raise CallError('Tú o tu contacto ya tienen una llamada.', 'busy', 409) from None
    except OperationalError:
        raise CallError('Intenta llamar nuevamente en unos segundos.', 'retry', 503) from None


def owned_call(user, call_id):
    call_id = parse_uuid(call_id, 'Identificador de llamada')
    call = Call.objects.select_related('caller', 'callee').filter(pk=call_id).filter(Q(caller=user) | Q(callee=user)).first()
    if not call:
        raise CallError('Llamada no encontrada.', 'not_found', 404)
    if call.status != 'ended':
        try:
            checked_relationship(call)
        except CallError:
            # Commit release independently before returning the authorization error.
            with transaction.atomic():
                lock_users(call.caller_id, call.callee_id)
                locked = Call.objects.select_for_update().select_related('caller', 'callee').get(pk=call.pk)
                finish(locked, 'unavailable')
            raise
    return call


def device_role(call, user, device_id, *, allow_unaccepted=False):
    device_id = parse_uuid(device_id, 'Identificador del dispositivo')
    if user.pk == call.caller_id:
        if call.caller_device_id != device_id:
            raise CallError('La llamada pertenece a otro dispositivo.', 'device', 409)
        return 'caller'
    if user.pk != call.callee_id:
        raise CallError('No participas en esta llamada.', 'forbidden', 403)
    if call.accepted_device_id and call.accepted_device_id != device_id:
        raise CallError('La llamada se aceptó en otro dispositivo.', 'device', 409)
    if not allow_unaccepted and call.accepted_device_id is None:
        raise CallError('Primero acepta la llamada.', 'state', 409)
    return 'callee'


def current_call(user):
    expire_calls()
    call = Call.objects.select_related('caller', 'callee').filter(Q(caller=user) | Q(callee=user)).exclude(status='ended').first()
    if call and (not call.connection.accepted or not call.caller.is_active or not call.callee.is_active):
        with transaction.atomic():
            lock_users(call.caller_id, call.callee_id)
            call = Call.objects.select_for_update().select_related('caller', 'callee').get(pk=call.pk)
            finish(call, 'unavailable')
        return None
    return call


def act(user, call_id, action, device_id):
    if action not in ('accept', 'reject', 'cancel', 'end'):
        raise CallError('Acción de llamada inválida.')
    expire_calls()
    initial = owned_call(user, call_id)
    with transaction.atomic():
        lock_users(initial.caller_id, initial.callee_id)
        call = Call.objects.select_for_update().select_related('caller', 'callee').get(pk=initial.pk)
        role = device_role(call, user, device_id, allow_unaccepted=True)
        if action in ('accept', 'reject') and role != 'callee' or action == 'cancel' and role != 'caller':
            raise CallError('No puedes realizar esta acción.', 'forbidden', 403)
        if call.status == 'ended':
            return call
        if action == 'accept':
            checked_relationship(call)
            if call.status in ('connecting', 'active'):
                return call
            call.status = 'connecting'
            call.accepted_device_id = parse_uuid(device_id)
            now = timezone.now()
            call.caller_seen = call.callee_seen = now
            call.expires_at = now + timedelta(seconds=settings.CALLS_CONNECT_SECONDS)
            call.version += 1
            call.save(update_fields=['status', 'accepted_device_id', 'expires_at', 'caller_seen', 'callee_seen', 'version'])
            publish(call)
            return call
        if action in ('cancel', 'reject') and call.status != 'ringing':
            raise CallError('La llamada ya se respondió; utiliza colgar.', 'state', 409)
        return finish(call, {'cancel': 'cancelled', 'reject': 'rejected', 'end': 'ended'}[action])


def utf8_length(value):
    try:
        return len(value.encode('utf-8'))
    except UnicodeError:
        raise CallError('La señal contiene texto inválido.') from None


def validate_signal(signal):
    if not isinstance(signal, dict) or signal.get('type') not in ('offer', 'answer', 'candidate', 'media'):
        raise CallError('Señal de llamada inválida.')
    kind = signal['type']
    if kind == 'media':
        if set(signal) != {'type', 'videoEnabled'} or not isinstance(signal.get('videoEnabled'), bool):
            raise CallError('El estado de video es inválido.')
        return {'type': kind, 'videoEnabled': signal['videoEnabled']}
    if kind in ('offer', 'answer'):
        sdp = signal.get('sdp')
        if set(signal) != {'type', 'sdp'} or not isinstance(sdp, str) or not sdp.startswith('v=0') or utf8_length(sdp) > 65536:
            raise CallError('Descripción de llamada inválida.')
        return {'type': kind, 'sdp': sdp}
    candidate = signal.get('candidate')
    if set(signal) != {'type', 'candidate'}:
        raise CallError('Candidato de conexión inválido.')
    if candidate is None:
        return {'type': kind, 'candidate': None}
    if not isinstance(candidate, dict) or set(candidate) - {'candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment'}:
        raise CallError('Candidato de conexión inválido.')
    raw = candidate.get('candidate')
    if not isinstance(raw, str) or utf8_length(raw) > 4096 or (raw and not raw.startswith('candidate:')):
        raise CallError('Candidato de conexión inválido.')
    mid, index, fragment = candidate.get('sdpMid'), candidate.get('sdpMLineIndex'), candidate.get('usernameFragment')
    if mid is not None and (not isinstance(mid, str) or len(mid) > 256):
        raise CallError('Identificador de pista inválido.')
    if index is not None and (isinstance(index, bool) or not isinstance(index, int) or not 0 <= index <= 64):
        raise CallError('Índice de pista inválido.')
    if fragment is not None and (not isinstance(fragment, str) or len(fragment) > 256):
        raise CallError('Candidato de conexión inválido.')
    return {'type': kind, 'candidate': candidate}


def signal_call(user, call_id, device_id, signal):
    signal = validate_signal(signal)
    expire_calls()
    initial = owned_call(user, call_id)
    with transaction.atomic():
        lock_users(initial.caller_id, initial.callee_id)
        call = Call.objects.select_for_update().select_related('caller', 'callee').get(pk=initial.pk)
        role = device_role(call, user, device_id)
        if call.status not in ('connecting', 'active'):
            raise CallError('La llamada no está conectándose.', 'state', 409)
        checked_relationship(call)
        kind = signal['type']
        if kind == 'media' and call.kind != 'video':
            raise CallError('Esta llamada no tiene video.', 'state', 409)
        if kind == 'offer':
            if role != 'caller' or call.status != 'connecting' or call.answer_sent:
                raise CallError('No puedes enviar esta oferta.', 'state', 409)
            call.offer_sent = True
            call.save(update_fields=['offer_sent'])
        elif kind == 'answer':
            if role != 'callee' or call.status != 'connecting' or not call.offer_sent:
                raise CallError('No puedes enviar esta respuesta.', 'state', 409)
            call.answer_sent = True
            call.save(update_fields=['answer_sent'])
        # ICE may be emitted by the native engine before its offer promise resolves.
        recipient = call.callee_id if role == 'caller' else call.caller_id
        target_device = call.accepted_device_id if role == 'caller' else call.caller_device_id
        event = {'type': 'call.signal', 'callId': str(call.pk), 'signal': signal, 'targetDeviceId': str(target_device)}
        transaction.on_commit(lambda: async_to_sync(get_channel_layer().group_send)(group_name(recipient), event))
        return call


def update_live_call(user, call_id, device_id, *, connected=False):
    expire_calls()
    initial = owned_call(user, call_id)
    with transaction.atomic():
        lock_users(initial.caller_id, initial.callee_id)
        call = Call.objects.select_for_update().select_related('caller', 'callee').get(pk=initial.pk)
        role = device_role(call, user, device_id)
        if call.status not in ('connecting', 'active'):
            raise CallError('La llamada ya no está activa.', 'state', 409)
        checked_relationship(call)
        now = timezone.now()
        setattr(call, f'{role}_seen', now)
        if connected:
            if not call.offer_sent or not call.answer_sent:
                raise CallError('Aún falta negociar la llamada.', 'state', 409)
            setattr(call, f'{role}_connected', True)
        newly_active = call.status == 'connecting' and call.caller_connected and call.callee_connected
        if newly_active:
            call.status = 'active'
            if call.connected_at is None:
                call.connected_at = now
            call.version += 1
        if call.status == 'active':
            call.expires_at = min(call.caller_seen, call.callee_seen) + timedelta(seconds=settings.CALLS_ACTIVE_SECONDS)
        call.save(update_fields=['caller_seen', 'callee_seen', 'caller_connected', 'callee_connected', 'status', 'expires_at', 'version', 'connected_at'])
        if newly_active:
            publish(call)
        return call


def end_from_socket(user, call_id, device_id):
    call = owned_call(user, call_id)
    action = 'end'
    if call.status == 'ringing':
        action = 'cancel' if user.pk == call.caller_id else 'reject'
    return act(user, call_id, action, device_id)
