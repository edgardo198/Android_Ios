# Variables
VENV_DIR = venv
PYTHON = $(VENV_DIR)\Scripts\python
MANAGE = $(PYTHON) api/manage.py
ADB = adb devices

# Comandos para el frontend (React Native con Expo)
run-frontend:
	cd app && npx expo start --port 8084

# Comandos para el backend (Django)
run-backend:
	$(MANAGE) runserver

# Verificar dispositivos Android conectados
connect-android:
	$(ADB)

# Iniciar todo el proyecto en paralelo
start:
	$(MAKE) venv
	$(MAKE) connect-android
	powershell -Command "Start-Process -NoNewWindow '$(MAKE)' -ArgumentList 'run-backend'"
	powershell -Command "Start-Process -NoNewWindow '$(MAKE)' -ArgumentList 'run-frontend'"

# Limpiar todo (compatible con Windows)
clean:
	rmdir /S /Q $(VENV_DIR)
	cd app && rmdir /S /Q node_modules

