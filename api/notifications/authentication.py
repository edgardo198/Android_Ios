import hashlib
import re

from django.utils import timezone
from rest_framework.authentication import BaseAuthentication, get_authorization_header
from rest_framework.exceptions import AuthenticationFailed

from .models import Device

TOKEN_PATTERN = re.compile(r'^ndv_[A-Za-z0-9_-]{43}$')


def token_digest(raw):
    return hashlib.sha256(raw.encode('ascii')).hexdigest()


def authenticate_device(raw):
    if not isinstance(raw, str) or not TOKEN_PATTERN.fullmatch(raw):
        raise AuthenticationFailed('La recepción de este dispositivo ya no está autorizada.')
    device = Device.objects.select_related('user').filter(token_digest=token_digest(raw), revoked_at__isnull=True,
                                                        expires_at__gt=timezone.now()).first()
    if not device or not device.user.is_active or device.auth_version != device.user.auth_version:
        raise AuthenticationFailed('La recepción de este dispositivo ya no está autorizada.')
    return device


class DeviceAuthentication(BaseAuthentication):
    # This class is used ONLY by device deletion. It cannot access chat, files,
    # calls/actions, account information or mint/refresh JWTs.
    def authenticate(self, request):
        header = get_authorization_header(request).split()
        if len(header) != 2 or header[0].lower() != b'bearer' or not header[1].startswith(b'ndv_'):
            return None
        try:
            device = authenticate_device(header[1].decode('ascii'))
        except UnicodeError:
            raise AuthenticationFailed('Credencial de dispositivo inválida.') from None
        return device.user, device

    def authenticate_header(self, request):
        return 'Bearer'
