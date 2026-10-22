import base64
import json
import shutil
import tempfile
from datetime import timedelta
from io import BytesIO
from unittest.mock import patch
from unittest.mock import Mock
from uuid import uuid4

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from channels.testing import WebsocketCommunicator
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import DatabaseError, IntegrityError, transaction
from django.test import TestCase, override_settings
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken
from PIL import Image

from .consumers import ChatConsumer
from .models import Connection, Message, Usuario
from .middleware import JWTAuthMiddleware, NativeAllowedHostsOriginValidator
from .serializers import UsuarioSerializer
from .services import user_group_name


def encode_bytes(raw_bytes):
    return base64.b64encode(raw_bytes).decode('utf-8')


def image_bytes(format='JPEG'):
    output = BytesIO()
    Image.new('RGB', (2, 2), 'blue').save(output, format=format)
    return output.getvalue()


@override_settings(MEDIA_ROOT=tempfile.gettempdir())
@override_settings(PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher'])
class ChatConsumerMediaTests(TestCase):
    def setUp(self):
        self.media_root = tempfile.mkdtemp(prefix='chat-media-tests-')
        self.override = override_settings(MEDIA_ROOT=self.media_root)
        self.override.enable()

        self.sender = Usuario.objects.create_user(
            username='alice',
            password='supersecret123',
            first_name='Alice',
            last_name='Sender',
        )
        self.receiver = Usuario.objects.create_user(
            username='bob',
            password='supersecret123',
            first_name='Bob',
            last_name='Receiver',
        )
        self.connection = Connection.objects.create(
            sender=self.sender,
            receiver=self.receiver,
            accepted=True,
        )

    def tearDown(self):
        self.override.disable()
        shutil.rmtree(self.media_root, ignore_errors=True)

    def make_consumer(self, user):
        consumer = ChatConsumer()
        consumer.scope = {'user': user}
        consumer.sent_groups = []
        consumer.sent_messages = []
        consumer.closed_codes = []
        consumer.close = lambda code=None, **kwargs: consumer.closed_codes.append(code)
        consumer.send_group = lambda group, source, data: consumer.sent_groups.append(
            {'group': group, 'source': source, 'data': data}
        )

        def capture_send(*args, **kwargs):
            text_data = kwargs.get('text_data') or (args[0] if args else None)
            if text_data:
                consumer.sent_messages.append(json.loads(text_data))

        consumer.send = capture_send
        return consumer

    @patch('chat.consumers.ChatConsumer.send_push_notification', autospec=True)
    def test_receive_message_send_image_saves_message_and_broadcasts(self, mocked_push):
        consumer = self.make_consumer(self.sender)

        consumer.receive_message_send_image(
            {
                'connectionId': self.connection.id,
                'base64': encode_bytes(image_bytes()),
                'filename': 'photo.jpg',
            }
        )

        message = Message.objects.get(connection=self.connection)
        self.assertTrue(message.image.name.endswith('photo.jpg'))
        self.assertEqual(len(consumer.sent_groups), 2)
        self.assertTrue(all(event['source'] == 'message.send' for event in consumer.sent_groups))
        self.assertEqual(consumer.sent_groups[0]['data']['message']['type'], 'image')
        mocked_push.assert_not_called()

    @patch('chat.consumers.ChatConsumer.send_push_notification', autospec=True)
    def test_receive_message_send_audio_saves_message_and_broadcasts(self, mocked_push):
        consumer = self.make_consumer(self.sender)

        consumer.receive_message_send_audio(
            {
                'connectionId': self.connection.id,
                'base64': encode_bytes(b'audio-bytes'),
                'filename': 'voice-note.m4a',
            }
        )

        message = Message.objects.get(connection=self.connection)
        self.assertTrue(message.audio.name.endswith('voice-note.m4a'))
        self.assertEqual(len(consumer.sent_groups), 2)
        self.assertEqual(consumer.sent_groups[0]['data']['message']['type'], 'audio')
        mocked_push.assert_not_called()

    @patch('chat.consumers.ChatConsumer.send_push_notification', autospec=True)
    def test_receive_message_send_video_saves_message_and_broadcasts(self, mocked_push):
        consumer = self.make_consumer(self.sender)

        consumer.receive_message_send_video(
            {
                'connectionId': self.connection.id,
                'base64': encode_bytes(b'video-bytes'),
                'filename': 'clip.mp4',
            }
        )

        message = Message.objects.get(connection=self.connection)
        self.assertTrue(message.video.name.endswith('clip.mp4'))
        self.assertEqual(len(consumer.sent_groups), 2)
        self.assertEqual(consumer.sent_groups[0]['data']['message']['type'], 'video')
        mocked_push.assert_not_called()

    @patch('chat.consumers.ChatConsumer.send_push_notification', autospec=True)
    def test_receive_message_send_document_saves_message_and_broadcasts(self, mocked_push):
        consumer = self.make_consumer(self.sender)

        consumer.receive_message_send_document(
            {
                'connectionId': self.connection.id,
                'base64': encode_bytes(b'document-bytes'),
                'filename': 'report.pdf',
            }
        )

        message = Message.objects.get(connection=self.connection)
        self.assertTrue(message.document.name.endswith('report.pdf'))
        self.assertEqual(len(consumer.sent_groups), 2)
        self.assertEqual(consumer.sent_groups[0]['data']['message']['type'], 'document')
        mocked_push.assert_not_called()

    @patch('chat.consumers.ChatConsumer.send_push_notification', autospec=True)
    def test_receive_message_send_audio_accepts_data_url_base64(self, mocked_push):
        consumer = self.make_consumer(self.sender)

        consumer.receive_message_send_audio(
            {
                'connectionId': self.connection.id,
                'base64': f'data:audio/mp4;base64,{encode_bytes(b"audio-bytes")}',
                'filename': 'voice-note.m4a',
            }
        )

        message = Message.objects.get(connection=self.connection)
        self.assertTrue(message.audio.name.endswith('voice-note.m4a'))
        self.assertEqual(consumer.sent_groups[0]['data']['message']['type'], 'audio')
        mocked_push.assert_not_called()

    def test_receive_message_send_document_rejects_invalid_base64(self):
        consumer = self.make_consumer(self.sender)

        consumer.receive_message_send_document(
            {
                'connectionId': self.connection.id,
                'base64': 'not-valid-base64!!!',
                'filename': 'report.pdf',
            }
        )

        self.assertFalse(Message.objects.exists())
        self.assertEqual(consumer.sent_messages[-1]['source'], 'error')
        self.assertEqual(
            consumer.sent_messages[-1]['message'],
            'El archivo recibido no tiene un formato valido.',
        )

    def test_receive_miniatura_saves_data_url_base64(self):
        consumer = self.make_consumer(self.sender)

        consumer.receive_miniatura(
            {
                'base64': f'data:image/png;base64,{encode_bytes(image_bytes("PNG"))}',
                'filename': '../avatar.png',
            }
        )

        self.sender.refresh_from_db()
        self.assertTrue(self.sender.miniatura)
        self.assertTrue(self.sender.miniatura.name.startswith('miniatura/'))
        self.assertTrue(self.sender.miniatura.name.endswith('.png'))
        self.assertNotIn('..', self.sender.miniatura.name)
        self.assertEqual(len(consumer.sent_groups), 1)
        self.assertEqual(consumer.sent_groups[0]['source'], 'miniatura')
        self.assertEqual(consumer.sent_groups[0]['data']['username'], self.sender.username)

    def test_receive_miniatura_rejects_invalid_base64(self):
        consumer = self.make_consumer(self.sender)

        consumer.receive_miniatura(
            {
                'base64': 'data:image/png;base64,not-valid-base64!!!',
                'filename': 'avatar.png',
            }
        )

        self.sender.refresh_from_db()
        self.assertFalse(self.sender.miniatura)
        self.assertEqual(consumer.sent_messages[-1]['source'], 'error')
        self.assertEqual(
            consumer.sent_messages[-1]['message'],
            'El archivo recibido no tiene un formato valido.',
        )

    def test_receive_friend_list_includes_latest_video_preview(self):
        Message.objects.create(
            connection=self.connection,
            user=self.sender,
            text='Video recibido',
            video='videos/latest.mp4',
            is_new=True,
        )
        consumer = self.make_consumer(self.sender)

        consumer.receive_friend_list({})

        self.assertEqual(len(consumer.sent_groups), 1)
        payload = consumer.sent_groups[0]['data']
        self.assertEqual(payload[0]['preview'], '[Video]')
        self.assertEqual(payload[0]['message']['type'], 'video')

    def test_receive_friend_list_includes_latest_document_preview(self):
        Message.objects.create(
            connection=self.connection,
            user=self.sender,
            text='Documento recibido',
            document='documents/latest.pdf',
            is_new=True,
        )
        consumer = self.make_consumer(self.sender)

        consumer.receive_friend_list({})

        self.assertEqual(len(consumer.sent_groups), 1)
        payload = consumer.sent_groups[0]['data']
        self.assertEqual(payload[0]['preview'], '[Documento]')
        self.assertEqual(payload[0]['message']['type'], 'document')

    def test_receive_friend_list_marks_latest_message_sender_correctly(self):
        Message.objects.create(
            connection=self.connection,
            user=self.receiver,
            text='Hola desde Bob',
            is_new=True,
        )
        consumer = self.make_consumer(self.sender)

        consumer.receive_friend_list({})

        payload = consumer.sent_groups[0]['data']
        self.assertEqual(payload[0]['message']['type'], 'text')
        self.assertFalse(payload[0]['message']['is_me'])

    def test_receive_request_accept_broadcasts_friend_without_annotations(self):
        pending_connection = Connection.objects.create(
            sender=self.receiver,
            receiver=self.sender,
            accepted=False,
        )
        consumer = self.make_consumer(self.sender)

        consumer.receive_request_accept({'username': self.receiver.username})

        pending_connection.refresh_from_db()
        self.assertTrue(pending_connection.accepted)
        self.assertEqual(len(consumer.sent_groups), 4)
        self.assertEqual(
            [event['source'] for event in consumer.sent_groups],
            ['request.accept', 'request.accept', 'friend.new', 'friend.new'],
        )


@override_settings(MEDIA_ROOT=tempfile.gettempdir())
@override_settings(PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher'])
class MessageMediaUploadViewTests(TestCase):
    def setUp(self):
        self.media_root = tempfile.mkdtemp(prefix='chat-media-upload-tests-')
        self.override = override_settings(MEDIA_ROOT=self.media_root)
        self.override.enable()

        self.sender = Usuario.objects.create_user(
            username='alice',
            password='supersecret123',
            first_name='Alice',
            last_name='Sender',
        )
        self.receiver = Usuario.objects.create_user(
            username='bob',
            password='supersecret123',
            first_name='Bob',
            last_name='Receiver',
        )
        self.connection = Connection.objects.create(
            sender=self.sender,
            receiver=self.receiver,
            accepted=True,
        )
        self.client = APIClient()
        self.client.force_authenticate(user=self.sender)

    def tearDown(self):
        self.override.disable()
        shutil.rmtree(self.media_root, ignore_errors=True)

    def test_upload_endpoint_supports_all_media_types(self):
        cases = [
            ('image', 'image', 'photo.jpg', image_bytes(), 'image/jpeg'),
            ('audio', 'audio', 'voice-note.m4a', b'audio-bytes', 'audio/mp4'),
            ('video', 'video', 'clip.mp4', b'video-bytes', 'video/mp4'),
            ('document', 'document', 'report.pdf', b'document-bytes', 'application/pdf'),
        ]

        for media_type, field_name, filename, raw_bytes, content_type in cases:
            with self.subTest(media_type=media_type):
                upload = SimpleUploadedFile(filename, raw_bytes, content_type=content_type)

                response = self.client.post(
                    '/chat/messages/media/',
                    {
                        'connectionId': str(self.connection.id),
                        'type': media_type,
                        'file': upload,
                    },
                    format='multipart',
                )

                self.assertEqual(response.status_code, 201)
                self.assertEqual(response.data['message']['type'], media_type)
                self.assertEqual(response.data['message']['filename'], filename)
                self.assertEqual(response.data['friend']['username'], self.receiver.username)

                message = Message.objects.latest('id')
                self.assertTrue(getattr(message, field_name).name.endswith(filename))

                Message.objects.all().delete()

    def test_upload_endpoint_rejects_unknown_media_type(self):
        upload = SimpleUploadedFile('report.bin', b'payload', content_type='application/octet-stream')

        response = self.client.post(
            '/chat/messages/media/',
            {
                'connectionId': str(self.connection.id),
                'type': 'binary',
                'file': upload,
            },
            format='multipart',
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data['detail'], 'Tipo de archivo no soportado.')

    @patch('chat.services.send_push_notification')
    @patch('chat.services.send_group')
    def test_upload_endpoint_broadcasts_media_payload_to_both_users(self, mocked_send_group, mocked_push):
        self.receiver.pushToken = 'ExponentPushToken[test]'
        self.receiver.save(update_fields=['pushToken'])
        upload = SimpleUploadedFile('photo.jpg', image_bytes(), content_type='image/jpeg')

        response = self.client.post(
            '/chat/messages/media/',
            {
                'connectionId': str(self.connection.id),
                'type': 'image',
                'file': upload,
            },
            format='multipart',
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data['message']['type'], 'image')
        self.assertEqual(response.data['message']['filename'], 'photo.jpg')
        self.assertEqual(response.data['friend']['username'], self.receiver.username)

        self.assertEqual(mocked_send_group.call_count, 2)
        sender_group, sender_source, sender_payload = mocked_send_group.call_args_list[0].args
        receiver_group, receiver_source, receiver_payload = mocked_send_group.call_args_list[1].args

        self.assertEqual(sender_group, self.sender.username)
        self.assertEqual(receiver_group, self.receiver.username)
        self.assertEqual(sender_source, 'message.send')
        self.assertEqual(receiver_source, 'message.send')
        self.assertEqual(sender_payload['message']['type'], 'image')
        self.assertEqual(receiver_payload['message']['type'], 'image')
        self.assertTrue(sender_payload['message']['is_me'])
        self.assertFalse(receiver_payload['message']['is_me'])
        mocked_push.assert_called_once_with(
            self.receiver.pushToken,
            self.sender.username,
            'Imagen',
        )

    def test_upload_endpoint_rejects_empty_file(self):
        upload = SimpleUploadedFile('empty.pdf', b'', content_type='application/pdf')

        response = self.client.post(
            '/chat/messages/media/',
            {
                'connectionId': str(self.connection.id),
                'type': 'document',
                'file': upload,
            },
            format='multipart',
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data['detail'], 'El archivo recibido esta vacio.')

    @patch('chat.services.send_group', side_effect=[RuntimeError('Redis unavailable'), None])
    def test_saved_upload_succeeds_when_realtime_delivery_fails(self, mocked_send_group):
        with self.assertLogs('chat.services', level='ERROR'):
            response = self.client.post(
                '/chat/messages/media/',
                {
                    'connectionId': str(self.connection.id),
                    'type': 'audio',
                    'file': SimpleUploadedFile('note.m4a', b'audio-bytes', content_type='audio/mp4'),
                },
                format='multipart',
            )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(Message.objects.count(), 1)
        self.assertEqual(mocked_send_group.call_count, 2)

    def test_upload_endpoint_rejects_invalid_connection_id(self):
        response = self.client.post(
            '/chat/messages/media/',
            {
                'connectionId': 'invalid',
                'type': 'video',
                'file': SimpleUploadedFile('clip.mp4', b'video-bytes', content_type='video/mp4'),
            },
            format='multipart',
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(Message.objects.count(), 0)

    def test_upload_endpoint_rejects_foreign_connections(self):
        stranger = Usuario.objects.create_user(username='stranger')
        self.client.force_authenticate(user=stranger)
        response = self.client.post('/chat/messages/media/', {
            'connectionId': self.connection.pk, 'type': 'audio',
            'file': SimpleUploadedFile('note.m4a', b'audio', content_type='audio/mp4'),
        }, format='multipart')
        self.assertEqual(response.status_code, 403)
        self.assertFalse(Message.objects.exists())

    def test_upload_endpoint_rejects_pending_connection(self):
        self.connection.accepted = False
        self.connection.save(update_fields=['accepted'])
        response = self.client.post('/chat/messages/media/', {
            'connectionId': self.connection.pk, 'type': 'audio',
            'file': SimpleUploadedFile('note.m4a', b'audio', content_type='audio/mp4'),
        }, format='multipart')
        self.assertEqual(response.status_code, 400)
        self.assertFalse(Message.objects.exists())

    def test_upload_endpoint_requires_authentication(self):
        self.client.force_authenticate(user=None)
        response = self.client.post('/chat/messages/media/', {}, format='multipart')
        self.assertEqual(response.status_code, 401)

    def test_upload_rejects_invalid_image_content(self):
        response = self.client.post('/chat/messages/media/', {
            'connectionId': self.connection.pk, 'type': 'image',
            'file': SimpleUploadedFile('photo.jpg', b'not-an-image', content_type='image/jpeg'),
        }, format='multipart')
        self.assertEqual(response.status_code, 400)
        self.assertFalse(Message.objects.exists())

    @override_settings(CHAT_MEDIA_MAX_BYTES={'image': 10, 'audio': 10, 'video': 10, 'document': 10})
    def test_upload_rejects_oversized_file_before_saving(self):
        response = self.client.post('/chat/messages/media/', {
            'connectionId': self.connection.pk, 'type': 'audio',
            'file': SimpleUploadedFile('note.m4a', b'12345678901', content_type='audio/mp4'),
        }, format='multipart')
        self.assertEqual(response.status_code, 413)
        self.assertFalse(Message.objects.exists())

    def test_upload_rejects_mismatched_type_and_active_document(self):
        for media_type, filename, content_type in (
            ('video', 'clip.mp4', 'image/jpeg'),
            ('document', 'page.html', 'text/html'),
        ):
            with self.subTest(media_type=media_type):
                response = self.client.post('/chat/messages/media/', {
                    'connectionId': self.connection.pk, 'type': media_type,
                    'file': SimpleUploadedFile(filename, b'payload', content_type=content_type),
                }, format='multipart')
                self.assertEqual(response.status_code, 400)
        self.assertFalse(Message.objects.exists())

    @patch('chat.models.Message.save', side_effect=RuntimeError('DB write failure'))
    def test_database_failure_cleans_up_stored_file(self, mocked_save):
        with self.assertLogs('chat.services', level='ERROR'):
            response = self.client.post('/chat/messages/media/', {
                'connectionId': self.connection.pk, 'type': 'audio',
                'file': SimpleUploadedFile('note.m4a', b'audio', content_type='audio/mp4'),
            }, format='multipart')
        self.assertEqual(response.status_code, 400)
        self.assertFalse(Message.objects.exists())
        from pathlib import Path
        self.assertFalse(any(path.is_file() for path in Path(self.media_root).rglob('*')))


class ChatProtocolTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.sender = Usuario.objects.create_user(username='alice')
        cls.receiver = Usuario.objects.create_user(username='bob', pushToken='private-device-token')
        cls.stranger = Usuario.objects.create_user(username='stranger')
        cls.connection = Connection.objects.create(sender=cls.sender, receiver=cls.receiver, accepted=True)

    def make_consumer(self, user=None):
        return ChatConsumerMediaTests.make_consumer(self, user or self.sender)

    def test_bad_protocol_payloads_report_errors_without_crashing(self):
        consumer = self.make_consumer()
        cases = ['[]', 'null', '42', '{"source": []}', '{"source":"message.send","connectionId":1,"message":{}}',
                 '{"source":"search","query":{}}', '{"source":"message.read","messageId":"oops"}',
                 '{"source":"message.read","messageId":9223372036854775808}',
                 '{"source":"message.list","connectionId":1,"page":[]}',
                 '{"source":"message.list","connectionId":1.2}',
                 '{"source":"miniatura","filename":"photo.jpg","base64":42}']
        for raw in cases:
            with self.subTest(raw=raw):
                consumer.receive(raw)
                self.assertEqual(consumer.sent_messages[-1]['source'], 'error')
        consumer.receive(bytes_data=b'binary')
        self.assertEqual(consumer.sent_messages[-1]['source'], 'error')
        self.assertFalse(Message.objects.exists())

    def test_typing_requires_an_accepted_connection(self):
        consumer = self.make_consumer(self.stranger)
        consumer.receive_message_type({'username': self.receiver.username})
        self.assertFalse(consumer.sent_groups)
        self.assertEqual(consumer.sent_messages[-1]['source'], 'error')

    def test_message_read_only_allows_the_recipient(self):
        message = Message.objects.create(connection=self.connection, user=self.sender, text='Hello')
        for user in (self.sender, self.stranger):
            consumer = self.make_consumer(user)
            consumer.receive_message_read({'messageId': message.pk})
            message.refresh_from_db()
            self.assertTrue(message.is_new)
            self.assertEqual(consumer.sent_messages[-1]['source'], 'error')
        recipient = self.make_consumer(self.receiver)
        recipient.receive_message_read({'messageId': message.pk})
        message.refresh_from_db()
        self.assertFalse(message.is_new)
        self.assertEqual(len(recipient.sent_groups), 2)

    def test_conversation_read_marks_only_received_messages_in_this_chat(self):
        incoming = Message.objects.create(connection=self.connection, user=self.receiver, text='Incoming')
        own = Message.objects.create(connection=self.connection, user=self.sender, text='Own')
        other_chat = Connection.objects.create(sender=self.sender, receiver=self.stranger, accepted=True)
        unrelated = Message.objects.create(connection=other_chat, user=self.stranger, text='Other chat')
        consumer = self.make_consumer()
        consumer.receive_message_read({'connectionId': self.connection.pk})
        for message in (incoming, own, unrelated):
            message.refresh_from_db()
        self.assertFalse(incoming.is_new)
        self.assertTrue(own.is_new)
        self.assertTrue(unrelated.is_new)
        self.assertEqual(consumer.sent_groups[0]['data']['messageIds'], [incoming.pk])

    def test_history_is_local_and_does_not_query_user_for_each_message(self):
        Message.objects.bulk_create([Message(connection=self.connection, user=self.receiver, text=str(index)) for index in range(16)])
        consumer = self.make_consumer()
        # Connection + bounded history + one session-revocation check at delivery.
        with self.assertNumQueries(3):
            consumer.receive_message_list({'connectionId': self.connection.pk, 'page': 0, 'requestId': 'current-request'})
        self.assertFalse(consumer.sent_groups)
        payload = consumer.sent_messages[-1]['data']
        self.assertEqual(payload['connectionId'], self.connection.pk)
        self.assertEqual(payload['page'], 0)
        self.assertEqual(payload['requestId'], 'current-request')
        self.assertIsNone(payload['next'])
        self.assertEqual(payload['limit'], 50)
        self.assertEqual(len(payload['messages']), 16)

    def test_history_limits_both_directions_and_all_media_to_latest_fifty_without_deleting(self):
        media_fields = (None, 'image', 'audio', 'video', 'document')
        history = []
        for index in range(60):
            message_data = {
                'connection': self.connection,
                'user': self.sender if index % 2 == 0 else self.receiver,
                'text': f'Message {index}',
            }
            field = media_fields[index % len(media_fields)]
            if field:
                message_data[field] = f'messages/{field}/sample-{index}'
            history.append(Message(**message_data))
        Message.objects.bulk_create(history)
        # Equal timestamps must still produce a deterministic recent window.
        Message.objects.filter(connection=self.connection).update(created=timezone.now())
        other_chat = Connection.objects.create(sender=self.sender, receiver=self.stranger, accepted=True)
        other_message = Message.objects.create(connection=other_chat, user=self.stranger, text='Other conversation')
        newest = Message.objects.create(connection=self.connection, user=self.receiver, text='Newest timestamp')
        expected_ids = [newest.pk] + [message.pk for message in reversed(history)][0:49]

        for user in (self.sender, self.receiver):
            with self.subTest(username=user.username):
                consumer = self.make_consumer(user)
                consumer.receive_message_list({'connectionId': self.connection.pk})
                payload = consumer.sent_messages[-1]['data']
                messages = payload['messages']
                self.assertEqual([message['id'] for message in messages], expected_ids)
                self.assertEqual({message['type'] for message in messages}, {'text', 'image', 'audio', 'video', 'document'})
                self.assertEqual({message['is_me'] for message in messages}, {True, False})
                self.assertNotIn(other_message.pk, [message['id'] for message in messages])
                self.assertEqual(payload['page'], 0)
                self.assertIsNone(payload['next'])
        self.assertEqual(Message.objects.filter(connection=self.connection).count(), 61)

    def test_legacy_history_pages_are_rejected_without_returning_old_messages(self):
        Message.objects.bulk_create([Message(connection=self.connection, user=self.receiver, text=str(index)) for index in range(60)])
        for page in (1, '1', 2, 1000):
            with self.subTest(page=page):
                consumer = self.make_consumer()
                consumer.receive_message_list({'connectionId': self.connection.pk, 'page': page})
                self.assertEqual(consumer.sent_messages, [{
                    'source': 'error',
                    'message': 'Solo se muestran los ultimos 50 mensajes de esta conversacion.',
                }])
                self.assertFalse(consumer.sent_groups)

    def test_history_window_does_not_change_unread_counts_or_message_receipts(self):
        Message.objects.bulk_create([Message(connection=self.connection, user=self.receiver, text=str(index)) for index in range(60)])
        consumer = self.make_consumer()
        consumer.receive_message_list({'connectionId': self.connection.pk})
        self.assertEqual(len(consumer.sent_messages[-1]['data']['messages']), 50)
        consumer.receive_friend_list({})
        self.assertEqual(consumer.sent_groups[-1]['data'][0]['unreadCount'], 60)
        self.assertEqual(Message.objects.filter(connection=self.connection, is_new=True).count(), 60)

    def test_friend_unread_count_includes_older_received_messages(self):
        Message.objects.create(connection=self.connection, user=self.receiver, text='Unread')
        Message.objects.create(connection=self.connection, user=self.sender, text='Latest own')
        consumer = self.make_consumer()
        with self.assertNumQueries(1):
            consumer.receive_friend_list({})
        friend = consumer.sent_groups[0]['data'][0]
        self.assertEqual(friend['unreadCount'], 1)
        self.assertTrue(friend['isNew'])
        self.assertTrue(friend['message']['is_me'])
        self.assertNotIn('pushToken', friend['friend'])

    def test_reciprocal_requests_reuse_existing_connection(self):
        pending = Connection.objects.create(sender=self.stranger, receiver=self.sender)
        consumer = self.make_consumer()
        consumer.receive_request_connect({'username': self.stranger.username})
        self.assertEqual(Connection.objects.filter(sender=self.sender, receiver=self.stranger).count(), 0)
        self.assertEqual(consumer.sent_groups[0]['data']['id'], pending.pk)

    def test_search_status_prefers_accepted_connection_over_legacy_pending(self):
        Connection.objects.create(sender=self.receiver, receiver=self.sender)
        consumer = self.make_consumer()
        consumer.receive_search({'query': 'bob'})
        self.assertEqual(consumer.sent_messages[-1]['data'][0]['status'], 'connected')
        self.assertNotIn('pushToken', consumer.sent_messages[-1]['data'][0])

    @patch('chat.consumers.ChatConsumer.send_group', side_effect=[RuntimeError('Realtime unavailable'), None])
    @patch('chat.consumers.ChatConsumer.send_push_notification')
    def test_saved_text_message_still_delivers_to_other_user_after_one_failure(self, mocked_push, mocked_send_group):
        consumer = self.make_consumer()
        consumer.send_group = mocked_send_group
        with self.assertLogs('chat.services', level='ERROR'):
            consumer.receive_message_send({'connectionId': self.connection.pk, 'message': 'Hello'})
        self.assertEqual(Message.objects.count(), 1)
        self.assertEqual(mocked_send_group.call_count, 2)


class TextMessageDeliveryTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.sender = Usuario.objects.create_user(username='alice')
        cls.receiver = Usuario.objects.create_user(username='bob', pushToken='test-device-token')
        cls.stranger = Usuario.objects.create_user(username='stranger')
        cls.connection = Connection.objects.create(sender=cls.sender, receiver=cls.receiver, accepted=True)

    def setUp(self):
        self.client_id = str(uuid4())
        self.payload = {
            'source': 'message.send',
            'connectionId': self.connection.pk,
            'clientId': self.client_id,
            'message': 'Mensaje fiable',
        }

    def make_consumer(self, user=None):
        consumer = ChatConsumerMediaTests.make_consumer(self, user or self.sender)
        consumer.send_push_notification = Mock()
        return consumer

    def assert_correlated_error(self, consumer, payload):
        response = consumer.sent_messages[-1]
        self.assertEqual(response['source'], 'error')
        self.assertEqual(response['clientId'], payload.get('clientId'))
        self.assertEqual(response['connectionId'], payload.get('connectionId'))
        self.assertEqual(response['data']['clientId'], payload.get('clientId'))
        self.assertEqual(response['data']['connectionId'], payload.get('connectionId'))
        self.assertEqual(response['data']['message'], response['message'])
        self.assertFalse(consumer.sent_groups)
        consumer.send_push_notification.assert_not_called()

    def test_new_message_acknowledges_persistence_directly_and_delivers_to_both_groups_once(self):
        consumer = self.make_consumer()
        consumer.receive(json.dumps(self.payload))
        message = Message.objects.get()
        response = consumer.sent_messages[0]
        self.assertEqual(response['source'], 'message.send')
        self.assertEqual(response['data']['connectionId'], self.connection.pk)
        self.assertEqual(response['data']['friend']['username'], self.receiver.username)
        self.assertEqual(response['data']['message']['id'], message.pk)
        self.assertEqual(response['data']['message']['clientId'], self.client_id)
        self.assertTrue(response['data']['message']['is_me'])
        self.assertEqual([event['group'] for event in consumer.sent_groups], [self.sender.username, self.receiver.username])
        self.assertEqual(consumer.sent_groups[0]['data']['message']['clientId'], self.client_id)
        consumer.send_push_notification.assert_called_once_with('test-device-token', 'alice', 'Mensaje fiable')

    def test_retry_after_lost_direct_ack_returns_same_message_without_delivery_or_notification_again(self):
        disconnected = self.make_consumer()
        disconnected.send = Mock(side_effect=RuntimeError('Socket disconnected before receiving acknowledgement'))
        with self.assertRaisesRegex(RuntimeError, 'Socket disconnected'):
            disconnected.receive(json.dumps(self.payload))
        saved = Message.objects.get()
        self.assertEqual(len(disconnected.sent_groups), 2)
        disconnected.send_push_notification.assert_called_once()
        # A receiver's read receipt must survive a retry by the sender.
        saved.is_new = False
        saved.save(update_fields=['is_new'])

        reconnect = self.make_consumer()
        reconnect.receive(json.dumps(self.payload))
        response = reconnect.sent_messages[0]['data']['message']
        self.assertEqual(response['id'], saved.pk)
        self.assertEqual(response['clientId'], self.client_id)
        self.assertFalse(response['isNew'])
        self.assertEqual(Message.objects.count(), 1)
        self.assertFalse(reconnect.sent_groups)
        reconnect.send_push_notification.assert_not_called()

    def test_direct_ack_succeeds_even_when_all_group_delivery_fails(self):
        consumer = self.make_consumer()
        consumer.send_group = Mock(side_effect=RuntimeError('Redis unavailable'))
        with self.assertLogs('chat.services', level='ERROR'):
            consumer.receive(json.dumps(self.payload))
        first_id = consumer.sent_messages[0]['data']['message']['id']
        self.assertEqual(consumer.send_group.call_count, 2)
        consumer.send_push_notification.assert_called_once()
        consumer.receive(json.dumps(self.payload))
        self.assertEqual(consumer.sent_messages[-1]['data']['message']['id'], first_id)
        self.assertEqual(consumer.send_group.call_count, 2)
        consumer.send_push_notification.assert_called_once()
        self.assertEqual(Message.objects.count(), 1)

    def test_reusing_client_id_for_different_text_or_connection_is_a_correlated_error(self):
        original = self.make_consumer()
        original.receive(json.dumps(self.payload))
        other_chat = Connection.objects.create(sender=self.sender, receiver=self.stranger, accepted=True)
        for changes in ({'message': 'Contenido diferente'}, {'connectionId': other_chat.pk}):
            with self.subTest(changes=changes):
                payload = {**self.payload, **changes}
                consumer = self.make_consumer()
                consumer.receive(json.dumps(payload))
                self.assert_correlated_error(consumer, payload)
                self.assertIn('mensaje diferente', consumer.sent_messages[-1]['message'])
        self.assertEqual(Message.objects.count(), 1)
        self.assertEqual(Message.objects.get().text, 'Mensaje fiable')

    def test_retry_still_requires_connection_membership_and_acceptance(self):
        self.make_consumer().receive(json.dumps(self.payload))
        stranger = self.make_consumer(self.stranger)
        stranger.receive(json.dumps(self.payload))
        self.assert_correlated_error(stranger, self.payload)
        self.assertIn('No tienes acceso', stranger.sent_messages[-1]['message'])
        self.connection.accepted = False
        self.connection.save(update_fields=['accepted'])
        sender = self.make_consumer()
        sender.receive(json.dumps(self.payload))
        self.assert_correlated_error(sender, self.payload)
        self.assertIn('no ha sido aceptada', sender.sent_messages[-1]['message'])
        self.assertEqual(Message.objects.count(), 1)

    def test_invalid_client_id_and_text_errors_preserve_pending_message_identifiers(self):
        for value in ('not-a-uuid', '', 42, True, [], {}, uuid4().hex):
            with self.subTest(client_id=value):
                payload = {**self.payload, 'clientId': value}
                consumer = self.make_consumer()
                consumer.receive(json.dumps(payload))
                self.assert_correlated_error(consumer, payload)
        for text in (' ', None, {}, 'a' * 10001):
            with self.subTest(text_type=type(text).__name__):
                payload = {**self.payload, 'message': text}
                consumer = self.make_consumer()
                consumer.receive(json.dumps(payload))
                self.assert_correlated_error(consumer, payload)
        payload = {**self.payload, 'connectionId': 'invalid'}
        consumer = self.make_consumer()
        consumer.receive(json.dumps(payload))
        self.assert_correlated_error(consumer, payload)
        self.assertFalse(Message.objects.exists())

    def test_uuid_case_and_trimmed_text_retries_share_the_same_persisted_message(self):
        consumer = self.make_consumer()
        consumer.receive(json.dumps({**self.payload, 'message': '  Mensaje fiable  '}))
        retry = self.make_consumer()
        retry.receive(json.dumps({**self.payload, 'clientId': self.client_id.upper()}))
        self.assertEqual(Message.objects.count(), 1)
        self.assertEqual(retry.sent_messages[0]['data']['message']['clientId'], self.client_id)
        self.assertFalse(retry.sent_groups)

    def test_client_id_is_unique_per_sender_and_legacy_messages_can_still_have_null_ids(self):
        sender = self.make_consumer()
        sender.receive(json.dumps(self.payload))
        receiver = self.make_consumer(self.receiver)
        receiver.receive(json.dumps(self.payload))
        self.assertNotEqual(sender.sent_messages[0]['data']['message']['id'], receiver.sent_messages[0]['data']['message']['id'])
        legacy = {key: value for key, value in self.payload.items() if key != 'clientId'}
        sender.receive(json.dumps(legacy))
        sender.receive(json.dumps(legacy))
        self.assertEqual(Message.objects.count(), 4)
        self.assertEqual(Message.objects.filter(client_id__isnull=True).count(), 2)
        self.assertIsNone(sender.sent_messages[-1]['data']['message']['clientId'])

    def test_database_uniqueness_enforces_concurrent_retry_identity(self):
        self.make_consumer().receive(json.dumps(self.payload))
        with self.assertRaises(IntegrityError), transaction.atomic():
            Message.objects.create(connection=self.connection, user=self.sender, text='Concurrent duplicate', client_id=self.client_id)
        self.assertEqual(Message.objects.count(), 1)

    @patch('chat.models.Message.objects.get_or_create', side_effect=DatabaseError('Database write failed'))
    def test_database_failure_reports_correlated_error_and_never_acknowledges_success(self, mocked_create):
        consumer = self.make_consumer()
        with self.assertLogs('chat.services', level='ERROR'):
            consumer.receive(json.dumps(self.payload))
        self.assert_correlated_error(consumer, self.payload)
        self.assertFalse(Message.objects.exists())


class AuthenticationFlowTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = Usuario.objects.create_user(username='alice', password='VeryStrong!Password-456', first_name='Alice', last_name='Sender', pushToken='own-device-token')

    def setUp(self):
        self.client = APIClient()

    def test_refresh_token_renews_access_and_me_requires_access_token(self):
        refresh = RefreshToken.for_user(self.user)
        response = self.client.post('/chat/token/refresh/', {'refresh': str(refresh)}, format='json')
        self.assertEqual(response.status_code, 200)
        self.client.credentials(HTTP_AUTHORIZATION='Bearer ' + response.data['access'])
        profile = self.client.get('/chat/me/')
        self.assertEqual(profile.status_code, 200)
        self.assertEqual(profile.data['user']['pushToken'], 'own-device-token')
        self.client.credentials(HTTP_AUTHORIZATION='Bearer ' + str(refresh))
        self.assertEqual(self.client.get('/chat/me/').status_code, 401)

    def test_expired_credentials_do_not_prevent_new_login(self):
        access = RefreshToken.for_user(self.user).access_token
        access.set_exp(from_time=timezone.now() - timedelta(minutes=10), lifetime=timedelta(minutes=1))
        self.client.credentials(HTTP_AUTHORIZATION='Bearer ' + str(access))
        response = self.client.post('/chat/signin/', {'username': ' ALICE ', 'password': 'VeryStrong!Password-456'}, format='json')
        self.assertEqual(response.status_code, 200)

    def test_sign_up_preserves_password_whitespace_for_login(self):
        password = '  StrongWhitespace!Password-456  '
        response = self.client.post('/chat/signup/', {
            'username': 'newuser', 'first_name': 'New', 'last_name': 'User', 'password': password,
            'email': 'newuser@example.test',
        }, format='json')
        self.assertEqual(response.status_code, 201, response.data)
        response = self.client.post('/chat/signin/', {'username': 'newuser', 'password': password}, format='json')
        self.assertEqual(response.status_code, 200)

    def test_exact_username_wins_for_legacy_case_duplicates(self):
        Usuario.objects.create_user(username='ALICE', password='DifferentStrong!Password-789')
        response = self.client.post('/chat/signin/', {'username': 'ALICE', 'password': 'DifferentStrong!Password-789'}, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['user']['username'], 'ALICE')

    def test_missing_names_and_invalid_credentials_are_client_errors(self):
        response = self.client.post('/chat/signup/', {'username': 'newuser', 'password': 'AnotherStrong!Password-789'}, format='json')
        self.assertEqual(response.status_code, 400)
        self.assertIn('first_name', response.data)
        self.assertFalse(Usuario.objects.filter(username='newuser').exists())
        self.assertEqual(self.client.post('/chat/signin/', [], format='json').status_code, 400)

    def test_password_is_validated_against_name(self):
        response = self.client.post('/chat/signup/', {
            'username': 'newuser', 'first_name': 'LongDistinctiveName', 'last_name': 'Sender', 'password': 'LongDistinctiveName',
        }, format='json')
        self.assertEqual(response.status_code, 400)
        self.assertIn('password', response.data)

    def test_inactive_user_cannot_refresh_access(self):
        refresh = RefreshToken.for_user(self.user)
        self.user.is_active = False
        self.user.save(update_fields=['is_active'])
        response = self.client.post('/chat/token/refresh/', {'refresh': str(refresh)}, format='json')
        self.assertEqual(response.status_code, 401)

    def test_push_registration_only_changes_current_user_token(self):
        self.client.force_authenticate(self.user)
        response = self.client.patch('/chat/me/', {'pushToken': 'new-device-token', 'is_staff': True}, format='json')
        self.assertEqual(response.status_code, 200)
        self.user.refresh_from_db()
        self.assertEqual(self.user.pushToken, 'new-device-token')
        self.assertFalse(self.user.is_staff)
        self.assertNotIn('pushToken', UsuarioSerializer(self.user).data)


class ChatTypingProtocolTests(TestCase):
    def setUp(self):
        # Every case rolls back its DB, so ephemeral IDs/order must also reset.
        from django.core.cache import cache
        cache.clear()

    @classmethod
    def setUpTestData(cls):
        cls.sender = Usuario.objects.create_user(username='typing_alice')
        cls.receiver = Usuario.objects.create_user(username='typing_bob')
        cls.stranger = Usuario.objects.create_user(username='typing_eve')
        cls.connection = Connection.objects.create(sender=cls.sender, receiver=cls.receiver, accepted=True)
        cls.other_connection = Connection.objects.create(sender=cls.receiver, receiver=cls.stranger, accepted=True)

    def make_consumer(self, user=None):
        return ChatConsumerMediaTests.make_consumer(self, user or self.sender)

    def send_typing(self, consumer=None, **overrides):
        consumer = consumer or self.make_consumer()
        consumer.receive(json.dumps({
            'source': 'message.type', 'connectionId': self.connection.pk,
            'isTyping': True, 'historyRevision': 0, **overrides,
        }))
        return consumer

    def typing_event(self, **overrides):
        return {'source': 'message.type', 'data': {
            'connectionId': self.connection.pk, 'username': self.sender.username,
            'isTyping': True, 'revision': 0,
            'expiresAt': (timezone.now() + timedelta(seconds=5)).isoformat(), **overrides,
        }}

    def test_start_heartbeat_and_stop_reach_only_the_contact_without_persisting(self):
        previous_updated = self.connection.updated
        consumer = self.make_consumer()
        for state in (True, True, False):
            self.send_typing(consumer, isTyping=state)
        self.assertEqual(len(consumer.sent_groups), 3)
        for event in consumer.sent_groups:
            self.assertEqual(event['group'], self.receiver.username)
            self.assertEqual(event['source'], 'message.type')
            self.assertEqual(event['data']['connectionId'], self.connection.pk)
            self.assertEqual(event['data']['username'], self.sender.username)
            self.assertEqual(event['data']['revision'], 0)
        self.assertEqual([event['data']['isTyping'] for event in consumer.sent_groups], [True, True, False])
        expiry = parse_datetime(consumer.sent_groups[0]['data']['expiresAt'])
        self.assertGreater(expiry, timezone.now())
        self.assertLessEqual(expiry, timezone.now() + timedelta(seconds=5))
        self.assertIsNone(consumer.sent_groups[-1]['data']['expiresAt'])
        self.assertFalse(Message.objects.exists())
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.updated, previous_updated)

    def test_reverse_direction_uses_authenticated_identity_and_ignores_forged_sender_fields(self):
        consumer = self.send_typing(self.make_consumer(self.receiver),
                                    username=self.sender.username, sender=self.stranger.username)
        event = consumer.sent_groups[0]
        self.assertEqual(event['group'], self.sender.username)
        self.assertEqual(event['data']['username'], self.receiver.username)
        self.assertNotIn('sender', event['data'])
        self.assertNotIn('pushToken', event['data'])

    def test_legacy_username_only_resolves_accepted_connection_and_defaults_to_start(self):
        consumer = self.make_consumer()
        consumer.receive_message_type({'username': self.receiver.username})
        self.assertEqual(len(consumer.sent_groups), 1)
        payload = consumer.sent_groups[0]['data']
        self.assertEqual(payload['connectionId'], self.connection.pk)
        self.assertEqual(payload['username'], self.sender.username)
        self.assertIs(payload['isTyping'], True)
        self.assertIsNotNone(payload['expiresAt'])

    def test_stranger_or_mismatched_recipient_cannot_signal_another_conversation(self):
        for user, overrides in (
            (self.stranger, {}),
            (self.sender, {'connectionId': self.other_connection.pk}),
            (self.sender, {'username': self.stranger.username}),
            (self.sender, {'username': self.sender.username}),
        ):
            with self.subTest(user=user.username, overrides=overrides):
                consumer = self.send_typing(self.make_consumer(user), **overrides)
                self.assertFalse(consumer.sent_groups)
                self.assertEqual(consumer.sent_messages[-1]['source'], 'error')

    def test_pending_relationship_and_inactive_users_are_rechecked_at_send(self):
        Connection.objects.filter(pk=self.connection.pk).update(accepted=False)
        consumer = self.send_typing()
        self.assertFalse(consumer.sent_groups)
        Connection.objects.filter(pk=self.connection.pk).update(accepted=True)
        for user in (self.sender, self.receiver):
            with self.subTest(user=user.username):
                Usuario.objects.filter(pk=user.pk).update(is_active=False)
                # The scope still contains its original active user instance.
                consumer = self.send_typing()
                self.assertFalse(consumer.sent_groups)
                if user.pk == self.sender.pk:
                    self.assertEqual(consumer.closed_codes, [4401])
                    self.assertFalse(consumer.sent_messages)
                else:
                    self.assertEqual(consumer.sent_messages[-1]['source'], 'error')
                Usuario.objects.filter(pk=user.pk).update(is_active=True)

    def test_malformed_typing_and_connection_values_never_become_group_events(self):
        for value in (None, 'true', 'false', 0, 1, {}, []):
            with self.subTest(state=value):
                consumer = self.send_typing(isTyping=value)
                self.assertFalse(consumer.sent_groups)
                self.assertEqual(consumer.sent_messages[-1]['source'], 'error')
        for identifier in (True, False, 0, -1, 'invalid', {}, []):
            with self.subTest(connection=identifier):
                consumer = self.send_typing(connectionId=identifier)
                self.assertFalse(consumer.sent_groups)
        consumer = self.send_typing(username='x' * 151)
        self.assertFalse(consumer.sent_groups)

    def test_stale_or_missing_history_revision_cannot_restore_typing_after_shared_clear(self):
        Connection.objects.filter(pk=self.connection.pk).update(history_revision=2)
        for revision in (None, 0, 1, True, 'invalid'):
            with self.subTest(revision=revision):
                consumer = self.send_typing(historyRevision=revision)
                self.assertFalse(consumer.sent_groups)
                error = consumer.sent_messages[-1]
                self.assertEqual(error['code'], 'history_cleared')
                self.assertEqual(error['revision'], 2)
                self.assertEqual(error['connectionId'], self.connection.pk)
        consumer = self.send_typing(historyRevision=2)
        self.assertEqual(consumer.sent_groups[0]['data']['revision'], 2)

    def test_delivery_accepts_current_start_and_stop_but_never_echoes_to_sender_or_stranger(self):
        for state in (True, False):
            event = self.typing_event(isTyping=state,
                                      expiresAt=(timezone.now() + timedelta(seconds=5)).isoformat() if state else None)
            receiver = self.make_consumer(self.receiver)
            receiver.broadcast_group(event)
            self.assertEqual(receiver.sent_messages, [event])
            for user in (self.sender, self.stranger):
                consumer = self.make_consumer(user)
                consumer.broadcast_group(event)
                self.assertFalse(consumer.sent_messages)

    def test_delivery_discards_expired_invalid_naive_or_unbounded_start_events(self):
        now = timezone.now()
        with patch('chat.consumers.timezone.now', return_value=now):
            for expiry in (None, '', 'invalid', [], now.isoformat(),
                           (now - timedelta(seconds=1)).isoformat(),
                           (now + timedelta(seconds=30)).isoformat(),
                           (now + timedelta(seconds=5)).replace(tzinfo=None).isoformat()):
                with self.subTest(expiry=expiry):
                    consumer = self.make_consumer(self.receiver)
                    consumer.broadcast_group(self.typing_event(expiresAt=expiry))
                    self.assertFalse(consumer.sent_messages)

    def test_delivery_discards_queued_events_after_clear_or_friendship_revocation(self):
        event = self.typing_event()
        receiver = self.make_consumer(self.receiver)
        Connection.objects.filter(pk=self.connection.pk).update(history_revision=1)
        receiver.broadcast_group(event)
        self.assertFalse(receiver.sent_messages)
        Connection.objects.filter(pk=self.connection.pk).update(history_revision=0, accepted=False)
        receiver.broadcast_group(event)
        self.assertFalse(receiver.sent_messages)

    def test_delivery_discards_wrong_identity_inactive_accounts_and_incomplete_payloads(self):
        events = [
            self.typing_event(username=self.stranger.username),
            self.typing_event(connectionId=self.other_connection.pk),
            self.typing_event(isTyping='true'),
            self.typing_event(revision=True),
            self.typing_event(isTyping=False, expiresAt='invalid'),
            {'source': 'message.type', 'data': {'username': self.sender.username}},
            {'source': 'message.type', 'data': []},
        ]
        for event in events:
            consumer = self.make_consumer(self.receiver)
            consumer.broadcast_group(event)
            self.assertFalse(consumer.sent_messages)
        for user in (self.sender, self.receiver):
            with self.subTest(user=user.username):
                Usuario.objects.filter(pk=user.pk).update(is_active=False)
                consumer = self.make_consumer(self.receiver)
                consumer.broadcast_group(self.typing_event())
                self.assertFalse(consumer.sent_messages)
                Usuario.objects.filter(pk=user.pk).update(is_active=True)

    @override_settings(CHANNEL_LAYERS={'default': {'BACKEND': 'channels.layers.InMemoryChannelLayer'}})
    def test_authenticated_websockets_deliver_start_and_stop_to_both_contact_devices_only(self):
        app = JWTAuthMiddleware(ChatConsumer.as_asgi())
        tokens = [str(RefreshToken.for_user(user).access_token)
                  for user in (self.sender, self.receiver, self.receiver, self.stranger)]

        async def probe():
            sockets = [WebsocketCommunicator(app, '/ws/chat/?token=' + token) for token in tokens]
            try:
                for socket in sockets:
                    connected, _ = await socket.connect()
                    self.assertTrue(connected)
                alice, bob_one, bob_two, eve = sockets
                await alice.send_json_to({'source': 'message.type', 'connectionId': self.connection.pk,
                                          'isTyping': True, 'historyRevision': 0})
                for bob in (bob_one, bob_two):
                    event = await bob.receive_json_from()
                    self.assertEqual(event['source'], 'message.type')
                    self.assertEqual(event['data']['username'], self.sender.username)
                    self.assertEqual(event['data']['connectionId'], self.connection.pk)
                    self.assertIs(event['data']['isTyping'], True)
                self.assertTrue(await alice.receive_nothing(timeout=0.03))
                self.assertTrue(await eve.receive_nothing(timeout=0.03))
                await bob_one.send_json_to({'source': 'message.type', 'connectionId': self.connection.pk,
                                            'isTyping': False, 'historyRevision': 0})
                event = await alice.receive_json_from()
                self.assertIs(event['data']['isTyping'], False)
                self.assertIsNone(event['data']['expiresAt'])
                self.assertTrue(await bob_two.receive_nothing(timeout=0.03))
                self.assertTrue(await eve.receive_nothing(timeout=0.03))
            finally:
                for socket in sockets:
                    await socket.disconnect()

        async_to_sync(probe)()


class WebSocketAuthenticationTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = Usuario.objects.create_user(username='usuario+prueba@example.com')

    def socket_probe(self, token, *, origin=None, expected=True):
        app = NativeAllowedHostsOriginValidator(JWTAuthMiddleware(ChatConsumer.as_asgi()))

        async def probe():
            headers = [(b'origin', origin.encode())] if origin else []
            socket = WebsocketCommunicator(app, '/ws/chat/?token=' + token, headers=headers)
            connected, _ = await socket.connect()
            self.assertEqual(connected, expected)
            if connected:
                await socket.send_json_to({'source': 'friend.list'})
                response = await socket.receive_json_from()
                self.assertEqual(response, {'source': 'friend.list', 'data': []})
            await socket.disconnect()

        async_to_sync(probe)()

    def test_native_access_and_username_with_special_characters(self):
        with override_settings(ALLOWED_HOSTS=['example.com']):
            self.socket_probe(str(RefreshToken.for_user(self.user).access_token))
        group = user_group_name(self.user.username)
        self.assertLess(len(group), 100)
        self.assertTrue(get_channel_layer().valid_group_name(group))

    def test_socket_rejects_refresh_invalid_and_expired_tokens(self):
        refresh = RefreshToken.for_user(self.user)
        expired = refresh.access_token
        expired.set_exp(from_time=timezone.now() - timedelta(minutes=10), lifetime=timedelta(minutes=1))
        for token in (str(refresh), 'invalid', str(expired), ''):
            with self.subTest(kind=token[:10]):
                self.socket_probe(token, expected=False)

    def test_socket_rejects_inactive_users(self):
        access = str(RefreshToken.for_user(self.user).access_token)
        self.user.is_active = False
        self.user.save(update_fields=['is_active'])
        self.socket_probe(access, expected=False)

    @override_settings(ALLOWED_HOSTS=['example.com'])
    def test_socket_rejects_browser_origin_outside_allowed_hosts(self):
        access = str(RefreshToken.for_user(self.user).access_token)
        self.socket_probe(access, origin='https://other.example', expected=False)
        self.socket_probe(access, origin='https://example.com')
