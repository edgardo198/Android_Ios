import asyncio
import base64
import hashlib
import hmac
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
from unittest.mock import patch
from uuid import uuid4

from asgiref.sync import async_to_sync
from channels.db import database_sync_to_async
from channels.layers import get_channel_layer
from channels.routing import URLRouter
from channels.testing import WebsocketCommunicator
from django.db import IntegrityError, OperationalError, close_old_connections, transaction
from django.core import signing
from django.test import TestCase, TransactionTestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import AccessToken, RefreshToken

from chat.middleware import JWTAuthMiddleware
from chat.models import Connection, Usuario
from .ice import ice_servers
from .models import BusyParticipant, Call, CallSocket
from .routing import websocket_urlpatterns
from .services import CallError, act, call_history, create_call, current_call, expire_calls, payload, signal_call, update_live_call, validate_signal


class CallFixtures:
    def setUp(self):
        super().setUp()
        self.alice = Usuario.objects.create_user(username='call_alice', password='test-password')
        self.bob = Usuario.objects.create_user(username='call_bob', password='test-password')
        self.eve = Usuario.objects.create_user(username='call_eve', password='test-password')
        self.connection = Connection.objects.create(sender=self.alice, receiver=self.bob, accepted=True)
        self.alice_device, self.bob_device = uuid4(), uuid4()
        self.client = APIClient()
        self.client.force_authenticate(self.alice)
        self.presence = CallSocket.objects.create(channel_name='tests.bob', user=self.bob, device_id=self.bob_device,
                                                 expires_at=timezone.now() + timedelta(seconds=90))

    def invitation(self, **kwargs):
        return {'connectionId': self.connection.pk, 'kind': 'audio', 'clientId': str(uuid4()),
                'deviceId': str(self.alice_device), **kwargs}

    def new_call(self):
        return create_call(self.alice, self.invitation())

    def connected_call(self):
        call = self.new_call()
        act(self.bob, call.pk, 'accept', self.bob_device)
        signal_call(self.alice, call.pk, self.alice_device, {'type': 'offer', 'sdp': 'v=0\r\n'})
        signal_call(self.bob, call.pk, self.bob_device, {'type': 'answer', 'sdp': 'v=0\r\n'})
        update_live_call(self.alice, call.pk, self.alice_device, connected=True)
        return update_live_call(self.bob, call.pk, self.bob_device, connected=True)


@override_settings(PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher'])
class CallServiceTests(CallFixtures, TestCase):
    def test_rest_requires_authentication(self):
        self.client.force_authenticate(None)
        for path, method in [('/calls/', 'post'), ('/calls/current/', 'get')]:
            response = getattr(self.client, method)(path, self.invitation(), format='json')
            self.assertEqual(response.status_code, 401)

    def test_create_payload_contains_only_lifecycle_and_no_sdp(self):
        response = self.client.post('/calls/', self.invitation(kind='video'), format='json')
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data['iceServers'], [])
        self.assertEqual(response.data['call']['callee']['id'], self.bob.pk)
        self.assertEqual(response.data['call']['callerDeviceId'], str(self.alice_device))
        self.assertNotIn('sdp', response.data['call'])
        self.assertEqual(BusyParticipant.objects.count(), 2)

    def test_duplicate_client_attempt_is_idempotent(self):
        data = self.invitation()
        first, second = create_call(self.alice, data), create_call(self.alice, data)
        self.assertEqual(first.pk, second.pk)
        self.assertEqual(Call.objects.count(), 1)
        act(self.alice, first.pk, 'cancel', self.alice_device)
        self.assertEqual(create_call(self.alice, data).status, 'ended')
        with self.assertRaises(CallError) as caught:
            create_call(self.alice, {**data, 'kind': 'video'})
        self.assertEqual(caught.exception.code, 'conflict')

    def test_busy_and_crossed_invitation_do_not_create_second_call(self):
        self.new_call()
        with self.assertRaises(CallError) as caught:
            create_call(self.bob, self.invitation(deviceId=str(self.bob_device)))
        self.assertEqual(caught.exception.code, 'busy')
        self.assertEqual(Call.objects.count(), 1)

    def test_unique_busy_user_is_database_enforced(self):
        call = self.new_call()
        with self.assertRaises(IntegrityError), transaction.atomic():
            BusyParticipant.objects.create(user=self.alice, call=call)
        self.assertEqual(BusyParticipant.objects.count(), 2)

    def test_offline_contact_and_unaccepted_relationship_rejected(self):
        self.presence.delete()
        response = self.client.post('/calls/', self.invitation(), format='json')
        self.assertEqual(response.data['code'], 'offline')
        self.connection.accepted = False
        self.connection.save()
        response = self.client.post('/calls/', self.invitation(), format='json')
        self.assertEqual(response.status_code, 403)
        self.assertEqual(Call.objects.count(), 0)

    def test_third_party_cannot_create_or_read_or_act(self):
        call = self.new_call()
        self.client.force_authenticate(self.eve)
        self.assertEqual(self.client.post('/calls/', self.invitation(), format='json').status_code, 403)
        self.assertIsNone(self.client.get('/calls/current/').data['call'])
        response = self.client.post(f'/calls/{call.pk}/action/', {'action': 'end', 'deviceId': str(uuid4())}, format='json')
        self.assertEqual(response.status_code, 404)

    def test_inactive_participant_cannot_receive_invitation(self):
        self.bob.is_active = False
        self.bob.save()
        with self.assertRaises(CallError) as caught:
            self.new_call()
        self.assertEqual(caught.exception.code, 'unavailable')

    def test_malformed_identifiers_and_kinds_do_not_create_calls(self):
        for change in [{'deviceId': None}, {'clientId': 'invalid'}, {'connectionId': True}, {'connectionId': '12.5'}, {'connectionId': '9' * 1000}, {'connectionId': '\u00b2'}, {'kind': 'other'}]:
            response = self.client.post('/calls/', self.invitation(**change), format='json')
            self.assertEqual(response.status_code, 400)
        self.assertEqual(Call.objects.count(), 0)

    def test_only_callee_can_accept_or_reject_and_only_caller_can_cancel(self):
        call = self.new_call()
        for user, device, action in [(self.alice, self.alice_device, 'accept'), (self.alice, self.alice_device, 'reject'), (self.bob, self.bob_device, 'cancel')]:
            with self.assertRaises(CallError) as caught:
                act(user, call.pk, action, device)
            self.assertEqual(caught.exception.code, 'forbidden')
        call.refresh_from_db()
        self.assertEqual(call.status, 'ringing')

    def test_accept_is_idempotent_and_second_phone_cannot_take_over(self):
        call = self.new_call()
        accepted = act(self.bob, call.pk, 'accept', self.bob_device)
        self.assertEqual(accepted.status, 'connecting')
        self.assertEqual(act(self.bob, call.pk, 'accept', self.bob_device).version, 2)
        for action in ('accept', 'end'):
            with self.assertRaises(CallError) as caught:
                act(self.bob, call.pk, action, uuid4())
            self.assertEqual(caught.exception.code, 'device')

    def test_terminal_state_releases_busy_and_late_accept_cannot_revive(self):
        call = self.new_call()
        act(self.alice, call.pk, 'cancel', self.alice_device)
        terminal = act(self.bob, call.pk, 'accept', self.bob_device)
        self.assertEqual(terminal.status, 'ended')
        self.assertEqual(terminal.reason, 'cancelled')
        self.assertEqual(terminal.version, 2)
        self.assertEqual(BusyParticipant.objects.count(), 0)
        self.assertEqual(self.new_call().status, 'ringing')

    def test_terminal_state_end_is_idempotent(self):
        call = self.new_call()
        first = act(self.bob, call.pk, 'reject', self.bob_device)
        second = act(self.bob, call.pk, 'reject', self.bob_device)
        self.assertEqual(first.version, second.version)
        self.assertEqual(second.reason, 'rejected')

    def test_caller_wrong_device_cannot_cancel(self):
        call = self.new_call()
        with self.assertRaises(CallError) as caught:
            act(self.alice, call.pk, 'cancel', uuid4())
        self.assertEqual(caught.exception.code, 'device')

    def test_ring_timeout_persists_without_clients_and_frees_users(self):
        call = self.new_call()
        Call.objects.filter(pk=call.pk).update(expires_at=timezone.now() - timedelta(seconds=1))
        CallSocket.objects.all().delete()
        self.assertEqual(expire_calls(), 1)
        call.refresh_from_db()
        self.assertEqual((call.status, call.reason), ('ended', 'missed'))
        self.assertEqual(BusyParticipant.objects.count(), 0)

    def test_negotiation_deadline_cannot_be_extended_by_heartbeat(self):
        call = self.new_call()
        call = act(self.bob, call.pk, 'accept', self.bob_device)
        deadline = call.expires_at
        update_live_call(self.alice, call.pk, self.alice_device)
        call.refresh_from_db()
        self.assertEqual(call.expires_at, deadline)
        Call.objects.filter(pk=call.pk).update(expires_at=timezone.now() - timedelta(seconds=1))
        self.assertIsNone(current_call(self.alice))
        call.refresh_from_db()
        self.assertEqual(call.reason, 'connection_timeout')

    def test_answer_requires_offer_and_offer_requires_caller(self):
        call = self.new_call()
        act(self.bob, call.pk, 'accept', self.bob_device)
        for user, device, signal in [(self.bob, self.bob_device, {'type': 'answer', 'sdp': 'v=0\r\n'}), (self.bob, self.bob_device, {'type': 'offer', 'sdp': 'v=0\r\n'})]:
            with self.assertRaises(CallError):
                signal_call(user, call.pk, device, signal)
        with self.assertRaises(CallError):
            update_live_call(self.alice, call.pk, self.alice_device, connected=True)

    def test_ice_is_valid_before_offer_and_never_persisted(self):
        call = self.new_call()
        act(self.bob, call.pk, 'accept', self.bob_device)
        candidate = {'type': 'candidate', 'candidate': {'candidate': 'candidate:1 1 udp 1 192.168.1.2 5000 typ host', 'sdpMid': '0', 'sdpMLineIndex': 0}}
        signal_call(self.alice, call.pk, self.alice_device, candidate)
        self.assertNotIn('candidate', {field.name for field in Call._meta.fields})
        self.assertEqual(validate_signal({'type': 'candidate', 'candidate': None})['candidate'], None)

    def test_invalid_and_oversized_signals_are_rejected(self):
        bad = [{'type': 'offer', 'sdp': 'v=0' + 'x' * 65537}, {'type': 'answer', 'sdp': None}, {'type': 'offer', 'sdp': 'v=0\ud800'},
               {'type': 'candidate', 'candidate': {'candidate': 'not-ice'}},
               {'type': 'candidate', 'candidate': {'candidate': 'candidate:1', 'sdpMLineIndex': True}},
               {'type': 'candidate', 'candidate': {'candidate': 'candidate:1', 'token': 'secret'}},
               {'type': 'candidate', 'candidate': {'candidate': 'candidate:' + 'x' * 4096}}]
        for signal in bad:
            with self.assertRaises(CallError):
                validate_signal(signal)

    def test_both_connections_required_for_active_and_dead_peer_expires(self):
        call = self.connected_call()
        self.assertEqual(call.status, 'active')
        Call.objects.filter(pk=call.pk).update(callee_seen=timezone.now() - timedelta(seconds=59))
        updated = update_live_call(self.alice, call.pk, self.alice_device)
        self.assertLess(updated.expires_at, timezone.now() + timedelta(seconds=2))
        Call.objects.filter(pk=call.pk).update(expires_at=timezone.now() - timedelta(seconds=1))
        expire_calls()
        call.refresh_from_db()
        self.assertEqual(call.reason, 'disconnected')

    def test_connection_withdrawal_commits_release_before_error(self):
        call = self.connected_call()
        self.connection.accepted = False
        self.connection.save()
        with self.assertRaises(CallError):
            signal_call(self.alice, call.pk, self.alice_device, {'type': 'candidate', 'candidate': None})
        call.refresh_from_db()
        self.assertEqual(call.reason, 'unavailable')
        self.assertEqual(BusyParticipant.objects.count(), 0)

    @override_settings(CALLS_STUN_URLS=['stun:our-server.local:3478'], CALLS_TURN_URLS=['turn:our-server.local:3478'], CALLS_TURN_SECRET='own-test-secret', CALLS_TURN_TTL_SECONDS=3600)
    @patch('calls.ice.time.time', return_value=100000)
    def test_own_turn_credentials_expire_and_secret_is_not_returned(self, _time):
        result = ice_servers(self.alice)
        self.assertEqual(result[1]['username'], f'103600:{self.alice.pk}')
        expected = base64.b64encode(hmac.new(b'own-test-secret', result[1]['username'].encode(), hashlib.sha1).digest()).decode()
        self.assertEqual(result[1]['credential'], expected)
        self.assertNotIn('own-test-secret', str(result))

    def test_current_endpoint_does_not_cache_credentials(self):
        response = self.client.get('/calls/current/')
        self.assertEqual(response['Cache-Control'], 'no-store')

    def test_active_timestamp_starts_only_after_both_peers_and_is_idempotent(self):
        call = self.new_call()
        act(self.bob, call.pk, 'accept', self.bob_device)
        signal_call(self.alice, call.pk, self.alice_device, {'type': 'offer', 'sdp': 'v=0\r\n'})
        signal_call(self.bob, call.pk, self.bob_device, {'type': 'answer', 'sdp': 'v=0\r\n'})
        first = update_live_call(self.alice, call.pk, self.alice_device, connected=True)
        self.assertEqual(first.status, 'connecting')
        self.assertIsNone(first.connected_at)
        first_active = update_live_call(self.bob, call.pk, self.bob_device, connected=True)
        self.assertIsNotNone(first_active.connected_at)
        later = update_live_call(self.alice, call.pk, self.alice_device, connected=True)
        self.assertEqual(later.connected_at, first_active.connected_at)
        self.assertEqual(later.version, first_active.version)
        self.assertEqual(payload(later)['activeAt'], first_active.connected_at.isoformat())

    def test_duration_uses_connection_and_fixed_end_not_invitation_or_heartbeat(self):
        call = self.connected_call()
        connected = timezone.now() - timedelta(seconds=22, milliseconds=900)
        ended = connected + timedelta(seconds=9, milliseconds=800)
        Call.objects.filter(pk=call.pk).update(connected_at=connected)
        with patch('calls.services.timezone.now', return_value=ended):
            terminal = act(self.alice, call.pk, 'end', self.alice_device)
        self.assertEqual(payload(terminal)['durationSeconds'], 9)
        with patch('calls.services.timezone.now', return_value=ended + timedelta(hours=1)):
            self.assertEqual(payload(terminal)['durationSeconds'], 9)
        never_connected = self.new_call()
        self.assertEqual(payload(never_connected)['durationSeconds'], 0)

    def test_media_signal_is_video_only_boolean_and_authorized_device(self):
        for value in [0, 1, 'false', None]:
            with self.assertRaises(CallError):
                validate_signal({'type': 'media', 'videoEnabled': value})
        with self.assertRaises(CallError):
            validate_signal({'type': 'media', 'videoEnabled': False, 'sdp': 'private'})
        call = self.connected_call()
        with self.assertRaises(CallError):
            signal_call(self.alice, call.pk, self.alice_device, {'type': 'media', 'videoEnabled': False})
        act(self.alice, call.pk, 'end', self.alice_device)
        video = create_call(self.alice, self.invitation(kind='video'))
        with self.assertRaises(CallError):
            signal_call(self.alice, video.pk, self.alice_device, {'type': 'media', 'videoEnabled': False})
        act(self.bob, video.pk, 'accept', self.bob_device)
        signal_call(self.alice, video.pk, self.alice_device, {'type': 'media', 'videoEnabled': False})
        with self.assertRaises(CallError):
            signal_call(self.bob, video.pk, uuid4(), {'type': 'media', 'videoEnabled': True})


@override_settings(PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher'])
class CallHistoryTests(CallFixtures, TestCase):
    def history_row(self, *, caller=None, callee=None, connection=None, reason='ended', connected=True, ended_at=None):
        end = ended_at or timezone.now()
        return Call.objects.create(
            connection=connection or self.connection, caller=caller or self.alice, callee=callee or self.bob,
            client_id=uuid4(), caller_device_id=uuid4(), accepted_device_id=uuid4(),
            kind='audio', status='ended', reason=reason,
            connected_at=end - timedelta(seconds=31) if connected else None,
            ended_at=end, expires_at=end,
        )

    def test_history_requires_auth_and_excludes_other_users_and_live_calls(self):
        own = self.history_row()
        other_connection = Connection.objects.create(sender=self.eve, receiver=self.bob, accepted=True)
        self.history_row(caller=self.eve, connection=other_connection)
        self.new_call()
        response = self.client.get('/calls/history/')
        self.assertEqual([row['id'] for row in response.data['results']], [str(own.pk)])
        self.assertEqual(response['Cache-Control'], 'no-store')
        self.client.force_authenticate(None)
        self.assertEqual(self.client.get('/calls/history/').status_code, 401)

    def test_history_uses_role_peer_result_and_hides_transport_identifiers(self):
        call = self.history_row()
        outgoing = self.client.get('/calls/history/').data['results'][0]
        self.assertEqual((outgoing['direction'], outgoing['peer']['id'], outgoing['result'], outgoing['durationSeconds']), ('outgoing', self.bob.pk, 'answered', 31))
        self.assertEqual(outgoing['activeAt'], call.connected_at.isoformat())
        self.assertEqual(outgoing['endedAt'], call.ended_at.isoformat())
        for name in ('clientId', 'callerDeviceId', 'acceptedDeviceId', 'iceServers', 'signal', 'sdp', 'candidate', 'expiresAt'):
            self.assertNotIn(name, outgoing)
        self.client.force_authenticate(self.bob)
        incoming = self.client.get('/calls/history/').data['results'][0]
        self.assertEqual((incoming['direction'], incoming['peer']['id']), ('incoming', self.alice.pk))

    def test_pagination_latest_fifty_stable_ties_no_duplicates_and_new_rows_do_not_shift_cursor(self):
        at = timezone.now()
        original = [self.history_row(ended_at=at) for _ in range(55)]
        first = self.client.get('/calls/history/').data
        self.assertEqual(len(first['results']), 50)
        self.assertIsInstance(first['nextCursor'], str)
        newer = self.history_row(ended_at=at + timedelta(seconds=1))
        second = self.client.get('/calls/history/', {'cursor': first['nextCursor']}).data
        self.assertEqual(len(second['results']), 5)
        self.assertIsNone(second['nextCursor'])
        ids = [row['id'] for row in first['results'] + second['results']]
        self.assertEqual(len(set(ids)), 55)
        self.assertEqual(set(ids), {str(call.pk) for call in original})
        self.assertNotIn(str(newer.pk), ids)

    def test_cursor_cannot_be_tampered_reused_by_other_user_or_expired(self):
        self.history_row()
        self.history_row()
        cursor = self.client.get('/calls/history/', {'limit': 1}).data['nextCursor']
        bad = self.client.get('/calls/history/', {'cursor': cursor + 'tampered'})
        self.assertEqual((bad.status_code, bad.data['code']), (400, 'invalid_cursor'))
        self.client.force_authenticate(self.bob)
        bad = self.client.get('/calls/history/', {'cursor': cursor})
        self.assertEqual(bad.data['code'], 'invalid_cursor')
        self.client.force_authenticate(self.alice)
        with patch('django.core.signing.time.time', return_value=time.time() + 86401):
            bad = self.client.get('/calls/history/', {'cursor': cursor})
        self.assertEqual(bad.data['code'], 'invalid_cursor')

    def test_limits_cursor_types_and_normalized_unanswered_results(self):
        for reason, result in [('missed', 'missed'), ('rejected', 'rejected'), ('cancelled', 'cancelled'), ('connection_timeout', 'failed')]:
            call = self.history_row(reason=reason, connected=False)
            row = next(row for row in self.client.get('/calls/history/').data['results'] if row['id'] == str(call.pk))
            self.assertEqual((row['result'], row['durationSeconds'], row['activeAt']), (result, 0, None))
        for limit in ('0', '51', '9999999999999', 'false', '\u00b2'):
            response = self.client.get('/calls/history/', {'limit': limit})
            self.assertEqual((response.status_code, response.data['code']), (400, 'invalid_limit'))
        malformed = signing.dumps({'version': 1, 'user': self.alice.pk, 'at': 'invalid', 'id': str(uuid4())}, salt='calls.history.v1')
        response = self.client.get('/calls/history/', {'cursor': malformed})
        self.assertEqual(response.data['code'], 'invalid_cursor')

    def test_missing_legacy_end_timestamp_uses_created_date_for_sorting(self):
        legacy = self.history_row(connected=False)
        Call.objects.filter(pk=legacy.pk).update(ended_at=None, created_at=timezone.now() - timedelta(minutes=1))
        current = self.history_row()
        rows = self.client.get('/calls/history/').data['results']
        self.assertEqual([row['id'] for row in rows], [str(current.pk), str(legacy.pk)])


@override_settings(PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher'], CHANNEL_LAYERS={'default': {'BACKEND': 'channels.layers.InMemoryChannelLayer'}})
class CallSocketTests(CallFixtures, TransactionTestCase):
    def communicator(self, user, device_id=None, token=True):
        access = str(RefreshToken.for_user(user).access_token) if token else 'invalid'
        suffix = f'&deviceId={device_id}' if device_id else ''
        return WebsocketCommunicator(JWTAuthMiddleware(URLRouter(websocket_urlpatterns)), f'/ws/calls/?token={access}{suffix}')

    async def receive_initial(self, socket):
        current = await socket.receive_json_from()
        self.assertEqual(current['type'], 'call.current')
        authenticated = await socket.receive_json_from()
        self.assertEqual(authenticated['type'], 'call.authenticated')
        self.assertEqual(set(authenticated), {'type', 'accessExpiresAt'})
        return current, authenticated

    def test_socket_requires_valid_token_and_device(self):
        async def run():
            for socket in [self.communicator(self.alice, self.alice_device, token=False), self.communicator(self.alice)]:
                ok, _code = await socket.connect()
                self.assertFalse(ok)
                await socket.disconnect()
        async_to_sync(run)()

    def test_invitation_and_signals_reach_only_participants_and_bound_device(self):
        async def run():
            alice = self.communicator(self.alice, self.alice_device)
            bob = self.communicator(self.bob, self.bob_device)
            bob_other = self.communicator(self.bob, uuid4())
            eve = self.communicator(self.eve, uuid4())
            sockets = [alice, bob, bob_other, eve]
            try:
                for socket in sockets:
                    self.assertTrue((await socket.connect())[0])
                    await self.receive_initial(socket)
                call = await database_sync_to_async(self.new_call)()
                for socket in [alice, bob, bob_other]:
                    self.assertEqual((await socket.receive_json_from())['call']['status'], 'ringing')
                self.assertTrue(await eve.receive_nothing(timeout=0.05))
                await database_sync_to_async(act)(self.bob, call.pk, 'accept', self.bob_device)
                for socket in [alice, bob, bob_other]:
                    self.assertEqual((await socket.receive_json_from())['call']['status'], 'connecting')
                await alice.send_json_to({'type': 'call.signal', 'callId': str(call.pk), 'deviceId': str(self.alice_device), 'signal': {'type': 'offer', 'sdp': 'v=0\r\n'}})
                signal = await bob.receive_json_from()
                self.assertEqual(signal['signal']['type'], 'offer')
                self.assertNotIn('targetDeviceId', signal)
                self.assertTrue(await bob_other.receive_nothing(timeout=0.05))
                self.assertTrue(await eve.receive_nothing(timeout=0.05))
                await eve.send_json_to({'type': 'call.signal', 'callId': str(call.pk), 'deviceId': str(eve.scope['query_string'].decode().split('deviceId=')[1]), 'signal': {'type': 'candidate', 'candidate': None}})
                self.assertEqual((await eve.receive_json_from())['code'], 'not_found')
                await bob.send_json_to({'type': 'call.end', 'callId': str(call.pk), 'deviceId': str(self.bob_device)})
                for socket in [alice, bob, bob_other]:
                    self.assertEqual((await socket.receive_json_from())['call']['status'], 'ended')
                self.assertEqual(await database_sync_to_async(BusyParticipant.objects.count)(), 0)
            finally:
                for socket in sockets:
                    await socket.disconnect()
        async_to_sync(run)()

    def test_socket_binding_rejects_wrong_device_and_malformed_json(self):
        async def run():
            socket = self.communicator(self.alice, self.alice_device)
            try:
                self.assertTrue((await socket.connect())[0])
                await self.receive_initial(socket)
                await socket.send_json_to({'type': 'call.heartbeat', 'deviceId': str(uuid4()), 'callId': str(uuid4())})
                self.assertEqual((await socket.receive_json_from())['code'], 'device')
                await socket.send_to(text_data='[invalid')
                self.assertEqual((await socket.receive_json_from())['code'], 'invalid')
                await socket.send_json_to({'type': 'call.ping'})
                self.assertEqual((await socket.receive_json_from())['type'], 'call.pong')
            finally:
                await socket.disconnect()
        async_to_sync(run)()

    def test_socket_cancel_before_accept_is_terminal(self):
        async def run():
            socket = self.communicator(self.alice, self.alice_device)
            try:
                await socket.connect()
                await self.receive_initial(socket)
                call = await database_sync_to_async(self.new_call)()
                await socket.receive_json_from()
                await socket.send_json_to({'type': 'call.end', 'callId': str(call.pk), 'deviceId': str(self.alice_device)})
                ended = (await socket.receive_json_from())['call']
                self.assertEqual((ended['status'], ended['reason']), ('ended', 'cancelled'))
            finally:
                await socket.disconnect()
        async_to_sync(run)()

    def test_persisted_expiry_from_separate_worker_is_delivered_as_null_snapshot(self):
        async def run():
            socket = self.communicator(self.alice, self.alice_device)
            try:
                await socket.connect()
                await self.receive_initial(socket)
                call = await database_sync_to_async(self.new_call)()
                await socket.receive_json_from()

                @database_sync_to_async
                def worker_expire():
                    Call.objects.filter(pk=call.pk).update(expires_at=timezone.now() - timedelta(seconds=1))
                    # A standalone worker's in-memory channel groups cannot reach
                    # the API process. Simulate only its persisted transition.
                    with patch('calls.services.publish'):
                        self.assertEqual(expire_calls(), 1)
                await worker_expire()
                current = await socket.receive_json_from(timeout=7)
                self.assertEqual(current['type'], 'call.current')
                self.assertIsNone(current['call'])
                self.assertEqual(await database_sync_to_async(BusyParticipant.objects.count)(), 0)
            finally:
                await socket.disconnect()
        async_to_sync(run)()

    def test_socket_closes_when_access_token_expires(self):
        async def run():
            socket = self.communicator(self.alice, self.alice_device)
            try:
                await socket.connect()
                await self.receive_initial(socket)
                with patch('calls.consumers.AccessToken', side_effect=TokenError('expired')):
                    await socket.send_json_to({'type': 'call.ping'})
                    closed = await socket.receive_output()
                self.assertEqual((closed['type'], closed['code']), ('websocket.close', 4401))
            finally:
                await socket.disconnect()
        async_to_sync(run)()

    def test_ping_rechecks_disabled_user_instead_of_stale_scope(self):
        async def run():
            socket = self.communicator(self.alice, self.alice_device)
            try:
                await socket.connect()
                await self.receive_initial(socket)
                await database_sync_to_async(Usuario.objects.filter(pk=self.alice.pk).update)(is_active=False)
                await socket.send_json_to({'type': 'call.ping'})
                self.assertEqual((await socket.receive_json_from())['code'], 'auth')
                closed = await socket.receive_output()
                self.assertEqual(closed['code'], 4401)
            finally:
                await socket.disconnect()
        async_to_sync(run)()

    def test_auth_refresh_keeps_active_call_identity_timestamp_and_socket(self):
        call = self.connected_call()
        token = RefreshToken.for_user(self.alice).access_token
        token.set_exp(lifetime=timedelta(hours=1))
        raw = str(token)

        async def run():
            socket = self.communicator(self.alice, self.alice_device)
            try:
                await socket.connect()
                current, previous_auth = await self.receive_initial(socket)
                self.assertEqual(current['call']['activeAt'], call.connected_at.isoformat())
                original_deadline = current['call']['expiresAt']
                await socket.send_json_to({'type': 'call.auth', 'token': raw, 'deviceId': str(self.alice_device)})
                refreshed = await socket.receive_json_from()
                self.assertEqual(set(refreshed), {'type', 'accessExpiresAt'})
                self.assertEqual(refreshed['type'], 'call.authenticated')
                self.assertGreater(refreshed['accessExpiresAt'], previous_auth['accessExpiresAt'])
                self.assertNotEqual(refreshed['accessExpiresAt'], original_deadline)
                # Verify subsequent commands validate the replacement token, not
                # only that an acknowledgement happened to be returned.
                with patch('calls.consumers.AccessToken', wraps=AccessToken) as validated:
                    await socket.send_json_to({'type': 'call.ping'})
                    self.assertEqual((await socket.receive_json_from())['type'], 'call.pong')
                    validated.assert_called_with(raw)
                stored = await database_sync_to_async(Call.objects.get)(pk=call.pk)
                self.assertEqual((stored.status, stored.version, stored.connected_at), (call.status, call.version, call.connected_at))
                self.assertEqual(await database_sync_to_async(BusyParticipant.objects.count)(), 2)
            finally:
                await socket.disconnect()
        async_to_sync(run)()

    def test_auth_refresh_rejects_other_user_wrong_device_bad_or_expired_tokens(self):
        other = str(RefreshToken.for_user(self.eve).access_token)
        own = str(RefreshToken.for_user(self.alice).access_token)
        refresh = str(RefreshToken.for_user(self.alice))
        expired = RefreshToken.for_user(self.alice).access_token
        expired.set_exp(from_time=timezone.now() - timedelta(minutes=10), lifetime=timedelta(seconds=1))
        cases = [(other, self.alice_device), (own, uuid4()), ('invalid', self.alice_device),
                 (str(expired), self.alice_device), (refresh, self.alice_device), ('x' * 8193, self.alice_device)]

        async def run():
            for raw, device in cases:
                socket = self.communicator(self.alice, self.alice_device)
                try:
                    await socket.connect()
                    await self.receive_initial(socket)
                    await socket.send_json_to({'type': 'call.auth', 'token': raw, 'deviceId': str(device)})
                    error = await socket.receive_json_from()
                    self.assertEqual((error['type'], error['code']), ('call.error', 'auth'))
                    self.assertNotIn(raw, str(error))
                    closed = await socket.receive_output()
                    self.assertEqual((closed['type'], closed['code']), ('websocket.close', 4401))
                finally:
                    await socket.disconnect()
        async_to_sync(run)()

    def test_auth_refresh_rechecks_disabled_account_and_cannot_move_user_group(self):
        token = str(RefreshToken.for_user(self.alice).access_token)

        async def run():
            socket = self.communicator(self.alice, self.alice_device)
            try:
                await socket.connect()
                await self.receive_initial(socket)
                await database_sync_to_async(Usuario.objects.filter(pk=self.alice.pk).update)(is_active=False)
                await socket.send_json_to({'type': 'call.auth', 'token': token, 'deviceId': str(self.alice_device)})
                self.assertEqual((await socket.receive_json_from())['code'], 'auth')
                self.assertEqual((await socket.receive_output())['code'], 4401)
            finally:
                await socket.disconnect()
        async_to_sync(run)()

    def test_video_state_relays_only_to_accepted_device_without_persisting_sdp(self):
        async def run():
            alice = self.communicator(self.alice, self.alice_device)
            bob = self.communicator(self.bob, self.bob_device)
            other = self.communicator(self.bob, uuid4())
            sockets = [alice, bob, other]
            try:
                for socket in sockets:
                    await socket.connect()
                    await self.receive_initial(socket)
                call = await database_sync_to_async(create_call)(self.alice, self.invitation(kind='video'))
                for socket in sockets:
                    await socket.receive_json_from()
                await database_sync_to_async(act)(self.bob, call.pk, 'accept', self.bob_device)
                for socket in sockets:
                    await socket.receive_json_from()
                signal = {'type': 'media', 'videoEnabled': False}
                await alice.send_json_to({'type': 'call.signal', 'callId': str(call.pk), 'deviceId': str(self.alice_device), 'signal': signal})
                received = await bob.receive_json_from()
                self.assertEqual(received, {'type': 'call.signal', 'callId': str(call.pk), 'signal': signal})
                self.assertTrue(await other.receive_nothing(timeout=0.05))
                self.assertTrue(await alice.receive_nothing(timeout=0.05))
            finally:
                for socket in sockets:
                    await socket.disconnect()
        async_to_sync(run)()

    def test_simultaneous_crossed_invitations_never_allocate_two_calls(self):
        CallSocket.objects.create(channel_name='tests.alice', user=self.alice, device_id=self.alice_device,
                                  expires_at=timezone.now() + timedelta(seconds=90))
        barrier = Barrier(2)
        alice_data = self.invitation()
        bob_data = self.invitation(deviceId=str(self.bob_device))

        def attempt(user_id, data):
            close_old_connections()
            try:
                user = Usuario.objects.get(pk=user_id)
                barrier.wait(timeout=5)
                try:
                    return ('created', str(create_call(user, data).pk))
                except CallError as error:
                    return ('error', error.code)
                except OperationalError:
                    # SQLite can ask both initial writers to retry. The HTTP views
                    # turn that transient writer conflict into a 503 response.
                    return ('error', 'retry')
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(attempt, self.alice.pk, alice_data), executor.submit(attempt, self.bob.pk, bob_data)]
            results = [future.result(timeout=10) for future in futures]
        self.assertLessEqual(Call.objects.exclude(status='ended').count(), 1)
        for state, code in results:
            if state == 'error':
                self.assertIn(code, ('busy', 'retry'))
        if not Call.objects.exists():
            create_call(self.alice, alice_data)
        self.assertEqual(BusyParticipant.objects.count(), 2)
        self.assertEqual(BusyParticipant.objects.values('call_id').distinct().count(), 1)
