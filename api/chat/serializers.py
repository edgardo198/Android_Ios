from rest_framework import serializers
from .models import Usuario, Connection, Message

class SignUpSerializer(serializers.ModelSerializer):
    class Meta:  
        model = Usuario
        fields = [
            'username',
            'first_name',
            'last_name',
            'password'
        ]
        extra_kwargs = {  
            'password': {
                'write_only': True
            }
        }

    def validate_username(self, value):
        # Verifica si el nombre de usuario ya existe
        if Usuario.objects.filter(username=value).exists():
            raise serializers.ValidationError("Este nombre de usuario ya está en uso.")
        return value

    def create(self, validated_data):
        # Mantiene los datos tal como se ingresan sin forzar a minúsculas
        username = validated_data['username']
        first_name = validated_data['first_name']
        last_name = validated_data['last_name']

        user = Usuario(
            username=username,
            first_name=first_name,
            last_name=last_name
        )
        password = validated_data['password']
        user.set_password(password)  # Encripta la contraseña
        user.save()
        return user

class UsuarioSerializer(serializers.ModelSerializer):
    name = serializers.SerializerMethodField()

    class Meta:
        model = Usuario
        fields = [
            'username',
            'name',
            'miniatura'
        ]

    def get_name(self, obj):
        # Capitaliza el nombre y el apellido
        fname = obj.first_name.capitalize()
        lname = obj.last_name.capitalize()
        return f"{fname} {lname}"


class SearchSerializer(UsuarioSerializer):
    status = serializers.SerializerMethodField()
    class Meta:
        model = Usuario
        fields = [
            'username',
            'name',
            'miniatura',
            'status'
        ]
    def get_status(self, obj):
        if obj.pending_them:
            return 'pending-them'
        elif obj.pending_me:
            return 'pending-me'
        elif obj.connected:
            return 'connected'
        return 'no-connection'

class RequestSerializer(serializers.ModelSerializer):
    sender = UsuarioSerializer()
    receiver = UsuarioSerializer()

    class Meta:
       model = Connection
       fields = [
           'id',
           'sender',
           'receiver',
           'created'
       ]

class FriendSerializer(serializers.ModelSerializer):
    friend = serializers.SerializerMethodField()
    preview = serializers.SerializerMethodField()
    updated = serializers.SerializerMethodField()


    class Meta:
        model = Connection
        fields = [
            'id',
            'friend',
            'preview',
            'updated'
        ]  

    def get_friend(self, obj):
        if self.context['user'] == obj.sender:
            return UsuarioSerializer(obj.receiver).data
        elif self.context['user'] == obj.receiver:
            return UsuarioSerializer(obj.sender).data
        else:
            print('Error: no se encontró friend para serializar')
    
    def get_preview(self, obj):
        if not hasattr(obj, 'latest_text'):
            return 'Nueva Connexion'
        return obj.latest_text
    
    def get_updated(self, obj):
        if not hasattr(obj, 'latest_created'):
            date = obj.updated
        else:
            date=obj.latest_created or obj.updated
        return date.isoformat()


class MessageSerializer(serializers.ModelSerializer):
    is_me = serializers.SerializerMethodField()

    class Meta:
        model = Message
        fields = [
            'id',
            'is_me',
            'text',
            'created'
        ]

    def get_is_me(self, obj):
        return self.context['user'] == obj.user

