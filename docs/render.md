# Prueba gratuita en Render: octubre de 2026

Estado: configuracion local preparada; despliegue remoto pendiente de acceso valido
y de publicar los cambios de ambos repositorios.

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

El arranque aplica migraciones y recopila archivos estaticos antes de escuchar en
el puerto 10000. Los adjuntos privados pasan por la autorizacion de Django; Nginx
solo sirve directamente los avatares publicos y los archivos estaticos.

## Limites del plan gratuito

- PostgreSQL vence a los 30 dias. Guarda copias antes de su vencimiento.
- Fotos, avatares y otros adjuntos se pierden al reiniciar, redesplegar o suspender
  el servicio. No se migran los archivos ni usuarios locales automaticamente.
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

1. Publica primero los cambios del repositorio `App` en GitHub. `App` es un
   submodulo; Render necesita que su commit exista en remoto.
2. En el repositorio principal, actualiza el puntero de `App` y publica la version
   revisada del backend, `render.yaml`, `Dockerfile.render`, `.dockerignore`,
   `.gitattributes` y `scripts/render/`. Hay cambios locales previos: revisalos
   antes de crear el commit; no subas secretos ni archivos personales.
3. En https://dashboard.render.com/ abre **New > Blueprint** y conecta
   `edgardo198/Android_Ios` con la rama que contiene esos cambios.
4. Comprueba que todos los planes sean **Free** y aplica el Blueprint.
5. Espera el build y abre la URL HTTPS que Render asigne. `/health/` debe devolver
   `{"status":"ok"}`. Verifica registro, acceso, mensajes y WebSocket con dos cuentas.
   Prueba adjuntos solo como datos temporales.

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
