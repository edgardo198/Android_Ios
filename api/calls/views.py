from django.db import OperationalError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .ice import ice_servers
from .services import CallError, act, call_history, create_call, current_call, delete_call_history, payload


def error_response(error):
    return Response({'detail': str(error), 'code': error.code}, status=error.status)


def retry_response():
    return Response({'detail': 'Intenta nuevamente en unos segundos.', 'code': 'retry'}, status=503)


class CreateCallView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        try:
            call = create_call(request.user, request.data)
            return Response({'call': payload(call), 'iceServers': ice_servers(request.user)}, status=201)
        except CallError as error:
            return error_response(error)
        except OperationalError:
            return retry_response()


class CurrentCallView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        try:
            call = current_call(request.user)
            response = Response({'call': payload(call) if call else None, 'iceServers': ice_servers(request.user)})
            response['Cache-Control'] = 'no-store'
            return response
        except CallError as error:
            return error_response(error)
        except OperationalError:
            return retry_response()


class CallActionView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, call_id):
        if not isinstance(request.data, dict):
            return Response({'detail': 'Datos de acción inválidos.', 'code': 'invalid'}, status=400)
        try:
            call = act(request.user, call_id, request.data.get('action'), request.data.get('deviceId'))
            return Response({'call': payload(call)})
        except CallError as error:
            return error_response(error)
        except OperationalError:
            return retry_response()


class CallHistoryView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        try:
            result = call_history(request.user, limit=request.query_params.get('limit', '50'), cursor=request.query_params.get('cursor'))
            response = Response(result)
            response['Cache-Control'] = 'no-store'
            return response
        except CallError as error:
            return error_response(error)
        except OperationalError:
            return retry_response()

    def delete(self, request, call_id=None):
        try:
            response = Response(delete_call_history(request.user, call_id))
            response['Cache-Control'] = 'no-store'
            return response
        except CallError as error:
            return error_response(error)
        except OperationalError:
            return retry_response()


class CallHistoryEntryView(APIView):
    permission_classes = [IsAuthenticated]

    def delete(self, request, call_id):
        return CallHistoryView.delete(self, request, call_id)
