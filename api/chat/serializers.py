from django.contrib.auth import password_validation
from django.core.exceptions import ValidationError as DjangoValidationError
from pathlib import Path
from rest_framework import serializers
from rest_framework_simplejwt.serializers import TokenRefreshSerializer
from .models import Usuario, Connection, Message, email_users
from .media_access import media_url
from .authentication import VersionedJWTAuthentication

PASSWORD_ERROR_TRANSLATIONS = {
    'This password is too short. It must contain at least 8 characters.': 'La contrasena debe tener al menos 8 caracteres.',
    'This password is too common.': 'La contrasena es demasiado comun.',
    'This password is entirely numeric.': 'La contrasena no puede ser solo numerica.',
    'The password is too similar to the username.': 'La contrasena es demasiado parecida al usuario.',
    'The password is too similar to the first name.': 'La contrasena es demasiado parecida al nombre.',
    'The password is too similar to the last name.': 'La contrasena es demasiado parecida al apellido.',
    'The password is too similar to the email address.': 'La contrasena es demasiado parecida al correo.',
}


def normalize_required_text(value, error_message):
    normalized_value = value.strip() if isinstance(value, str) else ''
    if not normalized_value:
        raise serializers.ValidationError(error_message)
    return normalized_value


def translate_password_errors(messages):
    return [PASSWORD_ERROR_TRANSLATIONS.get(message, message) for message in messages]


def validate_unique_email(value, *, user=None):
    normalized = value.strip().lower()
    if email_users(normalized, exclude_pk=user.pk if user else None, limit=1):
        raise serializers.ValidationError('Este correo ya está en uso.')
    return normalized


class SignUpSerializer(serializers.ModelSerializer):
    email = serializers.EmailField(required=True, allow_blank=False, max_length=254)
    class Meta:
        model = Usuario
        fields = [
            'username',
            'first_name',
            'last_name',
            'password',
            'email',
            'pushToken'
        ]
        extra_kwargs = {
            'password': {'write_only': True, 'trim_whitespace': False},
            'first_name': {'required': True, 'allow_blank': False},
            'last_name': {'required': True, 'allow_blank': False},
        }

    def validate_username(self, value):
        normalized_value = normalize_required_text(value, "Ingresa un nombre de usuario valido.")
        if Usuario.objects.filter(username__iexact=normalized_value).exists():
            raise serializers.ValidationError("Este nombre de usuario ya esta en uso.")
        return normalized_value

    def validate_email(self, value):
        return validate_unique_email(value)

    def validate_first_name(self, value):
        return normalize_required_text(value, "Ingresa un nombre valido.")

    def validate_last_name(self, value):
        return normalize_required_text(value, "Ingresa un apellido valido.")

    def validate_password(self, value):
        attributes = {}
        for field in ('username', 'first_name', 'last_name', 'email'):
            attribute_value = self.initial_data.get(field, '')
            attributes[field] = attribute_value.strip() if isinstance(attribute_value, str) else ''
        provisional_user = Usuario(**attributes)

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
            email=validated_data['email'],
            email_key=validated_data['email'],
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
        ]

    def get_name(self, obj):
        fname = obj.first_name.capitalize() if obj.first_name else ""
        lname = obj.last_name.capitalize() if obj.last_name else ""
        return f"{fname} {lname}".strip()


class CurrentUsuarioSerializer(UsuarioSerializer):
    id = serializers.IntegerField(read_only=True)
    authVersion = serializers.IntegerField(source='auth_version', read_only=True)
    liveTypingEnabled = serializers.BooleanField(source='typing_draft_enabled', read_only=True)
    liveTypingRevision = serializers.IntegerField(source='typing_draft_revision', read_only=True)
    class Meta(UsuarioSerializer.Meta):
        fields = UsuarioSerializer.Meta.fields + ['id', 'pushToken', 'email', 'authVersion', 'liveTypingEnabled', 'liveTypingRevision']


class StrictBooleanField(serializers.BooleanField):
    def to_internal_value(self, data):
        if type(data) is not bool:
            self.fail('invalid', input=data)
        return data


class PushTokenSerializer(serializers.ModelSerializer):
    email = serializers.EmailField(required=False, allow_blank=False, max_length=254)
    current_password = serializers.CharField(required=False, write_only=True, trim_whitespace=False, max_length=1024)
    liveTypingEnabled = StrictBooleanField(source='typing_draft_enabled', required=False)
    class Meta:
        model = Usuario
        fields = ['pushToken', 'email', 'current_password', 'liveTypingEnabled']

    def validate_email(self, value):
        return validate_unique_email(value, user=self.instance)

    def validate(self, attrs):
        if 'email' in attrs and attrs['email'] != self.instance.email:
            password = attrs.get('current_password')
            if not password:
                raise serializers.ValidationError({'current_password': ['Ingresa tu contraseña actual para cambiar el correo.']})
            if not self.instance.check_password(password):
                raise serializers.ValidationError({'current_password': ['La contraseña actual no es correcta.']})
        return attrs

    def update(self, instance, validated_data):
        validated_data.pop('current_password', None)
        if ('typing_draft_enabled' in validated_data
                and validated_data['typing_draft_enabled'] != instance.typing_draft_enabled):
            instance.typing_draft_revision += 1
            validated_data['typing_draft_revision'] = instance.typing_draft_revision
        for field, value in validated_data.items():
            setattr(instance, field, value)
        if validated_data:
            instance.save(update_fields=set(validated_data))
        return instance


class ActiveTokenRefreshSerializer(TokenRefreshSerializer):
    def validate(self, attrs):
        token = self.token_class(attrs['refresh'])
        user = VersionedJWTAuthentication().get_user(token)
        # Upgrade untouched legacy refresh tokens to an explicit version claim.
        token['auth_version'] = user.auth_version
        attrs = {**attrs, 'refresh': str(token)}
        return super().validate(attrs)


class PasswordResetRequestSerializer(serializers.Serializer):
    email = serializers.EmailField(max_length=254)

    def validate_email(self, value):
        return value.strip().lower()


class PasswordResetConfirmSerializer(serializers.Serializer):
    uid = serializers.RegexField(r'^[A-Za-z0-9_-]{1,64}$', max_length=64)
    token = serializers.RegexField(r'^[a-z0-9]{1,13}-[a-f0-9]{32}$', max_length=64)
    password = serializers.CharField(trim_whitespace=False, max_length=1024)


class SearchSerializer(UsuarioSerializer):
    status = serializers.SerializerMethodField()

    class Meta:
        model = Usuario
        fields = [
            'username',
            'name',
            'miniatura',
            'status',
        ]

    def get_status(self, obj):
        if obj.connected:
            return 'connected'
        elif obj.pending_them:
            return 'pending-them'
        elif obj.pending_me:
            return 'pending-me'
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
    unreadCount = serializers.SerializerMethodField()
    isNew = serializers.SerializerMethodField()
    clearedThrough = serializers.IntegerField(source='history_cleared_through', read_only=True)
    revision = serializers.IntegerField(source='history_revision', read_only=True)
    clearedAt = serializers.DateTimeField(source='history_cleared_at', read_only=True)

    class Meta:
        model = Connection
        fields = [
            'id',
            'friend',
            'preview',
            'updated',
            'message',
            'unreadCount',
            'isNew',
            'clearedThrough',
            'revision',
            'clearedAt',
        ]

    def get_unreadCount(self, obj):
        return getattr(obj, 'unread_count', 0)

    def get_isNew(self, obj):
        return self.get_unreadCount(obj) > 0

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
                'id': getattr(obj, 'latest_id', None),
                "type": "image",
                "text": "[Imagen]",
                "isNew": latest_is_new,
                "is_me": is_me
            }
        elif latest_audio:
            return {
                'id': getattr(obj, 'latest_id', None),
                "type": "audio",
                "text": "[Audio]",
                "isNew": latest_is_new,
                "is_me": is_me
            }
        elif latest_video:
            return {
                'id': getattr(obj, 'latest_id', None),
                "type": "video",
                "text": "[Video]",
                "isNew": latest_is_new,
                "is_me": is_me
            }
        elif latest_document:
            return {
                'id': getattr(obj, 'latest_id', None),
                "type": "document",
                "text": "[Documento]",
                "isNew": latest_is_new,
                "is_me": is_me
            }
        elif latest_text:
            return {
                'id': getattr(obj, 'latest_id', None),
                "type": "text",
                "text": latest_text,
                "isNew": latest_is_new,
                "is_me": is_me
            }
        else:
            return None


class MessageSerializer(serializers.ModelSerializer):
    clientId = serializers.UUIDField(source='client_id', read_only=True)
    is_me = serializers.SerializerMethodField()
    type = serializers.SerializerMethodField()
    isNew = serializers.BooleanField(source='is_new', read_only=True)
    filename = serializers.SerializerMethodField()
    image = serializers.SerializerMethodField()
    audio = serializers.SerializerMethodField()
    video = serializers.SerializerMethodField()
    document = serializers.SerializerMethodField()

    class Meta:
        model = Message
        fields = [
            'id',
            'clientId',
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
        return getattr(self.context.get('user'), 'pk', None) == obj.user_id

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

    def get_image(self, obj):
        return media_url(obj.pk, 'image') if obj.image else None

    def get_audio(self, obj):
        return media_url(obj.pk, 'audio') if obj.audio else None

    def get_video(self, obj):
        return media_url(obj.pk, 'video') if obj.video else None

    def get_document(self, obj):
        return media_url(obj.pk, 'document') if obj.document else None
