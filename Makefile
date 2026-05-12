# Variables
VENV_DIR = .venv
APP_DIR = App
PYTHON = $(VENV_DIR)\Scripts\python.exe
MANAGE = $(PYTHON) api/manage.py
ADB = adb devices

# Preparar backend local
install-backend:
	python -m venv $(VENV_DIR)
	$(PYTHON) -m pip install --upgrade pip
	$(PYTHON) -m pip install -r api\requirements.txt

# Preparar frontend local
install-frontend:
	cd $(APP_DIR) && npm install

# Instalar todo el proyecto
install:
	$(MAKE) install-backend
	$(MAKE) install-frontend

# Comandos para el frontend (React Native con Expo)
run-frontend:
	cd $(APP_DIR) && npx expo start --port 8084

run-web:
	cd $(APP_DIR) && npx expo start --web --port 8084

# Comandos para el backend (Django)
run-backend:
	$(MANAGE) runserver 0.0.0.0:8000

# Verificar dispositivos Android conectados
connect-android:
	$(ADB)

# Iniciar todo el proyecto en paralelo
start:
	$(MAKE) connect-android
	powershell -Command "Start-Process -NoNewWindow '$(MAKE)' -ArgumentList 'run-backend'"
	powershell -Command "Start-Process -NoNewWindow '$(MAKE)' -ArgumentList 'run-frontend'"

start-web:
	powershell -Command "Start-Process -NoNewWindow '$(MAKE)' -ArgumentList 'run-backend'"
	powershell -Command "Start-Process -NoNewWindow '$(MAKE)' -ArgumentList 'run-web'"

# Limpiar todo (compatible con Windows)
clean:
	rmdir /S /Q $(VENV_DIR)
	cd $(APP_DIR) && rmdir /S /Q node_modules

