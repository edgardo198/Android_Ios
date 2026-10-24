# Fotos y perfil: 1.1.9

Estado: activa en Render desde el 24 de octubre de 2026 a las 09:33:09 de Honduras.
Revision `bee1ff0b0577e3c0b211abf5e67f3694a3eb14cc`, despliegue
`dep-dbecu65g1s2s73f6v3c0`.
APK 1.1.9 (codigo Android 11) instalada en el Note 9 con `adb install -r`,
conservando los datos. Version instalada comprobada con el gestor de paquetes.

## Causa del fallo de perfil en Android

El selector de galeria envia la actividad al fondo. La app cierra el WebSocket
en ese estado y lo vuelve a conectar al regresar. La version anterior intentaba
subir el avatar mediante ese socket antes de terminar la reconexion. La foto
no se enviaba; el error tampoco tenia espacio suficiente en la tarjeta.

La subida usa ahora `POST /chat/me/avatar/`, con multipart y JWT. El cliente
espera confirmacion HTTP antes de cambiar su perfil. No transporta Base64 por
WebSocket ni necesita que el socket este abierto. La peticion queda ligada a
la cuenta que selecciono la foto: cambiar de cuenta descarta la respuesta vieja.

El servidor valida la imagen, guarda avatar y copia de PostgreSQL en una misma
transaccion y devuelve el perfil confirmado. El aviso opcional por Redis tiene
un limite de un segundo: un Redis lento no bloquea la respuesta de la subida.
Las versiones anteriores conservan el protocolo WebSocket para compatibilidad.

El error de Perfil ocupa el ancho de la tarjeta debajo de la cuenta y no la
columna estrecha del avatar.

## Redis y fotos del chat

Redis distribuye eventos; no conserva los archivos de fotos. Los binarios y su
copia de respaldo se leen mediante HTTP y PostgreSQL. La comprobacion real con
cuentas sinteticas recibio `message.send` en ambos sockets para una foto nueva,
con identidad de remitente/destinatario correcta. Ambos descargaron los mismos
bytes y el acceso anonimo sin ticket fue rechazado.

En el Note 9 se observo que la foto nueva de las 09:19 se mostraba correctamente.
La anterior de las 07:37 devuelve `media_missing`: su archivo ya no existe y
necesita reenviarse desde el original. Actualizar el visor no recupera esos bytes.
No se enviaron mensajes desde la cuenta real durante la revision.

## Verificaciones

146 pruebas del servidor y 179 del cliente; 83 archivos pasan sintaxis.
Incluyen subida sin Redis, Redis bloqueado, autenticacion, aislamiento entre
cuentas, expiracion, archivos ausentes, presupuesto compartido y restauracion.

APK de ARM64 y ARM32: `.downloads/apk/Mensajeria-1.1.9-Render-pruebas.apk`.
Compilacion correcta en 2m08s, JavaScript y WebRTC incluidos, sin Metro.
Firma igual a la APK anterior: permite `adb install -r` conservando los datos.
SHA256: `00e7e80e9c02b627bf0f46df284175db2a1438bff9f86a3e5e63529e7de30e74`.

En la web desplegada se abrio el selector, se cerro el WebSocket y se impidio
su reconexion durante la seleccion. La subida devolvio HTTP 200 y la nueva foto
de perfil se descargo con HTTP 200, sin errores. Resultado sin credenciales:
`.local/web-verification/avatar-full-flow.json`.

Tambien se completo galeria, vista previa, envio HTTP 201 y apertura de una foto
nueva en el visor web. Redis entrego una foto de control a ambos participantes;
los sockets conservaron conexion durante 26 segundos de inactividad y respondieron
a busqueda, lista de amigos y presencia de llamadas. No se observaron errores
`TimeoutError` nuevos en las comprobaciones del despliegue.

El archivo de fotos y avatares comparte un presupuesto de 100 MiB y depende de
la vigencia de PostgreSQL. Audio, video y documentos siguen siendo temporales.
