# Revision del flujo de fotos: 1.1.8

Estado: publicada y desplegada el 24 de octubre de 2026, despues de recibir
autorizacion explicita. Revision `a55a92dd2c64f5c0b06c9c625520eb8f56bb65de`.
La version posterior [1.1.9](revision-fotos-1.1.9.md) sustituye la espera del
WebSocket para subir avatares por una subida HTTP confirmada y corrige el error
de Perfil en Android. La version 1.1.8 se instalo en el Note 9 y luego se actualizo.

## Hallazgos comprobados

La imagen de prueba persistida se sigue descargando con HTTP 200 desde ambas
cuentas. El flujo web completo de galeria, vista previa, envio y descarga de
una foto nueva tambien paso, sin errores JavaScript. Esto no reproduce por si
solo el fallo de la foto del usuario; no se inspeccionaron sus credenciales ni
sus imagenes privadas.

Si se abre Perfil inmediatamente despues del ingreso, el selector podia usarse
antes de estar listo el WebSocket. En web el aviso nativo no proporcionaba una
explicacion visible. Esperar a la primera respuesta del chat permitio completar
la misma seleccion correctamente.

El visor solo obtenia el enlace temporal al montar o reintentar manualmente.
No renovaba un enlace que fallaba durante la carga. Ademas, un efecto reiniciaba
el estado cargado al cambiar la URL, pudiendo ocultar un evento de carga rapido.
Los avatares seguian sin copia persistente y Nginx evitaba cualquier recuperacion.

## Cambios preparados

- Perfil espera conexion y muestra errores en pantalla; el envio informa si
  realmente pudo escribir en el socket.
- El visor identifica la carga por URL y version. Ignora eventos anteriores y
  renueva una vez el enlace fallido, con limite para evitar bucles.
- Las fotos perdidas reciben `media_missing`, despues de comprobar permisos.
  La interfaz pide reenviarlas en lugar de mantener un reintento inutil.
- Avatares y fotos del chat comparten el limite existente de 100 MiB. La copia
  del avatar y el perfil se guardan en la misma transaccion. Cambiar avatar
  reemplaza su copia; un fallo conserva el perfil anterior.
- Nginx delega solo `/media/miniatura/` a Django para recuperar avatares faltantes.
  Las imagenes del chat siguen privadas y no se exponen en `/media/`.
- La comprobacion local de esquema exige las migraciones de fotos. Render aplica
  `0016_avatar_image_archive` antes de escuchar en el puerto publico.

## Validacion y entrega

Pasaron 141 pruebas del servidor y 177 del cliente; sintaxis de 83 archivos.
Se comprobaron cambio de cuenta, renovacion limitada, respuestas tardias, archivo
perdido, presupuesto compartido, restauracion publica de avatar sin acceso a
adjuntos privados y rollback ante fallo de base.

APK Android 1.1.8 (codigo 10), ARM64 y ARM32, compilada correctamente en 2m32s.
JavaScript, Hermes y WebRTC incluidos. La firma coincide con 1.1.7 para instalar
como actualizacion sin desinstalar. No se instalo: no habia dispositivo conectado.

Archivo: `.downloads/apk/Mensajeria-1.1.8-Render-pruebas.apk`.
SHA256: `153ed0d9acf1bbf41efde4d9406de9e449540b6a48a61d9943a116f965b5b657`.
Informe y checksum junto al APK; compilacion en `.logs/android-render-1.1.8-build.log`.

Para activar hay que publicar los cambios revisados en la rama
`render-pruebas-octubre-2026` de `edgardo198/Android_Ios` y desplegar el commit.
La revision automatica rechazo inicialmente crear ese commit. Se obtuvo la
autorizacion explicita del usuario antes de publicarlo; no se eludio el rechazo.

El cambio no recupera archivos antiguos que ya no existen. Las nuevas copias
dependen del presupuesto y vigencia de PostgreSQL; audio, video y documentos
siguen usando disco temporal. El primer despliegue tampoco puede conservar
avatares anteriores que aun no tengan copia en la base.
