import importlib
import json
import tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier, Event
from types import SimpleNamespace
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

from asgiref.sync import async_to_sync
from channels.db import database_sync_to_async
from channels.layers import get_channel_layer
from channels.routing import URLRouter
from channels.testing import WebsocketCommunicator
from django.contrib.auth.tokens import default_token_generator
from django.core import mail, signing
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.core.files.base import ContentFile
from django.db import IntegrityError, OperationalError, close_old_connections, transaction
from django.test import SimpleTestCase, TestCase, TransactionTestCase, override_settings
from django.utils import timezone
from django.utils.encoding import force_bytes
from django.utils.http import urlsafe_base64_encode
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import AccessToken, RefreshToken

from calls.models import BusyParticipant, Call
from calls.routing import websocket_urlpatterns as call_routes
from calls.services import act, create_call

from .consumers import ChatConsumer
from .media_access import TICKET_SALT, create_access_ticket, media_url
from .middleware import JWTAuthMiddleware
from .models import Connection, Message, Usuario
from .password_reset import (CONFIRM_DETAIL, INVALID_DETAIL, REQUEST_DETAIL, UNAVAILABLE_DETAIL,
                             deliver_password_reset, queue_password_reset, recovery_configuration_ready,
                             reset_password)
from .serializers import FriendSerializer, RequestSerializer, UsuarioSerializer
from .services import user_group_name
from .views import get_auth_for_user

FIXTURE_SETTINGS = {
    'SECRET_KEY': 'password-recovery-fixture-only-2026-never-use-for-deployment',
    'PASSWORD_HASHERS': ['django.contrib.auth.hashers.MD5PasswordHasher'],
    'DEBUG': True,
    'EMAIL_BACKEND': 'django.core.mail.backends.locmem.EmailBackend',
    'DEFAULT_FROM_EMAIL': 'mensajeria@example.test',
    'PASSWORD_RESET_URL': 'https://app.example.test/reset-password',
    'PASSWORD_RESET_APP_URL': 'chatlocal://reset-password',
    'PASSWORD_RESET_TIMEOUT': 1800,
    'CACHES': {'default': {'BACKEND': 'django.core.cache.backends.locmem.LocMemCache', 'LOCATION': 'recovery-tests-only'}},
    'CHANNEL_LAYERS': {'default': {'BACKEND': 'channels.layers.InMemoryChannelLayer'}},
}
OLD_PASSWORD = 'OriginalStrong!Password-2026'
NEW_PASSWORD = 'ReplacementStrong!Password-9274'


class RecoveryFixtures:
    def setUp(self):
        super().setUp()
        cache.clear()
        mail.get_connection()  # Initialize the isolated locmem outbox.
        mail.outbox.clear()
        self.alice = Usuario.objects.create_user(username='recovery_alice', email='alice@example.test', password=OLD_PASSWORD)
        self.bob = Usuario.objects.create_user(username='recovery_bob', email='bob@example.test', password=OLD_PASSWORD)
        self.connection = Connection.objects.create(sender=self.alice, receiver=self.bob, accepted=True)
        self.client = APIClient()

    def recovery_values(self, user=None):
        user = user or self.alice
        return {'uid': urlsafe_base64_encode(force_bytes(user.pk)), 'token': default_token_generator.make_token(user), 'password': NEW_PASSWORD}

    def confirm(self, values=None):
        return self.client.post('/chat/password-reset/confirm/', values or self.recovery_values(), format='json')


@override_settings(**FIXTURE_SETTINGS)
class EmailAccountTests(RecoveryFixtures, TestCase):
    def signup(self, **changes):
        data = {'username': 'new_email_user', 'first_name': 'New', 'last_name': 'User',
                'email': '  NEW.User@EXAMPLE.TEST  ', 'password': NEW_PASSWORD, **changes}
        return self.client.post('/chat/signup/', data, format='json')

    def test_signup_requires_valid_email_normalizes_and_keeps_own_fields_private(self):
        for email in ('', 'invalid-address', '\nwrong@example.test\rInjected'):
            self.assertEqual(self.signup(email=email).status_code, 400)
        response = self.signup()
        self.assertEqual(response.status_code, 201, response.data)
        self.assertEqual((response.data['user']['email'], response.data['user']['authVersion']), ('new.user@example.test', 0))
        user = Usuario.objects.get(username='new_email_user')
        self.assertEqual(user.email_key, 'new.user@example.test')
        for serializer in (UsuarioSerializer(user), RequestSerializer(self.connection), FriendSerializer(self.connection, context={'user': self.alice})):
            self.assertNotIn('"email":', json.dumps(serializer.data))
            self.assertNotIn('"authVersion":', json.dumps(serializer.data))
        self.assertEqual(AccessToken(response.data['tokens']['access'])['auth_version'], 0)

    def test_missing_email_case_duplicate_and_database_collision_are_rejected(self):
        data = {'username': 'no_email', 'first_name': 'New', 'last_name': 'User', 'password': NEW_PASSWORD}
        self.assertIn('email', self.client.post('/chat/signup/', data, format='json').data)
        response = self.signup(email=' ALICE@EXAMPLE.TEST ')
        self.assertEqual(response.status_code, 400)
        self.assertIn('email', response.data)
        with self.assertRaises(IntegrityError), transaction.atomic():
            Usuario.objects.bulk_create([Usuario(username='collision', email='not-aliased@example.test', email_key=self.alice.email_key)])

    def test_email_patch_requires_current_password_and_preserves_push_updates(self):
        self.client.force_authenticate(self.alice)
        for data in ({'email': 'replacement@example.test'}, {'email': 'replacement@example.test', 'current_password': 'incorrect'}):
            response = self.client.patch('/chat/me/', data, format='json')
            self.assertEqual(response.status_code, 400)
            self.assertIn('current_password', response.data)
        response = self.client.patch('/chat/me/', {'email': ' New.Address@EXAMPLE.TEST ', 'current_password': OLD_PASSWORD,
                                                  'pushToken': 'new-own-device', 'authVersion': 100, 'is_staff': True}, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['user']['email'], 'new.address@example.test')
        self.assertEqual(response.data['user']['authVersion'], 0)
        self.alice.refresh_from_db()
        self.assertEqual((self.alice.email_key, self.alice.pushToken, self.alice.is_staff), ('new.address@example.test', 'new-own-device', False))
        self.assertEqual(self.client.patch('/chat/me/', {'pushToken': None}, format='json').status_code, 200)

    def test_email_patch_real_bearer_jwt_updates_normalized_email_and_key(self):
        self.client.credentials(HTTP_AUTHORIZATION='Bearer ' + get_auth_for_user(self.alice)['tokens']['access'])
        response = self.client.patch('/chat/me/', {'email': ' JWT.New@EXAMPLE.TEST ', 'current_password': OLD_PASSWORD}, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['user']['email'], 'jwt.new@example.test')
        self.alice.refresh_from_db()
        self.assertEqual((self.alice.email, self.alice.email_key, self.alice.auth_version), ('jwt.new@example.test', 'jwt.new@example.test', 0))
        self.assertTrue(self.alice.check_password(OLD_PASSWORD))

    def test_patch_cannot_take_other_email_or_blank_current_email(self):
        self.client.force_authenticate(self.alice)
        for email in (' BOB@EXAMPLE.TEST ', ''):
            response = self.client.patch('/chat/me/', {'email': email, 'current_password': OLD_PASSWORD}, format='json')
            self.assertEqual(response.status_code, 400)
            self.assertIn('email', response.data)

    def test_legacy_blank_account_can_signin_and_add_email_without_changing_password(self):
        user = Usuario.objects.create_user(username='legacy_no_email', password=OLD_PASSWORD)
        response = self.client.post('/chat/signin/', {'username': user.username, 'password': OLD_PASSWORD}, format='json')
        self.assertEqual((response.status_code, response.data['user']['email']), (200, ''))
        self.client.credentials(HTTP_AUTHORIZATION='Bearer ' + response.data['tokens']['access'])
        response = self.client.patch('/chat/me/', {'email': 'legacy@example.test', 'current_password': OLD_PASSWORD}, format='json')
        self.assertEqual(response.status_code, 200)
        user.refresh_from_db()
        self.assertTrue(user.check_password(OLD_PASSWORD))
        self.assertEqual(user.email_key, 'legacy@example.test')

    def test_migration_reserves_only_unambiguous_emails_without_rewriting_legacy_values(self):
        first = Usuario.objects.create_user(username='legacy_first')
        second = Usuario.objects.create_user(username='legacy_second')
        unique = Usuario.objects.create_user(username='legacy_unique')
        blank = Usuario.objects.create_user(username='legacy_blank')
        Usuario.objects.filter(pk=first.pk).update(email=' Legacy@EXAMPLE.TEST ')
        Usuario.objects.filter(pk=second.pk).update(email='legacy@example.test')
        Usuario.objects.filter(pk=unique.pk).update(email=' MixedCase@EXAMPLE.TEST ')
        migration = importlib.import_module('chat.migrations.0013_usuario_email_key_auth_version')
        migration.reserve_unambiguous_emails(SimpleNamespace(get_model=lambda *args: Usuario), SimpleNamespace(connection=SimpleNamespace(alias='default')))
        for user in (first, second, unique, blank):
            user.refresh_from_db()
        self.assertEqual((first.email, first.email_key, second.email_key, blank.email, blank.email_key),
                         (' Legacy@EXAMPLE.TEST ', None, None, '', None))
        self.assertEqual((unique.email, unique.email_key), (' MixedCase@EXAMPLE.TEST ', 'mixedcase@example.test'))
        self.assertEqual(self.signup(email='legacy@example.test').status_code, 400)
        # A push-token save preserves ambiguous historical addresses untouched.
        first.pushToken = 'legacy-push'
        first.save(update_fields=['pushToken'])
        first.refresh_from_db()
        self.assertEqual(first.email, ' Legacy@EXAMPLE.TEST ')

    def test_duplicate_signup_race_reports_email_field_instead_of_username(self):
        with patch('chat.serializers.SignUpSerializer.create', side_effect=IntegrityError('fixture-only')):
            # Force a uniqueness collision after initial serializer validation.
            with patch('chat.serializers.validate_unique_email', return_value=self.alice.email):
                response = self.signup(email=self.alice.email)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(set(response.data), {'email'})

    def test_avatar_update_from_stale_scope_does_not_overwrite_private_email_or_auth_version(self):
        from .tests import ChatConsumerMediaTests, encode_bytes, image_bytes
        directory = tempfile.TemporaryDirectory(prefix='recovery-avatar-fixture-')
        self.addCleanup(directory.cleanup)
        # This socket scope predates an email update; only the avatar may be saved.
        Usuario.objects.filter(pk=self.alice.pk).update(email='changed@example.test', email_key='changed@example.test')
        consumer = ChatConsumerMediaTests.make_consumer(self, self.alice)
        with override_settings(MEDIA_ROOT=directory.name):
            consumer.receive_miniatura({'base64': encode_bytes(image_bytes()), 'filename': 'fixture.jpg'})
        self.alice.refresh_from_db()
        self.assertEqual((self.alice.email, self.alice.email_key, self.alice.auth_version), ('changed@example.test', 'changed@example.test', 0))
        self.assertTrue(self.alice.miniatura)
        self.assertEqual(set(consumer.sent_groups[0]['data']), {'username', 'name', 'miniatura'})


@override_settings(**FIXTURE_SETTINGS)
class PasswordRecoveryHttpTests(RecoveryFixtures, TestCase):
    def test_request_same_response_no_account_query_and_no_token_or_identity_in_http(self):
        with patch('chat.views.queue_password_reset', return_value=True) as queued:
            for email in ('ALICE@example.test', 'unknown@example.test'):
                with self.assertNumQueries(0):
                    response = self.client.post('/chat/password-reset/request/', {'email': email}, format='json')
                self.assertEqual((response.status_code, response.data), (200, {'detail': REQUEST_DETAIL}))
            self.assertEqual([call.args[0] for call in queued.call_args_list], ['alice@example.test', 'unknown@example.test'])

    def test_unconfigured_mail_is_global_503_even_before_invalid_or_known_input(self):
        with override_settings(EMAIL_BACKEND='django.core.mail.backends.smtp.EmailBackend', EMAIL_HOST='', DEFAULT_FROM_EMAIL=''):
            for email in (self.alice.email, 'unknown@example.test', 'invalid'):
                with self.assertNumQueries(0), patch('chat.views.queue_password_reset') as queued:
                    response = self.client.post('/chat/password-reset/request/', {'email': email}, format='json')
                self.assertEqual((response.status_code, response.data), (503, {'detail': UNAVAILABLE_DETAIL}))
                queued.assert_not_called()

    def test_delivery_fixed_web_and_native_urls_copyable_code_and_no_host_injection(self):
        deliver_password_reset(self.alice.email)
        self.assertEqual(len(mail.outbox), 1)
        message = mail.outbox[0]
        self.assertEqual((message.to, message.from_email), ([self.alice.email], 'mensajeria@example.test'))
        links = [line for line in message.body.splitlines() if line.startswith(('https://', 'chatlocal://'))]
        self.assertEqual(len(links), 2)
        self.assertEqual(urlsplit(links[0]).hostname, 'app.example.test')
        query = parse_qs(urlsplit(links[0]).query)
        uid, token = query['uid'][0], query['token'][0]
        self.assertTrue(default_token_generator.check_token(self.alice, token))
        self.assertIn(uid + ':' + token, message.body)
        self.assertIn('30 minutos', message.body)
        self.assertEqual(parse_qs(urlsplit(links[1]).query), query)

    def test_unknown_inactive_unusable_or_ambiguous_email_never_sends(self):
        self.bob.is_active = False
        self.bob.save(update_fields=['is_active'])
        unusable = Usuario.objects.create_user(username='unusable_email', email='unusable@example.test')
        duplicate = Usuario.objects.create_user(username='duplicate_legacy')
        Usuario.objects.filter(pk=duplicate.pk).update(email=' ALICE@EXAMPLE.TEST ')
        for email in ('unknown@example.test', self.bob.email, unusable.email, self.alice.email):
            deliver_password_reset(email)
        self.assertEqual(mail.outbox, [])

    def test_unicode_case_ambiguous_legacy_address_is_never_arbitrarily_reset_on_sqlite(self):
        first = Usuario.objects.create_user(username='unicode_legacy_one')
        second = Usuario.objects.create_user(username='unicode_legacy_two')
        Usuario.objects.filter(pk=first.pk).update(email='Élodie@example.test', password=self.alice.password)
        Usuario.objects.filter(pk=second.pk).update(email='élodie@example.test', password=self.alice.password)
        deliver_password_reset('élodie@example.test')
        self.assertEqual(mail.outbox, [])
        response = self.client.post('/chat/signup/', {'username': 'unicode_new', 'first_name': 'New', 'last_name': 'Person',
                                                     'email': 'ÉLODIE@example.test', 'password': NEW_PASSWORD}, format='json')
        self.assertEqual(response.status_code, 400)
        self.assertIn('email', response.data)

    def test_rate_limits_ip_email_and_cooldown_are_generic_and_forwarded_ip_not_trusted(self):
        with override_settings(PASSWORD_RESET_REQUEST_IP_LIMIT=2), patch('chat.views.queue_password_reset', return_value=True) as queued:
            for index in range(4):
                response = self.client.post('/chat/password-reset/request/', {'email': f'unknown-{index}@example.test'},
                                            format='json', HTTP_X_FORWARDED_FOR=f'10.0.0.{index + 1}')
                self.assertEqual((response.status_code, response.data), (200, {'detail': REQUEST_DETAIL}))
            self.assertEqual(queued.call_count, 2)
        cache.clear()
        with patch('chat.views.queue_password_reset', return_value=True) as queued:
            for address in ('127.0.0.1', '127.0.0.2'):
                self.client.post('/chat/password-reset/request/', {'email': self.alice.email}, format='json', REMOTE_ADDR=address)
            self.assertEqual(queued.call_count, 1)
        self.assertTrue(all('alice' not in key and '127.0.0' not in key for key in cache._cache))

    def test_busy_queue_fails_equally_for_known_and_unknown(self):
        with patch('chat.views.queue_password_reset', return_value=False):
            for email in (self.alice.email, 'unknown@example.test'):
                self.assertEqual(self.client.post('/chat/password-reset/request/', {'email': email}, format='json').status_code, 503)

    def test_valid_confirmation_one_use_password_validation_and_other_account_unchanged(self):
        values = self.recovery_values()
        weak = self.confirm({**values, 'password': '12345678'})
        self.assertEqual(weak.status_code, 400)
        self.assertIn('password', weak.data)
        self.assertTrue(default_token_generator.check_token(self.alice, values['token']))
        response = self.confirm(values)
        self.assertEqual((response.status_code, response.data), (200, {'detail': CONFIRM_DETAIL, 'username': self.alice.username}))
        self.alice.refresh_from_db()
        self.bob.refresh_from_db()
        self.assertTrue(self.alice.check_password(NEW_PASSWORD))
        self.assertEqual(self.alice.auth_version, 1)
        self.assertTrue(self.bob.check_password(OLD_PASSWORD))
        self.assertEqual(self.confirm(values).data, {'detail': INVALID_DETAIL})

    def test_invalid_expired_inactive_and_changed_email_use_same_error(self):
        values = self.recovery_values()
        cases = [{**values, 'uid': 'not-base64'}, {**values, 'uid': '999999999999999999999999999999999999999999'},
                 {**values, 'token': 'invalid'}, {**values, 'token': values['token'][:-1] + ('0' if values['token'][-1] != '0' else '1')}]
        for value in cases:
            response = self.confirm(value)
            self.assertEqual((response.status_code, response.data), (400, {'detail': INVALID_DETAIL}))
        with patch.object(default_token_generator, '_now', return_value=default_token_generator._now() + timedelta(seconds=1801)):
            self.assertEqual(self.confirm(values).data, {'detail': INVALID_DETAIL})
        self.alice.is_active = False
        self.alice.save(update_fields=['is_active'])
        self.assertEqual(self.confirm(values).data, {'detail': INVALID_DETAIL})
        self.alice.is_active = True
        self.alice.email = 'changed@example.test'
        self.alice.save(update_fields=['is_active', 'email'])
        self.assertEqual(self.confirm(values).data, {'detail': INVALID_DETAIL})

    def test_confirm_ip_bruteforce_limit_does_not_disclose_account(self):
        values = self.recovery_values()
        bad = {**values, 'token': 'abc-00000000000000000000000000000000'}
        with override_settings(PASSWORD_RESET_CONFIRM_IP_LIMIT=2):
            self.assertEqual(self.confirm(bad).status_code, 400)
            self.assertEqual(self.confirm(bad).status_code, 400)
            response = self.confirm(values)
        self.assertEqual(response.status_code, 429)
        self.assertNotIn(self.alice.username, str(response.data))

    def test_reset_revokes_legacy_http_refresh_and_tickets_but_other_account_survives(self):
        directory = tempfile.TemporaryDirectory(prefix='password-reset-media-fixture-')
        self.addCleanup(directory.cleanup)
        with override_settings(MEDIA_ROOT=directory.name):
            message = Message.objects.create(connection=self.connection, user=self.alice, text='[Audio]')
            message.audio.save('fixture.m4a', ContentFile(b'fixture-audio'))
            alice_ticket = create_access_ticket(self.alice, message.pk, 'audio')['url']
            bob_ticket = create_access_ticket(self.bob, message.pk, 'audio')['url']
            # Old signed tickets lacking version remain usable only at version0.
            legacy_ticket = signing.dumps({'user': self.alice.pk, 'message': message.pk, 'kind': 'audio'}, salt=TICKET_SALT)
            old_refresh = str(RefreshToken.for_user(self.alice))
            old_access = str(RefreshToken(old_refresh).access_token)
            self.assertEqual(self.confirm().status_code, 200)
            self.client.credentials(HTTP_AUTHORIZATION='Bearer ' + old_access)
            self.assertEqual(self.client.get('/chat/me/').status_code, 401)
            self.assertEqual(self.client.post('/chat/token/refresh/', {'refresh': old_refresh}, format='json').status_code, 401)
            self.client.credentials()
            for url in (alice_ticket, media_url(message.pk, 'audio') + '?ticket=' + legacy_ticket):
                self.assertEqual(self.client.get(url).status_code, 401)
            response = self.client.get(bob_ticket)
            self.assertEqual(response.status_code, 200)
            response.close()
            login = self.client.post('/chat/signin/', {'username': self.alice.username, 'password': NEW_PASSWORD}, format='json')
            self.assertEqual(login.status_code, 200)
            self.assertEqual(AccessToken(login.data['tokens']['access'])['auth_version'], 1)
            self.client.credentials(HTTP_AUTHORIZATION='Bearer ' + login.data['tokens']['access'])
            self.assertEqual(self.client.get('/chat/me/').status_code, 200)
            self.assertEqual(self.client.post('/chat/token/refresh/', {'refresh': login.data['tokens']['refresh']}, format='json').status_code, 200)

    def test_legacy_refresh_is_upgraded_and_bad_version_claims_fail_closed(self):
        legacy = RefreshToken.for_user(self.alice)
        response = self.client.post('/chat/token/refresh/', {'refresh': str(legacy)}, format='json')
        self.assertEqual(AccessToken(response.data['access'])['auth_version'], 0)
        for version in (False, '0', -1, 2147483648, None):
            legacy['auth_version'] = version
            response = self.client.post('/chat/token/refresh/', {'refresh': str(legacy)}, format='json')
            self.assertEqual(response.status_code, 401)

    def test_mail_failure_log_is_constant_and_never_contains_recipient_or_token(self):
        with patch('chat.password_reset.EmailMessage.send', side_effect=RuntimeError('secret SMTP password token recipient alice@example.test')):
            with self.assertLogs('chat.password_reset', level='WARNING') as captured:
                deliver_password_reset(self.alice.email)
        self.assertEqual(captured.output, ['WARNING:chat.password_reset:password_reset_delivery_failed'])


@override_settings(**FIXTURE_SETTINGS)
class RecoveryConfigurationTests(SimpleTestCase):
    def test_allowlisted_web_native_and_production_url_and_transport_config(self):
        self.assertTrue(recovery_configuration_ready())
        for url in ('https://user:password@app.example.test/reset-password', 'https://app.example.test/reset-password?uid=anything',
                    'https://app.example.test/reset-password#fragment', 'javascript:alert(1)', 'chatlocal://other-screen',
                    'https://app.example.test:bad/reset-password', 'https://app.example.test/reset-password?',
                    'https://app.example.test/reset-password#', 'https://app.example.test\\reset-password'):
            with override_settings(PASSWORD_RESET_URL=url):
                self.assertFalse(recovery_configuration_ready())
        with override_settings(PASSWORD_RESET_URL='chatlocal://reset-password'):
            self.assertTrue(recovery_configuration_ready())
        with override_settings(DEBUG=False, PASSWORD_RESET_URL='http://192.168.0.107:8081/reset-password',
                               EMAIL_BACKEND='django.core.mail.backends.smtp.EmailBackend', EMAIL_HOST='smtp.example.test',
                               EMAIL_HOST_USER='fixture', EMAIL_HOST_PASSWORD='fixture-only', EMAIL_TIMEOUT=5):
            self.assertFalse(recovery_configuration_ready())
        with override_settings(DEBUG=False):
            self.assertFalse(recovery_configuration_ready())  # Production never silently uses locmem.
        with override_settings(EMAIL_BACKEND='django.core.mail.backends.console.EmailBackend', MAIL_DEV_CONSOLE=False):
            self.assertFalse(recovery_configuration_ready())

    def test_queue_capacity_and_failed_submit_release_slot_without_secret_logs(self):
        capacity = Mock()
        capacity.acquire.return_value = False
        with patch('chat.password_reset._capacity', capacity), patch('chat.password_reset._executor') as executor:
            self.assertFalse(queue_password_reset('fixture@example.test'))
            executor.submit.assert_not_called()
        capacity.acquire.return_value = True
        with patch('chat.password_reset._capacity', capacity), patch('chat.password_reset._executor') as executor:
            executor.submit.side_effect = RuntimeError('never log this credential')
            with self.assertLogs('chat.password_reset', level='WARNING') as captured:
                self.assertTrue(queue_password_reset('fixture@example.test'))
            capacity.release.assert_called_once()
            self.assertEqual(captured.output, ['WARNING:chat.password_reset:password_reset_queue_unavailable'])


@override_settings(**FIXTURE_SETTINGS)
class RecoverySocketAndRaceTests(RecoveryFixtures, TransactionTestCase):
    def chat_socket(self, user, raw=None):
        raw = raw or get_auth_for_user(user)['tokens']['access']
        return WebsocketCommunicator(JWTAuthMiddleware(ChatConsumer.as_asgi()), '/ws/chat/?token=' + raw)

    def call_socket(self, user, device, raw=None):
        raw = raw or get_auth_for_user(user)['tokens']['access']
        return WebsocketCommunicator(JWTAuthMiddleware(URLRouter(call_routes)), f'/ws/calls/?token={raw}&deviceId={device}')

    async def call_initial(self, socket):
        self.assertEqual((await socket.receive_json_from())['type'], 'call.current')
        self.assertEqual((await socket.receive_json_from())['type'], 'call.authenticated')

    def test_email_patch_retries_short_transaction_after_real_concurrent_sqlite_writer(self):
        writing, release, finished = Event(), Event(), Event()
        self.client.credentials(HTTP_AUTHORIZATION='Bearer ' + get_auth_for_user(self.alice)['tokens']['access'])

        def websocket_writer():
            close_old_connections()
            try:
                with transaction.atomic():
                    Message.objects.create(connection_id=self.connection.pk, user_id=self.bob.pk, text='Concurrent fixture message')
                    writing.set()
                    if not release.wait(timeout=5):
                        raise RuntimeError('Fixture writer was not released.')
            finally:
                close_old_connections()
                finished.set()

        def release_on_retry(_delay):
            release.set()
            self.assertTrue(finished.wait(timeout=5))

        with ThreadPoolExecutor(max_workers=1) as executor:
            writer = executor.submit(websocket_writer)
            try:
                self.assertTrue(writing.wait(timeout=5))
                with patch('chat.views.sleep', side_effect=release_on_retry) as retry:
                    response = self.client.patch('/chat/me/', {'email': 'concurrent@example.test', 'current_password': OLD_PASSWORD}, format='json')
                self.assertEqual(response.status_code, 200, response.data)
                retry.assert_called_once()
            finally:
                release.set()
                writer.result(timeout=5)
        self.alice.refresh_from_db()
        self.assertEqual((self.alice.email, self.alice.email_key), ('concurrent@example.test', 'concurrent@example.test'))

    def test_email_patch_exhausted_lock_is_friendly_503_and_changes_nothing(self):
        self.client.credentials(HTTP_AUTHORIZATION='Bearer ' + get_auth_for_user(self.alice)['tokens']['access'])
        with patch('chat.serializers.PushTokenSerializer.save', side_effect=OperationalError('database is locked')) as saving:
            with patch('chat.views.sleep') as retry:
                response = self.client.patch('/chat/me/', {'email': 'blocked@example.test', 'current_password': OLD_PASSWORD}, format='json')
        self.assertEqual(response.status_code, 503)
        self.assertEqual(saving.call_count, 3)
        self.assertEqual(retry.call_count, 2)
        self.assertEqual(set(response.data), {'detail'})
        self.assertNotIn('locked', response.data['detail'])
        self.alice.refresh_from_db()
        self.assertEqual(self.alice.email, 'alice@example.test')

    def test_email_patch_revalidates_after_password_reset_between_validation_and_commit(self):
        self.client.credentials(HTTP_AUTHORIZATION='Bearer ' + get_auth_for_user(self.alice)['tokens']['access'])
        original_validate = __import__('chat.serializers', fromlist=['PushTokenSerializer']).PushTokenSerializer.is_valid

        def reset_after_validation(serializer, *args, **kwargs):
            result = original_validate(serializer, *args, **kwargs)
            Usuario.objects.filter(pk=self.alice.pk).update(auth_version=1)
            return result

        with patch('chat.serializers.PushTokenSerializer.is_valid', autospec=True, side_effect=reset_after_validation):
            response = self.client.patch('/chat/me/', {'email': 'stale@example.test', 'current_password': OLD_PASSWORD}, format='json')
        self.assertEqual(response.status_code, 401)
        self.alice.refresh_from_db()
        self.assertEqual(self.alice.email, 'alice@example.test')

    def test_reset_closes_all_old_chat_devices_not_other_user_or_new_session(self):
        values = self.recovery_values()

        async def run():
            sockets = [self.chat_socket(self.alice), self.chat_socket(self.alice), self.chat_socket(self.bob)]
            newer = None
            try:
                for socket in sockets:
                    self.assertTrue((await socket.connect())[0])
                self.assertIsNotNone(await database_sync_to_async(reset_password)(**values))
                for socket in sockets[:2]:
                    self.assertEqual(await socket.receive_json_from(), {'source': 'auth.invalidated', 'data': {'authVersion': 1}})
                    self.assertEqual((await socket.receive_output())['code'], 4401)
                self.assertTrue(await sockets[2].receive_nothing(timeout=0.03))
                fresh_user = await database_sync_to_async(Usuario.objects.get)(pk=self.alice.pk)
                newer = self.chat_socket(fresh_user)
                self.assertTrue((await newer.connect())[0])
                await get_channel_layer().group_send(user_group_name(self.alice.username), {'type': 'auth_invalidated', 'authVersion': 1})
                self.assertTrue(await newer.receive_nothing(timeout=0.03))
                await newer.send_json_to({'source': 'friend.list'})
                self.assertEqual((await newer.receive_json_from())['source'], 'friend.list')
            finally:
                for socket in sockets + ([newer] if newer else []):
                    await socket.disconnect()
        async_to_sync(run)()

    def test_open_chat_receive_and_queued_delivery_recheck_database_version_without_notification(self):
        async def run():
            first, second = self.chat_socket(self.alice), self.chat_socket(self.alice)
            try:
                await first.connect()
                await second.connect()
                await database_sync_to_async(Usuario.objects.filter(pk=self.alice.pk).update)(auth_version=1)
                await first.send_json_to({'source': 'friend.list'})
                self.assertEqual((await first.receive_json_from())['source'], 'auth.invalidated')
                self.assertEqual((await first.receive_output())['code'], 4401)
                await get_channel_layer().group_send(user_group_name(self.alice.username),
                                                     {'type': 'broadcast_group', 'source': 'fixture-private', 'data': {'secret': 'must-not-deliver'}})
                self.assertEqual((await second.receive_json_from())['source'], 'auth.invalidated')
                self.assertEqual((await second.receive_output())['code'], 4401)
            finally:
                await first.disconnect()
                await second.disconnect()
        async_to_sync(run)()

    def test_reset_ends_only_owned_active_call_not_unrelated_call_and_closes_old_call_devices(self):
        values = self.recovery_values()
        devices = [uuid4(), uuid4(), uuid4()]
        unrelated_user = Usuario.objects.create_user(username='unrelated_one')
        unrelated_peer = Usuario.objects.create_user(username='unrelated_two')
        unrelated_connection = Connection.objects.create(sender=unrelated_user, receiver=unrelated_peer, accepted=True)
        unrelated = Call.objects.create(connection=unrelated_connection, caller=unrelated_user, callee=unrelated_peer,
                                        client_id=uuid4(), caller_device_id=uuid4(), kind='audio', status='active',
                                        expires_at=timezone.now() + timedelta(seconds=60))
        BusyParticipant.objects.bulk_create([BusyParticipant(user=unrelated_user, call=unrelated), BusyParticipant(user=unrelated_peer, call=unrelated)])

        async def run():
            sockets = [self.call_socket(self.alice, devices[0]), self.call_socket(self.alice, devices[1]), self.call_socket(self.bob, devices[2])]
            try:
                for socket in sockets:
                    self.assertTrue((await socket.connect())[0])
                    await self.call_initial(socket)
                owned = await database_sync_to_async(create_call)(self.alice, {'connectionId': self.connection.pk, 'kind': 'audio',
                                                                              'clientId': str(uuid4()), 'deviceId': str(devices[0])})
                for socket in sockets:
                    await socket.receive_json_from()
                await database_sync_to_async(act)(self.bob, owned.pk, 'accept', devices[2])
                for socket in sockets:
                    await socket.receive_json_from()
                await database_sync_to_async(reset_password)(**values)
                for socket in sockets[:2]:
                    event = await socket.receive_json_from()
                    self.assertEqual(event, {'type': 'auth.invalidated', 'authVersion': 1})
                    self.assertEqual((await socket.receive_output())['code'], 4401)
                ended = await sockets[2].receive_json_from()
                self.assertEqual((ended['call']['id'], ended['call']['status'], ended['call']['reason']), (str(owned.pk), 'ended', 'session_revoked'))
                self.assertTrue(await sockets[2].receive_nothing(timeout=0.03))
                self.assertEqual(await database_sync_to_async(BusyParticipant.objects.filter(call=owned).count)(), 0)
                self.assertEqual((await database_sync_to_async(Call.objects.get)(pk=unrelated.pk)).status, 'active')
                self.assertEqual(await database_sync_to_async(BusyParticipant.objects.filter(call=unrelated).count)(), 2)
            finally:
                for socket in sockets:
                    await socket.disconnect()
        async_to_sync(run)()

    def test_call_token_renewal_cannot_resurrect_revoked_connection_with_new_version(self):
        device = uuid4()

        async def run():
            socket = self.call_socket(self.alice, device)
            try:
                await socket.connect()
                await self.call_initial(socket)
                await database_sync_to_async(Usuario.objects.filter(pk=self.alice.pk).update)(auth_version=1)
                current = await database_sync_to_async(Usuario.objects.get)(pk=self.alice.pk)
                replacement = get_auth_for_user(current)['tokens']['access']
                await socket.send_json_to({'type': 'call.auth', 'token': replacement, 'deviceId': str(device)})
                self.assertEqual(await socket.receive_json_from(), {'type': 'auth.invalidated', 'authVersion': 1})
                self.assertEqual((await socket.receive_output())['code'], 4401)
                newer = self.call_socket(current, uuid4(), replacement)
                try:
                    self.assertTrue((await newer.connect())[0])
                    await self.call_initial(newer)
                    await get_channel_layer().group_send(f'calls.user.{current.pk}', {'type': 'auth_invalidated', 'authVersion': 1})
                    self.assertTrue(await newer.receive_nothing(timeout=0.03))
                    await newer.send_json_to({'type': 'call.ping'})
                    self.assertEqual((await newer.receive_json_from())['type'], 'call.pong')
                finally:
                    await newer.disconnect()
            finally:
                await socket.disconnect()
        async_to_sync(run)()

    def test_real_async_mail_worker_closes_connections_and_releases_capacity_before_fixture_teardown(self):
        # A dedicated executor is always joined while this test DB still exists.
        with ThreadPoolExecutor(max_workers=1) as executor:
            with patch('chat.password_reset._executor', executor), patch('chat.password_reset.close_old_connections', wraps=close_old_connections) as closed:
                self.assertTrue(queue_password_reset(self.alice.email))
                # FIFO barrier completes after the delivery, avoiding sleeps.
                executor.submit(lambda: None).result(timeout=5)
                self.assertEqual(len(mail.outbox), 1)
                self.assertEqual(closed.call_count, 2)

    def test_concurrent_confirmations_have_only_one_success_and_single_version_bump(self):
        values = self.recovery_values()
        barrier = Barrier(2)

        def worker(index):
            close_old_connections()
            try:
                barrier.wait(timeout=5)
                for attempt in range(10):
                    try:
                        return reset_password(**values) is not None
                    except OperationalError:
                        # Shared-memory SQLite serializes writers via retry;
                        # PostgreSQL uses row locks in the actual implementation.
                        import time
                        # Distinct bounded delays prevent the two test clients
                        # from continuously colliding on SQLite lock upgrades.
                        time.sleep(0.01 * (index + 1) * (attempt + 1))
                return False
            finally:
                close_old_connections()
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(worker, range(2)))
        self.assertEqual(sorted(results), [False, True])
        self.alice.refresh_from_db()
        self.assertEqual(self.alice.auth_version, 1)
        self.assertTrue(self.alice.check_password(NEW_PASSWORD))
