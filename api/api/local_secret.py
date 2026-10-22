"""Keep development signatures private and stable across process restarts."""

import os
import secrets
import tempfile
from pathlib import Path

from django.core.exceptions import ImproperlyConfigured


def development_secret(base_dir):
    directory = Path(base_dir) / '.local'
    path = directory / 'secret-key'
    try:
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if not path.exists():
            # Publish a complete file atomically. Concurrent workers keep the
            # first key instead of replacing one another's signing secret.
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=directory,
                                             prefix='secret-key-', delete=False) as temporary:
                temporary.write(secrets.token_urlsafe(64))
                temporary_path = Path(temporary.name)
            try:
                try:
                    os.link(temporary_path, path)
                except FileExistsError:
                    pass
            finally:
                temporary_path.unlink(missing_ok=True)
        key = path.read_text(encoding='utf-8').strip()
        if len(key) < 50:
            raise ImproperlyConfigured('La clave local de desarrollo no es valida. Configura SECRET_KEY.')
        return key
    except OSError as error:
        raise ImproperlyConfigured('No se pudo guardar la clave local. Configura SECRET_KEY.') from error
