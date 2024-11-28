from .serializers import UsuarioSerializer
from channels.generic.websocket import WebsocketConsumer
from asgiref.sync import async_to_sync
from django.core.files.base import ContentFile
import base64
import json


class ChatConsumer(WebsocketConsumer):
    def connect(self):
        user = self.scope['user']
        if not user.is_authenticated:
            self.close()
            return
        self.username = user.username
        async_to_sync(self.channel_layer.group_add)(
            self.username, self.channel_name
        )
        self.accept()

    def disconnect(self, close_code):
        if hasattr(self, 'username'):
            async_to_sync(self.channel_layer.group_discard)(
                self.username, self.channel_name
            )

    def receive(self, text_data):
        data = json.loads(text_data)
        data_source = data.get('source')
        print('Received:', json.dumps(data, indent=2))

        if data_source == 'miniatura':
            self.receive_miniatura(data)

    def receive_miniatura(self, data):
        user = self.scope['user']
        image_str = data.get('base64')
        filename = data.get('filename')

        if not image_str or not filename:
            self.send(text_data=json.dumps({
                'source': 'error',
                'message': 'Invalid image or filename.'
            }))
            return

        try:
            image = ContentFile(base64.b64decode(image_str))
            user.miniatura.save(filename, image, save=True)
        except Exception as e:
            self.send(text_data=json.dumps({
                'source': 'error',
                'message': 'Failed to save image: {}'.format(str(e))
            }))
            return

        serialized = UsuarioSerializer(user)
        self.send_group(self.username, 'miniatura', serialized.data)

    def send_group(self, group, source, data):
        response = {
            'type': 'broadcast_group',
            'source': source,
            'data': data
        }
        async_to_sync(self.channel_layer.group_send)(
            group, response
        )

    def broadcast_group(self, event):
        data = {
            'source': event.get('source'),
            'data': event.get('data')
        }
        self.send(text_data=json.dumps(data))

