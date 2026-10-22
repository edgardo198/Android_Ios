from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('chat', '0013_usuario_email_key_auth_version')]
    operations = [
        migrations.AddField(
            model_name='usuario', name='typing_draft_enabled',
            field=models.BooleanField(default=False),
        ),
        migrations.AddField(
            model_name='usuario', name='typing_draft_revision',
            field=models.PositiveIntegerField(default=0, editable=False),
        ),
    ]
