"""Ephemeral ordering metadata only: draft text never enters this cache or DB."""
from contextlib import contextmanager
from threading import RLock
from time import time, time_ns
from uuid import uuid4

from django.core.cache import caches
from django.core.cache.backends.redis import RedisCache
from django.db.models import Q

from .models import Connection, Usuario

DRAFT_MAX_CHARACTERS = 500
DRAFT_MAX_BYTES = 2000
TYPING_FRAME_MAX_BYTES = 8192
METADATA_TTL_SECONDS = 15
COUNTER_TTL_SECONDS = 86400
RATE_WINDOW_SECONDS = 10
RATE_WINDOW_LIMIT = 50
MAX_SEQUENCE = 2 ** 53 - 1
_locks = tuple(RLock() for _ in range(64))


def route_key(user_id, connection_id):
    return f'chat.typing.{user_id}.{connection_id}'


@contextmanager
def _route_lock(backend, key):
    # LocMem is supported within one API process. Redis serializes metadata
    # updates between API workers; the atomic counter remains separate.
    if isinstance(backend, RedisCache):
        lock = backend._cache.get_client(key, write=True).lock(
            backend.make_key(f'{key}.lock'), timeout=2, blocking_timeout=0.2)
        acquired = lock.acquire(blocking=True)
        try:
            yield acquired
        finally:
            if acquired:
                lock.release()
    else:
        with _locks[hash(key) % len(_locks)]:
            yield True


def start_allowed(user_id):
    """Shared fixed window; STOP/setting changes never consume this budget."""
    backend = caches['default']
    window = int(time()) // RATE_WINDOW_SECONDS
    key = f'chat.typing.rate.{user_id}.{window}'
    try:
        if backend.add(key, 1, timeout=RATE_WINDOW_SECONDS + 1):
            return True
        return backend.incr(key) <= RATE_WINDOW_LIMIT
    except Exception:
        return False


def valid_draft(value):
    if value is None:
        return True
    if not isinstance(value, str) or len(value) > DRAFT_MAX_CHARACTERS:
        return False
    try:
        return len(value.encode('utf-8')) <= DRAFT_MAX_BYTES
    except UnicodeEncodeError:
        return False


def latest_metadata(user_id, connection_id):
    try:
        result = caches['default'].get(f'{route_key(user_id, connection_id)}.state')
        return result if isinstance(result, dict) else None
    except Exception:
        return None


def record_event(user, connection, *, stream_id, is_typing, expires_at,
                 only_current_stream=False, require_existing=False, settings_change=False):
    """Return metadata for an event, never accepting draft content as an argument."""
    backend = caches['default']
    key = route_key(user.pk, connection.pk)
    try:
        with _route_lock(backend, key) as acquired:
            if not acquired:
                return None
            previous = backend.get(f'{key}.state')
            if isinstance(previous, dict):
                # A previously validated writer cannot replace a newer epoch.
                if (previous['draftRevision'] > user.typing_draft_revision
                        or previous['historyRevision'] > connection.history_revision
                        or previous['authVersion'] > user.auth_version):
                    return None
                if only_current_stream and previous['streamId'] != stream_id:
                    return None
                if settings_change:
                    stream_id = previous['streamId']
                if (not is_typing and not settings_change and not previous['isTyping']
                        and previous['streamId'] == stream_id
                        and previous['draftRevision'] == user.typing_draft_revision
                        and previous['historyRevision'] == connection.history_revision):
                    return None
            elif require_existing:
                return None
            # UTC microseconds keep sequences increasing after cache expiry or
            # restart. Redis/LocMem incr is atomic, independent of latest state.
            backend.add(f'{key}.counter', time_ns() // 1000, timeout=COUNTER_TTL_SECONDS)
            sequence = backend.incr(f'{key}.counter')
            if type(sequence) is not int or sequence <= 0 or sequence > MAX_SEQUENCE:
                return None
            backend.touch(f'{key}.counter', timeout=COUNTER_TTL_SECONDS)
            metadata = {'sequence': sequence, 'streamId': stream_id, 'isTyping': is_typing,
                        'draftRevision': user.typing_draft_revision,
                        'historyRevision': connection.history_revision,
                        'authVersion': user.auth_version, 'expiresAt': expires_at}
            backend.set(f'{key}.state', metadata, timeout=METADATA_TTL_SECONDS)
            return metadata
    except Exception:
        # Cache failure must never bypass opt-in or order checks.
        return None


def metadata_is_current(user, connection, data):
    key = route_key(user.pk, connection.pk)
    try:
        backend = caches['default']
        current = backend.get(f'{key}.state')
        counter = backend.get(f'{key}.counter')
        return (isinstance(current, dict)
                and type(data.get('sequence')) is int and 0 < data['sequence'] <= MAX_SEQUENCE
                and isinstance(data.get('streamId'), str) and len(data['streamId']) <= 64
                and type(data.get('draftRevision')) is int
                and current['sequence'] == counter == data['sequence']
                and current['streamId'] == data['streamId']
                and current['isTyping'] == data['isTyping']
                and current['expiresAt'] == data['expiresAt']
                and current['historyRevision'] == connection.history_revision == data['revision']
                and current['draftRevision'] == user.typing_draft_revision == data['draftRevision']
                and current['authVersion'] == user.auth_version)
    except Exception:
        return False


def event_payload(user, connection, metadata, *, draft=None):
    return {'connectionId': connection.pk, 'username': user.username,
            'isTyping': metadata['isTyping'], 'revision': connection.history_revision,
            'expiresAt': metadata['expiresAt'], 'draft': draft,
            'draftRevision': metadata['draftRevision'],
            'sequence': metadata['sequence'], 'streamId': metadata['streamId']}


def notify_live_typing_settings(user_id):
    # Import lazily: serializers are imported by chat.services.
    from .services import send_group
    user = Usuario.objects.filter(pk=user_id, is_active=True).first()
    if user is None:
        return
    send_group(user.username, 'typing.settings',
               {'liveTypingEnabled': user.typing_draft_enabled,
                'liveTypingRevision': user.typing_draft_revision})
    # Only metadata is enumerated. Disabling or changing the epoch clears all
    # contacts, including another sender device's currently displayed draft.
    connections = Connection.objects.select_related('sender', 'receiver').filter(
        Q(sender_id=user_id) | Q(receiver_id=user_id), accepted=True)
    for connection in connections:
        peer = connection.receiver if connection.sender_id == user_id else connection.sender
        if not peer.is_active:
            continue
        metadata = record_event(user, connection, stream_id=str(uuid4()), is_typing=False,
                                expires_at=None, settings_change=True)
        if metadata:
            send_group(peer.username, 'message.type', event_payload(user, connection, metadata))
