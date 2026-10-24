# Preparar el servidor de llamadas

La API y Redis permanecen en Render. Coturn se instala en un servidor Linux
propio, separado, con IPv4 pública y puertos UDP/TCP accesibles. El servicio web
actual de Render recibe HTTP/WebSocket y no proporciona los puertos públicos
del relay TURN. Esta preparación no contrata infraestructura ni modifica Render.

Necesitas un servidor Ubuntu/Debian administrable por SSH y un dominio como
`turn.tu-dominio.com`, cuyo registro DNS A apunte a su IPv4 pública. El registro
debe resolver directamente al servidor, sin un proxy HTTP/CDN. Si existe un
registro AAAA, debe corresponder a un servicio IPv6 realmente configurado;
esta receta prepara IPv4. No sirve una PC detrás de CGNAT sin puertos entrantes.

## Generar los archivos privados

Desde la raíz del proyecto, sustituye dominio e IP por los reales:

```powershell
.\.venv\Scripts\python.exe scripts/prepare-coturn.py --domain turn.tu-dominio.com --public-ip IP_PUBLICA
```

Si la interfaz del servidor usa una IP privada con NAT 1:1, añade
`--local-ip IP_DE_INTERFAZ`. La IP pública debe mapear al servidor y los puertos
de relay deben conservar su número al atravesar NAT.

El generador crea `.local/coturn/turnserver.conf` y `render.env` con el mismo
secreto aleatorio de 256 bits. La carpeta está excluida de Git. No imprime el
secreto ni reemplaza archivos existentes. En Linux crea archivos con modo 600;
en Windows conserva las ACL de tu carpeta de usuario. Mantén ambos archivos
privados y transfiérelos mediante SSH/SFTP. No pegues su contenido en el chat.

## Instalar en el servidor Linux

Instala coturn y un certificado válido para el dominio. Por ejemplo, con un
Ubuntu/Debian que utilice apt y Certbot, ejecuta estos pasos en el servidor:

```bash
sudo apt-get update
sudo apt-get install coturn certbot
sudo certbot certonly --standalone -d turn.tu-dominio.com
```

Certbot standalone necesita TCP 80 entrante y libre durante la emisión y
renovación; si no puedes ofrecerlo, utiliza validación DNS con tu proveedor.
No abras un firewall desde una sesión SSH sin conservar primero el acceso SSH.

Sube `turnserver.conf` a una carpeta privada del servidor. Antes de arrancar,
copia los certificados y la configuración (en los paquetes Debian/Ubuntu el
usuario/grupo habitual es `turnserver`; compruébalo con `getent passwd turnserver`):

```bash
sudo install -d -o root -g turnserver -m 750 /etc/coturn/tls
sudo install -o root -g turnserver -m 640 /etc/letsencrypt/live/turn.tu-dominio.com/fullchain.pem /etc/coturn/tls/fullchain.pem
sudo install -o root -g turnserver -m 640 /etc/letsencrypt/live/turn.tu-dominio.com/privkey.pem /etc/coturn/tls/privkey.pem
sudo install -o root -g turnserver -m 640 ./turnserver.conf /etc/turnserver.conf
sudo systemctl enable --now coturn
sudo systemctl restart coturn
sudo systemctl status coturn --no-pager
```

Si el paquete exige `TURNSERVER_ENABLED=1` en `/etc/default/coturn`, habilítalo.
Configura un deploy hook de Certbot que vuelva a copiar ambos certificados con
esos permisos y reinicie coturn después de cada renovación exitosa. Copiar una
sola vez no mantiene el certificado actualizado.

Abre estos puertos tanto en el firewall del servidor como en el del proveedor:

| Puerto | Protocolo | Uso |
|---|---|---|
| 3478 | UDP y TCP | STUN/TURN |
| 5349 | TCP | TURN con TLS |
| 52000–52999 | UDP | Transporte de medios retransmitidos |

La configuración permite autenticación temporal, limita asignaciones y bloquea
destinos privados, locales y multicast. Los clientes acceden a TURN por UDP,
TCP o TLS; `no-tcp-relay` desactiva asignaciones de relay TCP, sin desactivar
la conexión TCP/TLS del cliente. El relay de medios usa UDP. No abras un relay
anónimo ni sustituyas `use-auth-secret` por acceso sin autenticación.

Algunas redes solo permiten TCP 443. En ese caso un administrador debe habilitar
TURN TLS en 443 en el host dedicado, resolver permisos/conflictos de ese puerto
y cambiar la URL `turns:` correspondiente; 5349 no garantiza acceso desde esas redes.

## Conectar Django en Render

Cuando coturn esté disponible y tenga TLS válido, copia las cuatro variables
de `render.env` a Environment del servicio
`mensajeria-pruebas-octubre-2026` en Render y despliega/reinicia el servicio:

- `CALLS_STUN_URLS`
- `CALLS_TURN_URLS`
- `CALLS_TURN_SECRET`
- `CALLS_TURN_TTL_SECONDS`

El secreto debe coincidir exactamente con `static-auth-secret` de coturn. Django
ya genera el usuario temporal y su contraseña HMAC; no hace falta un nuevo APK.
No pongas el secreto en variables `EXPO_PUBLIC_*` ni en el cliente. No configures
URLs de ejemplo en el servicio activo: un nombre sin servidor no resuelve el fallo.

## Comprobación pendiente al disponer del servidor

Comprueba DNS y TLS desde Internet, y que `/calls/current/` autenticado entrega
URLs TURN y credenciales temporales. No publiques el token ni la respuesta completa.
Después comprueba una asignación con credenciales válidas y que una contraseña
incorrecta no permite una asignación. Revisar solo `systemctl` o abrir un puerto
TCP no valida el transporte de medios.

Prueba audio y video entre Wi-Fi y datos móviles, confirma tráfico en ambos
sentidos y un par ICE seleccionado con candidato `relay` mediante getStats.
Para demostrar TURN, una prueba controlada debe usar `iceTransportPolicy: 'relay'`;
una llamada que conecta directamente no demuestra que el relay funciona. No se
fuerza esa política en la app de producción. Comprueba además al menos 5 minutos
de duración, colgar desde ambos extremos, bloqueo de pantalla y cambio de red.
La app todavía no renegocia ICE al cambiar de red: TURN no garantiza por sí solo
continuidad durante ese cambio.

Si hay que retirar la configuración, vacía las URLs STUN/TURN de Render y
reinicia. Se recupera el modo directo anterior, que sigue limitado por NAT.

Referencias: [configuración oficial de coturn](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf),
[TURN y WebRTC](https://webrtc.org/getting-started/turn-server) y
[puertos de servicios web de Render](https://render.com/docs/web-services#port-binding).
