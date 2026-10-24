# Llamadas de audio y video

Actualizado el 2026-10-24. Véase la [revisión 1.1.10](revision-llamadas-1.1.10.md)
para el diagnóstico de Render y las pruebas de recuperación. Los botones del chat, el motor WebRTC y la señalización
en Django ya están implementados. El APK actualizado con controles, historial
y servicio Android está instalado en el Samsung SM-N960U (Note9); la instalación
en el K51 y la prueba de sonido/video entre los dos
teléfonos siguen pendientes.

## Llamar desde el chat

1. Abre el APK de desarrollo instalado en ambos teléfonos y conecta la app a Metro.
2. Inicia sesión con **dos cuentas distintas**, una en cada teléfono.
3. Acepta la solicitud de amistad para que ambos tengan la misma conversación.
4. Mantén ambas aplicaciones abiertas y conectadas. Abre el chat del contacto.
5. Pulsa el **teléfono** para audio o la **cámara de video** para videollamada.
6. En el otro teléfono pulsa **Aceptar** y concede los permisos solicitados.

Los teléfonos y la PC deben compartir una red que permita comunicación entre
dispositivos. Conectar Metro por USB facilita cargar la app y acceder a la API;
el audio/video necesita también una ruta de red entre los teléfonos.

| Control | Qué hace |
| --- | --- |
| Teléfono del encabezado | Inicia una llamada de audio |
| Cámara de video del encabezado | Inicia una videollamada |
| Aceptar / Rechazar | Responde a una llamada entrante |
| Cancelar llamada | Detiene el intento mientras espera respuesta o conexión |
| Silenciar micrófono / Activar micrófono | Cambia el envío de audio durante la llamada |
| Desactivar video / Activar video | Cambia el envío de imagen y permite seguir hablando |
| Cambiar cámara | Alterna la cámara durante una videollamada compatible |
| Salida de audio | En Android ofrece las salidas disponibles: auricular, altavoz, audífonos o Bluetooth |
| Duración | Cuenta desde la conexión confirmada por ambos; al terminar muestra la duración calculada por el servidor |
| Colgar | Termina una llamada conectada y libera sus recursos |
| Cerrar | Cierra el aviso de una llamada finalizada |

La videollamada muestra el video del contacto y una vista de tu propia cámara.
El receptor no activa micrófono/cámara antes de aceptar. Desactivar video deja
de enviar imagen conservando el audio; cambiar de cámara requiere video activo.
Las salidas de audio aparecen solo cuando Android las ofrece. Bluetooth puede
solicitar su permiso al seleccionar el dispositivo conectado.

La app libera sus recursos al colgar, cerrar sesión o cambiar de cuenta.
Si se pierde la señalización durante una llamada ya conectada, conserva los
medios hasta 20 segundos mientras reconecta y comprueba el estado del servidor.
Si no se recupera, termina la llamada. Un intento todavía en negociación termina
al perder señalización. Cambiar de pantalla dentro de la app conserva la llamada.
El cliente renueva el JWT antes de vencer y autentica de nuevo el mismo usuario
y dispositivo dentro del WebSocket, conservando la conexión WebRTC. El servidor
confirma la nueva vigencia; si no puede renovar a tiempo o se desactiva la
cuenta, termina la sesión. La continuidad prolongada en hardware aún necesita
validación.

Solo se admite una llamada por cuenta. Si usas la misma cuenta en varios
dispositivos, la primera aceptación selecciona el teléfono que participa.
Un contacto sin la app abierta aparece como no disponible. Las invitaciones
vencen en 30 segundos; la negociación dispone de 45 segundos. No se graban llamadas.

## Historial

Entra a **Perfil → Historial de llamadas** para ver llamadas terminadas propias,
con el contacto, audio/video, dirección, resultado, fecha y duración. La primera
página muestra hasta 50 llamadas; **Ver más llamadas** carga la siguiente página
mediante un cursor firmado por usuario. **Actualizar** vuelve a consultar y
**Reintentar** recupera una carga fallida. Cambiar de cuenta o cerrar sesión
descarta la vista y las peticiones pendientes de la cuenta anterior.

La papelera borra una llamada terminada y **Borrar historial** borra todas tus
llamadas terminadas **para ambos participantes**. Las llamadas en curso continúan.
El cambio invalida las páginas anteriores mediante la revisión del historial y
se sincroniza por WebSocket. El borrado es lógico, conserva los registros y no
elimina físicamente archivos. Consulta [borrado-historial.md](borrado-historial.md)
para permisos, pendientes y diferencias con borrar los mensajes de un chat.

El servidor guarda una sola hora de conexión cuando ambos extremos confirman
el enlace. La duración final utiliza esa hora y el cierre del servidor, no la
espera de una invitación. Las llamadas que no conectaron tienen duración cero;
los registros antiguos sin esa hora no reconstruyen una duración desconocida.
El historial no incluye IDs de dispositivos, SDP, candidatos ICE ni tokens.

## Android y pantalla bloqueada

Inicia o acepta la llamada con la app visible y los permisos concedidos. El
nuevo APK incorpora un servicio Android de primer plano, una notificación de
llamada activa con **COLGAR**, una tarea Headless JS para mantener los latidos
y la renovación de sesión, y un wake lock que mantiene el procesamiento mientras
la pantalla está bloqueada. El cliente conserva una llamada iniciada cuando el
servicio confirmó su arranque. Si el servicio no está disponible, mantiene el
comportamiento de primer plano y termina al pasar al fondo.

La compilación actual ya incluye el plugin Kotlin, sus permisos y el servicio;
su instalación en el Note9 terminó con `Success`, conservando los datos mediante
`adb install -r`. El archivo está en
`.downloads/apk/ChatLocal-controles-historial.apk`. En otros teléfonos hay que
instalar este APK: recargar Metro no agrega módulos nativos al APK anterior.
La continuidad con pantalla bloqueada, Bluetooth y micrófono/cámara física
siguen pendientes de comprobar en los teléfonos. En web ambas pestañas deben
permanecer visibles; ocultar o cerrar la página finaliza la llamada.

Cerrar la app, perder la sesión o perder el servicio libera recursos. El servicio
no reinicia una llamada automáticamente después de terminar el proceso y no
despierta una app cerrada para una llamada nueva. No utiliza FCM/APNs.

## Iniciar localmente

Desde PowerShell en la raíz del proyecto:

```powershell
cd E:\Proyectos\ReactNativeCli
powershell -NoProfile -File .\scripts\start.ps1 -DevClient
```

El script inicia o reutiliza la API, Metro para el APK de desarrollo y el proceso
que vence llamadas. Imprime el enlace y QR de Metro. Si el puerto está ocupado
por Expo Go, selecciona otro con `-ExpoPort 8082`.

Las llamadas nativas requieren el **APK de desarrollo**: Expo Go no incluye el
módulo WebRTC. Para generar un APK con las arquitecturas ARM de 32 y 64 bits:

```powershell
powershell -NoProfile -File .\scripts\build-android.ps1 -Architecture arm
```

Deja que este comando ejecute prebuild: esta actualización agrega el plugin
nativo `withCallService` y no debe usar `-SkipPrebuild` al generar su primer APK.

Para compilar e instalar en un teléfono autorizado por USB:

```powershell
powershell -NoProfile -File .\scripts\build-android.ps1 -Architecture arm -Install -DeviceSerial 'SERIAL_ADB'
```

Reemplaza `SERIAL_ADB` por el serial de tu teléfono. Consulta los dispositivos:

```powershell
$adb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
& $adb devices
```

El APK actualizado ya está compilado con ARM de 32 y 64 bits. Puedes instalar
esa copia en otro teléfono autorizado:

```powershell
& $adb -s 'SERIAL_ADB' install -r .\.downloads\apk\ChatLocal-controles-historial.apk
```

Selecciona el serial de cada teléfono por separado. La instalación requiere
que aparezca como `device`, con
**Depuración USB** activada y la autorización de la PC aceptada; el modo de
transferencia de archivos de Windows no habilita ADB. El detalle de herramientas,
instalación y conexión USB/Wi-Fi está en [llamadas-nativas.md](llamadas-nativas.md).

Esta versión requiere `calls/0002_call_connected_at.py`, que agrega la hora de
conexión para duración e historial. Las migraciones `0001` y `0002` ya están
aplicadas en el entorno local; `0002` se aplicó después de un backup online de
SQLite guardado en `.local/backups`, y se reiniciaron los servicios. En otra
instalación, realiza un respaldo consistente antes de aplicar migraciones
pendientes:

```powershell
.\.venv\Scripts\python.exe api\manage.py migrate
```

No copies una base SQLite activa mientras escribe el servidor: utiliza su
operación de backup, o el procedimiento de respaldo de tu servidor PostgreSQL.
El script de inicio exige la migración `0002` registrada, la columna `connected_at`
y las tablas de llamadas antes de iniciar procesos o reutilizar un worker.
La comprobación abre SQLite solo para lectura; no crea una base ausente ni aplica
migraciones automáticamente.

## Web y conectividad entre redes

En web se utilizan las APIs WebRTC del navegador. Abre la app desde **HTTPS** o
desde **localhost** para que el navegador permita micrófono y cámara. Una URL
HTTP con la IP de la PC puede cargar el chat y bloquear los permisos de captura.
Si el navegador bloquea el inicio automático del audio, pulsa **Activar sonido**
en la pantalla de llamada.

La versión web usa el mismo inicio de sesión del chat. Las peticiones de
llamadas llevan el JWT de acceso y el WebSocket autentica usuario y dispositivo;
el servidor exige una conversación aceptada. Para probar audio/video localmente,
abre dos sesiones de navegador con cuentas distintas en `localhost` y permite
micrófono/cámara. Compartir una red LAN no convierte una URL HTTP con IP en un
contexto seguro: desde otro equipo necesitas HTTPS para esos permisos.

En Docker, el proxy Nginx envía `/calls/` a Django y `/ws/calls/` utiliza la ruta
WebSocket existente, conservando la autenticación. El servicio `calls-expiry`
vence llamadas incluso sin navegadores conectados, después de que la API aplique
migraciones. Comparte PostgreSQL, Redis y la configuración privada del backend.
Las variables `CALLS_*` también se entregan al backend y al worker en Compose;
los valores vacíos conservan la prueba directa LAN. La configuración de
producción mantiene el mismo esquema con `DEBUG=false`. Esto prepara el proxy
y el proceso de vencimiento; no instala TLS ni coturn.

Por defecto la API devuelve `iceServers: []`: no se utilizan servidores
STUN/TURN públicos ni servicios de llamadas. Esta configuración sirve para
probar una ruta directa en una red compatible. Para redes distintas configura
un servidor **coturn propio**, sus certificados y puertos, y entrega sus URLs
al proceso del backend. La [guía de coturn propio](coturn-propio.md) incluye el
generador de configuración privada y los pasos de instalación y comprobación.
Ejemplo con nombres ficticios:

```powershell
$env:CALLS_STUN_URLS = 'stun:turn.mi-servidor.local:3478'
$env:CALLS_TURN_URLS = 'turn:turn.mi-servidor.local:3478?transport=udp,turns:turn.mi-servidor.local:5349?transport=tcp'
$env:CALLS_TURN_SECRET = '<secreto-privado-aleatorio-configurado-en-coturn>'
$env:CALLS_TURN_TTL_SECONDS = '3600'
```

Sustituye los nombres y el marcador del secreto por los de tu infraestructura;
el ejemplo no configura un relay funcional. El secreto debe coincidir con
`static-auth-secret` de coturn y permanecer solo en el servidor. Configura
`use-auth-secret`, acceso autenticado y restricciones del relay. Django genera
un usuario temporal con fecha de vencimiento y una contraseña HMAC compatible
con coturn; los clientes autenticados reciben esas credenciales, nunca el
secreto permanente. La vigencia predeterminada es 3600 segundos, con máximo
86400 segundos.

Las variables se leen al iniciar Django. Reinicia tu API al cambiarlas; el
script conserva un servidor existente que ya responde. Usa HTTPS/WSS para el
backend accesible por Internet y Redis propio si hay varios procesos de API.
Coturn y las pruebas entre redes todavía están pendientes de instalación y
validación; los ejemplos no prueban conectividad mediante datos móviles.

## Estado de comprobación

| Comprobación | Resultado actual |
| --- | --- |
| Backend y regresión del chat | 123 pruebas pasan, incluidas 44 de llamadas |
| Regresión frontend | 291 de 291 pruebas pasan |
| Exportación Expo | Android, iOS y web completadas; son bundles, no una compilación nativa iOS |
| Esquema local | Migración `calls/0002_call_connected_at` aplicada tras backup online SQLite |
| Señalización Django con dos cuentas ficticias | Validada en una API/SQLite de prueba aislada |
| Audio WebRTC en navegador | RTP bidireccional, silenciado, reproducción y liberación de recursos comprobados con medios sintéticos |
| Video WebRTC y controles en navegador | Video de 320×240; desactivar/activar imagen conserva audio y PeerConnection, sin reproductores duplicados, con medios sintéticos |
| Duración e historial en web | Reloj desde `activeAt` y acceso por Perfil comprobados con dos cuentas |
| APK ARM de 32 y 64 bits | 160499934 bytes; APK actualizado instalado en Samsung SM-N960U con `Success`, conservando datos |
| Instalación en K51 | Pendiente de ADB autorizado; Windows lo detecta para archivos |
| Sonido, cámara y llamadas entre ambos Android | Pendientes de comprobación física |
| Llamada Android con pantalla bloqueada y rutas de audio | Código implementado; comprobación física pendiente |

La integración web final del 2026-10-09 pasó con dos cuentas, la API Django real
de prueba y medios sintéticos: RTP de audio y video de 320×240, desactivar y
reactivar video conservando el audio y la misma PeerConnection, sin duplicar
reproductores. Se comprobaron el reloj desde `activeAt`, el historial de ambos
usuarios desde Perfil y la liberación de recursos al colgar. Registro:
`.logs/call-controls-web-integration-final.log`. Las revisiones anteriores de
permisos, tamaños de pantalla y transporte están en
`.logs/web-calls-final-browser-y4m.log` y `.logs/real-calls-two-processes.log`.

El APK conservado en `.downloads/apk/ChatLocal-controles-historial.apk` tiene
SHA256 `E8451DB03A139400CF4993479C1157FE0E48DD994194489304FD7C6797CFD00D`.

La configuración de Docker/Nginx se validó como YAML y se comprobaron sus rutas,
dependencias e identidad compartida del worker. Sus binarios no están
disponibles en este entorno, por lo que el despliegue con esos servicios todavía
requiere validación antes de publicarlo.

Las pruebas sintéticas de RTP comprueban transporte y ciclo de vida; no prueban
lo que escucha una persona ni la cámara física del teléfono. **Perfil → Prueba
de llamadas** sigue disponible para permisos y vista local: preparar su pista
de audio no demuestra una llamada de voz.

La integración con Telecom, llamadas grupales, pruebas entre redes con TURN
propio e instalación/verificación iOS quedan para las siguientes etapas.
Android ya tiene servicio para llamadas iniciadas y selección de las salidas
disponibles, pero su funcionamiento con bloqueo y dispositivos de audio debe
validarse en hardware. Web conserva el alcance de primer plano. La app no usa
push para despertar una llamada entrante.
