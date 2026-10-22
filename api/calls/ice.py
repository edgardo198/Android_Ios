"""Own STUN/TURN endpoints with short-lived coturn REST credentials."""
import base64
import hashlib
import hmac
import time

from django.conf import settings


def ice_servers(user):
    servers = []
    if settings.CALLS_STUN_URLS:
        servers.append({'urls': settings.CALLS_STUN_URLS})
    if settings.CALLS_TURN_URLS and settings.CALLS_TURN_SECRET:
        username = f'{int(time.time()) + settings.CALLS_TURN_TTL_SECONDS}:{user.pk}'
        credential = base64.b64encode(hmac.new(settings.CALLS_TURN_SECRET.encode(), username.encode(), hashlib.sha1).digest()).decode()
        servers.append({'urls': settings.CALLS_TURN_URLS, 'username': username, 'credential': credential})
    return servers
