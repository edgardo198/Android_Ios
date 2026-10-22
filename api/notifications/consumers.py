import asyncio
import json
import time

from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer
from django.db import OperationalError
from django.utils import timezone
from rest_framework.exceptions import AuthenticationFailed, ValidationError

from .authentication import authenticate_device
from .services import acknowledge, device_group, drop_socket, event_batch, register_socket, user_group


class DeviceConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.poll_task = None
        self.groups_joined = []
        self.last_cursor = None
        self.awaiting_ack = False
        self.rate_start, self.rate_count = time.monotonic(), 0
        # Native-only header credential. Never accept token/query-string URLs.
        headers = [value for name, value in self.scope.get('headers', []) if name.lower() == b'authorization']
        if self.scope.get('query_string') or len(headers) != 1:
            await self.close(code=4401)
            return
        try:
            header = headers[0].decode('ascii').split()
            if len(header) != 2 or header[0].lower() != 'bearer':
                raise AuthenticationFailed()
            self.raw_token = header[1]
            self.device = await database_sync_to_async(register_socket)(self.channel_name, self.raw_token)
        except (AuthenticationFailed, UnicodeError):
            await self.close(code=4401)
            return
        self.auth_version = self.device.auth_version
        for group in (user_group(self.device.user_id), device_group(self.device.pk)):
            await self.channel_layer.group_add(group, self.channel_name)
            self.groups_joined.append(group)
        await self.accept()
        await self.send_json({'type': 'notification.ready', 'deviceId': str(self.device.device_id),
                              'expiresAt': self.device.expires_at.isoformat(), 'heartbeatSeconds': 15,
                              'serverTime': timezone.now().isoformat()})
        try:
            if not await self.deliver_batch(force=True):
                return
        except AuthenticationFailed:
            await self.revoke()
            return
        except OperationalError:
            # The ready credential remains usable; the next poll retries.
            pass
        self.poll_task = asyncio.create_task(self.poll_loop())

    async def send_json(self, data):
        await self.send(text_data=json.dumps(data))

    async def revoke(self):
        await self.send_json({'type': 'notification.revoked'})
        await self.close(code=4401)

    async def guard(self):
        try:
            self.device = await database_sync_to_async(authenticate_device)(self.raw_token)
            return True
        except AuthenticationFailed:
            await self.revoke()
            return False

    async def deliver_batch(self, *, force=False):
        if not await self.guard():
            return False
        batch = await database_sync_to_async(event_batch)(self.raw_token)
        if force or batch['cursor'] != self.last_cursor:
            await self.send_json(batch)
            self.last_cursor = batch['cursor']
            self.awaiting_ack = bool(batch['events']) or batch['cursor'] != str(self.device.last_acked)
        return True

    async def poll_loop(self):
        while True:
            await asyncio.sleep(5)
            try:
                if not await self.deliver_batch():
                    return
            except OperationalError:
                continue
            except AuthenticationFailed:
                await self.revoke()
                return

    async def disconnect(self, code):
        if self.poll_task:
            self.poll_task.cancel()
            try:
                await self.poll_task
            except asyncio.CancelledError:
                pass
        for group in self.groups_joined:
            await self.channel_layer.group_discard(group, self.channel_name)
        await database_sync_to_async(drop_socket)(self.channel_name)

    async def receive(self, text_data=None, bytes_data=None):
        if not isinstance(text_data, str) or len(text_data.encode('utf-8', errors='replace')) > 1024:
            await self.close(code=4400)
            return
        now = time.monotonic()
        if now - self.rate_start >= 10:
            self.rate_start, self.rate_count = now, 0
        self.rate_count += 1
        if self.rate_count > 40:
            await self.close(code=4429)
            return
        try:
            if not await self.guard():
                return
            data = json.loads(text_data)
            if not isinstance(data, dict):
                raise ValueError
            if data == {'type': 'notification.ping'}:
                self.device = await database_sync_to_async(register_socket)(self.channel_name, self.raw_token)
                await self.send_json({'type': 'notification.pong'})
                await self.deliver_batch()
            elif set(data) == {'type', 'cursor'} and data['type'] == 'notification.ack':
                cursor = await database_sync_to_async(acknowledge)(self.raw_token, data['cursor'])
                self.awaiting_ack = False
                await self.send_json({'type': 'notification.acked', 'cursor': cursor})
                await self.deliver_batch()
            else:
                raise ValueError
        except AuthenticationFailed:
            await self.revoke()
        except (ValueError, RecursionError, ValidationError):
            await self.send_json({'type': 'notification.error', 'code': 'invalid', 'detail': 'Aviso o cursor inválido.'})
        except OperationalError:
            await self.send_json({'type': 'notification.error', 'code': 'busy', 'detail': 'Intenta nuevamente.'})

    async def notification_available(self, event):
        try:
            await self.deliver_batch()
        except OperationalError:
            pass
        except AuthenticationFailed:
            await self.revoke()

    async def notification_recheck(self, event):
        await self.guard()

    async def auth_invalidated(self, event):
        version = event.get('authVersion')
        if type(version) is int and version > self.auth_version:
            await self.revoke()
