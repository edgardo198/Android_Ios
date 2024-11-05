from rest_framework import serializers
from .models import Usuario

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


