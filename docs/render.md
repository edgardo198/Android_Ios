# Prueba gratuita en Render: octubre de 2026

Estado: **correccion de desconexiones desplegada y verificada el 24 de octubre de 2026**.

Version activa: **1.1.9**, revision `bee1ff0b0577e3c0b211abf5e67f3694a3eb14cc`,
despliegue `dep-dbecu65g1s2s73f6v3c0`, desde las 09:33:09 de Honduras del
24 de octubre. [Verificacion de fotos y subida HTTP de perfil](revision-fotos-1.1.9.md).

Web y API: https://mensajeria-pruebas-octubre-2026.onrender.com

Codigo publicado: https://github.com/edgardo198/Android_Ios/tree/render-pruebas-octubre-2026

El despliegue activo se creo mediante la API de Render, con tres recursos en
plan gratuito. `render.yaml` paso la validacion oficial y sirve como referencia
de la arquitectura; no se creo una instancia de Blueprint.

| Recurso | ID | Plan |
| --- | --- | --- |
| Web | `srv-dbd00uon74is73fo9t10` | Free |
| PostgreSQL | `dpg-dbd00ugn74is73fo9s6g-a` | Free |
| Redis | `red-dbd00umq1p3s73dg7a40` | Free |

Render marco el despliegue `dep-dbd00vgn74is73fo9u8g` como `live`. Se verificaron
la pagina principal, el bundle Expo, `/health/`, `robots.txt`, los estilos del
administrador y el rechazo del acceso anonimo a `/chat/me/` y archivos privados.
No se crearon cuentas ni se envio ningun mensaje durante esas comprobaciones.

La correccion de acceso web quedo activa en la revision
`12e7dcd9ac00f45d1f09132174d3778b2fb6ebbb`, despliegue
`dep-dbd1jja9lscs738jso5g`, marcado `live` el 22 de octubre a las 14:14 UTC.
Se completo registro e ingreso con una cuenta sintetica de pruebas. En la web
actualizada se verifico el ingreso normal y otro con dos respuestas de salud
503 simuladas y una respuesta correcta demorada 2,5 segundos: no se envio el
formulario hasta estar listo y hubo exactamente un POST de ingreso.
No se enviaron mensajes. Los resultados locales estan en
`.local/web-verification/`; no contienen contrasenas ni tokens. La credencial de
la cuenta de prueba se conserva por separado en `qa-account.json`, excluido de Git.

## Correccion de desconexiones del 24 de octubre

La correccion de Redis se activo en la revision `5c416412f2a3b09663edf846fcede42d5ddb0daa`, despliegue
`dep-dbeb2c7avr4c73aart2g`, marcado `live` a las 13:24:22 UTC (07:24:22 en Honduras).

Los registros mostraban `redis.exceptions.TimeoutError` en `BZPOPMIN` y cierres
repetidos de `/ws/chat/` y `/ws/calls/`. No era prueba de una caida de Redis:
redis-py 8.1 fija por defecto cinco segundos de lectura, el mismo plazo que
Channels usa para su lectura bloqueante. Se configuro explicitamente un limite
de lectura de 20 segundos y de conexion de cinco segundos en la capa Channels.
El cache HTTP conserva su configuracion independiente.

La correccion es del servidor compartido por web y APK Render 1.1.7; no requiere
reinstalar ni borrar datos del telefono. Recarga la web y vuelve a abrir la app
para recuperar sus conexiones. No cambia los limites del plan gratuito.

Validacion: una prueba con el cliente Redis real y un servidor RESP controlado
demora la respuesta 5,25 segundos y comprueba que el siguiente evento llega por
la misma conexion. Pasaron 116 pruebas de cliente de chat, llamadas y cola.
En Render se verificaron ingreso y navegacion web tras inactividad, sin errores
JavaScript ni cierre de sockets. Otra prueba sin encabezado Origin, como Android,
conservo ambos sockets durante 26 segundos y recibio busqueda, lista de amigos
y respuesta de presencia de llamadas. Los resultados sin credenciales estan en
`.local/web-verification/redis-idle-results.json` y `native-idle-results.json`.
No habia telefono conectado: la interaccion fisica en Android sigue pendiente.

La revision que activo el respaldo de fotos a las 07:39:20 del 24 de octubre fue
`919414cd1160682afff0c2a5cfb2c5a6ba9e66d6`, despliegue
`dep-dbeb9c29lscs73aj2um0`. Agrega [copias privadas de fotos nuevas en PostgreSQL](fotos-render.md),
con un presupuesto conjunto de 100 MiB. Una foto sintetica sobrevivio al reemplazo
real de la instancia y se abrio desde ambas cuentas y desde el chat web.

## Periodo de prueba

Esta configuracion se usara solo para pruebas durante lo que resta de octubre
de 2026. La fecha prevista para terminar es el **31 de octubre de 2026**, hora de
Honduras. No hay apagado ni eliminacion automatica programados: al terminar las
pruebas hay que suspender el servicio web desde Render. La caducidad de PostgreSQL
se cuenta desde su creacion y no sustituye ese cierre.

Usa cuentas nuevas y datos de prueba. La configuracion excluye las bases de datos,
archivos multimedia y secretos locales del contexto Docker. La web solicita a
los buscadores que no la indexen mediante `robots.txt` y `X-Robots-Tag`; sigue
siendo una URL publica y esas indicaciones no restringen el acceso.

Al cerrar la prueba, conserva lo que quieras guardar antes de suspender el
servicio. Puedes eliminar los tres recursos temporales desde el panel si ya no
necesitas sus datos. Ninguno se convierte a un plan de pago automaticamente
mediante esta configuracion.

## Arquitectura

`render.yaml` crea un unico servicio web gratuito, PostgreSQL gratuito y Key Value
gratuito, todos en Oregon. `Dockerfile.render` compila la web Expo y ejecuta Nginx,
Daphne y el proceso de vencimiento de llamadas en el mismo contenedor.
La web y la API comparten el dominio HTTPS de Render. No hay que configurar CORS
ni copiar una URL de API en la web. El APK instalado sigue usando su servidor
anterior: para cambiarlo hay que compilarlo con `EXPO_PUBLIC_API_URL=https://<dominio-real>`.

Metro compila con un trabajador y un limite de heap de 2048 MiB por proceso.
La compilacion del 22 de octubre con paralelismo automatico supero los 8 GiB del
constructor de Render; ese fallo no cambio la version que ya estaba disponible.

El arranque aplica migraciones y recopila archivos estaticos antes de escuchar en
el puerto 10000. Los adjuntos privados pasan por la autorizacion de Django; Nginx
solo sirve directamente los avatares publicos y los archivos estaticos.

## Acceso web cuando el servidor esta dormido

Antes de ingresar o registrar una cuenta, la web comprueba `/health/` en su propio
dominio HTTPS. En Render espera hasta 90 segundos, con intentos GET de hasta
10 segundos; solo acepta JSON con `status: "ok"`. La comprobacion se comparte
entre solicitudes y se renueva despues de un minuto sin actividad.

Los datos del formulario se envian una sola vez, cuando el servidor esta listo.
Si no responde dentro de ese plazo, aparece un mensaje para reintentar y se
conservan los campos. No se buscan otros servidores ni se repite automaticamente
el registro o el ingreso. Las pruebas unitarias de disponibilidad, autenticacion
y API completaron 102 casos correctamente.

Para cargar la actualizacion en la PC, abre la URL de Render y pulsa Ctrl+F5.
Las cuentas creadas en el servidor local no se copiaron a esta base de pruebas.

## Limites del plan gratuito

- PostgreSQL vence a los 30 dias. Guarda copias antes de su vencimiento.
- Las fotos nuevas del chat y los avatares tienen copia en PostgreSQL (hasta 100 MiB
  en total) desde la correccion del 24 de octubre. No recupera fotos anteriores
  perdidas. Audio, video y documentos siguen en disco temporal y se
  pierden al reiniciar, redesplegar o suspender. No se migran archivos ni usuarios
  locales automaticamente. La copia de fotos dura mientras siga vigente la base.
- El servicio duerme despues de 15 minutos sin trafico y puede tardar alrededor
  de un minuto en despertar. No garantiza recepcion continua de avisos.
- Key Value gratuito no garantiza persistencia. PostgreSQL conserva los mensajes
  confirmados mientras siga vigente; Redis gestiona eventos y cache temporales.
- Gmail por SMTP no funciona aqui: Render bloquea los puertos SMTP en instancias
  gratuitas. La recuperacion por correo queda sin configurar.
- Las llamadas entre redes distintas requieren un servidor STUN/TURN propio
  configurado mediante las variables `CALLS_*`; Render no lo instala.
- No se crean workers, discos ni servicios de pago. Revisa los limites de consumo
  y facturacion de tu cuenta si tiene una tarjeta vinculada.

Fuente: https://render.com/docs/free

## Publicar

La rama `render-pruebas-octubre-2026` contiene una copia seleccionada del codigo
actual. Incluye `App` como una carpeta normal, por lo que este despliegue no
depende de publicar el submodulo por separado. Los repositorios de trabajo
originales y sus cambios pendientes se conservaron.

Para actualizar la prueba, publica los cambios revisados en esa rama y ejecuta
un despliegue manual desde el panel de Render o, en este equipo:

```powershell
powershell -NoProfile -File .\scripts\render-cli.ps1 deploys create srv-dbd00uon74is73fo9t10 --confirm
```

Los ayudantes de autenticacion y despliegue estan en el proyecto original de
esta PC. La rama publicada contiene el codigo necesario para construir y
ejecutar la aplicacion, sin sesiones locales ni archivos personales.

Comprueba `/health/` despues de publicar. Para pruebas funcionales, registra dos
cuentas nuevas y verifica mensajes y WebSocket entre ellas. Consulta los limites
de fotos y otros adjuntos anteriores. El [APK Android 1.1.7 de pruebas](android-render.md) incluye la URL de
Render y la espera de disponibilidad; se instalo en un Samsung Note 9.

El nombre del servicio no garantiza un subdominio concreto. Django utiliza
`RENDER_EXTERNAL_HOSTNAME`, proporcionado por Render, para permitir el dominio real.
Los despliegues automaticos quedan desactivados para revisar cada publicacion.

## Acceso automatico desde el navegador

Para evitar copiar claves, se preparo Render CLI oficial v2.31.0 dentro de
`.local/render-cli-v2.31.0/`, verificando su archivo SHA256 contra la distribucion
oficial. Inicia sesion con:

```powershell
powershell -NoProfile -File .\scripts\render-cli.ps1 login --confirm
```

El navegador abre la autorizacion de Render. Pulsa **Authorize CLI**; este paso
requiere la sesion del propietario de la cuenta. El token se guarda solo en
`.local/render-session/`, excluido de Git y del contexto Docker. El ejecutable
tambien es local y no se publica en el repositorio.

El comando ignora la clave `RENDER_API_KEY` anterior solo durante su ejecucion,
sin modificar la variable guardada del usuario. Usa el mismo script para listar
espacios de trabajo, seleccionar el correcto y consultar servicios:

```powershell
powershell -NoProfile -File .\scripts\render-cli.ps1 workspaces -o json
powershell -NoProfile -File .\scripts\render-cli.ps1 services -o json
```

Fuente: https://render.com/docs/cli

## Acceso alternativo mediante API key

La clave de entorno encontrada durante la preparacion devolvio HTTP 401.
Genera una nueva en https://dashboard.render.com/u/settings#api-keys y ejecuta:

```powershell
powershell -NoProfile -File .\scripts\configure-render.ps1
```

El comando solicita la clave con entrada oculta, valida el acceso y la guarda
en la variable de usuario `RENDER_API_KEY`. No la pegues en el chat ni en Git.
Un proceso ya abierto puede necesitar cargar nuevamente esa variable de usuario.

Si falla, el script muestra el motivo sin revelar la clave: HTTP 401 indica que
Render la rechazo; HTTP 403 indica acceso denegado; HTTP 429 pide esperar antes
de reintentar. Los fallos de red, TLS y guardado se informan por separado.
Pega la clave completa, sin comillas ni `Bearer`. Render solo la muestra completa
al crearla; si solo tienes una version ocultada, genera otra.
