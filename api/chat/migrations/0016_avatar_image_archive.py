from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [('chat', '0015_message_image_archive')]
    operations = [
        migrations.CreateModel(
            name='AvatarImageArchive',
            fields=[
                ('user', models.OneToOneField(primary_key=True, serialize=False,
                    on_delete=django.db.models.deletion.CASCADE, related_name='avatar_archive',
                    to=settings.AUTH_USER_MODEL)),
                ('filename', models.CharField(max_length=100)),
                ('content', models.BinaryField(editable=False)),
                ('size', models.PositiveIntegerField()),
            ],
        ),
    ]
