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

    def create(self, validated_data):
        username = validated_data['username'].lower()
        first_name = validated_data['first_name'].lower()
        last_name = validated_data['last_name'].lower()

        user = Usuario.objects.create(
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
        fname = obj.first_name.capitalize()
        lname = obj.last_name.capitalize()
        return f"{fname} {lname}"


