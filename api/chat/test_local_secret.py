import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured
from django.test import SimpleTestCase

from api.local_secret import development_secret


class DevelopmentSecretTests(SimpleTestCase):
    def test_workers_and_restarts_share_the_first_complete_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            with ThreadPoolExecutor(max_workers=8) as workers:
                keys = list(workers.map(development_secret, [directory] * 16))
            self.assertEqual(len(set(keys)), 1)
            self.assertGreaterEqual(len(keys[0]), 50)
            self.assertEqual(development_secret(directory), keys[0])
            self.assertEqual([path.name for path in (Path(directory) / '.local').iterdir()], ['secret-key'])

    def test_an_invalid_persisted_secret_is_not_silently_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            local = Path(directory) / '.local'
            local.mkdir()
            (local / 'secret-key').write_text('broken', encoding='utf-8')
            with self.assertRaises(ImproperlyConfigured):
                development_secret(directory)
            self.assertEqual((local / 'secret-key').read_text(encoding='utf-8'), 'broken')
