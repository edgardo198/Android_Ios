# Fotos del chat en la prueba de Render

Estado (24 de octubre de 2026): activa y verificada en Render.

Actualizacion posterior: [1.1.9](revision-fotos-1.1.9.md) agrega respaldo de
avatares en el mismo presupuesto de 100 MiB y subida de perfil por HTTP. El
registro siguiente describe la activacion inicial del respaldo de fotos del chat.

Revision `919414cd1160682afff0c2a5cfb2c5a6ba9e66d6`, despliegue
`dep-dbeb9c29lscs73aj2um0`, activo desde las 07:39:20 de Honduras.
La migracion `chat.0015_message_image_archive` se aplico correctamente.

El servicio gratuito guarda los adjuntos en un disco efimero. Render elimina sus
cambios al redesplegar, reiniciar o suspender la instancia. La base conserva el
mensaje y su ruta, pero no el contenido de la foto. Esto explica las imagenes
que dejaron de cargar despues del despliegue del arreglo de Redis.

No se encontro una copia local de las fotos subidas a Render. Las fotos del
servidor local son anteriores al despliegue y no corresponden a esas subidas.
Las imagenes sin original ni archivo de respaldo no se pueden reconstruir a
partir del mensaje; hay que reenviarlas desde un dispositivo que las conserve.

## Proteccion activa

Las fotos nuevas y GIF se copian, sin alterar sus bytes, a una tabla separada de
PostgreSQL antes de confirmar el envio. La copia y el mensaje se guardan en la
misma transaccion. Si falla la copia o se alcanza el limite, se rechaza el envio
y se retiran el mensaje y el archivo local incompletos.

`CHAT_ARCHIVE_IMAGES` se activa por defecto cuando existe
`RENDER_EXTERNAL_HOSTNAME`; en local queda desactivado. El limite de cada imagen
sigue siendo 10 MiB y el archivo conjunto tiene un presupuesto de 100 MiB,
configurable mediante `CHAT_IMAGE_ARCHIVE_MAX_BYTES`. Una fila bloqueada durante
la transaccion serializa las subidas entre conversaciones en PostgreSQL.

Al abrir una foto cuyo archivo local falta, se recupera atomicamente desde su
copia en la base. Antes de hacerlo se comprueban el usuario, la pertenencia al
chat, la aceptacion de la conexion y el borrado del historial. Los bytes no se
incluyen en las listas de mensajes ni se exponen en rutas publicas.

Esta correccion protege fotos enviadas despues de activarla. No recupera fotos
ya perdidas y no cambia el almacenamiento de audio, video, documentos o avatares.
La base gratuita de esta prueba vence el 21 de noviembre de 2026; la prueba sigue
prevista hasta el 31 de octubre. No es almacenamiento permanente ni un servicio
de copia externo. Un borrado logico de historial no libera el presupuesto de
copias, siguiendo la retencion fisica del historial ya existente.

## Activacion y verificacion

Antes de activar, conservar fuera del servidor cualquier adjunto temporal que
aun este disponible. El despliegue inicial de la correccion tambien reemplaza
el disco anterior y no puede conservar archivos que aun no tienen copia.
No se modifica el plan gratuito ni se contrata almacenamiento.

La activacion se completo con autorizacion del usuario, que confirmo haber
guardado los adjuntos necesarios. El arranque de Render aplica la migracion
antes de escuchar. No requiere una APK nueva.

Validacion local: 117 pruebas de fotos, GIF, permisos, historial y backend pasaron.
La prueba de persistencia abre la foto desde una carpeta completamente nueva,
compara cada byte y verifica que un tercero o un historial borrado no la restaure.
Tambien se comprobaron limite total, fallo de base y ausencia de respaldo.

La prueba real subio un PNG sintetico entre dos cuentas de prueba. Remitente y
destinatario lo descargaron con HTTP 200 y el acceso anonimo sin ticket obtuvo
401. Se reinicio el servicio y se confirmo el reemplazo de la instancia
`srv-dbd00uon74is73fo9t10-pkv7r` por `srv-dbd00uon74is73fo9t10-nhqlf` antes de
volver a descargar. El PNG conservo los mismos 101 bytes y SHA256
`ab573e142c7934932fda75e5e9573c4e3ec6d6c7cc363e9bfa67f1dc3053563e`.
Tambien abrio en el visor del chat web sin errores JavaScript.

Los resultados sin credenciales estan en `.local/web-verification/`:
`photo-persistence-upload.json`, `photo-persistence-verify.json` y
`photo-persistence-browser.json`. Las credenciales sinteticas se guardan aparte
y no se publican. La prueba no envio mensajes a cuentas de otras personas.

Fuente: https://render.com/docs/free#local-files-lost-on-redeploy
