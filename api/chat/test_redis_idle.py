"""Exercise Channels' blocking read with the installed redis-py client."""
import asyncio
import importlib.util
import os
from pathlib import Path
from unittest import IsolatedAsyncioTestCase, mock

from channels_redis.core import RedisChannelLayer
from redis.asyncio import ConnectionPool
from redis.backoff import NoBackoff
from redis.retry import Retry


class RedisIdleTests(IsolatedAsyncioTestCase):
    async def test_idle_read_survives_blocking_pop_then_receives_next_event(self):
        commands = []
        tasks = set()

        async def serve(reader, writer):
            task = asyncio.current_task()
            tasks.add(task)
            try:
                while header := await reader.readline():
                    count = int(header[1:])
                    arguments = []
                    for _ in range(count):
                        length = int((await reader.readline())[1:])
                        arguments.append(await reader.readexactly(length))
                        await reader.readexactly(2)
                    command = arguments[0].upper()
                    commands.append(command)
                    if command == b'BZPOPMIN':
                        if commands.count(command) == 1:
                            # Redis waits five seconds; scheduling/network delay
                            # makes the previous five-second client deadline fail.
                            await asyncio.sleep(5.25)
                            writer.write(b'*-1\r\n')
                        else:
                            writer.write(b'*3\r\n$4\r\nidle\r\n$5\r\nevent\r\n$1\r\n1\r\n')
                    elif command in {b'EVAL', b'ZADD'}:
                        writer.write(b':0\r\n')
                    else:
                        writer.write(b'+OK\r\n')
                    await writer.drain()
            except (ConnectionError, asyncio.IncompleteReadError):
                pass
            finally:
                writer.close()
                await writer.wait_closed()
                tasks.discard(task)

        server = await asyncio.start_server(serve, '127.0.0.1', 0)
        port = server.sockets[0].getsockname()[1]
        spec = importlib.util.spec_from_file_location(
            'api._idle_test_settings', Path(__file__).resolve().parents[1] / 'api' / 'settings.py')
        module = importlib.util.module_from_spec(spec)
        with mock.patch.dict(os.environ, {'REDIS_URL': f'redis://127.0.0.1:{port}',
                                         'SECRET_KEY': 'idle-regression-test', 'DEBUG': 'true'}):
            spec.loader.exec_module(module)
        config = module.CHANNEL_LAYERS['default']['CONFIG']
        host = config['hosts'][0]
        # Fail immediately on timeout instead of hiding it behind automatic retries.
        layer = RedisChannelLayer(hosts=[{**host, 'protocol': 2,
                                         'retry': Retry(NoBackoff(), 0)}])
        try:
            pool = ConnectionPool.from_url(host['address'], **{
                key: value for key, value in host.items() if key != 'address'})
            self.assertGreater(pool.connection_kwargs['socket_timeout'], layer.brpop_timeout)
            self.assertEqual(pool.connection_kwargs['socket_connect_timeout'], 5)
            await pool.aclose()
            self.assertIsNone(await asyncio.wait_for(
                layer._brpop_with_clean(0, 'idle', layer.brpop_timeout), 8))
            self.assertEqual(await asyncio.wait_for(
                layer._brpop_with_clean(0, 'idle', layer.brpop_timeout), 2), b'event')
            self.assertEqual(commands.count(b'BZPOPMIN'), 2)
        finally:
            await layer.close_pools()
            server.close()
            await server.wait_closed()
            if tasks:
                await asyncio.gather(*tasks)
