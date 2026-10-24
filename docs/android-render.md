# APK de pruebas con Render

Version Android actual: **1.1.9**, codigo **11**. Instalada en el Note 9 el 24 de
octubre de 2026 como actualizacion sin borrar datos. La firma coincide con la
version anterior. Archivo: `.downloads/apk/Mensajeria-1.1.9-Render-pruebas.apk`.
Detalles y verificacion en [revision de fotos 1.1.9](revision-fotos-1.1.9.md).

## Registro de la version 1.1.7

Version Android de este registro historico: **1.1.7**, codigo **9**.

Estado: **compilado, verificado e instalado el 22 de octubre de 2026** en un
Samsung Note 9 SM-N960U con Android 10. Se actualizo la version 1.1.5 con
`adb install -r`; no se desinstalo ni se borraron los datos de la app.

Servidor incluido: https://mensajeria-pruebas-octubre-2026.onrender.com

## Compilar

Desde la raiz del proyecto:

```powershell
powershell -NoProfile -File .\scripts\build-android.ps1 -BuildType Release -Architecture arm -ApiUrl https://mensajeria-pruebas-octubre-2026.onrender.com -Workers 2
```

El APK incluye ARM64 y ARM32, JavaScript, Hermes y WebRTC. Abre directamente
desde su icono, sin Metro, Expo Go ni una conexion USB a la PC. Necesita Internet
para comunicarse con Render. La configuracion Android usa HTTPS y desactiva
el trafico HTTP sin cifrar.

Conserva el identificador de aplicacion y la firma de pruebas existentes para
permitir actualizar la APK anterior. No hace falta desinstalarla. Las sesiones
y colas de mensajes de una URL de API explicita se guardan por servidor; la
version de Render no reutiliza credenciales ni envia pendientes del servidor
local. Los datos locales anteriores no se migran ni se borran.

Render tiene su propia base de datos. Registra una cuenta de prueba en ese
servidor; las cuentas creadas en la PC no se copiaron al despliegue.

La prueba utiliza los recursos gratuitos descritos en [Render](render.md), con
limites de adjuntos, correo y llamadas entre redes distintas. Desde el 24 de
octubre, las [fotos nuevas del chat tienen copia en PostgreSQL](fotos-render.md)
y sobreviven al reinicio del servidor, dentro del presupuesto y vigencia de la
prueba. No requiere recompilar ni reinstalar esta APK. Los otros adjuntos siguen
siendo temporales.

## Archivo y comprobaciones

El archivo final se conserva como `.downloads/apk/Mensajeria-1.1.7-Render-pruebas.apk`.
Se comprueban la firma, version, arquitecturas, bundle incluido y URL de Render
antes de entregarlo. El registro de compilacion queda en
`.logs/android-render-1.1.7-build.log`.

Resultado: `BUILD SUCCESSFUL` en 3 minutos y 7 segundos, 992 tareas (56 ejecutadas,
936 actualizadas), APK de 82.896.247 bytes (aprox. 83 MB).
Pasaron 97 pruebas de sesion, aislamiento y cola de mensajes durante la preparacion
anterior, y 102 de API, disponibilidad y acceso al corregir el inicio de Render.
El mapa de fuentes confirma que el APK contiene las versiones actuales de
`secure.js`, `outbox.js` y `api.js`, incluida la espera de disponibilidad de 90 segundos.
La firma coincide con la APK anterior y el manifiesto desactiva HTTP sin cifrar.

SHA256 del APK:

```text
cc052fd666a783c48f2b92dcb90eca8b18802bbbaa7524d17fd3b7bab17f1bc4
```

El informe `.apk.json` y el archivo `.apk.sha256` se guardan junto al instalador.

La huella SHA256 del APK instalado en el Note 9 coincide con este archivo. El
proceso inicia sin errores JavaScript ni cierres fatales en el registro filtrado.
La comprobacion interactiva de ingreso y mensajeria esta pendiente de mantener
el telefono desbloqueado. Las llamadas requieren una prueba separada.
