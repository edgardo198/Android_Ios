
from django.urls import path
from .views import (ActiveTokenRefreshView, AvatarUploadView, ConnectionHistoryView, CurrentUserView, MessageMediaAccessView,
                    MessageMediaDownloadView, MessageMediaUploadView, PasswordResetConfirmView,
                    PasswordResetRequestView, SignInView, SignUpView)

urlpatterns = [
    path('signin/', SignInView.as_view()),
    path('signup/', SignUpView.as_view()),
    path('password-reset/request/', PasswordResetRequestView.as_view(), name='password_reset_request'),
    path('password-reset/confirm/', PasswordResetConfirmView.as_view(), name='password_reset_confirm'),
    path('token/refresh/', ActiveTokenRefreshView.as_view(), name='token_refresh'),
    path('me/', CurrentUserView.as_view(), name='current_user'),
    path('me/avatar/', AvatarUploadView.as_view(), name='avatar_upload'),
    path('connections/<int:connection_id>/history/', ConnectionHistoryView.as_view(), name='connection_history'),
    path('messages/media/', MessageMediaUploadView.as_view()),
    path('messages/<int:message_id>/media/<str:kind>/', MessageMediaDownloadView.as_view(), name='message_media'),
    path('messages/<int:message_id>/media/<str:kind>/access/', MessageMediaAccessView.as_view(), name='message_media_access'),
]
