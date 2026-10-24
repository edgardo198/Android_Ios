import tempfile
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from asgiref.sync import async_to_sync
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import DatabaseError
from django.test import TestCase, override_settings
from PIL import Image
from rest_framework.test import APIClient

from .models import AvatarImageArchive, Connection, MessageImageArchive, Usuario
from .services import ChatServiceError, create_media_message_from_file, save_avatar


@override_settings(CHAT_ARCHIVE_IMAGES=True, CHAT_IMAGE_ARCHIVE_MAX_BYTES=100 * 1024 * 1024,
                   PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher'])
class AvatarArchiveTests(TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.override = override_settings(MEDIA_ROOT=self.directory.name)
        self.override.enable()
        self.addCleanup(self.override.disable)
        self.user = Usuario.objects.create_user(username='avatar_sender')
        self.other = Usuario.objects.create_user(username='avatar_recipient')
        self.connection = Connection.objects.create(sender=self.user, receiver=self.other, accepted=True)
        output = BytesIO()
        Image.new('RGB', (8, 8), 'red').save(output, 'PNG')
        self.raw = output.getvalue()

    def photo(self):
        return SimpleUploadedFile('profile.png', self.raw, content_type='image/png')

    def read(self, response):
        async def consume():
            return b''.join([part async for part in response.streaming_content])
        try:
            return async_to_sync(consume)()
        finally:
            response.close()

    def test_public_profile_photo_is_restored_in_production_without_exposing_chat_media(self):
        save_avatar(self.user, self.photo())
        url = '/media/' + self.user.miniatura.name
        with tempfile.TemporaryDirectory() as fresh, override_settings(MEDIA_ROOT=fresh, DEBUG=False):
            response = APIClient().get(url)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(self.read(response), self.raw)
            self.assertEqual(response['Cache-Control'], 'no-cache')
            self.assertEqual(APIClient().get('/media/messages/images/private.png').status_code, 404)

    def test_replacing_avatar_uses_one_copy_and_does_not_consume_budget_twice(self):
        with override_settings(CHAT_IMAGE_ARCHIVE_MAX_BYTES=len(self.raw)):
            save_avatar(self.user, self.photo())
            save_avatar(self.user, self.photo())
        self.assertEqual(AvatarImageArchive.objects.count(), 1)
        self.assertEqual(bytes(AvatarImageArchive.objects.get().content), self.raw)

    def test_message_and_avatar_share_one_budget(self):
        with override_settings(CHAT_IMAGE_ARCHIVE_MAX_BYTES=len(self.raw) * 2 - 1):
            save_avatar(self.user, self.photo())
            with self.assertRaises(ChatServiceError):
                create_media_message_from_file(self.user, self.connection, self.photo(), 'image', broadcast=False)
        self.assertFalse(MessageImageArchive.objects.exists())
        self.assertEqual(AvatarImageArchive.objects.count(), 1)

    def test_failed_archive_preserves_the_previous_profile_and_removes_new_file(self):
        save_avatar(self.user, self.photo())
        original = self.user.miniatura.name
        with patch('chat.image_archive.AvatarImageArchive.objects.update_or_create', side_effect=DatabaseError('offline')):
            with self.assertRaises(ChatServiceError):
                save_avatar(self.user, self.photo())
        self.user.refresh_from_db()
        self.assertEqual(self.user.miniatura.name, original)
        self.assertEqual(len(list(Path(self.directory.name).rglob('*.png'))), 1)

    def test_stale_account_fields_are_not_overwritten_by_photo_update(self):
        Usuario.objects.filter(pk=self.user.pk).update(email='fresh@example.invalid', email_key='fresh@example.invalid', auth_version=3)
        save_avatar(self.user, self.photo())
        self.user.refresh_from_db()
        self.assertEqual(self.user.email, 'fresh@example.invalid')
        self.assertEqual(self.user.auth_version, 3)

    def test_replaced_or_disabled_avatar_cannot_be_restored_by_old_public_url(self):
        save_avatar(self.user, self.photo())
        old_url = '/media/' + self.user.miniatura.name
        save_avatar(self.user, self.photo())
        new_url = '/media/' + self.user.miniatura.name
        with tempfile.TemporaryDirectory() as fresh, override_settings(MEDIA_ROOT=fresh):
            self.assertEqual(APIClient().get(old_url).status_code, 404)
            Usuario.objects.filter(pk=self.user.pk).update(is_active=False)
            self.assertEqual(APIClient().get(new_url).status_code, 404)

    def test_missing_files_return_a_specific_error_only_after_authorization(self):
        message, _ = create_media_message_from_file(self.user, self.connection, self.photo(), 'image', broadcast=False)
        MessageImageArchive.objects.all().delete()
        Path(message.image.path).unlink()
        client = APIClient()
        url = f'/chat/messages/{message.pk}/media/image/access/'
        client.force_authenticate(user=self.user)
        response = client.post(url)
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.data['code'], 'media_missing')
        client.force_authenticate(user=Usuario.objects.create_user(username='avatar_stranger'))
        self.assertEqual(client.post(url).status_code, 403)
