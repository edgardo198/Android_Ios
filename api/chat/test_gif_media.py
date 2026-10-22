import tempfile
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from asgiref.sync import async_to_sync
from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from PIL import Image
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from .models import Connection, Message, Usuario


def animated_gif_bytes():
    output = BytesIO()
    frames = [Image.new('RGB', (4, 4), color) for color in ('red', 'blue')]
    frames[0].save(output, format='GIF', save_all=True, append_images=frames[1:], duration=100, loop=0)
    return output.getvalue()


@override_settings(PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher'])
class GifMessageMediaTests(TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='chat-gif-tests-')
        self.override = override_settings(MEDIA_ROOT=self.directory.name)
        self.override.enable()
        self.addCleanup(self.directory.cleanup)
        self.addCleanup(self.override.disable)
        for target in ('chat.services.send_group', 'chat.services.send_push_notification'):
            mocked = patch(target)
            mocked.start()
            self.addCleanup(mocked.stop)
        self.sender = Usuario.objects.create_user(username='gif_sender')
        self.recipient = Usuario.objects.create_user(username='gif_recipient')
        self.stranger = Usuario.objects.create_user(username='gif_stranger')
        self.connection = Connection.objects.create(sender=self.sender, receiver=self.recipient, accepted=True)
        self.raw = animated_gif_bytes()
        self.client = self.authenticated(self.sender)

    def authenticated(self, user):
        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION=f'Bearer {RefreshToken.for_user(user).access_token}')
        return client

    def upload(self, filename='animated.gif', data=None, content_type='image/gif', client=None):
        return (client or self.client).post('/chat/messages/media/', {
            'connectionId': self.connection.pk, 'type': 'image',
            'file': SimpleUploadedFile(filename, self.raw if data is None else data, content_type=content_type),
        }, format='multipart')

    def read(self, response):
        try:
            if not response.streaming:
                return response.content
            async def consume():
                return b''.join([part async for part in response.streaming_content])
            return async_to_sync(consume)()
        finally:
            response.close()

    def test_upload_retains_every_original_byte_and_both_animation_frames(self):
        response = self.upload()
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data['message']['type'], 'image')
        self.assertEqual(response.data['message']['filename'], 'animated.gif')
        message = Message.objects.get()
        with message.image.open('rb') as stored:
            original = stored.read()
        self.assertEqual(original, self.raw)
        with Image.open(BytesIO(original)) as decoded:
            self.assertEqual(decoded.format, 'GIF')
            self.assertEqual(decoded.n_frames, 2)
            self.assertEqual(decoded.info['loop'], 0)
            decoded.seek(1)
            self.assertEqual(decoded.convert('RGB').getpixel((0, 0)), (0, 0, 255))

    def test_gif_extension_mime_and_decoded_content_must_agree_without_saving_rejected_files(self):
        png = BytesIO()
        Image.new('RGB', (2, 2), 'green').save(png, 'PNG')
        cases = (
            ('fake.gif', png.getvalue(), 'image/gif'),
            ('renamed.png', self.raw, 'image/png'),
            ('renamed.jpg', self.raw, 'image/gif'),
            ('wrong-mime.gif', self.raw, 'image/jpeg'),
            ('truncated.gif', b'GIF89a', 'image/gif'),
        )
        for filename, data, mime in cases:
            with self.subTest(filename=filename):
                self.assertEqual(self.upload(filename, data, mime).status_code, 400)
        self.assertFalse(Message.objects.exists())
        self.assertFalse(any(path.is_file() for path in Path(self.directory.name).rglob('*')))

    def test_gif_uses_configured_image_size_limit_and_generic_mime_remains_supported(self):
        limits = {'image': len(self.raw) - 1, 'audio': 1000, 'video': 1000, 'document': 1000}
        with override_settings(CHAT_MEDIA_MAX_BYTES=limits):
            self.assertEqual(self.upload().status_code, 413)
        self.assertFalse(Message.objects.exists())
        limits['image'] = len(self.raw)
        with override_settings(CHAT_MEDIA_MAX_BYTES=limits):
            self.assertEqual(self.upload(content_type='application/octet-stream').status_code, 201)

    def test_original_animation_download_is_private_to_current_conversation_members(self):
        response = self.upload()
        self.assertEqual(response.status_code, 201)
        url = response.data['message']['image']
        self.assertRegex(url, r'^/chat/messages/\d+/media/image/$')
        self.assertNotIn('ticket', url)
        anonymous = APIClient()
        stranger = self.authenticated(self.stranger)
        self.assertEqual(anonymous.get(url).status_code, 401)
        self.assertEqual(stranger.post(url + 'access/', {}, format='json').status_code, 403)
        self.assertEqual(stranger.get(url).status_code, 403)
        for user in (self.sender, self.recipient):
            client = self.authenticated(user)
            signed = client.post(url + 'access/', {}, format='json')
            self.assertEqual(signed.status_code, 200)
            download = anonymous.get(signed.data['url'])
            self.assertEqual(download.status_code, 200)
            self.assertEqual(download['Content-Type'], 'image/gif')
            self.assertEqual(download['Cache-Control'], 'private, no-store')
            self.assertEqual(self.read(download), self.raw)
        message = Message.objects.get()
        self.assertEqual(anonymous.get('/media/' + message.image.name).status_code, 404)
        self.connection.accepted = False
        self.connection.save(update_fields=['accepted'])
        self.assertEqual(anonymous.get(signed.data['url']).status_code, 403)

    def test_gif_upload_requires_authenticated_accepted_membership(self):
        self.assertEqual(self.upload(client=APIClient()).status_code, 401)
        self.assertEqual(self.upload(client=self.authenticated(self.stranger)).status_code, 403)
        self.connection.accepted = False
        self.connection.save(update_fields=['accepted'])
        self.assertEqual(self.upload().status_code, 400)
        self.assertFalse(Message.objects.exists())
