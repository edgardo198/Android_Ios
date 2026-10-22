import asyncio
import json
import time
from datetime import datetime, timedelta, timezone as datetime_timezone
from urllib.parse import parse_qs

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer
from django.conf import settings
from django.db import OperationalError
from django.utils import timezone
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import AccessToken
from rest_framework.exceptions import AuthenticationFailed

from chat.models import Usuario
from chat.authentication import VersionedJWTAuthentication, token_auth_version
from .ice import ice_servers
from .models import CallSocket
from .services import CallError, current_call, end_from_socket, expire_calls, group_name, parse_uuid, payload, signal_call, update_live_call


@database_sync_to_async
def register_socket(channel_name, user, device_id):
    if not Usuario.objects.filter(pk=user.pk, is_active=True).exists():
        raise CallError('La sesión ya no está activa.', 'auth', 401)
    CallSocket.objects.update_or_create(channel_name=channel_name, defaults={
        'user': user, 'device_id': device_id,
        'expires_at': timezone.now() + timedelta(seconds=settings.CALLS_PRESENCE_SECONDS),
    })


@database_sync_to_async
def unregister_socket(channel_name):
    CallSocket.objects.filter(channel_name=channel_name).delete()


@database_sync_to_async
def snapshot(user):
    if not Usuario.objects.filter(pk=user.pk, is_active=True).exists():
        raise CallError('La sesión ya no está activa.', 'auth', 401)
    call = current_call(user)
    return {'type': 'call.current', 'call': payload(call) if call else None, 'iceServers': ice_servers(user)}


def auth_payload(token):
    return {'type': 'call.authenticated', 'accessExpiresAt': datetime.fromtimestamp(token['exp'], tz=datetime_timezone.utc).isoformat()}


@database_sync_to_async
def renew_access_token(raw_token, expected_user_id, expected_version=None):
    if not isinstance(raw_token, str) or not raw_token or len(raw_token) > 8192:
        raise CallError('No se pudo renovar la sesión de llamada.', 'auth', 401)
    try:
        token = AccessToken(raw_token)
        user = VersionedJWTAuthentication().get_user(token)
        if user.pk != expected_user_id or not user.is_active:
            raise CallError('La sesión pertenece a otra cuenta.', 'auth', 401)
        if expected_version is not None and user.auth_version != expected_version:
            raise CallError('La sesión anterior fue cerrada.', 'auth', 401)
        return user, auth_payload(token)
    except (TokenError, AuthenticationFailed):
        raise CallError('La sesión de llamada venció o no es válida.', 'auth', 401) from None


class CallConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.expiry_task = None
        self.user_group = None
        self.window_start, self.window_count = time.monotonic(), 0
        user = self.scope.get('user')
        if not user or not user.is_authenticated or not user.is_active:
            await self.close(code=4401)
            return
        try:
            query = parse_qs(self.scope.get('query_string', b'').decode())
            devices = query.get('deviceId', [])
            self.device_id = parse_uuid(devices[0] if len(devices) == 1 else None, 'Dispositivo')
            tokens = query.get('token', [])
            if len(tokens) != 1:
                raise CallError('Sesión inválida.', 'auth', 401)
            self.access_token = tokens[0]
            access = AccessToken(self.access_token)
        except (CallError, UnicodeError):
            await self.close(code=4400)
            return
        except TokenError:
            await self.close(code=4401)
            return
        try:
            user, _authenticated = await renew_access_token(self.access_token, user.pk)
            self.scope['user'] = user
        except CallError:
            await self.close(code=4401)
            return
        self.user_group = group_name(user.pk)
        self.auth_version = token_auth_version(access)
        await self.channel_layer.group_add(self.user_group, self.channel_name)
        try:
            await register_socket(self.channel_name, user, self.device_id)
            current = await snapshot(user)
        except CallError:
            await self.close(code=4401)
            return
        await self.accept()
        await self.send(text_data=json.dumps(current))
        await self.send(text_data=json.dumps(auth_payload(access)))
        self.expiry_task = asyncio.create_task(self.expiry_loop())

    async def expiry_loop(self):
        while True:
            await asyncio.sleep(5)
            try:
                await renew_access_token(self.access_token, self.scope['user'].pk, self.auth_version)
                # The standalone expiry worker has a separate InMemory layer.
                # Polling persisted state also delivers its terminal transitions.
                await self.send(text_data=json.dumps(await snapshot(self.scope['user'])))
            except (TokenError, CallError):
                await self.close(code=4401)
                return
            except OperationalError:
                # An SQLite writer can hold a brief lock; the next sweep retries.
                continue

    async def disconnect(self, close_code):
        if self.expiry_task:
            self.expiry_task.cancel()
            try:
                await self.expiry_task
            except asyncio.CancelledError:
                pass
        if self.user_group:
            await self.channel_layer.group_discard(self.user_group, self.channel_name)
            await unregister_socket(self.channel_name)

    async def receive(self, text_data=None, bytes_data=None):
        call_id = None
        try:
            if not isinstance(text_data, str) or len(text_data.encode()) > 98304:
                raise CallError('El mensaje de llamada excede el límite.')
            now = time.monotonic()
            if now - self.window_start >= 10:
                self.window_start, self.window_count = now, 0
            self.window_count += 1
            if self.window_count > 80:
                raise CallError('Demasiadas señales; espera unos segundos.', 'rate_limit', 429)
            try:
                data = json.loads(text_data)
            except (ValueError, RecursionError):
                raise CallError('Mensaje JSON inválido.') from None
            if not isinstance(data, dict):
                raise CallError('Mensaje de llamada inválido.')
            call_id = data.get('callId') if isinstance(data.get('callId'), str) and len(data['callId']) <= 36 else None
            message_type = data.get('type')
            if message_type == 'call.auth':
                try:
                    if set(data) != {'type', 'token', 'deviceId'} or parse_uuid(data.get('deviceId')) != self.device_id:
                        raise CallError('Dispositivo inválido.', 'auth', 401)
                except CallError:
                    raise CallError('No se pudo renovar la sesión de este dispositivo.', 'auth', 401) from None
                user, authenticated = await renew_access_token(data.get('token'), self.scope['user'].pk, self.auth_version)
                self.access_token = data['token']
                self.scope['user'] = user
                await register_socket(self.channel_name, user, self.device_id)
                await self.send(text_data=json.dumps(authenticated))
                return
            try:
                self.scope['user'], _authenticated = await renew_access_token(self.access_token, self.scope['user'].pk, self.auth_version)
            except CallError:
                # Preserve the previous expiry close code while account/version
                # failures additionally explain that the session was revoked.
                AccessToken(self.access_token)
                raise
            if message_type == 'call.ping':
                await register_socket(self.channel_name, self.scope['user'], self.device_id)
                await self.send(text_data=json.dumps({'type': 'call.pong'}))
                return
            device_id = parse_uuid(data.get('deviceId'), 'Dispositivo')
            if device_id != self.device_id:
                raise CallError('La señal pertenece a otro dispositivo.', 'device', 409)
            if message_type == 'call.signal':
                await database_sync_to_async(signal_call)(self.scope['user'], call_id, device_id, data.get('signal'))
            elif message_type in ('call.connected', 'call.heartbeat'):
                await database_sync_to_async(update_live_call)(self.scope['user'], call_id, device_id, connected=message_type == 'call.connected')
            elif message_type == 'call.end':
                await database_sync_to_async(end_from_socket)(self.scope['user'], call_id, device_id)
            else:
                raise CallError('Acción de llamada no reconocida.')
        except CallError as error:
            if error.code == 'auth':
                current_version = await database_sync_to_async(Usuario.objects.filter(pk=self.scope['user'].pk).values_list('auth_version', flat=True).first)()
                if current_version is not None and current_version > self.auth_version:
                    await self.auth_invalidated({'authVersion': current_version})
                    return
            await self.send(text_data=json.dumps({'type': 'call.error', 'callId': call_id, 'code': error.code, 'message': str(error)}))
            if error.code == 'auth':
                await self.close(code=4401)
        except TokenError:
            await self.close(code=4401)
        except OperationalError:
            await self.send(text_data=json.dumps({'type': 'call.error', 'callId': call_id, 'code': 'retry', 'message': 'Intenta nuevamente en unos segundos.'}))

    async def call_state(self, event):
        if not await self.session_is_current():
            return
        await self.send(text_data=json.dumps({'type': 'call.state', 'call': event['call']}))

    async def call_signal(self, event):
        if not await self.session_is_current():
            return
        if event.get('targetDeviceId') == str(self.device_id):
            await self.send(text_data=json.dumps({'type': 'call.signal', 'callId': event['callId'], 'signal': event['signal']}))

    async def call_history_cleared(self, event):
        if not await self.session_is_current():
            return
        await self.send(text_data=json.dumps({'type': 'call.history.cleared',
                                             'callIds': event['callIds'], 'revision': event['revision']}))

    async def session_is_current(self):
        try:
            await renew_access_token(self.access_token, self.scope['user'].pk, self.auth_version)
            return True
        except CallError:
            current = await database_sync_to_async(Usuario.objects.filter(pk=self.scope['user'].pk).values_list('auth_version', flat=True).first)()
            if current is not None and current > self.auth_version:
                await self.send(text_data=json.dumps({'type': 'auth.invalidated', 'authVersion': current}))
            await self.close(code=4401)
            return False

    async def auth_invalidated(self, event):
        version = event.get('authVersion')
        if type(version) is int and version > self.auth_version:
            await self.send(text_data=json.dumps({'type': 'auth.invalidated', 'authVersion': version}))
            await self.close(code=4401)
