"""Prepare private coturn and Django configuration without contacting any host."""
import argparse
import ipaddress
import os
from pathlib import Path
import re
import secrets


def prepare(domain, public_ip, local_ip, output):
    domain = domain.lower().rstrip('.')
    if (len(domain) > 253 or '.' not in domain or
            not all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', part)
                    for part in domain.split('.')) or
            domain.endswith(('.invalid', '.local', '.localhost', '.example'))):
        raise ValueError('Indica el dominio DNS real del servidor TURN.')
    public = ipaddress.IPv4Address(public_ip)
    local = ipaddress.IPv4Address(local_ip or public_ip)
    if not public.is_global:
        raise ValueError('La IP publica debe ser IPv4 global, accesible desde Internet.')
    if local.is_unspecified or local.is_multicast or local.is_loopback:
        raise ValueError('La IP local debe pertenecer a la interfaz del servidor.')
    output = Path(output)
    if output.exists() and any(output.iterdir()):
        raise ValueError('La carpeta de salida debe estar vacia; no se reemplazan secretos.')
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    secret = secrets.token_hex(32)
    config = [
        '# Privado: no publicar ni incluir en el APK.',
        'listening-port=3478', 'tls-listening-port=5349',
        f'listening-ip={local}', f'relay-ip={local}',
        'min-port=52000', 'max-port=52999',
        f'realm={domain}', 'fingerprint', 'use-auth-secret',
        f'static-auth-secret={secret}',
        'cert=/etc/coturn/tls/fullchain.pem',
        'pkey=/etc/coturn/tls/privkey.pem',
        'no-tlsv1', 'no-tlsv1_1', 'no-dtls',
        'no-cli', 'no-multicast-peers', 'no-tcp-relay',
        'user-quota=4', 'total-quota=100', 'stale-nonce=600',
        'log-file=stdout', 'simple-log',
    ]
    if public != local:
        config.append(f'external-ip={public}/{local}')
    for subnet in [
        '0.0.0.0-0.255.255.255', '10.0.0.0-10.255.255.255',
        '100.64.0.0-100.127.255.255', '127.0.0.0-127.255.255.255',
        '169.254.0.0-169.254.255.255', '172.16.0.0-172.31.255.255',
        '192.168.0.0-192.168.255.255', '224.0.0.0-255.255.255.255',
        '::1', 'fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
        'fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    ]:
        config.append(f'denied-peer-ip={subnet}')
    env = [
        f'CALLS_STUN_URLS=stun:{domain}:3478',
        f'CALLS_TURN_URLS=turn:{domain}:3478?transport=udp,turn:{domain}:3478?transport=tcp,turns:{domain}:5349?transport=tcp',
        f'CALLS_TURN_SECRET={secret}', 'CALLS_TURN_TTL_SECONDS=3600',
    ]
    for name, lines in [('turnserver.conf', config), ('render.env', env)]:
        path = output / name
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as stream:
            stream.write('\n'.join(lines) + '\n')
    return output.resolve()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--domain', required=True, help='Dominio DNS real del servidor TURN')
    parser.add_argument('--public-ip', required=True, help='IPv4 publica del servidor')
    parser.add_argument('--local-ip', help='IPv4 de interfaz si el proveedor usa NAT 1:1')
    parser.add_argument('--output', default='.local/coturn', help='Carpeta privada vacia')
    args = parser.parse_args()
    try:
        output = prepare(args.domain, args.public_ip, args.local_ip, args.output)
    except (ValueError, OSError) as error:
        parser.exit(1, f'No se genero la configuracion: {error}\n')
    print(f'Configuracion privada preparada en: {output}')
    print('Archivos: turnserver.conf y render.env. Ningun servidor fue modificado.')


if __name__ == '__main__':
    main()
