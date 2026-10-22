from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('chat', '0011_message_client_id')]

    operations = [
        migrations.AddField(
            model_name='connection', name='history_cleared_through',
            field=models.PositiveBigIntegerField(default=0),
        ),
        migrations.AddField(
            model_name='connection', name='history_revision',
            field=models.PositiveBigIntegerField(default=0),
        ),
        migrations.AddField(
            model_name='connection', name='history_cleared_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
