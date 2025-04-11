from rest_framework import serializers
from .models import Usuario, Connection, Message

class SignUpSerializer(serializers.ModelSerializer):
    class Meta:  
        model = Usuario
        fields = [
            'username',
            'first_name',
            'last_name',
            'password',
            'pushToken'
        ]
        extra_kwargs = {  
            'password': {'write_only': True}
        }

    def validate_username(self, value):
        if Usuario.objects.filter(username=value).exists():
            raise serializers.ValidationError("Este nombre de usuario ya está en uso.")
        return value

    def create(self, validated_data):
        user = Usuario(
            username=validated_data['username'],
            first_name=validated_data['first_name'],
            last_name=validated_data['last_name'],
            pushToken=validated_data.get('pushToken')
        )
        user.set_password(validated_data['password'])
        user.save()
        return user


class UsuarioSerializer(serializers.ModelSerializer):
    name = serializers.SerializerMethodField()

    class Meta:
        model = Usuario
        fields = [
            'username',
            'name',
            'miniatura',
            'pushToken'
        ]

    def get_name(self, obj):
        fname = obj.first_name.capitalize() if obj.first_name else ""
        lname = obj.last_name.capitalize() if obj.last_name else ""
        return f"{fname} {lname}".strip()


class SearchSerializer(UsuarioSerializer):
    status = serializers.SerializerMethodField()
    
    class Meta:
        model = Usuario
        fields = [
            'username',
            'name',
            'miniatura',
            'status', 
            'pushToken'
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
    message = serializers.SerializerMethodField()

    class Meta:
        model = Connection
        fields = [
            'id',
            'friend',
            'preview',
            'updated',
            'message'
        ]

    def get_friend(self, obj):
        user = self.context.get('user')
        if user == obj.sender:
            return UsuarioSerializer(obj.receiver, context=self.context).data
        elif user == obj.receiver:
            return UsuarioSerializer(obj.sender, context=self.context).data
        return None

    def get_preview(self, obj):
        default = 'Nueva Connexion'
        return getattr(obj, 'latest_text', default) or default

    def get_updated(self, obj):
        date = getattr(obj, 'latest_created', None) or obj.updated
        return date.isoformat() if date else ''

    def get_message(self, obj):
        # Por defecto, sin mensaje nuevo; la lógica de actualización se maneja en el consumer.
        return {"isNew": False}


class MessageSerializer(serializers.ModelSerializer):
    is_me = serializers.SerializerMethodField()
    type = serializers.SerializerMethodField()
    isNew = serializers.BooleanField(source='is_new', read_only=True)

    class Meta:
        model = Message
        fields = [
            'id',
            'is_me',
            'text',
            'image', 
            'audio',  
            'created',
            'type',
            'isNew'
        ]

    def get_is_me(self, obj):
        return self.context.get('user') == obj.user

    def get_type(self, obj):
        if obj.image:
            return 'image'
        elif obj.audio:
            return 'audio'
        elif obj.text:
            return 'text'
        return 'unknown'



