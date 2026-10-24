# Mensajeria: Android, iOS y web

Proyecto de mensajeria con Expo SDK 57, React Native y Django Channels. La versión actual del proyecto es **1.1.9**, código Android **11**, desplegada en Render e instalada en el Note 9. Los archivos y fotos de perfil se suben por HTTP multipart; WebSocket entrega mensajes, historial y eventos de lectura. El backend valida la conexion y conserva el mensaje antes de intentar su entrega en tiempo real.

La compilación Android para Render se documenta en [APK de pruebas con Render](docs/android-render.md).

La [revision de fotos 1.1.9](docs/revision-fotos-1.1.9.md) corrige el envio de perfil
al volver de la galeria y la carga de enlaces temporales. Fotos nuevas y avatares
tienen copia privada en PostgreSQL, con un presupuesto conjunto de 100 MiB durante
la vigencia de la prueba. Las fotos anteriores perdidas necesitan reenviarse.

Esta etapa agrega **avisos de mensajes y llamadas con la interfaz Android cerrada**,
mediante un receptor nativo y notificación permanente conectados al servidor propio.
Se controla en **Perfil → Conversación**. En el chat, **Adjuntar → Emojis / GIF**
permite insertar emojis y enviar GIF animados de tus archivos con vista previa.
Consulta el [funcionamiento y los límites de recepción](docs/avisos-y-gif.md).

Toca la foto del contacto en la cabecera del chat para abrir su perfil con foto,
nombre y opciones **Audio**, **Videollamada** y **Borrar conversación**. Las
llamadas también conservan sus botones en la cabecera, controles, duración e
historial en **Perfil → Historial de llamadas**. Permiten silenciar,
activar/desactivar video y cambiar cámara; en Android muestran las salidas de
audio disponibles. Consulta [cómo llamar y el estado de las pruebas](docs/llamadas.md).
La versión 1.1.5, código 7, está compilada e instalada en ambos Android
mediante actualización sin desinstalar. Las pruebas físicas de llamadas entre los teléfonos siguen
pendientes.

El nuevo servicio Android de primer plano incorpora notificación con **COLGAR**,
Headless JS y wake lock para mantener una llamada ya iniciada al bloquear la
pantalla. El APK local **1.1.5**, con JavaScript incluido para abrir sin Metro,
ya se compiló y se instaló en Note9 y K51 conservando sus datos. Ambos procesos
abrieron sin errores fatales en los logs filtrados. En el K51 se comprobó la
sesión recuperada y Perfil organizado sin pantalla blanca. La revisión visual
del Note9 sigue pendiente porque permanece bloqueado.
En otro teléfono hay que instalar el APK actualizado. La continuidad
con pantalla bloqueada todavía necesita prueba física. Web requiere ambas
pestañas visibles. El cliente renueva JWT por el mismo WebSocket, conservando
WebRTC si el servidor confirma la sesión; cerrar sesión o cambiar de cuenta
termina la llamada y descarta el historial visible.

La versión web utiliza esos mismos botones y la pantalla de llamada, con video
local/remoto, aceptar/rechazar, silenciar, activar/desactivar video, duración y
colgar. Desde la raíz, inicia o reutiliza
la API y Metro con:

```powershell
powershell -NoProfile -File .\scripts\start.ps1 -Web -DevClient
```

Abre `http://localhost:8081` en la PC. Prueba con dos cuentas distintas y una
amistad aceptada, usando sesiones de navegador independientes y manteniendo
ambas pestañas visibles. Concede micrófono/cámara al iniciar o aceptar; si el
navegador bloquea la reproducción, pulsa **Activar sonido**. Desde otro equipo
se requiere HTTPS para usar cámara/micrófono; una URL HTTP con la IP de la PC no
habilita esos permisos. La configuración Docker incluye el proxy `/calls/` y el
proceso de vencimiento, pero no instala HTTPS ni el servidor TURN propio.

Cada conversacion muestra solamente los ultimos 50 mensajes, combinando los confirmados con los textos pendientes e incluyendo fotos, audio, video y documentos. Al llegar un mensaje nuevo sale de la vista el mas antiguo; no se carga historial adicional al desplazarse. El historial confirmado anterior permanece guardado en la base de datos; los textos pendientes siguen en la cola local.

## Nombre, icono y borrado del historial

La app se llama **Mensajeria**, versión **1.1.5**, código Android **7**. Utiliza
el último icono proporcionado, **Dos personas y un mensaje.png**: una figura
verde delante de otra azul y una burbuja blanca sobre fondo azul claro.
El PNG original se conserva sin modificar;
el icono Android mantiene la composición con margen y la pantalla de inicio
usa fondo blanco. Conserva su identificador para actualizarla sin desinstalar.

En el chat, toca la foto del contacto y elige **Borrar conversación** dentro de
su perfil. La acción pide confirmacion y borra el historial
**para ambos participantes**, incluidos los pendientes anteriores. Conserva
el contacto y permite seguir enviando mensajes nuevos. En **Perfil → Historial
de llamadas**, puedes borrar una llamada terminada o todo tu historial; los
registros correspondientes desaparecen tambien para sus otros participantes.
Una llamada activa continua y puede generar un nuevo registro al finalizar.

Los avisos sincronizan los dispositivos conectados; al reconectar se verifican
las revisiones antes de transmitir pendientes. Los adjuntos del historial
borrado dejan de autorizar descargas. Este es borrado logico: los registros y
archivos se conservan fisicamente para reconocer reintentos; no elimina copias
ya descargadas. Detalles en [borrado-historial.md](docs/borrado-historial.md).

## Textos pendientes

Los mensajes de texto se guardan primero en AsyncStorage, en una cola independiente por cuenta de hasta 100 pendientes entre todas sus conversaciones. El editor se limpia solo despues de guardar el texto; si falla el almacenamiento o la cola esta llena, muestra el error y conserva el borrador. La cola local y el limite de 50 mensajes visibles son limites distintos.

Puedes encolar textos sin conexion. Los textos en estado Pendiente se envian al reconectar y se recuperan para la misma cuenta al volver a abrir la app. Una sesion recuperada verifica su identidad y la revision del historial en el servidor antes de transmitir la cola; descarta pendientes anteriores a un borrado compartido. Cada envio conserva un UUID `clientId`; el backend aplica unicidad por remitente y UUID, y su confirmacion (ACK) retira el pendiente. Reintentar con ese mismo identificador devuelve el mensaje existente sin crear duplicados. Si ese mensaje ya fue borrado, el ACK no contiene su texto ni adjuntos y no lo vuelve a mostrar.

Si no llega la confirmacion en 15 segundos, la burbuja muestra **Sin confirmación** y permite **Reintentar** manualmente. El mensaje puede haber llegado al servidor aunque falte su confirmacion. **Quitar pendiente** retira solo el intento de la cola local y no borra mensajes que ya llegaron; esta accion no esta disponible mientras muestra Enviando. La cola se aplica a textos.

La migracion `chat/0011_message_client_id.py` ya esta aplicada en el entorno local. En otros entornos ejecuta desde la raiz antes de usar los pendientes:

```powershell
.\.venv\Scripts\python.exe api\manage.py migrate
```

## Indicador de escritura

Al comenzar a escribir, el contacto recibe **Escribiendo…**, incluso si el chat
está vacío. El indicador se muestra por separado y no ocupa uno de los 50
mensajes visibles. Mientras continúan las pulsaciones, se renueva cada dos
segundos; se apaga tras 2,5 segundos sin cambios, al enviar, vaciar el editor,
salir del campo o conversación, cerrar sesión o enviar la app al fondo.

Si falta el aviso de parada, caduca a los cinco segundos. Los eventos se
comprueban contra la conversación, el usuario y la revisión del historial para
evitar que aparezcan en otro chat o después de un borrado. Con movimiento
reducido, los puntos se muestran estáticos en el modo predeterminado.

En **Perfil → Animación al escribir**, elige **Sistema**, **Activada** o
**Desactivada**. Sistema respeta la preferencia de movimiento del teléfono o
navegador; Activada anima los puntos aunque el sistema reduzca el movimiento;
Desactivada los mantiene visibles sin animación. La opción se guarda en este
dispositivo y no cambia los ajustes de Android. El movimiento nativo usa un
ciclo continuo sin bloquear las interacciones de la lista.

En la revisión del K51, las tres escalas de animación de Android estaban en
cero; esto explica sus puntos fijos en modo Sistema. No se modificaron esos
ajustes. Para animarlos desde la app, selecciona Activada en Perfil.

En **Perfil → Conversación → Compartir borrador en vivo**, puedes mostrar
el texto antes de enviarlo al contacto. Empieza desactivado; se guarda por
cuenta y se sincroniza entre dispositivos. El borrador no crea mensajes,
caduca al pausar y desactivarlo conserva el texto del editor. Consulta
[Perfil y borrador en vivo](docs/perfil-y-borrador.md) para los controles,
límites y actualización del backend con la migración 0014.

## Correo y recuperación de contraseña

Desde 1.1.3, registrarse requiere un correo electrónico. Las cuentas existentes
pueden añadirlo o cambiarlo en **Perfil**, escribiendo su contraseña actual.
El correo es privado para su dueño: no se muestra a contactos ni en búsquedas.

En el acceso, pulsa **Olvidé mi contraseña** y escribe el correo guardado.
El correo de recuperación contiene un enlace y un código para establecer una
nueva contraseña. Vencen a los 30 minutos por defecto; `PASSWORD_RESET_TIMEOUT`
permite configurar entre 15 y 30 minutos. Al completar el cambio se invalidan
las sesiones anteriores y se terminan las llamadas de esa cuenta. Una sesión
de otra cuenta permanece abierta.

Consulta [recuperación de contraseña y configuración segura de Gmail](docs/password-recovery.md).
La configuración protegida de Gmail existe en esta PC. El envío real
sigue pendiente de comprobar la recepción de un correo. No compartas esa contraseña
en el chat ni la guardes en el repositorio. Para configurar el remitente desde
la raíz:

```powershell
powershell -NoProfile -File .\scripts\configure-gmail.ps1 -Email tu-cuenta@gmail.com
powershell -NoProfile -File .\scripts\start.ps1 -RestartApi
```

El primer comando solicita la contraseña con entrada oculta y guarda un perfil
local protegido para el usuario de Windows. El segundo carga ese perfil;
rechaza el reinicio si hay llamadas sin terminar. Cambiar Gmail no requiere
recompilar el APK.

## Vista previa de archivos

El botón de imágenes del chat permite **Elegir de la galería** o **Tomar foto**.
En web, la segunda opción se llama **Cámara o archivo** y depende del navegador.
Después de elegir o capturar, se abre una vista previa: pulsa **Enviar archivo**
para confirmar o **Cancelar** para descartar. Seleccionar una imagen no la envía.

Los videos, audios y documentos también tienen vista previa. Las fotos se muestran completas; los videos y audios tienen controles de reproduccion. Los documentos muestran una ficha con nombre, extension y tamano disponible. En Android, detener la grabacion permite escuchar el audio antes de enviarlo.

**Enviar archivo** confirma la subida y **Cancelar** descarta la seleccion sin enviarla. Si falla el envio, la vista previa muestra el error y conserva el archivo para reintentar. El borrador de texto permanece en el chat. La seleccion se descarta al salir de la conversacion; una confirmacion en curso impide iniciar otra.

Durante el envio se muestran los bytes transmitidos y el porcentaje cuando el transporte conoce el total. Si no lo conoce, el indicador es indeterminado. El 100% significa que se transmitio el archivo: el modal espera la confirmacion del servidor antes de cerrarse. Las subidas permiten hasta cinco minutos y **Detener subida** interrumpe el intento, conservando la seleccion para revisarla. Detener una subida o perder su respuesta no borra lo que ya haya recibido el servidor; revisa el chat antes de reintentar manualmente.

## Adjuntos privados y detalle del chat

Fotos, audios, videos y documentos usan rutas protegidas por mensaje. La app solicita un acceso temporal autenticado; el servidor comprueba que la cuenta siga activa y pertenezca a una conversacion aceptada. Cada enlace permite acceder solo a ese archivo durante un maximo de 15 minutos y no contiene el JWT de la sesion. El servidor vuelve a comprobar los permisos al descargar. Los archivos antiguos tambien quedan protegidos sin moverlos ni modificar su contenido. Solo los avatares conservan acceso publico.

Los reproductores y las descargas obtienen o renuevan esos enlaces cuando hace falta. Los videos y audios admiten rangos para reproducir y avanzar sin descargar todo el archivo en memoria. Los caches de acceso se invalidan al cambiar de cuenta o cerrar sesion. Un enlace temporal puede utilizarse mientras siga vigente; no es cifrado de extremo a extremo.

Las burbujas muestran la hora del mensaje en la zona horaria del dispositivo. Los mensajes propios confirmados muestran **Enviado** y cambian a **Leído** al recibir el recibo del servidor. Los textos pendientes mantienen sus estados y opciones de reintento.

## Estructura

```text
App/                     Frontend Expo (repositorio Git independiente)
  App.js                 Navegacion y ciclo de vida de la aplicacion
  src/screens/           Pantallas
  src/components/        Componentes de mensajes y conversaciones
  src/common/            Componentes reutilizables
  src/core/              API, sesion, WebSocket y logica compartida
  tests/                 Regresiones del frontend
  scripts/               Comprobacion de sintaxis
api/                     Backend Django
  api/                   Configuracion HTTP, ASGI y almacenamiento
  chat/                  Modelos, servicios, endpoints, consumidores y pruebas
  chat/migrations/       Migraciones de base de datos
  calls/                 Estado, permisos y senalizacion de llamadas WebRTC
  requirements.in        Dependencias directas
  requirements.txt       Versiones resueltas y fijadas
scripts/                 Inicio local, verificacion y resolucion de dependencias
.github/workflows/       Verificacion automatica
```

`.venv`, `node_modules`, `.expo`, `.logs`, bases SQLite, `.env` y multimedia pertenecen al entorno local. No se versionan. Los archivos existentes en `api/media/` siguen disponibles. `App-temp/`, `venv/` y `media/` de la raiz son copias antiguas; la aplicacion usa `App/`, `.venv/` y `api/media/`.

`App/` es un submodulo. Para clonar el proyecto completo usa `git clone --recurse-submodules <url-del-proyecto>`. Al guardar cambios en Git, registra primero los cambios del repositorio `App/` y luego actualiza su referencia en el repositorio principal. No se modifico el historial Git; si un `.env` ya fue publicado, reemplaza sus credenciales.

## Requisitos e instalacion

- Python 3.12.
- Node.js 24 LTS (SDK 57 requiere al menos Node 22.13).
- Para desarrollar con QR: Expo Go compatible con SDK 57; las llamadas nativas
  requieren el APK propio.

Desde la raiz en PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r api\requirements.txt
Push-Location App
npm ci
Pop-Location
.\.venv\Scripts\python.exe api\manage.py migrate
```

El backend local usa SQLite y un channel layer en memoria cuando no configuras PostgreSQL o Redis. Para multiples procesos/instancias utiliza Redis. Django lee las variables del proceso; los `.env.example` son plantillas y no se cargan automaticamente en el inicio local.

Esta version requiere `calls/0002_call_connected_at`, `calls/0003_call_history_deleted_callhistoryrevision`
y `chat/0012_connection_history_clear` para duracion y borrado compartido.
Ya estan aplicadas en la base local tras un backup online de SQLite conservado en
`.local/backups`; los servicios se reiniciaron con el esquema actualizado.
Antes de migrar una instalación existente, realiza un respaldo consistente de
su base. `scripts/start.ps1` comprueba las migraciones, tablas y campos del historial
antes de iniciar procesos, incluso si el worker ya existe; no migra ni crea una
base SQLite ausente.

La recuperación de contraseña de 1.1.3 también requiere
`chat/0013_usuario_email_key_auth_version`. Aplica las migraciones tras un
respaldo antes de usar los nuevos campos de correo y versión de sesión.
En esta PC ya está aplicada: se respaldó SQLite y se verificó que las cuentas,
contraseñas, correos y cantidades de mensajes, conversaciones y llamadas se conservaron.

## Iniciar y probar desde Android

### APK local sin Metro

La APK anterior **Mensajeria 1.1.4**, código **6**, quedó compilada y verificada
en `.downloads/apk/Mensajeria-1.1.4-local.apk`. Incorpora Perfil organizado,
el nuevo icono y el borrador optativo en vivo. Ocupa **82902347 bytes**, con
bundle de **5080996 bytes**; SHA256:
`748E3514967B2988656911914BDEE8A73097719770B5D225AE029A9B62A9A041`.
La firma coincide con la instalada, conserva ARM32/64 y JavaScript incluido.
Pasaron **422 pruebas frontend**, **208 backend** y las pruebas web reales de
Perfil, borrador y preferencias de animación. Registro de APK:
`.logs/mensajeria-1.1.4-apk-verification.json`. La migración 0014 se aplicó con
respaldo y conservación de los datos existentes. La API responde en el puerto
8000 desde una sesión normal; la configuración local protegida de Gmail está
cargada. Android confirmó versión 1.1.4, código 6 y el mismo hash del APK en
Note9 y K51, mediante actualización sin desinstalar y sin errores en los logs
de runtime filtrados. Registro:
`.logs/mensajeria-1.1.4-phone-verification.json`.

Como registro de la versión anterior, sigue disponible lo siguiente:

La versión **Mensajeria 1.1.3** incorpora correo y recuperación de contraseña,
además del selector de animación de escritura en Perfil. Conserva el perfil
del contacto, selección de imágenes desde galería/cámara y vista previa antes
de enviar. Las pantallas de inicio y
acceso usan la fuente del sistema mientras carga la fuente personalizada o si
esa carga falla, sin bloquear su visualización.

Desde la raíz, genera el APK ARM32/64 con la dirección de la API de esta PC:

```powershell
powershell -NoProfile -File .\scripts\build-android.ps1 -BuildType Release -Architecture arm -ApiUrl http://192.168.0.107:8000 -Workers 4
```

El script ejecuta prebuild, incorpora JavaScript y valida el bundle y las
bibliotecas nativas antes de instalar. Genera
`App/android/app/build/outputs/apk/release/app-release.apk`.
El APK final está en `.downloads/apk/Mensajeria-1.1.3-local.apk`, con
**82914503 bytes** y bundle incluido de **5070120 bytes**. SHA256:
`4D63B8207ED14EA4BBCB709C5959A5732B107BAA5712C84D66FF64DCE87AD480`.
Android confirmó versión **1.1.3**, código **5**, y ese mismo hash instalado
en Note9 y K51. Los procesos abrieron sin errores en los logs de runtime
filtrados. Firma, bundle e iconos verificados en
`.logs/mensajeria-1.1.3-apk-verification.json`; dispositivos en
`.logs/mensajeria-1.1.3-phone-verification.json`.
Pasaron **405 pruebas frontend**, **185 backend** y las pruebas web aisladas
de recuperación y animación con persistencia de la preferencia. Gmail real
sigue pendiente de introducir localmente la contraseña de aplicación.

El registro anterior de distribución es `.downloads/apk/Mensajeria-1.1.2-local.apk`,
con **82882931 bytes**, JavaScript incluido de **5038548 bytes** y compatibilidad
con Android 24 o posterior en ARM32/64. SHA256:
`40E0CCBAFC9CB0D7058F779C68CA44350751BAF3C6E31AD58B0C18B4A839FDE5`.
La compilación final terminó correctamente en 2 minutos y 48 segundos.
Android confirmó versión 1.1.2 y código 4 en ambos teléfonos después de
`adb install -r`. Conserva el
identificador y la clave debug existentes para actualizar con `adb install -r`
sin desinstalar. Es un APK local firmado para pruebas; una publicación en
Google Play requiere la firma definitiva.

Como registro anterior, el APK 1.1.1 está en
`.downloads/apk/Mensajeria-1.1.1-local.apk`, con 81375883 bytes.
SHA256:
`EE305DFA2DEF10E1F6FDD83C0404623BA4BECC66438C14AED500B252879812F8`.
Esa compilación terminó correctamente y su bundle ocupa 5032984 bytes.
El APK anterior se instaló en el Note9 mediante `adb install -r`; Android
confirmó versión 1.1.1 y código 3. Esa instalación ahora está actualizada a 1.1.4.

Abre la app desde su icono. Android ya no necesita Metro ni Expo Go; la API local
debe estar funcionando en la PC y ambos teléfonos deben poder llegar a
`192.168.0.107:8000`. Si cambia esa dirección, recompila con la nueva
`-ApiUrl`. Este APK todavía depende de la PC para el backend; alojar la API
en un servidor es un paso separado. La comprobación visual del Note9 y las
pruebas físicas de llamadas siguen pendientes. La captura del K51 está en
`.tmp/k51-mensajeria-1.1.2-open.png`. Una nueva petición desde el Note9 a la
API LAN recibió HTTP 200; esto confirma conectividad al servidor, no la revisión
de su pantalla ni de micrófono/cámara. La validación del APK, bundle, iconos
compilados y firma está registrada en
`.logs/mensajeria-1.1.2-apk-verification.json`.
Versiones, procesos activos y conservación de datos de ambos teléfonos:
`.logs/mensajeria-1.1.2-phone-verification.json`.

La guía [llamadas-nativas.md](docs/llamadas-nativas.md) incluye instalación y
arranque de API y worker sin Metro.

### Desarrollo con Expo

```powershell
powershell -NoProfile -File scripts/start.ps1
```

El script inicia Django con Daphne/ASGI y Expo en segundo plano, comprueba que respondan e imprime el enlace `exp://<IP-de-tu-PC>:8081`. Guarda logs en `.logs/`. Si los servicios ya responden, los reutiliza. Tu telefono y PC deben estar en la misma red.

El APK ARM32/64 anterior de **Mensajeria 1.1.0**, con icono propio,
WebRTC, servicio Android, controles y borrado compartido del historial,
se instaló en el Samsung SM-N960U (Note9), conservando sus datos mediante
`adb install -r`. La copia `.downloads/apk/Mensajeria-1.1.0-desarrollo.apk`
ocupa 158349650 bytes. Ese registro corresponde al APK anterior, reemplazado
en el Note9 por las versiones Release posteriores; el último registro
confirmado es 1.1.4.
El APK de desarrollo necesita Metro.
El modo Release del apartado anterior incluye JavaScript y
conserva por ahora la API local; la API pública queda para el despliegue.
Para volver a compilar usa
`powershell -NoProfile -File scripts/build-android.ps1 -Architecture arm`;
los cambios de nombre, icono y plugins requieren prebuild. La comprobación
física de audio/video, bloqueo y salidas de audio sigue pendiente. Para instalar
y conectar la app, sigue [llamadas-nativas.md](docs/llamadas-nativas.md) y ejecuta
`powershell -NoProfile -File scripts/start.ps1 -DevClient`. Este modo inicia el
vencimiento de llamadas e imprime el enlace y QR del development client. Si
Expo Go ya ocupa el puerto, agrega `-ExpoPort 8082`; el script conserva el servidor
existente y avisa si su modo es diferente. El arranque habitual sin `-DevClient`
sigue usando Expo Go para el chat; las llamadas WebRTC requieren el APK instalado.

Para conservar el QR y logs en una terminal interactiva:

```powershell
# Terminal 1
Push-Location api
..\.venv\Scripts\python.exe -m daphne -v 0 -b 0.0.0.0 -p 8000 api.asgi:application

# Terminal 2, desde la raiz
Push-Location App
npm start
```

Para web usa `npm run web` dentro de `App/`, o `scripts/start.ps1 -Web`. Puedes cambiar los puertos con `-ApiPort 8001 -ExpoPort 8082`. La URL `EXPO_PUBLIC_API_URL` tiene prioridad; los valores localhost se adaptan al host de Expo en el dispositivo. Ejemplo de servidor especifico:

```powershell
$env:EXPO_PUBLIC_API_URL='http://192.168.0.107:8000'
Push-Location App
npm start
```

Los avisos con la app cerrada usan un receptor Android propio con notificación permanente y requieren la APK actualizada. No utilizan Expo Push, FCM ni un proyecto EAS. Expo Go y web permiten probar el chat y los archivos con la app abierta. La primera compilación puede tardar mientras Metro reconstruye su caché.

El guardado de fotos/videos usa la API moderna de galeria de SDK 57. En Android 11 o posterior, guardar los archivos del chat no solicita acceso de lectura a toda la galeria. En Android anterior pide solo escritura; en iOS pide permiso para agregar. Expo Go conserva limitaciones de acceso completo a la biblioteca; para probar ese acceso se necesita un [development build](https://docs.expo.dev/develop/development-builds/create-a-build/). La navegacion usa React Navigation 7 con native-stack para evitar la API obsoleta InteractionManager.

## Verificar cambios

```powershell
powershell -NoProfile -File scripts/check.ps1
```

Ejecuta chequeo de dependencias Python, Django, migraciones, regresiones backend/frontend, sintaxis, Expo Doctor y exportacion de Android/iOS/web. Puedes usar `-SkipBuild` o `-SkipDoctor` para una comprobacion local mas corta. Los bundles quedan en `App/dist/`; no son un APK. El workflow de GitHub ejecuta los mismos chequeos principales.

La verificación actual pasó 369 pruebas frontend, 152 backend y revisó la
sintaxis de 70 archivos. La integración web real con dos cuentas de prueba y
sesiones independientes pasó: escritura en chat vacío, inicio inmediato,
latidos continuos durante más de ocho segundos, parada en ambos sentidos al
limpiar/enviar/salir/borrar historial y vencimiento sin parada a los cinco
segundos. Con movimiento reducido los puntos son estáticos y el editor sigue
visible en 320×480; no hubo errores de runtime. Registro:
`.logs/typing-web-integration.log`.
La comprobación anterior de la versión 1.1.1 pasó 352 pruebas frontend y
sintaxis de 68 archivos; el backend previo pasó 140 pruebas.
Las exportaciones Expo Android/iOS/web anteriores completaron
correctamente. La integración web comprobó audio RTP,
video sintético de 320×240, desactivar/activar video conservando audio y la misma
PeerConnection sin reproductores duplicados, duración desde `activeAt` e
historial de dos cuentas desde Perfil. Registro:
`.logs/call-controls-web-integration-final.log`. Estas pruebas no confirman
sonido/cámara físicos, bloqueo ni salidas de audio Android.

La integración web del perfil y selector de imágenes también pasó con dos
cuentas de prueba: abrir el perfil no captura medios, cancelar el borrado no
envía DELETE y galería/cámara preparan una vista previa sin subir. Confirmar
sube un archivo privado visible para ambos; cancelar libera la selección.
Registro: `.logs/contact-camera-web-integration-final.log`. La captura física
de cámara Android sigue pendiente.

Para cambiar las dependencias backend edita `api/requirements.in`, resuelve el lockfile y verifica:

```powershell
.\.venv\Scripts\python.exe scripts\lock_backend.py
.\.venv\Scripts\python.exe -m pip install -r api\requirements.txt
powershell -NoProfile -File scripts/check.ps1
```

## Configuracion del backend

Consulta `api/.env.example`. Configura `DATABASE_URL` o las variables `POSTGRES_*` para PostgreSQL. `REDIS_URL` habilita el channel layer compartido. Las conexiones del chat deben estar aceptadas y pertenecer al usuario autenticado.

| Variable | Uso |
| --- | --- |
| `DEBUG` | Desarrollo local; en produccion debe ser `false` |
| `SECRET_KEY` | Obligatoria con `DEBUG=false`; en desarrollo se genera una clave privada persistente si no se configura |
| `ALLOWED_HOSTS` | Hosts/dominios del backend, separados por coma |
| `CORS_ALLOWED_ORIGINS` | Origenes web completos, separados por coma |
| `CORS_ALLOW_ALL_ORIGINS` | Por defecto sigue DEBUG; desactivado en produccion |
| `CHAT_IMAGE_MAX_BYTES` | Imagenes: 10 MiB por defecto |
| `CHAT_AUDIO_MAX_BYTES` | Audio: 25 MiB por defecto |
| `CHAT_VIDEO_MAX_BYTES` | Video: 100 MiB por defecto |
| `CHAT_DOCUMENT_MAX_BYTES` | Documentos: 25 MiB por defecto |
| `CHAT_MEDIA_ACCESS_TTL_SECONDS` | Vigencia de accesos a adjuntos: 900 segundos por defecto y como maximo |

Los limites deben ser enteros positivos. Imagenes se verifican con Pillow; audio/video validan tipo, extension y tamano. La reproduccion final tambien depende de codecs admitidos por el telefono.

La clave local se guarda en `api/.local/secret-key`, excluida de Git y de las imagenes Docker; no la compartas ni la borres al reiniciar. Compose de desarrollo conserva su clave en el volumen `development_secrets`. Al reemplazar la antigua clave fija, las sesiones locales anteriores requieren iniciar sesion nuevamente. La opcion Daphne `-v 0` evita guardar los tokens de WebSocket y los enlaces temporales en logs de acceso.

## Docker

Copia `.env.example` a `.env` y ajusta puertos/credenciales antes de ejecutar:

```powershell
docker compose up --build
```

Levanta PostgreSQL, Redis, Django ASGI en `:8000` y web en `:8084`. Nginx sirve la app, los avatares `/media/miniatura/` y `/static/`, y reenvia `/chat/` y `/ws/` al backend. Bloquea las rutas publicas antiguas de adjuntos; las descargas privadas pasan por Django. Los archivos subidos se conservan en `api/media/` y PostgreSQL en un volumen. PostgreSQL y Redis publican sus puertos solo en localhost.

Para una configuracion de produccion define `SECRET_KEY`, `ALLOWED_HOSTS`, `POSTGRES_PASSWORD` y `EXPO_PUBLIC_API_URL` (URL publica HTTPS, disponible durante el build), y ejecuta:

```powershell
docker compose -f docker-compose.yml -f docker-compose.production.yml up --build -d
```

La capa de produccion desactiva DEBUG y CORS abierto. Usa la URL publica del proxy Nginx como `EXPO_PUBLIC_API_URL`, para que tambien esten disponibles los avatares. Configura TLS en el proxy de entrada que use tu servidor y conserva respaldos de PostgreSQL y `api/media/`.

## Respaldo y migracion SQLite a PostgreSQL

```powershell
.\.venv\Scripts\python.exe api\manage.py dumpdata --exclude contenttypes --exclude auth.Permission --indent 2 --output api\db-export.json
```

Para cargar ese respaldo en el servicio PostgreSQL, monta el archivo en un contenedor temporal y ejecuta `manage.py loaddata`. `api/db-export.json` contiene datos de usuarios y esta excluido de Git y de las imagenes Docker.
