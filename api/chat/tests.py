import base64
import shutil
import tempfile
from unittest.mock import patch

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from .consumers import ChatConsumer
from .models import Connection, Message, Usuario


def encode_bytes(raw_bytes):
    return base64.b64encode(raw_bytes).decode('utf-8')


@override_settings(MEDIA_ROOT=tempfile.gettempdir())
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
        consumer.send_group = lambda group, source, data: consumer.sent_groups.append(
            {'group': group, 'source': source, 'data': data}
        )
        consumer.send = lambda *args, **kwargs: None
        return consumer

    @patch('chat.consumers.ChatConsumer.send_push_notification', autospec=True)
    def test_receive_message_send_image_saves_message_and_broadcasts(self, mocked_push):
        consumer = self.make_consumer(self.sender)

        consumer.receive_message_send_image(
            {
                'connectionId': self.connection.id,
                'base64': encode_bytes(b'image-bytes'),
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
            ('image', 'image', 'photo.jpg', b'image-bytes', 'image/jpeg'),
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
        upload = SimpleUploadedFile('photo.jpg', b'image-bytes', content_type='image/jpeg')

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
