import json
import base64
import requests
from channels.generic.websocket import WebsocketConsumer
from asgiref.sync import async_to_sync
from django.core.files.base import ContentFile
from django.db.models import Q, Exists, OuterRef
from django.db.models.functions import Coalesce

from .serializers import (
    UsuarioSerializer, 
    SearchSerializer, 
    RequestSerializer, 
    FriendSerializer, 
    MessageSerializer
)
from .models import Usuario, Connection, Message

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
        elif data_source == 'message.send_image':
            self.receive_message_send_image(data)
        elif data_source == 'message.send_audio':
            self.receive_message_send_audio(data)
        elif data_source == 'message.type':
            self.receive_message_type(data)
        elif data_source == 'message.read':
            self.receive_message_read(data)
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
        # Puedes agregar más "source" según se requiera.

    def receive_message_list(self, data):
        user = self.scope['user']
        connectionId = data.get('connectionId')
        page = data.get('page')
        page_size = 15 
        try:
            connection = Connection.objects.get(id=connectionId)
        except Connection.DoesNotExist:
            print('Error: no se pudo encontrar la conexión')
            return
        messages = Message.objects.filter(connection=connection).order_by('-created')[
            page * page_size:(page + 1) * page_size
        ]
        serialized_messages = MessageSerializer(
            messages,
            context={'user': user},
            many=True
        )
        recipient = connection.sender if connection.sender != user else connection.receiver
        serialized_friend = UsuarioSerializer(recipient)
        messages_count = Message.objects.filter(connection=connection).count()
        next_page = page + 1 if messages_count > (page + 1) * page_size else None
        payload = {
            'messages': serialized_messages.data,
            'next': next_page,
            'friend': serialized_friend.data
        }
        self.send_group(user.username, 'message.list', payload)
    
    def _build_message_payload(self, message, current_user, friend):
    # NOTA: La actualización de is_new (marcar mensaje como leído) se debe hacer en otro punto,
    # por ejemplo, cuando el receptor abra el chat, y no al construir el payload.
        serialized_message = MessageSerializer(message, context={'user': current_user})
        return {
            'message': serialized_message.data,
            'friend': UsuarioSerializer(friend).data
        }

    def receive_message_send(self, data):
        """Procesa el envío de mensajes de texto."""
        user = self.scope['user']
        connection_id = data.get('connectionId')
        message_text = data.get('message')
    
        # Buscar la conexión
        try:
            connection = Connection.objects.get(id=connection_id)
        except Connection.DoesNotExist:
            print('Error: no se pudo encontrar la conexión')
            return

        # Determinar el receptor: si el usuario es el sender, el receptor es el receiver, y viceversa.
        recipient = connection.sender if connection.sender != user else connection.receiver

        # Crear el mensaje marcándolo como nuevo
        message = Message.objects.create(
            connection=connection,
            user=user,
            text=message_text,
            is_new=True
        )

        # Serializar el mensaje para el emisor y para el receptor
        serialized_message_for_sender = MessageSerializer(message, context={'user': user})
        serialized_message_for_recipient = MessageSerializer(message, context={'user': recipient})
    
        # Serializar la información del amigo. Para el emisor, el "friend" es el receptor, y viceversa.
        serialized_friend_for_sender = UsuarioSerializer(recipient)
        serialized_friend_for_recipient = UsuarioSerializer(user)

        # Enviar el mensaje al emisor
        self.send_group(user.username, 'message.send', {
            'message': serialized_message_for_sender.data,
            'friend': serialized_friend_for_sender.data
        })

        # Enviar notificación push (solo una vez al receptor)
        if recipient.pushToken:
            self.send_push_notification(recipient.pushToken, user.username, message_text)

        # Enviar el mensaje al receptor
        self.send_group(recipient.username, 'message.send', {
            'message': serialized_message_for_recipient.data,
            'friend': serialized_friend_for_recipient.data
        })


    def receive_message_send_image(self, data):
        """
        Procesa el envío de mensajes con imagen.
        Se espera recibir la imagen en base64 y el nombre del archivo.
        """
        user = self.scope['user']
        connection_id = data.get('connectionId')
        base64_image = data.get('base64')
        filename = data.get('filename')
        if not base64_image or not filename:
            self.send(text_data=json.dumps({
                'source': 'error',
                'message': 'Imagen o nombre de archivo inválido'
            }))
            return
        try:
            image_data = base64.b64decode(base64_image)
            content_file = ContentFile(image_data, name=filename)
            connection = Connection.objects.get(id=connection_id)
            message = Message.objects.create(
                connection=connection,
                user=user,
                text='',
                is_new=True
            )
            message.image.save(filename, content_file, save=True)
        except Exception as e:
            self.send(text_data=json.dumps({
                'source': 'error',
                'message': f'Error al guardar la imagen: {str(e)}'
            }))
            return

        recipient = connection.sender if connection.sender != user else connection.receiver
        serialized_message = MessageSerializer(message, context={'user': user})
        
        payload = {
            'message': serialized_message.data,
            'friend': recipient.username
        }
        self.send_group(user.username, 'message.send', payload)
        self.send_group(recipient.username, 'message.send', payload)

    def receive_message_send_audio(self, data):
        """
        Procesa el envío de mensajes con audio.
        Se espera recibir el audio en base64 y el nombre del archivo.
        """
        user = self.scope['user']
        connection_id = data.get('connectionId')
        base64_audio = data.get('base64')
        filename = data.get('filename')
        if not base64_audio or not filename:
            self.send(text_data=json.dumps({
                'source': 'error',
                'message': 'Audio o nombre de archivo inválido'
            }))
            return
        try:
            audio_data = base64.b64decode(base64_audio)
            content_file = ContentFile(audio_data, name=filename)
            connection = Connection.objects.get(id=connection_id)
            message = Message.objects.create(
                connection=connection,
                user=user,
                text='',
                is_new=True
            )
            message.audio.save(filename, content_file, save=True)
        except Exception as e:
            self.send(text_data=json.dumps({
                'source': 'error',
                'message': f'Error al guardar el audio: {str(e)}'
            }))
            return
        
        recipient = connection.sender if connection.sender != user else connection.receiver
        serialized_message = MessageSerializer(message, context={'user': user})
        payload = {
            'message': serialized_message.data,
            'friend': recipient.username
        }
        self.send_group(user.username, 'message.send', payload)
        self.send_group(recipient.username, 'message.send', payload)
    def receive_message_read(self, data):
        message_id = data.get('messageId')
        if not message_id:
            self.send(text_data=json.dumps({'source': 'error', 'message': 'No se proporcionó messageId'}))
            return
        try:
            message = Message.objects.get(id=message_id)
            message.is_new = False
            message.save()
            updated_payload = MessageSerializer(message, context={'user': self.scope['user']}).data
            self.send_group(self.username, 'message.read', {'message': updated_payload})
            other = message.connection.sender if message.connection.sender != message.user else message.connection.receiver
            self.send_group(other.username, 'message.read', {'message': updated_payload})
            # Aquí podrías emitir un evento o actualizar globalmente la friendList para reiniciar unreadCount.
            # Por ejemplo, si tienes una función en tu global store:
            # resetFriendUnreadCount(username_del_amigo)
        except Message.DoesNotExist:
            self.send(text_data=json.dumps({'source': 'error', 'message': 'Mensaje no encontrado'}))


    def receive_message_type(self, data):
        """Maneja eventos de tipeo (typing)."""
        user = self.scope['user']
        recipient_username = data.get('username')
        payload = {'username': user.username}
        self.send_group(recipient_username, 'message.type', payload)

    def receive_request_accept(self, data):
        username = data.get('username')
        try:
            connection = Connection.objects.get(
                sender__username=username,
                receiver=self.scope['user']
            )
        except Connection.DoesNotExist:
            print('Error: Conexión no existe')
            return
        connection.accepted = True
        connection.save()

        serialized = RequestSerializer(connection)
        self.send_group(connection.sender.username, 'request.accept', serialized.data)
        self.send_group(connection.receiver.username, 'request.accept', serialized.data)

        serialized_friend = FriendSerializer(connection, context={'user': connection.sender})
        self.send_group(connection.sender.username, 'friend.new', serialized_friend.data)
        serialized_friend = FriendSerializer(connection, context={'user': connection.receiver})
        self.send_group(connection.receiver.username, 'friend.new', serialized_friend.data)

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
        self.send_group(connection.sender.username, 'request.connect', serialized.data)
        self.send_group(connection.receiver.username, 'request.connect', serialized.data)

    def receive_request_list(self, data):
        """Maneja la lista de solicitudes de conexión."""
        user = self.scope['user']
        connections = Connection.objects.filter(receiver=user, accepted=False)
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
        ).exclude(username=self.username).annotate(
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

    def send_push_notification(self, push_token, title, message):
        """Envía una notificación push utilizando la API de Expo."""
        expo_url = "https://exp.host/--/api/v2/push/send"
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json"
        }
        payload = {
            "to": push_token,
            "sound": "default",
            "title": title,
            "body": message
        }
        try:
            response = requests.post(expo_url, json=payload, headers=headers)
            response.raise_for_status()
            print(f"Notificación enviada: {response.json()}")
        except requests.exceptions.RequestException as e:
            print(f"Error enviando la notificación: {e}")



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