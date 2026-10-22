from django.urls import path
from .consumers import DeviceConsumer

websocket_urlpatterns = [path('ws/device-events/', DeviceConsumer.as_asgi())]
