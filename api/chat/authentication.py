"""Revoke all JWTs after recovery while retaining untouched legacy sessions."""
from rest_framework.exceptions import AuthenticationFailed
from rest_framework_simplejwt.authentication import JWTAuthentication


def token_auth_version(token):
    value = token.get('auth_version', 0)
    if type(value) is not int or value < 0 or value > 2147483647:
        raise AuthenticationFailed('La sesión ya no es válida.', code='token_not_valid')
    return value


class VersionedJWTAuthentication(JWTAuthentication):
    def get_user(self, validated_token):
        user = super().get_user(validated_token)
        if token_auth_version(validated_token) != user.auth_version:
            raise AuthenticationFailed('La sesión venció. Inicia sesión nuevamente.', code='token_not_valid')
        return user
