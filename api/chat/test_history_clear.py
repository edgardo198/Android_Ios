import base64
import json
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from unittest.mock import Mock, patch
from uuid import uuid4

from asgiref.sync import async_to_sync
from channels.db import database_sync_to_async
from channels.testing import WebsocketCommunicator
from django.core.files.base import ContentFile
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import OperationalError, close_old_connections
from django.test import TestCase, TransactionTestCase, override_settings
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from .consumers import ChatConsumer
from .media_access import media_url
from .middleware import JWTAuthMiddleware
from .models import Connection, Message, Usuario
from .services import ChatServiceError, build_message_payload, clear_connection_history, create_text_message


class HistoryFixtures:
    def setUp(self):
        super().setUp()
        self.directory = tempfile.TemporaryDirectory(prefix='chat-clear-history-')
        self.override = override_settings(MEDIA_ROOT=self.directory.name)
        self.override.enable()
        self.addCleanup(self.directory.cleanup)
        self.addCleanup(self.override.disable)
        self.alice = Usuario.objects.create_user(username='clear_alice')
        self.bob = Usuario.objects.create_user(username='clear_bob')
        self.eve = Usuario.objects.create_user(username='clear_eve')
        self.connection = Connection.objects.create(sender=self.alice, receiver=self.bob, accepted=True)
        self.client = APIClient()
        self.client.force_authenticate(self.alice)

    def consumer(self, user):
        consumer = ChatConsumer()
        consumer.scope = {'user': user}
        consumer.sent = []
        consumer.groups = []
        consumer.send = lambda *args, **kwargs: consumer.sent.append(json.loads(kwargs.get('text_data') or args[0]))
        consumer.send_group = lambda group, source, data: consumer.groups.append({'group': group, 'source': source, 'data': data})
        consumer.send_push_notification = Mock()
        return consumer

    def clear(self):
        response = self.client.delete(f'/chat/connections/{self.connection.pk}/history/')
        self.assertEqual(response.status_code, 200, response.data)
        return response.data


@override_settings(PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher'])
class SharedMessageHistoryTests(HistoryFixtures, TestCase):
    def test_clear_authentication_membership_and_accepted_friendship(self):
        endpoint = f'/chat/connections/{self.connection.pk}/history/'
        self.client.force_authenticate(None)
        self.assertEqual(self.client.delete(endpoint).status_code, 401)
        self.client.force_authenticate(self.eve)
        self.assertEqual(self.client.delete(endpoint).status_code, 403)
        self.client.force_authenticate(self.alice)
        self.connection.accepted = False
        self.connection.save(update_fields=['accepted'])
        self.assertEqual(self.client.delete(endpoint).status_code, 400)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.history_revision, 0)

    def test_both_histories_previews_and_unreads_clear_without_removing_friendship_or_ledger(self):
        old, _created = create_text_message(self.alice, self.connection, 'Before', str(uuid4()))
        received = Message.objects.create(connection=self.connection, user=self.bob, text='Incoming')
        unrelated = Connection.objects.create(sender=self.alice, receiver=self.eve, accepted=True)
        other = Message.objects.create(connection=unrelated, user=self.eve, text='Other conversation')
        result = self.clear()
        self.assertEqual(result['clearedThrough'], received.pk)
        self.assertEqual(result['revision'], 1)
        self.assertIsNotNone(result['clearedAt'])
        self.connection.refresh_from_db()
        self.assertTrue(self.connection.accepted)
        self.assertEqual(Message.objects.count(), 3)
        for user in (self.alice, self.bob):
            consumer = self.consumer(user)
            consumer.receive_message_list({'connectionId': self.connection.pk})
            self.assertEqual(consumer.sent[-1]['data']['messages'], [])
            self.assertEqual(consumer.sent[-1]['data']['revision'], 1)
            consumer.receive_friend_list({})
            friend = next(row for row in consumer.groups[-1]['data'] if row['id'] == self.connection.pk)
            self.assertIsNone(friend['message'])
            self.assertEqual((friend['unreadCount'], friend['isNew'], friend['clearedThrough']), (0, False, received.pk))
        self.assertTrue(Message.objects.get(pk=old.pk).client_id)
        self.assertEqual(Message.objects.get(pk=other.pk).text, 'Other conversation')

    def test_new_messages_survive_cutoff_and_need_current_revision_even_with_stale_connection_object(self):
        old = Message.objects.create(connection=self.connection, user=self.bob, text='old')
        self.clear()
        for revision in (None, 0, True, 'bad', '9' * 100):
            consumer = self.consumer(self.alice)
            consumer.receive_message_send({'connectionId': self.connection.pk, 'message': 'late pending',
                                           'clientId': str(uuid4()), 'historyRevision': revision})
            error = consumer.sent[-1]
            self.assertEqual(error['code'], 'history_cleared')
            self.assertEqual(error['data']['clearedThrough'], old.pk)
            self.assertEqual(error['data']['revision'], 1)
            self.assertFalse(consumer.groups)
        current, _created = create_text_message(self.alice, self.connection, 'After', str(uuid4()), history_revision=1)
        self.assertGreater(current.pk, old.pk)
        for user in (self.alice, self.bob):
            consumer = self.consumer(user)
            consumer.receive_message_list({'connectionId': self.connection.pk})
            self.assertEqual([row['id'] for row in consumer.sent[-1]['data']['messages']], [current.pk])

    def test_retry_of_hidden_client_id_acknowledges_without_content_broadcast_or_duplication(self):
        client_id = str(uuid4())
        original, _created = create_text_message(self.alice, self.connection, 'Private old text', client_id)
        self.clear()
        consumer = self.consumer(self.alice)
        consumer.receive_message_send({'connectionId': self.connection.pk, 'message': 'Private old text',
                                       'clientId': client_id, 'historyRevision': 0})
        ack = consumer.sent[-1]
        self.assertEqual(ack['source'], 'message.ack')
        self.assertEqual((ack['data']['messageId'], ack['data']['clientId'], ack['data']['historyCleared']), (original.pk, client_id, True))
        self.assertNotIn('message', ack['data'])
        self.assertNotIn('Private old text', json.dumps(ack))
        self.assertEqual(Message.objects.count(), 1)
        self.assertFalse(consumer.groups)
        consumer.send_push_notification.assert_not_called()

    def test_read_receipts_skip_hidden_rows_and_only_mark_new_visible_messages(self):
        hidden = Message.objects.create(connection=self.connection, user=self.bob, text='Hidden', is_new=True)
        self.clear()
        consumer = self.consumer(self.alice)
        consumer.receive_message_read({'messageId': hidden.pk})
        self.assertEqual(consumer.sent[-1]['source'], 'error')
        visible = Message.objects.create(connection=self.connection, user=self.bob, text='Visible', is_new=True)
        consumer.receive_message_read({'connectionId': self.connection.pk})
        self.assertEqual(consumer.groups[0]['data']['messageIds'], [visible.pk])
        hidden.refresh_from_db(); visible.refresh_from_db()
        self.assertTrue(hidden.is_new)
        self.assertFalse(visible.is_new)

    def test_existing_private_tickets_and_new_access_are_revoked_for_both_participants(self):
        message = Message.objects.create(connection=self.connection, user=self.alice, text='Audio')
        message.audio.save('old.m4a', ContentFile(b'old audio'))
        path = Path(message.audio.path)
        tickets = []
        for user in (self.alice, self.bob):
            self.client.force_authenticate(user)
            tickets.append(self.client.post(media_url(message.pk, 'audio') + 'access/').data['url'])
        self.clear()
        for user in (self.alice, self.bob):
            self.client.force_authenticate(user)
            self.assertEqual(self.client.post(media_url(message.pk, 'audio') + 'access/').status_code, 404)
            self.assertEqual(self.client.get(media_url(message.pk, 'audio')).status_code, 404)
        anonymous = APIClient()
        for ticket in tickets:
            self.assertEqual(anonymous.get(ticket).status_code, 404)
        self.assertTrue(path.is_file())

    def test_media_uploads_reject_old_revision_before_saving_and_accept_current(self):
        self.clear()
        endpoint = '/chat/messages/media/'
        response = self.client.post(endpoint, {'connectionId': self.connection.pk, 'type': 'audio', 'historyRevision': 0,
                                              'file': SimpleUploadedFile('note.m4a', b'audio', content_type='audio/mp4')}, format='multipart')
        self.assertEqual((response.status_code, response.data['code'], response.data['revision']), (409, 'history_cleared', 1))
        self.assertFalse(Message.objects.exists())
        self.assertEqual(list(Path(self.directory.name).rglob('*.m4a')), [])
        consumer = self.consumer(self.bob)
        consumer.receive_message_send_audio({'connectionId': self.connection.pk, 'historyRevision': 0,
                                            'filename': 'old.m4a', 'base64': base64.b64encode(b'audio').decode()})
        self.assertEqual(consumer.sent[-1]['code'], 'history_cleared')
        response = self.client.post(endpoint, {'connectionId': self.connection.pk, 'type': 'audio', 'historyRevision': 1,
                                              'file': SimpleUploadedFile('new.m4a', b'audio', content_type='audio/mp4')}, format='multipart')
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual(response.data['revision'], 1)
        self.assertEqual(Message.objects.count(), 1)

    def test_old_queued_group_message_is_not_delivered_after_clear(self):
        old, _created = create_text_message(self.alice, self.connection, 'queued', str(uuid4()))
        outgoing = build_message_payload(old, self.alice, self.bob)
        incoming = build_message_payload(old, self.bob, self.alice)
        self.clear()
        sender, receiver = self.consumer(self.alice), self.consumer(self.bob)
        sender.broadcast_group({'source': 'message.send', 'data': outgoing})
        receiver.broadcast_group({'source': 'message.send', 'data': incoming})
        self.assertEqual(sender.sent[-1]['source'], 'message.ack')
        self.assertNotIn('queued', json.dumps(sender.sent))
        self.assertFalse(receiver.sent)

    def test_clearing_empty_history_still_invalidates_offline_unsent_pending_revision(self):
        first, second = self.clear(), self.clear()
        self.assertEqual((first['clearedThrough'], second['clearedThrough']), (0, 0))
        self.assertEqual((first['revision'], second['revision']), (1, 2))
        consumer = self.consumer(self.alice)
        consumer.receive_message_send({'connectionId': self.connection.pk, 'message': 'old unsent',
                                       'clientId': str(uuid4()), 'historyRevision': 1})
        self.assertEqual(consumer.sent[-1]['data']['revision'], 2)
        self.assertFalse(Message.objects.exists())


@override_settings(PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher'],
                   CHANNEL_LAYERS={'default': {'BACKEND': 'channels.layers.InMemoryChannelLayer'}})
class SharedMessageHistorySocketTests(HistoryFixtures, TransactionTestCase):
    def test_message_send_racing_clear_is_either_hidden_once_or_rejected_as_old_revision(self):
        barrier = Barrier(2)
        client_id = str(uuid4())

        def send():
            close_old_connections()
            try:
                barrier.wait(timeout=5)
                for attempt in range(20):
                    try:
                        message, _created = create_text_message(self.alice, self.connection, 'Concurrent pending', client_id, history_revision=0)
                        return message.pk
                    except ChatServiceError as error:
                        if error.code == 'history_cleared':
                            return None
                        time.sleep(0.01 * (attempt + 1))
                self.fail('No se pudo completar el envío concurrente de prueba.')
            finally:
                close_old_connections()

        def clear():
            close_old_connections()
            try:
                barrier.wait(timeout=5)
                for attempt in range(20):
                    try:
                        return clear_connection_history(self.bob, self.connection.pk)
                    except OperationalError:
                        time.sleep(0.01 * (attempt + 1) + 0.003)
                self.fail('No se pudo completar el borrado concurrente de prueba.')
            finally:
                close_old_connections()

        with patch('chat.services.logger.exception'), ThreadPoolExecutor(max_workers=2) as pool:
            sending, clearing = pool.submit(send), pool.submit(clear)
            message_id, result = sending.result(timeout=10), clearing.result(timeout=10)
        self.assertEqual(result['revision'], 1)
        if message_id is not None:
            self.assertGreaterEqual(result['clearedThrough'], message_id)
            self.assertEqual(Message.objects.filter(client_id=client_id).count(), 1)
        else:
            self.assertFalse(Message.objects.filter(client_id=client_id).exists())
        for user in (self.alice, self.bob):
            consumer = self.consumer(user)
            consumer.receive_message_list({'connectionId': self.connection.pk})
            self.assertEqual(consumer.sent[-1]['data']['messages'], [])

    def test_clear_is_delivered_to_both_participants_all_devices_and_no_stranger(self):
        Message.objects.create(connection=self.connection, user=self.alice, text='old')

        async def run():
            def socket(user):
                return WebsocketCommunicator(JWTAuthMiddleware(ChatConsumer.as_asgi()),
                                             '/ws/chat/?token=' + str(RefreshToken.for_user(user).access_token))
            alice, alice_other, bob, eve = [socket(user) for user in (self.alice, self.alice, self.bob, self.eve)]
            sockets = [alice, alice_other, bob, eve]
            try:
                for connection in sockets:
                    self.assertTrue((await connection.connect())[0])
                result = await database_sync_to_async(clear_connection_history)(self.alice, self.connection.pk)
                for connection in (alice, alice_other, bob):
                    event = await connection.receive_json_from()
                    self.assertEqual(event, {'source': 'message_history_cleared', 'data': result})
                self.assertTrue(await eve.receive_nothing(timeout=0.05))
            finally:
                for connection in sockets:
                    await connection.disconnect()
        async_to_sync(run)()
