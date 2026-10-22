"""Bounded asynchronous delivery; no tokens or recipient addresses in logs."""
import ipaddress
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlencode, urlparse

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.conf import settings
from django.contrib.auth import password_validation
from django.contrib.auth.tokens import default_token_generator
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.core.mail import EmailMessage
from django.core.validators import validate_email
from django.db import close_old_connections, transaction
from django.db.models import Q
from django.utils.crypto import salted_hmac
from django.utils.encoding import force_bytes
from django.utils.http import urlsafe_base64_decode, urlsafe_base64_encode
from rest_framework.exceptions import ValidationError as ApiValidationError

from .models import Usuario, email_users
from .serializers import translate_password_errors
from .services import user_group_name

logger = logging.getLogger(__name__)
REQUEST_DETAIL = 'Si existe una cuenta activa con ese correo, recibirás instrucciones para recuperar la contraseña.'
INVALID_DETAIL = 'El enlace venció o no es válido. Solicita uno nuevo.'
UNAVAILABLE_DETAIL = 'La recuperación de contraseña no está disponible. Intenta más tarde.'
CONFIRM_DETAIL = 'Contraseña actualizada. Inicia sesión nuevamente.'
# Each process has at most two SMTP workers and fourteen queued deliveries.
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix='password-recovery')
_capacity = threading.BoundedSemaphore(16)


def recovery_configuration_ready():
    try:
        url = urlparse(settings.PASSWORD_RESET_URL)
        url.port
        native_reset = (url.scheme == 'chatlocal' and url.hostname == 'reset-password'
                        and url.path in {'', '/'} and url.port is None)
        if ((url.scheme not in {'http', 'https'} and not native_reset) or not url.hostname or url.username is not None
                or url.password is not None or any(character in settings.PASSWORD_RESET_URL for character in ('?', '#', '\\'))
                or any(character.isspace() for character in settings.PASSWORD_RESET_URL)
                or (not settings.DEBUG and url.scheme == 'http')):
            return False
        app_url = getattr(settings, 'PASSWORD_RESET_APP_URL', 'chatlocal://reset-password')
        if app_url and app_url != 'chatlocal://reset-password':
            return False
        validate_email(settings.DEFAULT_FROM_EMAIL)
        backend = settings.EMAIL_BACKEND
        if backend == 'django.core.mail.backends.smtp.EmailBackend':
            if settings.EMAIL_HOST.lower() == 'smtp.gmail.com' and (not settings.EMAIL_HOST_USER
                    or not settings.EMAIL_HOST_PASSWORD or not (settings.EMAIL_USE_TLS or settings.EMAIL_USE_SSL)):
                return False
            return (bool(settings.EMAIL_HOST) and settings.EMAIL_TIMEOUT is not None
                    and bool(settings.EMAIL_HOST_USER) == bool(settings.EMAIL_HOST_PASSWORD)
                    and not (settings.EMAIL_USE_TLS and settings.EMAIL_USE_SSL))
        if backend == 'django.core.mail.backends.console.EmailBackend':
            return settings.DEBUG and bool(getattr(settings, 'MAIL_DEV_CONSOLE', False))
        # In-memory/test transports are explicit and forbidden in production.
        return settings.DEBUG and backend == 'django.core.mail.backends.locmem.EmailBackend'
    except (ValueError, TypeError, AttributeError, ValidationError):
        return False


def requester_ip(request):
    value = request.META.get('REMOTE_ADDR', '')
    # Proxies are never trusted implicitly; spoofed X-Forwarded-For cannot evade
    # the default limit. Deployment may explicitly select its trusted hop count.
    proxies = getattr(settings, 'PASSWORD_RESET_TRUSTED_PROXY_COUNT', 0)
    if type(proxies) is int and proxies > 0:
        forwarded = request.META.get('HTTP_X_FORWARDED_FOR', '')
        if isinstance(forwarded, str) and len(forwarded) <= 2048:
            addresses = [item.strip() for item in forwarded.split(',')]
            if len(addresses) >= proxies:
                value = addresses[-proxies]
    try:
        return str(ipaddress.ip_address(value))
    except (ValueError, TypeError):
        return 'unknown'


def rate_key(kind, value):
    # Recipient/IP values and reset codes never become cache keys in plain text.
    return 'password-reset:' + kind + ':' + salted_hmac('chat.password-reset.rate', value, algorithm='sha256').hexdigest()


def _consume_limit(key, limit, window):
    if cache.add(key, 1, timeout=window):
        return True
    try:
        return cache.incr(key) <= limit
    except ValueError:
        # Expiry between add and incr: retry exactly once with atomic add.
        return cache.add(key, 1, timeout=window)


def request_allowed(request, email):
    window = settings.PASSWORD_RESET_RATE_WINDOW_SECONDS
    if not _consume_limit(rate_key('request-ip', requester_ip(request)), settings.PASSWORD_RESET_REQUEST_IP_LIMIT, window):
        return False
    if not _consume_limit(rate_key('request-email', email), settings.PASSWORD_RESET_REQUEST_EMAIL_LIMIT, window):
        return False
    return cache.add(rate_key('request-cooldown', email), 1, timeout=settings.PASSWORD_RESET_REQUEST_COOLDOWN_SECONDS)


def confirm_allowed(request):
    return _consume_limit(rate_key('confirm-ip', requester_ip(request)), settings.PASSWORD_RESET_CONFIRM_IP_LIMIT,
                          settings.PASSWORD_RESET_RATE_WINDOW_SECONDS)


def deliver_password_reset(email):
    close_old_connections()
    try:
        # A legacy duplicated address must never choose an arbitrary account.
        matches = email_users(email)
        if len(matches) != 1 or not matches[0].is_active or not matches[0].has_usable_password():
            return
        user = matches[0]
        uid = urlsafe_base64_encode(force_bytes(user.pk))
        token = default_token_generator.make_token(user)
        link = settings.PASSWORD_RESET_URL + '?' + urlencode({'uid': uid, 'token': token})
        app_url = getattr(settings, 'PASSWORD_RESET_APP_URL', 'chatlocal://reset-password')
        app_link = app_url + '?' + urlencode({'uid': uid, 'token': token}) if app_url else ''
        app_line = f'Abrir en la aplicación:\n{app_link}\n\n' if app_link and app_link != link else ''
        minutes = settings.PASSWORD_RESET_TIMEOUT // 60
        body = (f'Se solicitó recuperar la contraseña de tu cuenta Mensajeria.\n\n'
                f'Abre este enlace (válido durante {minutes} minutos):\n{link}\n\n'
                f'{app_line}'
                f'También puedes copiar este código en la aplicación:\n{uid}:{token}\n\n'
                'Si no solicitaste este cambio, ignora este correo. Tu contraseña seguirá igual.\n')
        sent = EmailMessage('Recuperar contraseña de Mensajeria', body, settings.DEFAULT_FROM_EMAIL, [email]).send(fail_silently=False)
        if sent != 1:
            logger.warning('password_reset_delivery_failed')
    except Exception:
        # No traceback: SMTP/database exceptions can include addresses or links.
        logger.warning('password_reset_delivery_failed')
    finally:
        close_old_connections()


def queue_password_reset(email):
    if not _capacity.acquire(blocking=False):
        return False

    def run():
        try:
            deliver_password_reset(email)
        finally:
            _capacity.release()

    def submit():
        try:
            _executor.submit(run)
        except Exception:
            _capacity.release()
            logger.warning('password_reset_queue_unavailable')

    # Request views run under Django autocommit; this also prevents a transaction
    # caller from delivering a link before its account changes become durable.
    transaction.on_commit(submit)
    return True


def notify_auth_invalidated(user_id, username, version):
    try:
        from notifications.services import revoke_user_devices
        revoke_user_devices(user_id, version)
    except Exception:
        logger.warning('password_reset_device_notification_failed')
    channel_layer = get_channel_layer()
    if channel_layer is None:
        return
    from calls.services import group_name
    event = {'type': 'auth_invalidated', 'authVersion': version}
    try:
        for group in (user_group_name(username), group_name(user_id)):
            async_to_sync(channel_layer.group_send)(group, event)
    except Exception:
        # Database version checks still revoke access if the event transport fails.
        logger.warning('password_reset_session_notification_failed')


def reset_password(uid, token, password):
    try:
        decoded = urlsafe_base64_decode(uid).decode('ascii')
        if not decoded.isascii() or not decoded.isdigit() or not 0 < int(decoded) <= 9223372036854775807:
            return None
        user_id = int(decoded)
    except (ValueError, UnicodeError, OverflowError):
        return None
    with transaction.atomic():
        user = Usuario.objects.select_for_update().filter(pk=user_id, is_active=True).first()
        if user is None or not user.has_usable_password() or not default_token_generator.check_token(user, token):
            return None
        try:
            password_validation.validate_password(password, user)
        except ValidationError as error:
            raise ApiValidationError({'password': translate_password_errors(error.messages)}) from None
        old_password, old_version = user.password, user.auth_version
        from calls.models import Call
        from calls.services import terminate_revoked_calls
        call_ids = list(Call.objects.filter(Q(caller_id=user.pk) | Q(callee_id=user.pk)).exclude(status='ended').values_list('pk', flat=True))
        user.set_password(password)
        user.auth_version += 1
        # select_for_update serializes PostgreSQL. The conditional write prevents
        # a second successful use on engines where that lock is not available.
        changed = Usuario.objects.filter(pk=user.pk, is_active=True, password=old_password,
                                         auth_version=old_version, email=user.email).update(
                                             password=user.password, auth_version=user.auth_version)
        if changed != 1:
            return None
        password_validation.password_changed(password, user)
        def committed():
            try:
                terminate_revoked_calls(user.pk, call_ids)
            except Exception:
                logger.warning('password_reset_call_cleanup_failed')
            finally:
                notify_auth_invalidated(user.pk, user.username, user.auth_version)
        transaction.on_commit(committed)
        return user
