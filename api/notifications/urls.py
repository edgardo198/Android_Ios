from django.urls import path
from .views import DeleteDeviceView, RegisterDeviceView

urlpatterns = [
    path('devices/', RegisterDeviceView.as_view()),
    path('devices/<str:device_id>/', DeleteDeviceView.as_view()),
]
