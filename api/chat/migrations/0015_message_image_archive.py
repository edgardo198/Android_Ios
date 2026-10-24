from django.db import migrations, models
import django.db.models.deletion


def initialize_budget(apps, schema_editor):
    apps.get_model('chat', 'ImageArchiveBudget').objects.using(schema_editor.connection.alias).get_or_create(pk=1)


class Migration(migrations.Migration):
    dependencies = [('chat', '0014_usuario_live_typing')]
    operations = [
        migrations.CreateModel(
            name='MessageImageArchive',
            fields=[
                ('message', models.OneToOneField(primary_key=True, serialize=False,
                    on_delete=django.db.models.deletion.CASCADE, related_name='image_archive', to='chat.message')),
                ('filename', models.CharField(max_length=100)),
                ('content', models.BinaryField(editable=False)),
                ('size', models.PositiveIntegerField()),
            ],
        ),
        migrations.CreateModel(
            name='ImageArchiveBudget',
            fields=[('id', models.PositiveSmallIntegerField(default=1, primary_key=True, serialize=False))],
        ),
        migrations.RunPython(initialize_budget, migrations.RunPython.noop),
    ]
