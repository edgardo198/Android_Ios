# Android_Ios

Aplicacion de mensajeria con Django en el backend y Expo/React Native en el frontend.

## Requisitos

- Python 3.12
- Node.js LTS

## Instalacion

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r api\requirements.txt
cd App
npm install
```

## Ejecutar backend

```powershell
.\.venv\Scripts\python.exe api\manage.py runserver 0.0.0.0:8000
```

En desarrollo local, si no defines `REDIS_URL`, Django usa un channel layer en memoria para que el proyecto funcione sin Redis.

Para usar PostgreSQL fuera de Docker, define `DATABASE_URL` antes de ejecutar Django:

```powershell
$env:DATABASE_URL='postgresql://android_ios:android_ios@localhost:5432/android_ios'
.\.venv\Scripts\python.exe api\manage.py migrate
.\.venv\Scripts\python.exe api\manage.py runserver 0.0.0.0:8000
```

## Docker backend

```powershell
docker compose up --build
```

El compose levanta PostgreSQL, Redis, el backend Django en `http://localhost:8000` y el frontend web en `http://localhost:8084`.

Si el puerto `8000` ya esta ocupado, puedes levantar todo con otro puerto para la API:

```powershell
$env:API_PORT='8001'
$env:EXPO_PUBLIC_API_URL='http://localhost:8001'
docker compose up --build
```

## Migrar SQLite a PostgreSQL

Con la base SQLite actual en `api/db.sqlite3`, exporta los datos:

```powershell
$env:PYTHONUTF8='1'
.\.venv\Scripts\python.exe api\manage.py dumpdata --exclude contenttypes --exclude auth.Permission --indent 2 --output api\db-export.json
```

Luego levanta PostgreSQL y carga el respaldo desde el contenedor `api`:

```powershell
docker compose up -d db redis
docker compose build api
docker compose run --rm api python manage.py migrate
$fixture = (Resolve-Path .\api\db-export.json).Path
docker compose run --rm -v "${fixture}:/app/db-export.json:ro" api python manage.py loaddata /app/db-export.json
```

Cuando confirmes que todo funciona en PostgreSQL, elimina `api\db-export.json`; ese archivo no debe subirse a Git.

Para publicar la imagen, etiqueta el repositorio destino y haz push:

```powershell
docker tag android-ios-api:latest <usuario>/android-ios-api:latest
docker push <usuario>/android-ios-api:latest
```

## Ejecutar frontend

```powershell
cd App
npx expo start --port 8084
```

Si corres la app en un dispositivo fisico y necesitas apuntar al backend de tu PC, define `EXPO_PUBLIC_API_URL` antes de iniciar Expo. Ejemplo:

```powershell
$env:EXPO_PUBLIC_API_URL='http://192.168.1.50:8000'
npx expo start --port 8084
```

## Abrir en navegador

Para levantar la misma app en web y poder iniciar sesion con el mismo backend:

```powershell
.\.venv\Scripts\python.exe api\manage.py runserver 0.0.0.0:8000
cd App
$env:EXPO_PUBLIC_API_URL='http://127.0.0.1:8000'
npx expo start --web --port 8084
```

Si abres la app web desde otro equipo en tu red local, cambia `127.0.0.1` por la IP de tu PC, por ejemplo `http://192.168.1.50:8000`.

El login web reutiliza el mismo endpoint `/chat/signin/` y conserva la sesion en el navegador para que el flujo se parezca al de la app movil.
