import os

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'api.settings')

from django.core.asgi import get_asgi_application

django_asgi_app = get_asgi_application()

from channels.routing import ProtocolTypeRouter, URLRouter
from chat.middleware import JWTAuthMiddleware, NativeAllowedHostsOriginValidator
import chat.routing
import calls.routing
import notifications.routing

application = ProtocolTypeRouter({
    "http": django_asgi_app,
    "websocket": NativeAllowedHostsOriginValidator(
        JWTAuthMiddleware(
            URLRouter(
                chat.routing.websocket_urlpatterns + calls.routing.websocket_urlpatterns
                + notifications.routing.websocket_urlpatterns
            )
        )
    ),
})


