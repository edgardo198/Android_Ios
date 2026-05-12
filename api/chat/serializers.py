from django.contrib.auth import password_validation
from django.core.exceptions import ValidationError as DjangoValidationError
from pathlib import Path
from rest_framework import serializers
from .models import Usuario, Connection, Message

PASSWORD_ERROR_TRANSLATIONS = {
    'This password is too short. It must contain at least 8 characters.': 'La contrasena debe tener al menos 8 caracteres.',
    'This password is too common.': 'La contrasena es demasiado comun.',
    'This password is entirely numeric.': 'La contrasena no puede ser solo numerica.',
    'The password is too similar to the username.': 'La contrasena es demasiado parecida al usuario.',
    'The password is too similar to the first name.': 'La contrasena es demasiado parecida al nombre.',
    'The password is too similar to the last name.': 'La contrasena es demasiado parecida al apellido.',
}


def normalize_required_text(value, error_message):
    normalized_value = value.strip() if isinstance(value, str) else ''
    if not normalized_value:
        raise serializers.ValidationError(error_message)
    return normalized_value


def translate_password_errors(messages):
    return [PASSWORD_ERROR_TRANSLATIONS.get(message, message) for message in messages]


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
        normalized_value = normalize_required_text(value, "Ingresa un nombre de usuario valido.")
        if Usuario.objects.filter(username__iexact=normalized_value).exists():
            raise serializers.ValidationError("Este nombre de usuario ya esta en uso.")
        return normalized_value

    def validate_first_name(self, value):
        return normalize_required_text(value, "Ingresa un nombre valido.")

    def validate_last_name(self, value):
        return normalize_required_text(value, "Ingresa un apellido valido.")

    def validate_password(self, value):
        username = self.initial_data.get('username', '')
        provisional_user = Usuario(username=username.strip() if isinstance(username, str) else '')

        try:
            password_validation.validate_password(value, provisional_user)
        except DjangoValidationError as error:
            raise serializers.ValidationError(translate_password_errors(list(error.messages)))

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
        latest_image = getattr(obj, 'latest_image', None)
        latest_audio = getattr(obj, 'latest_audio', None)
        latest_video = getattr(obj, 'latest_video', None)
        latest_document = getattr(obj, 'latest_document', None)
        latest_text = getattr(obj, 'latest_text', None)

        if latest_image:
            return '[Imagen]'
        elif latest_audio:
            return '[Audio]'
        elif latest_video:
            return '[Video]'
        elif latest_document:
            return '[Documento]'
        elif latest_text:
            return latest_text
        return 'Nueva conexion'

    def get_updated(self, obj):
        date = getattr(obj, 'latest_created', None) or obj.updated
        return date.isoformat() if date else ''

    def get_message(self, obj):
        user = self.context.get('user')
        latest_image = getattr(obj, 'latest_image', None)
        latest_audio = getattr(obj, 'latest_audio', None)
        latest_video = getattr(obj, 'latest_video', None)
        latest_document = getattr(obj, 'latest_document', None)
        latest_text = getattr(obj, 'latest_text', None)
        latest_is_new = getattr(obj, 'latest_is_new', False)
        latest_user_id = getattr(obj, 'latest_user_id', None)
        is_me = latest_user_id == getattr(user, 'id', None) if latest_user_id is not None else False

        if latest_image:
            return {
                "type": "image",
                "text": "[Imagen]",
                "isNew": latest_is_new,
                "is_me": is_me
            }
        elif latest_audio:
            return {
                "type": "audio",
                "text": "[Audio]",
                "isNew": latest_is_new,
                "is_me": is_me
            }
        elif latest_video:
            return {
                "type": "video",
                "text": "[Video]",
                "isNew": latest_is_new,
                "is_me": is_me
            }
        elif latest_document:
            return {
                "type": "document",
                "text": "[Documento]",
                "isNew": latest_is_new,
                "is_me": is_me
            }
        elif latest_text:
            return {
                "type": "text",
                "text": latest_text,
                "isNew": latest_is_new,
                "is_me": is_me
            }
        else:
            return None


class MessageSerializer(serializers.ModelSerializer):
    is_me = serializers.SerializerMethodField()
    type = serializers.SerializerMethodField()
    isNew = serializers.BooleanField(source='is_new', read_only=True)
    filename = serializers.SerializerMethodField()

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
            'filename',
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
        elif obj.video:
            return 'video'
        elif obj.document:
            return 'document'
        elif obj.text:
            return 'text'
        return 'unknown'

    def get_filename(self, obj):
        media_field = obj.image or obj.audio or obj.video or obj.document
        if not media_field:
            return ''

        return Path(media_field.name).name
