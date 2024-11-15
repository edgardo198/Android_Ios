from channels.generic.websocket import WebsocketConsumer
from asgiref.sync import async_to_sync
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
        print('recive', json.dumps(data, index = 2))

