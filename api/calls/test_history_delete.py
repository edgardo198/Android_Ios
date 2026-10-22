import time
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import AsyncMock, patch
from uuid import uuid4

from asgiref.sync import async_to_sync
from channels.db import database_sync_to_async
from django.db import OperationalError, close_old_connections
from django.test import TestCase, TransactionTestCase, override_settings
from django.utils import timezone

from chat.models import Connection
from .models import BusyParticipant, Call
from .services import call_history, delete_call_history
from .tests import CallFixtures


class HistoryDeleteFixtures(CallFixtures):
    def terminal(self, caller=None, callee=None, connection=None):
        now = timezone.now()
        return Call.objects.create(caller=caller or self.alice, callee=callee or self.bob,
                                   connection=connection or self.connection, client_id=uuid4(), caller_device_id=uuid4(),
                                   kind='audio', status='ended', reason='missed', ended_at=now, expires_at=now)


@override_settings(PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher'])
class SharedCallHistoryDeleteTests(HistoryDeleteFixtures, TestCase):
    def test_delete_is_authenticated_own_terminal_only_and_preserves_live_call(self):
        terminal = self.terminal()
        live = self.new_call()
        self.client.force_authenticate(None)
        self.assertEqual(self.client.delete('/calls/history/').status_code, 401)
        self.client.force_authenticate(self.eve)
        self.assertEqual(self.client.delete(f'/calls/history/{terminal.pk}/').status_code, 404)
        self.client.force_authenticate(self.alice)
        self.assertEqual(self.client.delete(f'/calls/history/{live.pk}/').status_code, 409)
        response = self.client.delete('/calls/history/')
        self.assertEqual((response.status_code, response.data['deletedCount'], response.data['callIds']), (200, 1, None))
        live.refresh_from_db()
        self.assertEqual(live.status, 'ringing')
        self.assertFalse(live.history_deleted)
        self.assertEqual(BusyParticipant.objects.count(), 2)
        self.connection.refresh_from_db()
        self.assertTrue(self.connection.accepted)

    def test_individual_delete_is_shared_idempotent_and_keeps_other_rows(self):
        first, other = self.terminal(), self.terminal()
        response = self.client.delete(f'/calls/history/{first.pk}/')
        self.assertEqual(response.data, {'deletedCount': 1, 'callIds': [str(first.pk)], 'revision': 1})
        for user in (self.alice, self.bob):
            result = call_history(user)
            self.assertEqual([row['id'] for row in result['results']], [str(other.pk)])
            self.assertEqual(result['revision'], 1)
        repeat = self.client.delete(f'/calls/history/{first.pk}/')
        self.assertEqual(repeat.data, {'deletedCount': 0, 'callIds': [], 'revision': 1})
        self.assertEqual(Call.objects.count(), 2)
        self.assertEqual(self.client.get(f'/calls/history/{first.pk}/').status_code, 405)

    def test_bulk_delete_only_hides_requesters_terminal_calls_and_invalidates_affected_cursors(self):
        first, second = self.terminal(), self.terminal()
        third_connection = Connection.objects.create(sender=self.alice, receiver=self.eve, accepted=True)
        third = self.terminal(callee=self.eve, connection=third_connection)
        unrelated_connection = Connection.objects.create(sender=self.bob, receiver=self.eve, accepted=True)
        unrelated = self.terminal(caller=self.bob, callee=self.eve, connection=unrelated_connection)
        cursor = call_history(self.bob, limit=1)['nextCursor']
        result = self.client.delete('/calls/history/')
        self.assertEqual(result.data['deletedCount'], 3)
        self.assertEqual(call_history(self.alice)['results'], [])
        for user in (self.bob, self.eve):
            rows = call_history(user)
            self.assertEqual([row['id'] for row in rows['results']], [str(unrelated.pk)])
            self.assertEqual(rows['revision'], 1)
        self.client.force_authenticate(self.bob)
        response = self.client.get('/calls/history/', {'cursor': cursor})
        self.assertEqual((response.status_code, response.data['code']), (400, 'invalid_cursor'))
        newer = self.terminal()
        self.assertIn(str(newer.pk), [row['id'] for row in call_history(self.alice)['results']])
        self.assertFalse(Call.objects.get(pk=newer.pk).history_deleted)
        self.assertTrue(all(Call.objects.get(pk=call.pk).history_deleted for call in (first, second, third)))

    def test_broadcast_failure_does_not_roll_back_or_turn_successful_delete_into_error(self):
        call = self.terminal()
        with patch('calls.services.get_channel_layer') as layer, self.assertLogs('calls.services', level='WARNING'):
            layer.return_value.group_send = AsyncMock(side_effect=RuntimeError('unavailable'))
            with self.captureOnCommitCallbacks(execute=True):
                result = delete_call_history(self.alice, call.pk)
        self.assertEqual(result['deletedCount'], 1)
        self.assertEqual(layer.return_value.group_send.call_count, 2)
        self.assertTrue(Call.objects.get(pk=call.pk).history_deleted)


@override_settings(PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher'],
                   CHANNEL_LAYERS={'default': {'BACKEND': 'channels.layers.InMemoryChannelLayer'}})
class SharedCallHistoryDeleteSocketTests(HistoryDeleteFixtures, TransactionTestCase):
    def test_concurrent_deletes_by_both_participants_are_terminal_and_increment_revision_once(self):
        call = self.terminal()
        barrier = Barrier(2)

        def delete(user, offset):
            close_old_connections()
            try:
                barrier.wait(timeout=5)
                for attempt in range(20):
                    try:
                        return delete_call_history(user, call.pk)
                    except OperationalError:
                        time.sleep(0.01 * (attempt + 1) + offset)
                self.fail('No se pudo completar el borrado concurrente de la base de prueba.')
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(delete, self.alice, 0)
            second = pool.submit(delete, self.bob, 0.003)
            results = [first.result(timeout=10), second.result(timeout=10)]
        self.assertEqual(sorted(row['deletedCount'] for row in results), [0, 1])
        self.assertEqual([call_history(user)['revision'] for user in (self.alice, self.bob)], [1, 1])
        self.assertEqual(Call.objects.count(), 1)
        self.assertTrue(Call.objects.get(pk=call.pk).history_deleted)

    def test_shared_delete_events_reach_all_devices_of_both_users_without_stopping_active_rtc(self):
        from .tests import CallSocketTests
        terminal = self.terminal()
        live = self.connected_call()

        async def run():
            communicator = CallSocketTests.communicator
            alice = communicator(self, self.alice, self.alice_device)
            bob = communicator(self, self.bob, self.bob_device)
            bob_other = communicator(self, self.bob, uuid4())
            eve = communicator(self, self.eve, uuid4())
            sockets = [alice, bob, bob_other, eve]
            try:
                for socket in sockets:
                    self.assertTrue((await socket.connect())[0])
                    await socket.receive_json_from(); await socket.receive_json_from()
                result = await database_sync_to_async(delete_call_history)(self.alice, terminal.pk)
                for socket in (alice, bob, bob_other):
                    event = await socket.receive_json_from()
                    self.assertEqual(event, {'type': 'call.history.cleared', 'callIds': [str(terminal.pk)], 'revision': result['revision']})
                self.assertTrue(await eve.receive_nothing(timeout=0.05))
                status = await database_sync_to_async(lambda: Call.objects.get(pk=live.pk).status)()
                self.assertEqual(status, 'active')
                self.assertEqual(await database_sync_to_async(BusyParticipant.objects.count)(), 2)
            finally:
                for socket in sockets:
                    await socket.disconnect()
        async_to_sync(run)()
