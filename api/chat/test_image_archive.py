import tempfile
from pathlib import Path
from unittest.mock import patch

from django.db import DatabaseError
from django.test import override_settings
from rest_framework.test import APIClient

from .models import Message, MessageImageArchive
from .test_gif_media import GifMessageMediaTests


@override_settings(CHAT_ARCHIVE_IMAGES=True, CHAT_IMAGE_ARCHIVE_MAX_BYTES=100 * 1024 * 1024)
class DurableImageTests(GifMessageMediaTests):
    # Also run the existing upload/format/privacy cases with archiving enabled.
    def test_photo_and_original_gif_frames_survive_a_completely_new_media_root(self):
        uploaded = self.upload()
        self.assertEqual(uploaded.status_code, 201)
        url = uploaded.data['message']['image']
        message = Message.objects.get()
        self.assertEqual(bytes(MessageImageArchive.objects.get().content), self.raw)
        with tempfile.TemporaryDirectory() as fresh_root, override_settings(MEDIA_ROOT=fresh_root):
            restored = Path(fresh_root) / message.image.name
            self.assertFalse(restored.exists())
            signed = self.client.post(url + 'access/', {}, format='json')
            self.assertEqual(signed.status_code, 200)
            self.assertEqual(restored.read_bytes(), self.raw)
            downloaded = APIClient().get(signed.data['url'])
            self.assertEqual(downloaded.status_code, 200)
            self.assertEqual(self.read(downloaded), self.raw)
            self.assertNotIn('content', uploaded.data['message'])
            self.assertNotIn('image_archive', uploaded.data['message'])

    def test_full_archive_rejects_upload_and_rolls_back_message_and_local_file(self):
        with override_settings(CHAT_IMAGE_ARCHIVE_MAX_BYTES=len(self.raw) - 1):
            response = self.upload()
        self.assertEqual(response.status_code, 413)
        self.assertFalse(Message.objects.exists())
        self.assertFalse(MessageImageArchive.objects.exists())
        self.assertFalse(any(path.is_file() for path in Path(self.directory.name).rglob('*')))

    def test_archive_failure_does_not_acknowledge_a_non_durable_photo(self):
        with patch('chat.image_archive.MessageImageArchive.objects.create', side_effect=DatabaseError('offline')):
            with self.assertLogs('chat.services', level='ERROR'):
                response = self.upload()
        self.assertEqual(response.status_code, 400)
        self.assertFalse(Message.objects.exists())
        self.assertFalse(MessageImageArchive.objects.exists())
        self.assertFalse(any(path.is_file() for path in Path(self.directory.name).rglob('*')))

    def test_total_budget_counts_previously_saved_photos(self):
        with override_settings(CHAT_IMAGE_ARCHIVE_MAX_BYTES=len(self.raw) * 2 - 1):
            self.assertEqual(self.upload().status_code, 201)
            self.assertEqual(self.upload().status_code, 413)
        self.assertEqual(Message.objects.count(), 1)
        self.assertEqual(MessageImageArchive.objects.count(), 1)

    def test_archive_for_another_filename_cannot_restore_a_missing_file(self):
        uploaded = self.upload()
        url = uploaded.data['message']['image']
        MessageImageArchive.objects.update(filename='messages/images/another.gif')
        with tempfile.TemporaryDirectory() as fresh_root, override_settings(MEDIA_ROOT=fresh_root):
            self.assertEqual(self.client.post(url + 'access/', {}, format='json').status_code, 404)

    def test_unauthorized_or_cleared_photo_is_never_restored(self):
        uploaded = self.upload()
        url = uploaded.data['message']['image']
        message = Message.objects.get()
        with tempfile.TemporaryDirectory() as fresh_root, override_settings(MEDIA_ROOT=fresh_root):
            restored = Path(fresh_root) / message.image.name
            stranger = self.authenticated(self.stranger)
            self.assertEqual(stranger.post(url + 'access/', {}, format='json').status_code, 403)
            self.assertFalse(restored.exists())
            self.connection.history_cleared_through = message.pk
            self.connection.save(update_fields=['history_cleared_through'])
            self.assertEqual(self.client.post(url + 'access/', {}, format='json').status_code, 404)
            self.assertFalse(restored.exists())

    def test_a_photo_without_archive_cannot_be_recreated_from_its_message(self):
        uploaded = self.upload()
        url = uploaded.data['message']['image']
        MessageImageArchive.objects.all().delete()
        with tempfile.TemporaryDirectory() as fresh_root, override_settings(MEDIA_ROOT=fresh_root):
            self.assertEqual(self.client.post(url + 'access/', {}, format='json').status_code, 404)
