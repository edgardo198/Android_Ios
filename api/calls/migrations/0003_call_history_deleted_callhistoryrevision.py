from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [
        ('calls', '0002_call_connected_at'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name='call', name='history_deleted',
            field=models.BooleanField(db_index=True, default=False),
        ),
        migrations.CreateModel(
            name='CallHistoryRevision',
            fields=[
                ('user', models.OneToOneField(on_delete=django.db.models.deletion.CASCADE,
                                             primary_key=True, serialize=False, to=settings.AUTH_USER_MODEL)),
                ('revision', models.PositiveBigIntegerField(default=0)),
            ],
        ),
    ]
