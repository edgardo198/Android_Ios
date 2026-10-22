import json
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from unittest.mock import patch
from uuid import uuid4

from asgiref.sync import async_to_sync
from channels.db import database_sync_to_async
from channels.testing import WebsocketCommunicator
from django.core.cache import cache, caches
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from .consumers import ChatConsumer
from .middleware import JWTAuthMiddleware
from .models import Connection, Message, Usuario
from .serializers import CurrentUsuarioSerializer, UsuarioSerializer
from . import tests as chat_tests
from .typing import (RATE_WINDOW_LIMIT, latest_metadata,
                     notify_live_typing_settings, record_event, route_key)

FIXTURE = {
    'SECRET_KEY': 'live-typing-tests-only-not-a-deployment-secret-2026',
    'PASSWORD_HASHERS': ['django.contrib.auth.hashers.MD5PasswordHasher'],
    'CACHES': {'default': {'BACKEND': 'django.core.cache.backends.locmem.LocMemCache',
                           'LOCATION': 'live-typing-isolated-tests'}},
    'CHANNEL_LAYERS': {'default': {'BACKEND': 'channels.layers.InMemoryChannelLayer'}},
}


@override_settings(**FIXTURE)
class LiveTypingTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.alice = Usuario.objects.create_user(username='draft_alice', password='FixtureStrong!2026',
                                               email='draft-alice@example.test')
        cls.bob = Usuario.objects.create_user(username='draft_bob')
        cls.eve = Usuario.objects.create_user(username='draft_eve')
        cls.connection = Connection.objects.create(sender=cls.alice, receiver=cls.bob, accepted=True)
        cls.other = Connection.objects.create(sender=cls.bob, receiver=cls.eve, accepted=True)

    def setUp(self):
        cache.clear()
        self.client = APIClient()
        self.client.force_authenticate(self.alice)

    def consumer(self, user=None):
        return chat_tests.ChatConsumerMediaTests.make_consumer(self, user or self.alice)

    def opt_in(self, *, revision=1):
        Usuario.objects.filter(pk=self.alice.pk).update(typing_draft_enabled=True, typing_draft_revision=revision)

    def send(self, consumer=None, **overrides):
        consumer = consumer or self.consumer()
        consumer.receive(json.dumps({'source': 'message.type', 'connectionId': self.connection.pk,
                                     'historyRevision': 0, 'isTyping': True, 'draftRevision': 1,
                                     'clientSequence': 1, 'draft': 'A synthetic private draft', **overrides}))
        return consumer

    def deliver(self, event, user=None):
        consumer = self.consumer(user or self.bob)
        consumer.broadcast_group(event)
        return consumer.sent_messages

    def test_default_is_disabled_and_preference_fields_are_private(self):
        own = CurrentUsuarioSerializer(self.alice).data
        self.assertEqual((own['liveTypingEnabled'], own['liveTypingRevision']), (False, 0))
        public = UsuarioSerializer(self.alice).data
        self.assertNotIn('liveTypingEnabled', public)
        self.assertNotIn('liveTypingRevision', public)
        signup = self.client.post('/chat/signup/', {'username': 'draft_new', 'first_name': 'New',
            'last_name': 'Fixture', 'password': 'Unique!Synthetic-92', 'email': 'draft-new@example.test',
            'liveTypingEnabled': True, 'liveTypingRevision': 100}, format='json')
        self.assertEqual(signup.status_code, 201)
        self.assertEqual((signup.data['user']['liveTypingEnabled'], signup.data['user']['liveTypingRevision']), (False, 0))

    def test_patch_toggle_is_strict_idempotent_and_preserves_other_private_fields(self):
        old_password, old_email, old_auth = self.alice.password, self.alice.email, self.alice.auth_version
        for value, revision in ((True, 1), (True, 1), (False, 2), (False, 2)):
            with patch('chat.services.send_group'), self.captureOnCommitCallbacks(execute=True):
                response = self.client.patch('/chat/me/', {'liveTypingEnabled': value, 'liveTypingRevision': 500}, format='json')
            self.assertEqual(response.status_code, 200)
            self.assertEqual((response.data['user']['liveTypingEnabled'], response.data['user']['liveTypingRevision']), (value, revision))
        self.alice.refresh_from_db()
        self.assertEqual((self.alice.password, self.alice.email, self.alice.auth_version), (old_password, old_email, old_auth))
        for value in (None, 'true', 'false', 1, 0, [], {}):
            response = self.client.patch('/chat/me/', {'liveTypingEnabled': value}, format='json')
            self.assertEqual(response.status_code, 400)
            self.assertIn('liveTypingEnabled', response.data)

    def test_push_token_and_stale_request_instances_do_not_rollback_preference(self):
        self.opt_in(revision=4)
        response = self.client.patch('/chat/me/', {'pushToken': 'fixture-push'}, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual((response.data['user']['liveTypingEnabled'], response.data['user']['liveTypingRevision']), (True, 4))
        with patch('chat.services.send_group'), self.captureOnCommitCallbacks(execute=True):
            response = self.client.patch('/chat/me/', {'liveTypingEnabled': False}, format='json')
        self.assertEqual(response.data['user']['liveTypingRevision'], 5)
        self.alice.refresh_from_db()
        self.assertEqual(self.alice.pushToken, 'fixture-push')

    def test_unauthenticated_and_revoked_jwt_cannot_update_settings(self):
        access = RefreshToken.for_user(self.alice).access_token
        access['auth_version'] = 0
        self.client.force_authenticate(None)
        self.assertEqual(self.client.patch('/chat/me/', {'liveTypingEnabled': True}, format='json').status_code, 401)
        self.client.credentials(HTTP_AUTHORIZATION='Bearer ' + str(access))
        Usuario.objects.filter(pk=self.alice.pk).update(auth_version=1)
        self.assertEqual(self.client.patch('/chat/me/', {'liveTypingEnabled': True}, format='json').status_code, 401)
        self.alice.refresh_from_db()
        self.assertFalse(self.alice.typing_draft_enabled)

    def test_opt_in_draft_reaches_only_contact_and_cache_never_contains_text(self):
        self.opt_in()
        marker = 'synthetic-draft-not-for-storage-8294'
        backend = caches['default']
        with patch.object(backend, 'set', wraps=backend.set) as writes:
            consumer = self.send(draft=marker)
        event = consumer.sent_groups[0]
        self.assertEqual((event['group'], event['data']['draft']), (self.bob.username, marker))
        metadata = latest_metadata(self.alice.pk, self.connection.pk)
        self.assertNotIn('draft', metadata)
        self.assertNotIn(marker, repr(metadata))
        self.assertTrue(writes.called)
        for call in writes.call_args_list:
            self.assertNotIn(marker, repr(call))
        self.assertEqual(self.deliver(event)[0]['data']['draft'], marker)
        self.assertFalse(self.deliver(event, self.alice))
        self.assertFalse(self.deliver(event, self.eve))
        self.assertFalse(Message.objects.exists())
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.updated, type(self).connection.updated)

    def test_disabled_or_stale_preference_never_relays_text_and_returns_own_settings(self):
        for enabled, revision in ((False, 0), (False, 1), (True, 2)):
            Usuario.objects.filter(pk=self.alice.pk).update(typing_draft_enabled=enabled, typing_draft_revision=revision)
            consumer = self.send()
            self.assertEqual(len(consumer.sent_groups), 1)
            self.assertEqual((consumer.sent_groups[0]['group'], consumer.sent_groups[0]['source']),
                             (self.alice.username, 'typing.settings'))
            self.assertNotIn('draft', consumer.sent_groups[0]['data'])

    def test_legacy_indicator_remains_usable_without_sharing_text(self):
        consumer = self.consumer()
        consumer.receive_message_type({'username': self.bob.username})
        event = consumer.sent_groups[0]
        self.assertIsNone(event['data']['draft'])
        self.assertEqual(event['data']['draftRevision'], 0)
        self.assertTrue(self.deliver(event))

    def test_draft_length_unicode_bounds_and_errors_never_echo_content(self):
        self.opt_in()
        self.assertEqual(self.send(draft='🙂' * 500).sent_groups[0]['data']['draft'], '🙂' * 500)
        for value in ('sensitive-marker-' + 'a' * 501, '🙂' * 501, '\ud800', 42, False, [], {}):
            consumer = self.send(draft=value)
            self.assertFalse(consumer.sent_groups)
            self.assertEqual(consumer.sent_messages[-1]['source'], 'error')
            self.assertNotIn('sensitive-marker', json.dumps(consumer.sent_messages))
            self.assertNotIn('draft', consumer.sent_messages[-1])

    def test_typing_frame_is_bounded_without_echoing_extra_payload(self):
        self.opt_in()
        consumer = self.send(unused='private-extra-marker-' + 'x' * 9000)
        self.assertFalse(consumer.sent_groups)
        self.assertNotIn('private-extra-marker', json.dumps(consumer.sent_messages))

    def test_client_sequence_rejects_replays_including_stop(self):
        self.opt_in()
        consumer = self.send(clientSequence=2)
        self.send(consumer, clientSequence=1, draft='older')
        self.send(consumer, clientSequence=2, isTyping=False, draft=None)
        self.assertEqual(len(consumer.sent_groups), 1)
        self.send(consumer, clientSequence=3, isTyping=False, draft=None)
        self.assertEqual(len(consumer.sent_groups), 2)
        self.assertIsNone(consumer.sent_groups[-1]['data']['draft'])
        for sequence in (True, 0, -1, 2 ** 31, '1', [], {}):
            self.assertFalse(self.send(clientSequence=sequence).sent_groups)

    def test_queued_start_is_discarded_after_newer_stop(self):
        self.opt_in()
        consumer = self.send()
        first = consumer.sent_groups[0]
        self.send(consumer, clientSequence=2, isTyping=False, draft=None)
        stop = consumer.sent_groups[-1]
        self.assertGreater(stop['data']['sequence'], first['data']['sequence'])
        self.assertFalse(self.deliver(first))
        self.assertTrue(self.deliver(stop))

    def test_older_socket_stop_and_disconnect_do_not_clear_newer_device(self):
        self.opt_in()
        old = self.send()
        newest = self.send(draft='new device')
        event = newest.sent_groups[0]
        self.assertNotEqual(event['data']['streamId'], old.sent_groups[0]['data']['streamId'])
        self.send(old, clientSequence=2, isTyping=False, draft=None)
        self.assertEqual(len(old.sent_groups), 1)
        old.disconnect(1000)
        self.assertEqual(len(old.sent_groups), 1)
        self.assertTrue(self.deliver(event))
        newest.disconnect(1000)
        stop = newest.sent_groups[-1]
        self.assertIs(stop['data']['isTyping'], False)
        self.assertGreater(stop['data']['sequence'], event['data']['sequence'])
        self.assertFalse(self.deliver(event))
        self.assertTrue(self.deliver(stop))

    def test_counter_survives_metadata_expiry_and_old_draft_cannot_return(self):
        self.opt_in()
        first = self.send().sent_groups[0]
        cache.delete(route_key(self.alice.pk, self.connection.pk) + '.state')
        newer = self.send(draft='after metadata TTL').sent_groups[0]
        self.assertGreater(newer['data']['sequence'], first['data']['sequence'])
        self.assertFalse(self.deliver(first))
        self.assertTrue(self.deliver(newer))

    def test_current_metadata_is_checked_again_at_delivery_for_all_epochs(self):
        self.opt_in()
        for mutation in ('preference', 'history', 'auth', 'deactivated', 'unaccepted'):
            with self.subTest(mutation=mutation):
                cache.clear()
                event = self.send().sent_groups[0]
                if mutation == 'preference':
                    Usuario.objects.filter(pk=self.alice.pk).update(typing_draft_enabled=False, typing_draft_revision=2)
                elif mutation == 'history':
                    Connection.objects.filter(pk=self.connection.pk).update(history_revision=1)
                elif mutation == 'auth':
                    Usuario.objects.filter(pk=self.alice.pk).update(auth_version=1)
                elif mutation == 'deactivated':
                    Usuario.objects.filter(pk=self.alice.pk).update(is_active=False)
                else:
                    Connection.objects.filter(pk=self.connection.pk).update(accepted=False)
                self.assertFalse(self.deliver(event))
                Usuario.objects.filter(pk=self.alice.pk).update(typing_draft_enabled=True, typing_draft_revision=1,
                                                               auth_version=0, is_active=True)
                Connection.objects.filter(pk=self.connection.pk).update(history_revision=0, accepted=True)

    def test_expired_draft_is_not_delivered_even_when_metadata_is_current(self):
        self.opt_in()
        event = self.send().sent_groups[0]
        with patch('chat.consumers.timezone.now', return_value=timezone.now() + timedelta(seconds=6)):
            self.assertFalse(self.deliver(event))

    def test_disable_notifies_own_devices_and_clears_only_accepted_contacts(self):
        self.opt_in()
        extra = Connection.objects.create(sender=self.alice, receiver=self.eve, accepted=True)
        pending_user = Usuario.objects.create_user(username='draft_pending')
        Connection.objects.create(sender=self.alice, receiver=pending_user)
        first = self.send().sent_groups[0]
        with patch('chat.services.send_group') as sent, self.captureOnCommitCallbacks(execute=True):
            response = self.client.patch('/chat/me/', {'liveTypingEnabled': False}, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(sent.call_args_list), 3)
        own, *peers = sent.call_args_list
        self.assertEqual(own.args, (self.alice.username, 'typing.settings',
                                  {'liveTypingEnabled': False, 'liveTypingRevision': 2}))
        self.assertEqual({call.args[0] for call in peers}, {self.bob.username, self.eve.username})
        stop = next(call.args[2] for call in peers if call.args[0] == self.bob.username)
        self.assertEqual((stop['draft'], stop['isTyping'], stop['draftRevision']), (None, False, 2))
        self.assertEqual(stop['streamId'], first['data']['streamId'])
        self.assertGreater(stop['sequence'], first['data']['sequence'])
        self.assertFalse(self.deliver(first))
        self.assertTrue(self.deliver({'source': 'message.type', 'data': stop}))
        self.assertEqual(latest_metadata(self.alice.pk, extra.pk)['draftRevision'], 2)

    def test_older_validated_writer_cannot_replace_metadata_after_disable(self):
        self.opt_in()
        self.alice.refresh_from_db()
        old_user = self.alice
        first = self.send().sent_groups[0]
        Usuario.objects.filter(pk=self.alice.pk).update(typing_draft_enabled=False, typing_draft_revision=2)
        with patch('chat.services.send_group'):
            notify_live_typing_settings(self.alice.pk)
        stale = record_event(old_user, self.connection, stream_id=first['data']['streamId'],
                             is_typing=True, expires_at=first['data']['expiresAt'])
        self.assertIsNone(stale)
        self.assertFalse(self.deliver(first))
        self.assertEqual(latest_metadata(self.alice.pk, self.connection.pk)['draftRevision'], 2)

    def test_counter_and_latest_state_both_must_match_before_delivery(self):
        self.opt_in()
        event = self.send().sent_groups[0]
        cache.incr(route_key(self.alice.pk, self.connection.pk) + '.counter')
        self.assertFalse(self.deliver(event))

    def test_concurrent_metadata_publishers_preserve_the_highest_sequence(self):
        self.opt_in()
        self.alice.refresh_from_db()
        expiry = (timezone.now() + timedelta(seconds=5)).isoformat()

        def publish(_index):
            return record_event(self.alice, self.connection, stream_id=str(uuid4()),
                                is_typing=True, expires_at=expiry)

        with ThreadPoolExecutor(max_workers=8) as executor:
            events = list(executor.map(publish, range(40)))
        self.assertTrue(all(event is not None for event in events))
        self.assertEqual(len({event['sequence'] for event in events}), 40)
        latest = latest_metadata(self.alice.pk, self.connection.pk)
        self.assertEqual(latest['sequence'], max(event['sequence'] for event in events))
        self.assertEqual(cache.get(route_key(self.alice.pk, self.connection.pk) + '.counter'), latest['sequence'])

    def test_typing_settings_snapshot_and_queued_older_settings_guard(self):
        self.opt_in(revision=3)
        consumer = self.consumer()
        consumer.receive(json.dumps({'source': 'typing.settings', 'username': self.eve.username}))
        self.assertEqual(consumer.sent_groups, [{'group': self.alice.username, 'source': 'typing.settings',
            'data': {'liveTypingEnabled': True, 'liveTypingRevision': 3}}])
        own = self.consumer()
        own.broadcast_group({'source': 'typing.settings', 'data': {'liveTypingEnabled': True, 'liveTypingRevision': 2}})
        self.assertFalse(own.sent_messages)
        own.broadcast_group({'source': 'typing.settings', 'data': {'liveTypingEnabled': True, 'liveTypingRevision': 3,
                                                                 'draft': 'must not echo'}})
        self.assertEqual(own.sent_messages[0]['data'], {'liveTypingEnabled': True, 'liveTypingRevision': 3})

    def test_budget_allows_debounced_typing_and_stop_always_clears(self):
        self.opt_in()
        consumer = self.consumer()
        with patch('chat.typing.time', return_value=2000):
            for sequence in range(1, RATE_WINDOW_LIMIT + 3):
                self.send(consumer, clientSequence=sequence)
        self.assertEqual(len(consumer.sent_groups), RATE_WINDOW_LIMIT)
        self.send(consumer, clientSequence=RATE_WINDOW_LIMIT + 3, isTyping=False, draft=None)
        self.assertEqual(len(consumer.sent_groups), RATE_WINDOW_LIMIT + 1)
        self.assertIs(consumer.sent_groups[-1]['data']['isTyping'], False)
        with patch('chat.services.send_group') as sent, self.captureOnCommitCallbacks(execute=True):
            self.client.patch('/chat/me/', {'liveTypingEnabled': False}, format='json')
        self.assertEqual(len(sent.call_args_list), 2)

    def test_cache_failure_cannot_enable_sharing_or_bypass_delivery_guard(self):
        self.opt_in()
        with patch('chat.consumers.start_allowed', return_value=True), patch.object(caches['default'], 'get', side_effect=RuntimeError('fixture outage')):
            consumer = self.send()
        self.assertFalse(consumer.sent_groups)

    def test_real_authenticated_websockets_draft_snapshot_and_disable_two_devices(self):
        self.opt_in()
        app = JWTAuthMiddleware(ChatConsumer.as_asgi())
        tokens = [str(RefreshToken.for_user(user).access_token)
                  for user in (self.alice, self.alice, self.bob, self.bob, self.eve)]

        @database_sync_to_async
        def disable():
            Usuario.objects.filter(pk=self.alice.pk).update(typing_draft_enabled=False, typing_draft_revision=2)
            notify_live_typing_settings(self.alice.pk)

        async def probe():
            sockets = [WebsocketCommunicator(app, '/ws/chat/?token=' + token) for token in tokens]
            try:
                for socket in sockets:
                    self.assertTrue((await socket.connect())[0])
                alice, alice_other, bob, bob_other, eve = sockets
                await alice.send_json_to({'source': 'typing.settings'})
                for own in (alice, alice_other):
                    self.assertEqual((await own.receive_json_from())['data'],
                                     {'liveTypingEnabled': True, 'liveTypingRevision': 1})
                await alice.send_json_to({'source': 'message.type', 'connectionId': self.connection.pk,
                    'historyRevision': 0, 'isTyping': True, 'draftRevision': 1, 'clientSequence': 1,
                    'draft': 'Synthetic socket draft'})
                for peer in (bob, bob_other):
                    self.assertEqual((await peer.receive_json_from())['data']['draft'], 'Synthetic socket draft')
                self.assertTrue(await eve.receive_nothing(timeout=0.03))
                await disable()
                for own in (alice, alice_other):
                    event = await own.receive_json_from()
                    self.assertEqual(event['source'], 'typing.settings')
                    self.assertEqual(event['data'], {'liveTypingEnabled': False, 'liveTypingRevision': 2})
                for peer in (bob, bob_other):
                    event = await peer.receive_json_from()
                    self.assertEqual((event['data']['isTyping'], event['data']['draft'], event['data']['draftRevision']),
                                     (False, None, 2))
                self.assertTrue(await eve.receive_nothing(timeout=0.03))
            finally:
                for socket in sockets:
                    await socket.disconnect()
        async_to_sync(probe)()
