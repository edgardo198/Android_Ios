FROM node:24-alpine AS web
WORKDIR /web
COPY App/package.json App/package-lock.json ./
RUN npm ci
COPY App/ ./
ENV EXPO_PUBLIC_API_SAME_ORIGIN=true
# The web client uses this service's HTTPS origin for REST and WebSockets.
ENV EXPO_PUBLIC_API_URL=""
# Keep Metro within the free builder's memory budget.
RUN NODE_OPTIONS=--max-old-space-size=2048 npx expo export --platform web --max-workers 1 --output-dir dist

FROM python:3.12-slim AS dependencies
WORKDIR /build
COPY api/requirements.txt ./
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends nginx \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=dependencies /install /usr/local
COPY api/ ./
COPY --from=web /web/dist /usr/share/nginx/html
COPY scripts/render/nginx.conf /etc/nginx/nginx.conf
COPY scripts/render/start.sh /app/render-start.sh
EXPOSE 10000
CMD ["bash", "/app/render-start.sh"]
