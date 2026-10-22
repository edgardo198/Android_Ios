import time

from django.core.management.base import BaseCommand, CommandError
from django.db import OperationalError
from calls.services import expire_calls
from notifications.services import sweep_expired


class Command(BaseCommand):
    help = 'Expira llamadas y libera usuarios, incluso cuando no quedan clientes conectados.'

    def add_arguments(self, parser):
        parser.add_argument('--loop', action='store_true')
        parser.add_argument('--interval', type=int, default=5)

    def handle(self, *args, **options):
        interval = options['interval']
        if not 1 <= interval <= 60:
            raise CommandError('El intervalo debe estar entre 1 y 60 segundos.')
        try:
            while True:
                try:
                    count = expire_calls()
                    sweep_expired(force=False)
                    if count or not options['loop']:
                        self.stdout.write(f'Llamadas expiradas: {count}')
                except OperationalError:
                    if not options['loop']:
                        raise CommandError('Base de datos ocupada; intenta nuevamente.') from None
                if not options['loop']:
                    break
                time.sleep(interval)
        except KeyboardInterrupt:
            return
