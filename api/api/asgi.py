import os
from django.core.asgi import get_asgi_application
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.security.websocket import AllowedHostsOriginValidator
from django_channels_jwt_auth_middleware.auth import JWTAuthMiddlewareStack

import chat.routing 


os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'api.settings') 

application = ProtocolTypeRouter({
    "http": get_asgi_application(),
    "websocket": AllowedHostsOriginValidator(
        JWTAuthMiddlewareStack(
            URLRouter(
                chat.routing.websocket_urlpatterns  
            )
        )
    ),
})

