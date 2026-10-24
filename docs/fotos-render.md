# Fotos del chat en la prueba de Render

Estado (24 de octubre de 2026): correccion preparada y probada; despliegue pendiente.

El servicio gratuito guarda los adjuntos en un disco efimero. Render elimina sus
cambios al redesplegar, reiniciar o suspender la instancia. La base conserva el
mensaje y su ruta, pero no el contenido de la foto. Esto explica las imagenes
que dejaron de cargar despues del despliegue del arreglo de Redis.

No se encontro una copia local de las fotos subidas a Render. Las fotos del
servidor local son anteriores al despliegue y no corresponden a esas subidas.
Las imagenes sin original ni archivo de respaldo no se pueden reconstruir a
partir del mensaje; hay que reenviarlas desde un dispositivo que las conserve.

## Correccion preparada

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

## Activacion

Antes de activar, conservar fuera del servidor cualquier adjunto temporal que
aun este disponible. El despliegue inicial de la correccion tambien reemplaza
el disco anterior y no puede conservar archivos que aun no tienen copia.
No se modifica el plan gratuito ni se contrata almacenamiento.

Publicar los archivos revisados, incluida la migracion
`0015_message_image_archive`, y desplegar esa revision. El arranque de Render
aplica la migracion antes de escuchar. No requiere una APK nueva.

Validacion local: 117 pruebas de fotos, GIF, permisos, historial y backend pasaron.
La prueba de persistencia abre la foto desde una carpeta completamente nueva,
compara cada byte y verifica que un tercero o un historial borrado no la restaure.
Tambien se comprobaron limite total, fallo de base y ausencia de respaldo.

Fuente: https://render.com/docs/free#local-files-lost-on-redeploy
