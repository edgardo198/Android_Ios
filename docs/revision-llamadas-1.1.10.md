# Revisión de llamadas: 24 de octubre de 2026

El endpoint autenticado `/calls/current/` de Render respondió HTTP 200 con
`iceServers: []`. No hay STUN ni TURN configurados en producción. La señalización
por Django/Redis no sustituye al relay de medios: una conexión directa puede
funcionar en LAN y fallar con NAT o redes móviles. Se mantiene la decisión del
proyecto de utilizar coturn propio, sin servidores públicos ni servicios externos.

La versión 1.1.10 corrige otro motivo de corte: una llamada con medios conectados
ya no se termina inmediatamente cuando se cierra el WebSocket. Conserva el mismo
PeerConnection durante hasta 20 segundos mientras reconecta. Tras consultar el
estado autorizado actual, cancela ese plazo y confirma la conexión al servidor.
Un fin remoto, una revocación o cerrar sesión siguen liberando los recursos. Una
llamada que todavía negocia termina al perder señalización porque el protocolo
actual no reproduce ofertas/respuestas perdidas.

Validación: 130 pruebas del cliente de llamadas y revisión sintáctica de 83
archivos. Dos cuentas sintéticas contra Render negociaron audio y video con
WebRTC real y dispositivos multimedia simulados; recibieron paquetes de audio
y video después de forzar el cierre del socket y recuperarlo. La prueba se hizo
con dos navegadores en el mismo equipo: no valida NAT móvil ni TURN.

Para completar el funcionamiento entre redes, hace falta un servidor coturn
propio con IP pública, dominio, certificado y puertos accesibles. Django ya emite
credenciales temporales HMAC mediante `CALLS_TURN_SECRET`. Configurar en Render
`CALLS_STUN_URLS`, `CALLS_TURN_URLS` y el mismo secreto privado de coturn; nunca
poner el secreto en el APK ni en el repositorio. Las URLs pueden incluir UDP
3478 y TLS/TCP 5349 (o 443 si el host dedicado lo permite). Abrir también el rango
UDP de relay elegido en coturn y su firewall. No usar una dirección de ejemplo
como configuración activa. Ver `docs/llamadas.md`, sección STUN/TURN.

Falta comprobar dos dispositivos físicos en redes distintas y probar un cambio
Wi-Fi/datos. El 24 de octubre el Note 9 no apareció conectado mediante ADB durante
esta revisión. El APK nuevo no se considera instalado hasta comprobarlo.

Referencias: https://webrtc.org/getting-started/turn-server y
https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf.
