from django.db import OperationalError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from chat.authentication import VersionedJWTAuthentication
from .authentication import DeviceAuthentication
from .models import Device
from .services import register_device, revoke_device


class RegisterDeviceView(APIView):
    authentication_classes = [VersionedJWTAuthentication]
    permission_classes = [IsAuthenticated]

    def post(self, request):
        try:
            response = Response(register_device(request.user, request.auth, request.data), status=201)
        except OperationalError:
            response = Response({'detail': 'La recepción está ocupada. Intenta nuevamente.'}, status=503)
        response['Cache-Control'] = 'no-store'
        return response


class DeleteDeviceView(APIView):
    authentication_classes = [DeviceAuthentication, VersionedJWTAuthentication]
    permission_classes = [IsAuthenticated]

    def delete(self, request, device_id):
        try:
            revoke_device(request.user, device_id, request.auth if isinstance(request.auth, Device) else None,
                          None if isinstance(request.auth, Device) else request.auth)
            response = Response(status=204)
        except OperationalError:
            response = Response({'detail': 'No se pudo desactivar la recepción. Intenta nuevamente.'}, status=503)
        response['Cache-Control'] = 'no-store'
        return response
