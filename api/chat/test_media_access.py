import tempfile
import time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch

from asgiref.sync import async_to_sync
from django.core import signing
from django.core.files.base import ContentFile
from django.test import TestCase, override_settings
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import RefreshToken

from .media_access import TICKET_SALT, media_url
from .models import Connection, Message, Usuario
from .serializers import MessageSerializer


@override_settings(PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher'])
class PrivateMessageMediaTests(TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='chat-private-media-tests-')
        self.override = override_settings(MEDIA_ROOT=self.directory.name, CHAT_MEDIA_ACCESS_TTL_SECONDS=900)
        self.override.enable()
        self.addCleanup(self.directory.cleanup)
        self.addCleanup(self.override.disable)
        self.sender = Usuario.objects.create_user(username='sender')
        self.recipient = Usuario.objects.create_user(username='recipient')
        self.stranger = Usuario.objects.create_user(username='stranger')
        self.connection = Connection.objects.create(sender=self.sender, receiver=self.recipient, accepted=True)
        self.message = self.make_message('audio')
        self.client = APIClient()
        self.client.force_authenticate(user=self.sender)

    def make_message(self, kind, filename=None, data=b'0123456789'):
        filenames = {'image': 'photo.jpg', 'audio': 'note.m4a', 'video': 'clip.mp4', 'document': 'report.pdf'}
        message = Message.objects.create(user=self.sender, connection=self.connection, text=f'[{kind}]')
        getattr(message, kind).save(filename or filenames[kind], ContentFile(data))
        return message

    def issue(self, message=None, kind='audio', client=None):
        return (client or self.client).post(media_url((message or self.message).pk, kind) + 'access/', {}, format='json')

    def signed_url(self, message=None, kind='audio', client=None):
        response = self.issue(message, kind, client)
        self.assertEqual(response.status_code, 200)
        return response.data['url']

    def read(self, response):
        try:
            if not response.streaming:
                return response.content
            if response.is_async:
                async def consume():
                    return b''.join([chunk async for chunk in response.streaming_content])
                return async_to_sync(consume)()
            return b''.join(response.streaming_content)
        finally:
            response.close()

    def test_sender_and_recipient_can_issue_and_download_all_types_with_jwt(self):
        for kind in ('image', 'audio', 'video', 'document'):
            message = self.make_message(kind)
            for user in (self.sender, self.recipient):
                with self.subTest(kind=kind, user=user.pk):
                    client = APIClient()
                    client.credentials(HTTP_AUTHORIZATION='Bearer ' + str(RefreshToken.for_user(user).access_token))
                    response = self.issue(message, kind, client)
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.data['expiresIn'], 900)
                    self.assertIn('expiresAt', response.data)
                    self.assertEqual(response['Cache-Control'], 'private, no-store')
                    download = client.get(media_url(message.pk, kind))
                    self.assertEqual(download.status_code, 200)
                    self.assertEqual(self.read(download), b'0123456789')

    def test_anonymous_requires_ticket_and_stranger_cannot_issue_or_use_one(self):
        url = self.signed_url()
        anonymous = APIClient()
        self.assertEqual(anonymous.post(media_url(self.message.pk, 'audio') + 'access/').status_code, 401)
        self.assertEqual(anonymous.get(media_url(self.message.pk, 'audio')).status_code, 401)
        download = anonymous.get(url)
        self.assertEqual(download.status_code, 200)
        self.assertEqual(self.read(download), b'0123456789')
        self.client.force_authenticate(user=self.stranger)
        self.assertEqual(self.issue().status_code, 403)
        self.assertEqual(self.client.get(url).status_code, 403)

    def test_pending_and_revoked_connections_deny_jwt_and_existing_tickets(self):
        url = self.signed_url()
        self.connection.accepted = False
        self.connection.save(update_fields=['accepted'])
        self.assertEqual(self.issue().status_code, 403)
        self.assertEqual(self.client.get(media_url(self.message.pk, 'audio')).status_code, 403)
        self.assertEqual(APIClient().get(url).status_code, 403)

    def test_ticket_rechecks_current_membership(self):
        url = self.signed_url()
        self.connection.sender = self.stranger
        self.connection.save(update_fields=['sender'])
        self.assertEqual(APIClient().get(url).status_code, 403)

    def test_inactive_user_cannot_use_issued_ticket_or_jwt(self):
        url = self.signed_url()
        token = str(RefreshToken.for_user(self.sender).access_token)
        self.sender.is_active = False
        self.sender.save(update_fields=['is_active'])
        anonymous = APIClient()
        self.assertEqual(anonymous.get(url).status_code, 401)
        anonymous.credentials(HTTP_AUTHORIZATION='Bearer ' + token)
        self.assertEqual(anonymous.get(media_url(self.message.pk, 'audio')).status_code, 401)

    def test_ticket_tampering_and_expiry_are_rejected(self):
        url = self.signed_url()
        ticket = parse_qs(urlsplit(url).query)['ticket'][0]
        content, signature = ticket.rsplit(':', 1)
        tampered = content + ':' + ('A' if signature[0] != 'A' else 'B') + signature[1:]
        endpoint = media_url(self.message.pk, 'audio')
        client = APIClient()
        self.assertEqual(client.get(endpoint, {'ticket': tampered}).status_code, 401)
        with patch('django.core.signing.time.time', return_value=time.time() + 901):
            self.assertEqual(client.get(url).status_code, 401)

    @override_settings(CHAT_MEDIA_ACCESS_TTL_SECONDS=5)
    def test_configured_short_lifetime_is_used_and_never_exceeds_fifteen_minutes(self):
        response = self.issue()
        self.assertEqual(response.data['expiresIn'], 5)
        with patch('django.core.signing.time.time', return_value=time.time() + 6):
            self.assertEqual(APIClient().get(response.data['url']).status_code, 401)
        with override_settings(CHAT_MEDIA_ACCESS_TTL_SECONDS=9999):
            self.assertEqual(self.issue().data['expiresIn'], 900)

    def test_ticket_scope_cannot_cross_messages_or_media_kinds(self):
        url = self.signed_url()
        ticket = parse_qs(urlsplit(url).query)['ticket'][0]
        another = self.make_message('audio')
        client = APIClient()
        self.assertEqual(client.get(media_url(another.pk, 'audio'), {'ticket': ticket}).status_code, 401)
        self.assertEqual(client.get(media_url(self.message.pk, 'video'), {'ticket': ticket}).status_code, 401)
        stranger_ticket = signing.dumps({'message': self.message.pk, 'kind': 'audio', 'user': self.stranger.pk}, salt=TICKET_SALT)
        self.assertEqual(client.get(media_url(self.message.pk, 'audio'), {'ticket': stranger_ticket}).status_code, 403)

    def test_wrong_kind_missing_message_and_missing_file_never_issue_tickets(self):
        self.assertEqual(self.issue(kind='image').status_code, 404)
        self.assertEqual(self.issue(kind='unknown').status_code, 404)
        self.assertEqual(self.client.get(media_url(self.message.pk, 'image')).status_code, 404)
        self.assertEqual(self.client.post(media_url(999999, 'audio') + 'access/').status_code, 404)
        Path(self.message.audio.path).unlink()
        self.assertEqual(self.issue().status_code, 404)

    def test_storage_path_cannot_escape_root_even_for_legacy_database_values(self):
        Message.objects.filter(pk=self.message.pk).update(audio='../outside.m4a')
        self.assertEqual(self.issue().status_code, 404)
        self.assertEqual(self.client.get(media_url(self.message.pk, 'audio')).status_code, 404)

    def test_historical_files_serialize_protected_urls_without_modifying_storage(self):
        for kind in ('image', 'audio', 'video', 'document'):
            message = self.make_message(kind)
            original_name = getattr(message, kind).name
            payload = MessageSerializer(message, context={'user': self.sender}).data
            self.assertEqual(payload[kind], media_url(message.pk, kind))
            self.assertNotIn('ticket=', payload[kind])
            self.assertNotIn('/media/', payload[kind].replace('/media/' + kind + '/', '/'))
            message.refresh_from_db()
            self.assertEqual(getattr(message, kind).name, original_name)
            self.assertTrue(Path(getattr(message, kind).path).exists())

    def test_byte_ranges_are_bounded_and_support_open_suffix_and_clamped_end(self):
        client = APIClient()
        url = self.signed_url()
        for header, expected, content_range in (
            ('bytes=2-5', b'2345', 'bytes 2-5/10'),
            ('bytes=7-', b'789', 'bytes 7-9/10'),
            ('bytes=-3', b'789', 'bytes 7-9/10'),
            ('bytes=8-999', b'89', 'bytes 8-9/10'),
        ):
            with self.subTest(header=header):
                response = client.get(url, HTTP_RANGE=header)
                self.assertEqual(response.status_code, 206)
                self.assertEqual(response['Content-Range'], content_range)
                self.assertEqual(int(response['Content-Length']), len(expected))
                self.assertEqual(response['Accept-Ranges'], 'bytes')
                self.assertEqual(self.read(response), expected)

    def test_unsatisfiable_malformed_and_multiple_ranges_return_416(self):
        for value in ('bytes=10-', 'bytes=7-2', 'bytes=-0', 'bytes=-', 'bytes=1-2,4-5', 'bytes=abc-2'):
            with self.subTest(value=value):
                response = self.client.get(media_url(self.message.pk, 'audio'), HTTP_RANGE=value)
                self.assertEqual(response.status_code, 416)
                self.assertEqual(response['Content-Range'], 'bytes */10')
                self.assertEqual(self.read(response), b'')

    def test_head_has_full_headers_no_body_and_ignores_range(self):
        response = APIClient().head(self.signed_url(), HTTP_RANGE='bytes=2-5')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response['Content-Length'], '10')
        self.assertEqual(response['Accept-Ranges'], 'bytes')
        self.assertNotIn('Content-Range', response)
        self.assertEqual(self.read(response), b'')

    def test_download_is_async_streamed_in_blocks_and_has_private_headers(self):
        message = self.make_message('video', data=b'x' * (128 * 1024 + 7))
        response = self.client.get(media_url(message.pk, 'video'), HTTP_ACCEPT='video/mp4')
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.is_async)
        self.assertEqual(response['Cache-Control'], 'private, no-store')
        self.assertEqual(response['X-Content-Type-Options'], 'nosniff')
        self.assertEqual(response['Referrer-Policy'], 'no-referrer')
        async def sizes():
            return [len(chunk) async for chunk in response.streaming_content]
        try:
            self.assertEqual(async_to_sync(sizes)(), [65536, 65536, 7])
        finally:
            response.close()

    def test_documents_download_as_sanitized_attachments_and_media_is_inline(self):
        message = self.make_message('document', filename='report.pdf')
        response = self.client.get(media_url(message.pk, 'document'))
        self.assertEqual(response['Content-Disposition'], 'attachment; filename="report.pdf"')
        self.read(response)
        response = self.client.get(media_url(self.message.pk, 'audio'))
        self.assertEqual(response['Content-Disposition'], 'inline; filename="note.m4a"')
        self.read(response)

    @override_settings(DEBUG=True)
    def test_legacy_public_urls_are_blocked_even_in_debug_but_avatars_remain(self):
        anonymous = APIClient()
        for kind in ('image', 'audio', 'video', 'document'):
            message = self.make_message(kind)
            self.assertEqual(anonymous.get('/media/' + getattr(message, kind).name).status_code, 404)
        self.sender.miniatura.save('avatar.jpg', ContentFile(b'avatar'))
        avatar = anonymous.get('/media/' + self.sender.miniatura.name)
        self.assertEqual(avatar.status_code, 200)
        self.assertEqual(self.read(avatar), b'avatar')
        self.assertEqual(anonymous.get('/media/miniatura/../' + self.message.audio.name).status_code, 404)

    def test_errors_do_not_allow_public_caching(self):
        for url in (media_url(self.message.pk, 'audio'), media_url(self.message.pk, 'audio') + 'access/'):
            response = APIClient().get(url) if url.endswith('/audio/') else APIClient().post(url)
            self.assertEqual(response.status_code, 401)
            self.assertEqual(response['Cache-Control'], 'private, no-store')
