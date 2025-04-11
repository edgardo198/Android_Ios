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
        # Si el usuario actual es el sender, el amigo es el receiver, y viceversa.
        if user == obj.sender:
            return UsuarioSerializer(obj.receiver, context=self.context).data
        elif user == obj.receiver:
            return UsuarioSerializer(obj.sender, context=self.context).data
        return None

    def get_preview(self, obj):
        if obj.latest_text:
            return obj.latest_text
        elif obj.latest_image:
            return '[Imagen]'
        elif obj.latest_audio:
            return '[Audio]'
        elif hasattr(obj, 'latest_video') and obj.latest_video:
            return '[Video]'
        elif hasattr(obj, 'latest_document') and obj.latest_document:
            return '[Documento]'
        return 'Nueva conexión'

    def get_updated(self, obj):
        date = getattr(obj, 'latest_created', None) or obj.updated
        return date.isoformat() if date else ''

    def get_message(self, obj):
        user = self.context.get('user')
        is_me = user == obj.sender
        if obj.latest_text:
            return {
                "type": "text",
                "text": obj.latest_text,
                "isNew": obj.latest_is_new,
                "is_me": is_me
            }
        elif obj.latest_image:
            return {
                "type": "image",
                "text": "[Imagen]",
                "isNew": obj.latest_is_new,
                "is_me": is_me
            }
        elif obj.latest_audio:
            return {
                "type": "audio",
                "text": "[Audio]",
                "isNew": obj.latest_is_new,
                "is_me": is_me
            }
        elif hasattr(obj, 'latest_video') and obj.latest_video:
            return {
                "type": "video",
                "text": "[Video]",
                "isNew": obj.latest_is_new,
                "is_me": is_me
            }
        elif hasattr(obj, 'latest_document') and obj.latest_document:
            return {
                "type": "document",
                "text": "[Documento]",
                "isNew": obj.latest_is_new,
                "is_me": is_me
            }
        else:
            return None


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
            'video',
            'document',
            'created',
            'type',
            'isNew'
        ]

    def get_is_me(self, obj):
        # Compara el usuario actual con el usuario asociado al mensaje.
        return self.context.get('user') == obj.user

    def get_type(self, obj):
        if obj.image:
            return 'image'
        elif obj.audio:
            return 'audio'
        elif obj.video:
            return 'video'
        elif obj.document:
            return 'document'
        elif obj.text:
            return 'text'
        return 'unknown'



