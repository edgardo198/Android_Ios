"""Authenticate WebSocket connections with the same access tokens as HTTP."""

from urllib.parse import parse_qs

from channels.db import database_sync_to_async
from channels.security.websocket import AllowedHostsOriginValidator
from django.contrib.auth.models import AnonymousUser
from rest_framework.exceptions import AuthenticationFailed
from rest_framework_simplejwt.exceptions import InvalidToken
from .authentication import VersionedJWTAuthentication, token_auth_version


class JWTAuthMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        scope = dict(scope)
        scope['user'] = AnonymousUser()
        try:
            tokens = parse_qs(scope.get('query_string', b'').decode('utf-8')).get('token', [])
            if len(tokens) == 1:
                scope['user'], scope['auth_version'] = await self.authenticate(tokens[0])
        except (UnicodeDecodeError, AuthenticationFailed, InvalidToken, ValueError, TypeError, OverflowError):
            # Invalid credentials remain anonymous and are rejected by the consumer.
            # Never log tokens from the query string.
            pass
        return await self.app(scope, receive, send)

    @database_sync_to_async
    def authenticate(self, raw_token):
        authentication = VersionedJWTAuthentication()
        token = authentication.get_validated_token(raw_token)
        return authentication.get_user(token), token_auth_version(token)


class NativeAllowedHostsOriginValidator:
    """Validate browser origins while accepting native clients without Origin."""

    def __init__(self, app):
        self.app = app
        self.browser_app = AllowedHostsOriginValidator(app)

    async def __call__(self, scope, receive, send):
        has_origin = any(name.lower() == b'origin' for name, _value in scope.get('headers', []))
        app = self.browser_app if has_origin else self.app
        return await app(scope, receive, send)
