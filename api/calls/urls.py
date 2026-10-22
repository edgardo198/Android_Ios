from django.urls import path
from .views import CallActionView, CallHistoryEntryView, CallHistoryView, CreateCallView, CurrentCallView

urlpatterns = [
    path('', CreateCallView.as_view()),
    path('current/', CurrentCallView.as_view()),
    path('history/', CallHistoryView.as_view()),
    path('history/<uuid:call_id>/', CallHistoryEntryView.as_view()),
    path('<uuid:call_id>/action/', CallActionView.as_view()),
]
