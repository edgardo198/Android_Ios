"""
URL configuration for api project.

The `urlpatterns` list routes URLs to views. For more information please see:
    https://docs.djangoproject.com/en/5.1/topics/http/urls/
Examples:
Function views
    1. Add an import:  from my_app import views
    2. Add a URL to urlpatterns:  path('', views.home, name='home')
Class-based views
    1. Add an import:  from other_app.views import Home
    2. Add a URL to urlpatterns:  path('', Home.as_view(), name='home')
Including another URLconf
    1. Import the include() function: from django.urls import include, path
    2. Add a URL to urlpatterns:  path('blog/', include('blog.urls'))
"""
from django.conf import settings
from django.contrib import admin
from django.http import FileResponse, Http404, JsonResponse
from django.urls import path, include
from pathlib import Path


def health(_request):
    return JsonResponse({'status': 'ok'})


def public_avatar(_request, filename):
    # Only avatars stay public. Never route the entire MEDIA_ROOT in DEBUG.
    if not settings.DEBUG:
        raise Http404
    raw_root = Path(settings.MEDIA_ROOT).resolve() / 'miniatura'
    root = raw_root.resolve()
    if root != raw_root:
        raise Http404
    try:
        target = (root / filename).resolve()
        target.relative_to(root)
        if not target.is_file():
            raise Http404
        return FileResponse(target.open('rb'))
    except (ValueError, OSError):
        raise Http404 from None


urlpatterns = [
    path('health/', health),
    path('admin/', admin.site.urls),
    path('chat/', include('chat.urls')),
    path('calls/', include('calls.urls')),
    path('notifications/', include('notifications.urls')),
]


urlpatterns += [path(settings.MEDIA_URL.lstrip('/') + 'miniatura/<path:filename>', public_avatar)]
