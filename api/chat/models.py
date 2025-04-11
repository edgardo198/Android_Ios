from django.contrib.auth.models import AbstractUser
from django.db import models
from django.utils.text import slugify
import os

def cargar_miniatura(instance, filename):
    extension = filename.split('.')[-1]
    path = f'miniatura/{slugify(instance.username)}'
    if extension:
        path = f'{path}.{extension}'
    return path  

class Usuario(AbstractUser):
    miniatura = models.ImageField(
        upload_to=cargar_miniatura,
        null=True,
        blank=True
    )

    pushToken = models.CharField(max_length=255, null=True, blank=True)

class Connection(models.Model):
    sender = models.ForeignKey(
        Usuario, 
        related_name='sent_connections',
        on_delete=models.CASCADE
    )
    receiver = models.ForeignKey(
        Usuario, 
        related_name='received_connections',
        on_delete=models.CASCADE
    )
    accepted = models.BooleanField(default=False)
    updated = models.DateTimeField(auto_now=True)
    created = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.sender.username + ' -> ' + self.receiver.username

class Message (models.Model):
    connection =models.ForeignKey(
        Connection,
        related_name='messages',
        on_delete=models.CASCADE
    )
    user=models.ForeignKey(
        Usuario,
        related_name='my_messages',
        on_delete=models.CASCADE
    )
    text=models.TextField()
    created = models.DateTimeField(auto_now_add=True)

    image = models.ImageField(upload_to='messages/images/', null=True, blank=True)
    audio = models.FileField(upload_to='messages/audio/', null=True, blank=True)
    created = models.DateTimeField(auto_now_add=True)

    is_new = models.BooleanField(default=True)
    def __str__(self):
        return f"{self.user.username}: {self.text or 'Imagen/Audio'}"

    