#!/usr/bin/env bash
set -euo pipefail

: "${SECRET_KEY:?Render must provide SECRET_KEY}"
: "${DATABASE_URL:?Render must provide DATABASE_URL}"
: "${REDIS_URL:?Render must provide REDIS_URL}"
: "${RENDER_EXTERNAL_HOSTNAME:?Render must provide its public hostname}"
export DEBUG=false

# Free instances have no pre-deploy command or interactive shell.
python manage.py migrate --noinput
python manage.py collectstatic --noinput
mkdir -p /app/media/miniatura
nginx -t

pids=()
cleanup() {
    trap - TERM INT EXIT
    kill -TERM "${pids[@]}" 2>/dev/null || true
    wait "${pids[@]}" 2>/dev/null || true
}
trap cleanup TERM INT EXIT

# Keep the expiry loop in this free service; workers require a paid instance.
python manage.py expire_calls --loop &
pids+=("$!")
daphne -v 0 -b 127.0.0.1 -p 8000 api.asgi:application &
pids+=("$!")
nginx -g 'daemon off;' &
pids+=("$!")

# Restart the whole container if any required process exits, even successfully.
set +e
wait -n "${pids[@]}"
exit 1
