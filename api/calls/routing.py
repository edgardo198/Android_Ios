from django.urls import path
from .consumers import CallConsumer

websocket_urlpatterns = [path('ws/calls/', CallConsumer.as_asgi())]
