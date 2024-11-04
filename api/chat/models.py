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

