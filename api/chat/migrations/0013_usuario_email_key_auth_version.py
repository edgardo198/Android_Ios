from collections import Counter

from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import migrations, models


def reserve_unambiguous_emails(apps, schema_editor):
    user = apps.get_model('chat', 'Usuario')
    rows = list(user.objects.using(schema_editor.connection.alias).values_list('pk', 'email'))
    counts = Counter(email.strip().lower() for _pk, email in rows if email and email.strip())
    for pk, email in rows:
        key = email.strip().lower() if email else ''
        if not key or counts[key] != 1:
            continue
        try:
            validate_email(key)
        except ValidationError:
            continue
        # The original email, passwords, usernames and empty addresses stay intact.
        user.objects.using(schema_editor.connection.alias).filter(pk=pk).update(email_key=key)


class Migration(migrations.Migration):
    dependencies = [('chat', '0012_connection_history_clear')]
    operations = [
        migrations.AddField(model_name='usuario', name='email_key',
                            field=models.CharField(blank=True, editable=False, max_length=254, null=True, unique=True)),
        migrations.AddField(model_name='usuario', name='auth_version',
                            field=models.PositiveIntegerField(default=0, editable=False)),
        migrations.RunPython(reserve_unambiguous_emails, migrations.RunPython.noop),
    ]
