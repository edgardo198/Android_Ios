
from django.urls import path
from .views import MessageMediaUploadView, SignInView, SignUpView

urlpatterns = [
    path('signin/', SignInView.as_view()),
    path('signup/', SignUpView.as_view()),
    path('messages/media/', MessageMediaUploadView.as_view()),
]


