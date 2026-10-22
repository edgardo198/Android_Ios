import json
from datetime import timedelta
from unittest.mock import patch
from uuid import uuid4

from asgiref.sync import async_to_sync
from channels.db import database_sync_to_async
from channels.layers import get_channel_layer
from channels.routing import URLRouter
from channels.testing import WebsocketCommunicator
from django.core.cache import cache
from django.test import TestCase, TransactionTestCase, override_settings
from django.utils import timezone
from rest_framework.exceptions import AuthenticationFailed, ValidationError
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from calls.models import BusyParticipant, Call
from calls.services import act, create_call, expire_calls
from chat.models import Connection, Message, Usuario
from chat.services import broadcast_message, clear_connection_history, send_push_notification
from .authentication import authenticate_device, token_digest
from .models import Device, DeviceSocket, Event
from .routing import websocket_urlpatterns
from .services import (acknowledge, enqueue_call_notice, enqueue_message_notice, event_batch,
                       native_receiver_online, register_device, register_socket, revoke_device,
                       revoke_user_devices, sweep_expired, user_group)
from . import services as notice_services

FIXTURE_SETTINGS = {
    'SECRET_KEY': 'native-notice-tests-only-2026-not-a-deployment-secret',
    'PASSWORD_HASHERS': ['django.contrib.auth.hashers.MD5PasswordHasher'],
    'CACHES': {'default': {'BACKEND': 'django.core.cache.backends.locmem.LocMemCache',
                           'LOCATION': 'notice-tests-isolated'}},
    'CHANNEL_LAYERS': {'default': {'BACKEND': 'channels.layers.InMemoryChannelLayer'}},
    'NOTIFICATIONS_TOKEN_DAYS': 30,
    'NOTIFICATIONS_EVENT_DAYS': 7,
    'NOTIFICATIONS_MAX_DEVICES': 5,
}


class NoticeFixtures:
    def setUp(self):
        super().setUp()
        cache.clear()
        self.alice = Usuario.objects.create_user(username='notice_alice', password='Synthetic!Password-2026')
        self.bob = Usuario.objects.create_user(username='notice_bob', password='Synthetic!Password-2026')
        self.eve = Usuario.objects.create_user(username='notice_eve', password='Synthetic!Password-2026')
        self.connection = Connection.objects.create(sender=self.alice, receiver=self.bob, accepted=True)
        self.other = Connection.objects.create(sender=self.alice, receiver=self.eve, accepted=True)
        self.client = APIClient()

    def register(self, user=None, identifier=None):
        user = user or self.bob
        return register_device(user, None, {'deviceId': str(identifier or uuid4()), 'platform': 'android'})

    def message(self, **kwargs):
        return Message.objects.create(connection=self.connection, user=self.alice,
                                      text='SYNTHETIC_CONTENT_MUST_NOT_BECOME_NOTICE', **kwargs)

    def call(self, **kwargs):
        return Call.objects.create(connection=self.connection, caller=self.alice, callee=self.bob,
            client_id=uuid4(), caller_device_id=uuid4(), kind='audio',
            expires_at=timezone.now() + timedelta(seconds=30), **kwargs)

    def auth(self, user):
        access = RefreshToken.for_user(user).access_token
        access['auth_version'] = user.auth_version
        self.client.credentials(HTTP_AUTHORIZATION='Bearer ' + str(access))
        return str(access)


@override_settings(**FIXTURE_SETTINGS)
class NoticeSecurityTests(NoticeFixtures, TestCase):
    def test_register_requires_current_jwt_and_returns_only_hashed_scoped_secret(self):
        data = {'deviceId': str(uuid4()), 'platform': 'android'}
        self.assertEqual(self.client.post('/notifications/devices/', data, format='json').status_code, 401)
        self.auth(self.bob)
        response = self.client.post('/notifications/devices/', data, format='json')
        self.assertEqual(response.status_code, 201)
        raw = response.data['deviceToken']
        self.assertTrue(raw.startswith('ndv_'))
        self.assertEqual(len(raw), 47)
        self.assertEqual(response['Cache-Control'], 'no-store')
        device = Device.objects.get(user=self.bob)
        self.assertEqual(device.token_digest, token_digest(raw))
        self.assertNotIn(raw, repr(device.__dict__))
        self.assertEqual(set(response.data), {'deviceId', 'deviceToken', 'expiresAt'})
        self.client.credentials(HTTP_AUTHORIZATION='Bearer ' + raw)
        for url in ('/chat/me/', '/calls/current/', '/notifications/devices/'):
            request = self.client.post(url, data, format='json') if url.endswith('devices/') else self.client.get(url)
            self.assertEqual(request.status_code, 401)

    def test_registration_validates_platform_id_and_bounds_device_count(self):
        self.auth(self.bob)
        for identifier in ('', 'bad', True, {}, str(uuid4()).replace('-', '')):
            response = self.client.post('/notifications/devices/', {'deviceId': identifier, 'platform': 'android'}, format='json')
            self.assertEqual(response.status_code, 400)
        for platform in ('web', 'ios', None, 1):
            self.assertEqual(self.client.post('/notifications/devices/', {'deviceId': str(uuid4()),
                                               'platform': platform}, format='json').status_code, 400)
        for _index in range(5):
            self.register()
        with self.assertRaises(ValidationError):
            self.register()
        self.assertEqual(Device.objects.filter(user=self.bob).count(), 5)

    def test_same_installation_identifier_is_isolated_between_accounts(self):
        identifier = uuid4()
        bob, eve = self.register(identifier=identifier), self.register(self.eve, identifier)
        self.assertNotEqual(bob['deviceToken'], eve['deviceToken'])
        self.assertEqual(authenticate_device(bob['deviceToken']).user_id, self.bob.pk)
        self.assertEqual(authenticate_device(eve['deviceToken']).user_id, self.eve.pk)

    def test_rotation_invalidates_previous_secret_and_preserves_unacked_ledger(self):
        registration = self.register()
        message = self.message()
        enqueue_message_notice(message.pk)
        first = event_batch(registration['deviceToken'])
        rotated = self.register(identifier=registration['deviceId'])
        with self.assertRaises(AuthenticationFailed):
            authenticate_device(registration['deviceToken'])
        new_batch = event_batch(rotated['deviceToken'])
        self.assertEqual(new_batch['events'], first['events'])
        self.assertNotEqual(registration['deviceToken'], rotated['deviceToken'])

    def test_stale_heartbeat_cannot_recreate_presence_after_token_rotation(self):
        registration = self.register()
        stale = authenticate_device(registration['deviceToken'])
        rotated = self.register(identifier=registration['deviceId'])
        with patch('notifications.services.authenticate_device', return_value=stale):
            with self.assertRaises(AuthenticationFailed):
                register_socket('stale.heartbeat', registration['deviceToken'])
        self.assertFalse(DeviceSocket.objects.exists())
        authenticate_device(rotated['deviceToken'])

    def test_ack_revalidates_rotated_token_after_locked_row_read(self):
        registration = self.register()
        enqueue_message_notice(self.message().pk)
        batch = event_batch(registration['deviceToken'])
        stale = authenticate_device(registration['deviceToken'])
        rotated = self.register(identifier=registration['deviceId'])
        with patch('notifications.services.authenticate_device', return_value=stale):
            with self.assertRaises(AuthenticationFailed):
                acknowledge(registration['deviceToken'], batch['cursor'])
        self.assertEqual(authenticate_device(rotated['deviceToken']).last_acked, 0)

    def test_device_bearer_can_revoke_only_itself_and_jwt_cannot_revoke_other_user(self):
        first, second = self.register(), self.register()
        self.client.credentials(HTTP_AUTHORIZATION='Bearer ' + first['deviceToken'])
        self.assertEqual(self.client.delete('/notifications/devices/' + second['deviceId'] + '/').status_code, 204)
        self.assertEqual(authenticate_device(second['deviceToken']).user_id, self.bob.pk)
        self.auth(self.eve)
        self.assertEqual(self.client.delete('/notifications/devices/' + first['deviceId'] + '/').status_code, 204)
        authenticate_device(first['deviceToken'])
        self.client.credentials(HTTP_AUTHORIZATION='Bearer ' + first['deviceToken'])
        self.assertEqual(self.client.delete('/notifications/devices/' + first['deviceId'] + '/').status_code, 204)
        with self.assertRaises(AuthenticationFailed):
            authenticate_device(first['deviceToken'])

    def test_expired_inactive_and_auth_version_revoked_credentials_are_rejected(self):
        for condition in ('expired', 'inactive', 'version'):
            with self.subTest(condition=condition):
                registration = self.register()
                if condition == 'expired':
                    Device.objects.filter(token_digest=token_digest(registration['deviceToken'])).update(expires_at=timezone.now())
                elif condition == 'inactive':
                    Usuario.objects.filter(pk=self.bob.pk).update(is_active=False)
                else:
                    Usuario.objects.filter(pk=self.bob.pk).update(auth_version=1)
                with self.assertRaises(AuthenticationFailed):
                    event_batch(registration['deviceToken'])
                Usuario.objects.filter(pk=self.bob.pk).update(is_active=True, auth_version=0)

    def test_multi_device_ack_is_separate_and_does_not_read_or_duplicate_messages(self):
        first, second, eve = self.register(), self.register(), self.register(self.eve)
        message = self.message()
        enqueue_message_notice(message.pk)
        enqueue_message_notice(message.pk)
        self.assertEqual(Event.objects.filter(kind='message').count(), 1)
        one, two = event_batch(first['deviceToken']), event_batch(second['deviceToken'])
        self.assertEqual(one['events'], two['events'])
        self.assertEqual(event_batch(eve['deviceToken'])['events'], [])
        self.assertEqual(acknowledge(first['deviceToken'], one['cursor']), one['cursor'])
        self.assertEqual(event_batch(first['deviceToken'])['events'], [])
        self.assertEqual(event_batch(second['deviceToken'])['events'], two['events'])
        message.refresh_from_db()
        self.assertTrue(message.is_new)
        self.assertEqual(Message.objects.count(), 1)

    def test_notice_payload_has_only_metadata_and_no_text_draft_credentials_or_media_url(self):
        registration = self.register()
        message = self.message(audio='messages/audio/synthetic.m4a')
        enqueue_message_notice(message.pk)
        row = event_batch(registration['deviceToken'])['events'][0]
        self.assertEqual(set(row), {'id', 'type', 'connectionId', 'revision', 'messageId', 'mediaType', 'title'})
        self.assertEqual((row['type'], row['mediaType'], row['title']), ('message', 'audio', 'Nuevo mensaje'))
        payload = json.dumps(row)
        self.assertNotIn(message.text, payload)
        self.assertNotIn('synthetic.m4a', payload)
        self.assertNotIn(registration['deviceToken'], payload)
        self.assertNotIn(message.text, repr(Event.objects.get().__dict__))

    def test_ack_rejects_undelivered_foreign_or_invalid_cursor_and_is_idempotent(self):
        registration = self.register()
        message = self.message()
        enqueue_message_notice(message.pk)
        event_id = Event.objects.get().pk
        with self.assertRaises(ValidationError):
            acknowledge(registration['deviceToken'], str(event_id))
        batch = event_batch(registration['deviceToken'])
        for cursor in ('-1', 'x', '', 1, True, '9' * 30, str(int(batch['cursor']) + 1)):
            with self.assertRaises(ValidationError):
                acknowledge(registration['deviceToken'], cursor)
        for _index in range(2):
            self.assertEqual(acknowledge(registration['deviceToken'], batch['cursor']), batch['cursor'])
        self.assertEqual(acknowledge(registration['deviceToken'], '0'), batch['cursor'])

    def test_message_clear_read_relationship_revocation_and_inactive_peer_filter_at_delivery(self):
        for condition in ('clear', 'read', 'unaccepted', 'inactive'):
            with self.subTest(condition=condition):
                registration = self.register()
                message = self.message()
                enqueue_message_notice(message.pk)
                if condition == 'clear':
                    Connection.objects.filter(pk=self.connection.pk).update(history_cleared_through=message.pk, history_revision=1)
                elif condition == 'read':
                    Message.objects.filter(pk=message.pk).update(is_new=False)
                elif condition == 'unaccepted':
                    Connection.objects.filter(pk=self.connection.pk).update(accepted=False)
                else:
                    Usuario.objects.filter(pk=self.alice.pk).update(is_active=False)
                self.assertEqual(event_batch(registration['deviceToken'])['events'], [])
                Message.objects.all().delete()
                Event.objects.all().delete()
                Device.objects.all().delete()
                Connection.objects.filter(pk=self.connection.pk).update(accepted=True, history_revision=0, history_cleared_through=0)
                Usuario.objects.filter(pk=self.alice.pk).update(is_active=True)

    def test_shared_history_clear_emits_metadata_to_both_devices_without_physical_message_delete(self):
        alice, bob = self.register(self.alice), self.register()
        message = self.message()
        enqueue_message_notice(message.pk)
        with self.captureOnCommitCallbacks(execute=True):
            clear_connection_history(self.alice, self.connection.pk)
        for registration in (alice, bob):
            events = event_batch(registration['deviceToken'])['events']
            self.assertEqual(len(events), 1)
            self.assertEqual((events[0]['type'], events[0]['revision'], events[0]['clearedThrough']),
                             ('history.cleared', 1, message.pk))
        self.assertTrue(Message.objects.filter(pk=message.pk).exists())

    def test_reconnect_reconciles_saved_message_when_notification_hook_was_unavailable(self):
        registration = self.register()
        message = self.message()
        self.assertFalse(Event.objects.exists())
        batch = event_batch(registration['deviceToken'])
        self.assertEqual(batch['events'][0]['messageId'], message.pk)
        self.assertEqual(Event.objects.count(), 1)

    def test_new_device_does_not_receive_old_unread_messages_but_existing_device_recovers_them(self):
        existing = self.register()
        old = self.message()
        new = self.register()
        self.assertEqual(event_batch(existing['deviceToken'])['events'][0]['messageId'], old.pk)
        self.assertEqual(event_batch(new['deviceToken'])['events'], [])
        fresh = self.message()
        self.assertEqual(event_batch(new['deviceToken'])['events'][0]['messageId'], fresh.pk)

    def test_service_presence_allows_incoming_call_with_ui_closed_and_expires(self):
        registration = self.register()
        self.assertFalse(native_receiver_online(self.bob.pk))
        register_socket('test.native.bob', registration['deviceToken'])
        self.assertTrue(native_receiver_online(self.bob.pk))
        data = {'connectionId': self.connection.pk, 'kind': 'video', 'clientId': str(uuid4()), 'deviceId': str(uuid4())}
        with self.captureOnCommitCallbacks(execute=True):
            call = create_call(self.alice, data)
        event = event_batch(registration['deviceToken'])['events'][0]
        self.assertEqual((event['type'], event['callId'], event['kind'], event['direction'], event['status']),
                         ('call', str(call.pk), 'video', 'incoming', 'ringing'))
        DeviceSocket.objects.update(expires_at=timezone.now())
        self.assertFalse(native_receiver_online(self.bob.pk))
        Usuario.objects.filter(pk=self.bob.pk).update(auth_version=1)
        self.assertFalse(native_receiver_online(self.bob.pk))

    def test_current_call_version_and_ended_state_cancel_notice_without_expired_ringing_replay(self):
        registration = self.register()
        call = self.call()
        enqueue_call_notice(call.pk)
        self.assertEqual(event_batch(registration['deviceToken'])['events'][0]['status'], 'ringing')
        Call.objects.filter(pk=call.pk).update(status='connecting', version=2, accepted_device_id=uuid4())
        enqueue_call_notice(call.pk)
        batch = event_batch(registration['deviceToken'])
        self.assertEqual(len(batch['events']), 1)
        self.assertEqual((batch['events'][0]['status'], batch['events'][0]['version']), ('connecting', 2))
        Call.objects.filter(pk=call.pk).update(status='ended', version=3, reason='cancelled')
        enqueue_call_notice(call.pk)
        self.assertEqual(event_batch(registration['deviceToken'])['events'][0]['status'], 'ended')
        Call.objects.filter(pk=call.pk).update(status='ringing', version=4, expires_at=timezone.now())
        enqueue_call_notice(call.pk)
        self.assertEqual(event_batch(registration['deviceToken'])['events'], [])

    def test_expiry_worker_releases_busy_and_emits_terminal_notice(self):
        registration = self.register()
        call = self.call()
        BusyParticipant.objects.bulk_create([BusyParticipant(user=self.alice, call=call), BusyParticipant(user=self.bob, call=call)])
        enqueue_call_notice(call.pk)
        Call.objects.filter(pk=call.pk).update(expires_at=timezone.now())
        with self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(expire_calls(), 1)
        self.assertFalse(BusyParticipant.objects.exists())
        event = event_batch(registration['deviceToken'])['events'][0]
        self.assertEqual((event['status'], event['version']), ('ended', 2))

    def test_password_reset_revokes_all_old_device_tokens_and_preserves_other_account(self):
        old, other_old, eve = self.register(), self.register(), self.register(self.eve)
        register_socket('old.native', old['deviceToken'])
        register_socket('eve.native', eve['deviceToken'])
        enqueue_message_notice(self.message().pk)
        Usuario.objects.filter(pk=self.bob.pk).update(auth_version=1)
        revoke_user_devices(self.bob.pk, 1)
        self.assertFalse(Event.objects.filter(user=self.bob).exists())
        self.assertFalse(DeviceSocket.objects.filter(device__user=self.bob).exists())
        for registration in (old, other_old):
            with self.assertRaises(AuthenticationFailed):
                authenticate_device(registration['deviceToken'])
        authenticate_device(eve['deviceToken'])
        self.assertTrue(DeviceSocket.objects.filter(device__user=self.eve).exists())

    def test_expired_metadata_cleanup_does_not_delete_messages_or_valid_devices(self):
        registration = self.register()
        message = self.message()
        enqueue_message_notice(message.pk)
        Event.objects.update(expires_at=timezone.now())
        register_socket('expiry.fixture', registration['deviceToken'])
        DeviceSocket.objects.update(expires_at=timezone.now())
        sweep_expired()
        self.assertFalse(Event.objects.exists())
        self.assertFalse(DeviceSocket.objects.exists())
        self.assertTrue(Message.objects.filter(pk=message.pk).exists())
        authenticate_device(registration['deviceToken'])

    def test_expired_notice_retention_does_not_replay_old_unread_messages(self):
        registration = self.register()
        old = self.message()
        Device.objects.update(receive_since=timezone.now() - timedelta(days=10))
        Message.objects.filter(pk=old.pk).update(created=timezone.now() - timedelta(days=8))
        enqueue_message_notice(old.pk)
        Event.objects.update(expires_at=timezone.now())
        sweep_expired()
        self.assertEqual(event_batch(registration['deviceToken'])['events'], [])
        self.assertFalse(Event.objects.exists())
        self.assertTrue(Message.objects.get(pk=old.pk).is_new)

    def test_cleanup_preserves_device_reactivated_after_retirement_selection(self):
        registration = self.register()
        old = timezone.now() - timedelta(days=31)
        Device.objects.update(revoked_at=old, expires_at=old)
        original = notice_services._delete_retired_devices
        reactivated = {}

        def reactivate_before_cleanup(candidate_ids, retention):
            reactivated.update(self.register(identifier=registration['deviceId']))
            register_socket('reactivated.native', reactivated['deviceToken'])
            return original(candidate_ids, retention)

        with patch('notifications.services._delete_retired_devices', side_effect=reactivate_before_cleanup) as delete:
            sweep_expired()
        self.assertTrue(delete.called)
        self.assertEqual(Device.objects.count(), 1)
        self.assertTrue(native_receiver_online(self.bob.pk))
        authenticate_device(reactivated['deviceToken'])

    def test_worker_cleanup_runs_at_most_once_per_minute_and_keeps_valid_device(self):
        registration = self.register()
        with patch('notifications.services._sweep_clock', 0), patch('notifications.services.monotonic', return_value=1000):
            sweep_expired(force=False)
            register_socket('expired.minute', registration['deviceToken'])
            DeviceSocket.objects.update(expires_at=timezone.now())
            sweep_expired(force=False)
            self.assertTrue(DeviceSocket.objects.exists())
            self.assertFalse(native_receiver_online(self.bob.pk))
            with patch('notifications.services.monotonic', return_value=1061):
                sweep_expired(force=False)
            self.assertFalse(DeviceSocket.objects.exists())
        authenticate_device(registration['deviceToken'])

    def test_broadcast_idempotency_and_legacy_push_do_not_use_any_external_service(self):
        registration = self.register()
        self.bob.pushToken = 'synthetic-old-expo-token'
        self.bob.save(update_fields=['pushToken'])
        message = self.message()
        with patch('requests.post') as external:
            broadcast_message(message, self.alice, self.bob, message.text)
            broadcast_message(message, self.alice, self.bob, message.text)
            send_push_notification(self.bob.pushToken, 'legacy', message.text)
        external.assert_not_called()
        self.assertEqual(Event.objects.filter(user=self.bob, kind='message').count(), 1)
        self.assertEqual(event_batch(registration['deviceToken'])['events'][0]['messageId'], message.pk)

    def test_cursor_order_is_string_safe_and_has_more_pages_without_changing_unread(self):
        registration = self.register()
        for index in range(102):
            message = self.message()
            enqueue_message_notice(message.pk)
        batch = event_batch(registration['deviceToken'])
        self.assertTrue(batch['hasMore'])
        self.assertEqual(len(batch['events']), 100)
        self.assertTrue(all(isinstance(event['id'], str) for event in batch['events']))
        acknowledge(registration['deviceToken'], batch['cursor'])
        next_batch = event_batch(registration['deviceToken'])
        self.assertEqual(len(next_batch['events']), 2)
        self.assertFalse(next_batch['hasMore'])
        self.assertGreater(int(next_batch['cursor']), int(batch['cursor']))
        self.assertEqual(Message.objects.filter(is_new=True).count(), 102)


@override_settings(**FIXTURE_SETTINGS)
class NoticeWebSocketTests(NoticeFixtures, TransactionTestCase):
    def socket(self, raw, *, query='', extra_headers=None):
        headers = [(b'authorization', ('Bearer ' + raw).encode())] + (extra_headers or [])
        return WebsocketCommunicator(URLRouter(websocket_urlpatterns), '/ws/device-events/' + query, headers=headers)

    async def open_socket(self, socket):
        self.assertTrue((await socket.connect())[0])
        ready = await socket.receive_json_from()
        self.assertEqual(ready['type'], 'notification.ready')
        self.assertEqual(ready['heartbeatSeconds'], 15)
        batch = await socket.receive_json_from()
        self.assertEqual(batch['type'], 'notification.events')
        return batch

    def test_headers_only_rejects_query_invalid_jwt_and_duplicate_authorization(self):
        registration = self.register()
        jwt = str(RefreshToken.for_user(self.bob).access_token)
        async def probe():
            for raw, query, extras in ((registration['deviceToken'], '?token=anything', None),
                ('bad', '', None), (jwt, '', None),
                (registration['deviceToken'], '', [(b'authorization', b'Bearer other')])):
                socket = self.socket(raw, query=query, extra_headers=extras)
                self.assertFalse((await socket.connect())[0])
                await socket.disconnect()
        async_to_sync(probe)()

    def test_ws_notices_target_two_own_devices_only_ack_and_reconnect_no_unread_side_effect(self):
        one, two, outsider = self.register(), self.register(), self.register(self.eve)
        @database_sync_to_async
        def create():
            message = self.message()
            enqueue_message_notice(message.pk)
            return message.pk
        async def probe():
            sockets = [self.socket(registration['deviceToken']) for registration in (one, two, outsider)]
            try:
                for socket in sockets:
                    self.assertEqual((await self.open_socket(socket))['events'], [])
                message_id = await create()
                first, second = [await socket.receive_json_from() for socket in sockets[:2]]
                self.assertEqual(first['events'], second['events'])
                self.assertEqual(first['events'][0]['messageId'], message_id)
                self.assertTrue(await sockets[2].receive_nothing(timeout=0.03))
                await sockets[0].send_json_to({'type': 'notification.ack', 'cursor': first['cursor']})
                self.assertEqual((await sockets[0].receive_json_from())['type'], 'notification.acked')
                await sockets[0].disconnect()
                sockets[0] = self.socket(one['deviceToken'])
                self.assertEqual((await self.open_socket(sockets[0]))['events'], [])
                await sockets[1].send_json_to({'type': 'notification.ping'})
                self.assertEqual((await sockets[1].receive_json_from())['type'], 'notification.pong')
            finally:
                for socket in sockets:
                    await socket.disconnect()
        async_to_sync(probe)()
        self.assertTrue(Message.objects.get().is_new)
        self.assertFalse(DeviceSocket.objects.exists())

    def test_device_delete_closes_immediately_and_auth_version_reset_preserves_other_user(self):
        registration, outsider = self.register(), self.register(self.eve)
        @database_sync_to_async
        def reset():
            Usuario.objects.filter(pk=self.bob.pk).update(auth_version=1)
            revoke_user_devices(self.bob.pk, 1)
        async def probe():
            bob, eve = self.socket(registration['deviceToken']), self.socket(outsider['deviceToken'])
            try:
                await self.open_socket(bob)
                await self.open_socket(eve)
                await reset()
                self.assertEqual(await bob.receive_json_from(), {'type': 'notification.revoked'})
                close = await bob.receive_output()
                self.assertEqual((close['type'], close['code']), ('websocket.close', 4401))
                self.assertTrue(await eve.receive_nothing(timeout=0.03))
                await eve.send_json_to({'type': 'notification.ping'})
                self.assertEqual((await eve.receive_json_from())['type'], 'notification.pong')
            finally:
                await bob.disconnect()
                await eve.disconnect()
        async_to_sync(probe)()

    def test_rotation_closes_previous_ws_and_new_secret_remains_usable(self):
        registration = self.register()
        @database_sync_to_async
        def rotate():
            return self.register(identifier=registration['deviceId'])
        async def probe():
            old = self.socket(registration['deviceToken'])
            fresh = None
            try:
                await self.open_socket(old)
                rotated = await rotate()
                self.assertEqual(await old.receive_json_from(), {'type': 'notification.revoked'})
                self.assertEqual((await old.receive_output())['code'], 4401)
                fresh = self.socket(rotated['deviceToken'])
                await self.open_socket(fresh)
            finally:
                await old.disconnect()
                if fresh:
                    await fresh.disconnect()
        async_to_sync(probe)()

    def test_ws_invalid_commands_never_echo_client_content_and_cannot_perform_call_actions(self):
        registration = self.register()
        async def probe():
            socket = self.socket(registration['deviceToken'])
            try:
                await self.open_socket(socket)
                for payload in ({'type': 'notification.ack', 'cursor': '99999'},
                    {'type': 'call.accept', 'draft': 'SYNTHETIC_PRIVATE_DRAFT'}, []):
                    await socket.send_json_to(payload)
                    response = await socket.receive_json_from()
                    self.assertEqual(response['type'], 'notification.error')
                    self.assertNotIn('SYNTHETIC_PRIVATE_DRAFT', json.dumps(response))
            finally:
                await socket.disconnect()
        async_to_sync(probe)()
