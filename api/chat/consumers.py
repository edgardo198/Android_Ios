from .serializers import UsuarioSerializer, SearchSerializer, RequestSerializer, FriendSerializer, MessageSerializer
from channels.generic.websocket import WebsocketConsumer
from asgiref.sync import async_to_sync
from django.core.files.base import ContentFile
from django.db.models import Q, Exists, OuterRef
from .models import Usuario, Connection, Message
from django.db.models.functions import Coalesce
import base64
import json


class ChatConsumer(WebsocketConsumer):
    def connect(self):
        """Maneja la conexión inicial de WebSocket."""
        user = self.scope['user']
        if not user.is_authenticated:
            self.close()
            return

        self.username = user.username
        async_to_sync(self.channel_layer.group_add)(
            self.username, 
            self.channel_name
        )
        self.accept()

    def disconnect(self, close_code):
        """Maneja la desconexión del WebSocket."""
        if hasattr(self, 'username'):
            async_to_sync(self.channel_layer.group_discard)(
                self.username, 
                self.channel_name
            )

    def receive(self, text_data):
        """Recibe mensajes de WebSocket y los redirige según la fuente."""
        try:
            data = json.loads(text_data)
        except json.JSONDecodeError:
            self.send(text_data=json.dumps({
                'source': 'error',
                'message': 'Invalid JSON format.'
            }))
            return
        
        data_source = data.get('source')

        print('Receive:', json.dumps(data, indent=2))

        if data_source == 'friend.list':
            self.receive_friend_list(data)

        elif data_source == 'message.list':
            self.receive_message_list(data)

        elif data_source == 'message.send':
            self.receive_message_send(data)

        elif data_source == 'message.type':
            self.receive_message_type(data)

        elif data_source == 'request.accept':
            self.receive_request_accept(data)

        elif data_source == 'request.connect':
            self.receive_request_connect(data)
        
        elif data_source == 'request.list':
            self.receive_request_list(data)

        elif data_source == 'search':
            self.receive_search(data)

        elif data_source == 'miniatura':
            self.receive_miniatura(data)


    def receive_message_list(self, data):
        user =self.scope['user']
        connectioId = data.get('connectionId')
        page = data.get('page')
        try:
            connection = Connection.objects.get(id=connectioId)
        except Connection.DoesNotExist:
            print('Error: no se pudo encontrar la connecion')
            return
        messages = Message.objects.filter(
            connection=connection
        ).order_by('-created')
        serialized_messages = MessageSerializer(
            messages,
            context ={
                'user':user
            },
            many = True
        )
        recipient = connection.sender
        if connection.sender ==  user:
            recipient = connection.receiver
        serialized_friend = UsuarioSerializer(recipient)
        data ={
            'messages': serialized_messages.data,
            'friend': serialized_friend.data
        }
        self.send_group(user.username, 'message.list', data)


    def receive_message_send(self, data):
        user = self.scope['user']
        connection_id = data.get('connectionId')
        message_text = data.get('message')

        try:
            connection = Connection.objects.get(id=connection_id)
        except Connection.DoesNotExist:
            print('Error: no se pudo encontrar la conexión')
            return  # Se interrumpe la ejecución si no se encuentra la conexión

    # Crear el mensaje
        message = Message.objects.create(
            connection=connection,
            user=user,
            text=message_text
        )

    # Determinar el destinatario
        recipient = connection.sender
        if connection.sender == user:
            recipient = connection.receiver

    # Enviar el mensaje al usuario actual
        serialized_message = MessageSerializer(
            message, context={'user': user}
        )
        serialized_friend = UsuarioSerializer(recipient)
        data = {
            'message': serialized_message.data,
            'friend': serialized_friend.data  
        }
        self.send_group(user.username, 'message.send', data)

    # Enviar el mensaje al destinatario
        serialized_message = MessageSerializer(
            message, context={'user': recipient}
        )
        serialized_friend = UsuarioSerializer(user)
        data = {
            'message': serialized_message.data,
            'friend': serialized_friend.data 
        }
        self.send_group(recipient.username, 'message.send', data)


    def receive_friend_list(self, data):
        user = self.scope['user']
        #mensaje sub query
        latest_message = Message.objects.filter(
            connection=OuterRef('id')
        ).order_by('-created')[:1]
        #conexion con el usuario 
        connections = Connection.objects.filter(
            Q(sender=user) | Q(receiver = user),
            accepted=True
        ).annotate(
            latest_text=latest_message.values('text'),
            latest_created=latest_message.values('created'),
        ).order_by(
            Coalesce('latest_created', 'updated').desc()
        )

        serialized = FriendSerializer(
            connections,
            context = {'user': user},
            many = True
            )
        self.send_group( 
            user.username, 'friend.list', serialized.data 
            )
    
    def receive_message_type(self, data):
        user = self.scope['user']
        recipient_username = data.get('username')
        data = {
			'username': user.username
		}
        self.send_group(recipient_username, 'message.type', data)

    def receive_request_accept(self, data):
        username = data.get('username')
        try:
            connection = Connection.objects.get(
                sender__username=username,
                receiver = self.scope['user']
            )
        except Connection.DoesNotExist:
            print('rror: Conexion no existe')
            return
        connection.accepted = True
        connection.save()

        serialized = RequestSerializer(connection)
        self.send_group(
            connection.sender.username, 'request.accept', serialized.data
        )

        self.send_group(
            connection.receiver.username, 'request.accept', serialized.data
        )

        serialized_friend = FriendSerializer(
            connection, 
            context={
                'user': connection.sender 
            }
        )

        self.send_group(
            connection.sender.username, 'friend.new', serialized_friend.data
        )

        serialized_friend = FriendSerializer(
            connection, 
            context={
                'user': connection.receiver 
            }
        )

        self.send_group(
            connection.receiver.username, 'friend.new', serialized_friend.data
        )

    def receive_request_connect(self, data):
        """Maneja la solicitud de conexión entre usuarios."""
        username = data.get('username')
        try:
            receiver = Usuario.objects.get(username=username)
        except Usuario.DoesNotExist:
            self.send(text_data=json.dumps({
                'source': 'error',
                'message': 'Usuario no encontrado.'
            }))
            return

        connection, _ = Connection.objects.get_or_create(
            sender=self.scope['user'],
            receiver=receiver
        )

        serialized = RequestSerializer(connection)

        self.send_group(
            connection.sender.username, 
            'request.connect', 
            serialized.data
        )
        self.send_group(
            connection.receiver.username, 
            'request.connect', 
            serialized.data
        )

    def receive_request_list(self, data):
        """Maneja la lista de solicitudes de conexión."""
        user = self.scope['user']
        connections = Connection.objects.filter(
            receiver=user,
            accepted=False
        )
        serialized = RequestSerializer(connections, many=True)
        self.send_group(user.username, 'request.list', serialized.data)

    def receive_search(self, data):
        """Maneja la búsqueda de usuarios."""
        query = data.get('query', '')
        if not query:
            self.send(text_data=json.dumps({
                'source': 'error',
                'message': 'La consulta de búsqueda está vacía.'
            }))
            return

        users = Usuario.objects.filter(
            Q(username__istartswith=query) |
            Q(first_name__istartswith=query) |
            Q(last_name__istartswith=query)
        ).exclude(
            username=self.username
        ).annotate(
            pending_them=Exists(
                Connection.objects.filter(
                    sender=self.scope['user'],
                    receiver=OuterRef('id'),
                    accepted=False
                )
            ),
            pending_me=Exists(
                Connection.objects.filter(
                    sender=OuterRef('id'),
                    receiver=self.scope['user'],
                    accepted=False
                )
            ),
            connected=Exists(
                Connection.objects.filter(
                    Q(sender=self.scope['user'], receiver=OuterRef('id')) |
                    Q(receiver=self.scope['user'], sender=OuterRef('id')),
                    accepted=True
                )
            )
        )

        serialized = SearchSerializer(users, many=True)
        self.send_group(self.username, 'search', serialized.data)

    def receive_miniatura(self, data):
        """Maneja la carga de miniaturas de usuario."""
        user = self.scope['user']
        image_str = data.get('base64')
        filename = data.get('filename')

        if not image_str or not filename:
            self.send(text_data=json.dumps({
                'source': 'error',
                'message': 'Imagen o nombre de archivo inválidos.'
            }))
            return

        try:
            image = ContentFile(base64.b64decode(image_str))
            user.miniatura.save(filename, image, save=True)
        except Exception as e:
            self.send(text_data=json.dumps({
                'source': 'error',
                'message': f'Error al guardar la imagen: {str(e)}'
            }))
            return

        serialized = UsuarioSerializer(user)
        self.send_group(self.username, 'miniatura', serialized.data)

    def send_group(self, group, source, data):
        """Envía un mensaje a un grupo de canales."""
        response = {
            'type': 'broadcast_group',
            'source': source,
            'data': data
        }
        async_to_sync(self.channel_layer.group_send)(group, response)

    def broadcast_group(self, event):
        """Envía mensajes de forma global a través de broadcast."""
        data = {
            'source': event.get('source'),
            'data': event.get('data')
        }
        self.send(text_data=json.dumps(data))
