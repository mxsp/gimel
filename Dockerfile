# syntax=docker/dockerfile:1

# ==============================================================================
# Stage 1: Build all frontend SPAs (Portal /app, Twin Studio /studio,
#          Grundriss /twin, and Agent Lab /lab)
# ==============================================================================
FROM node:20-slim AS web-builder
WORKDIR /src

# Install dependencies first for layer caching
COPY web/package.json web/package-lock.json ./web/
COPY agentlab/web/package.json agentlab/web/package-lock.json ./agentlab/web/
RUN cd /src/web && npm ci --no-audit --no-fund \
 && cd /src/agentlab/web && npm ci --no-audit --no-fund

# Copy frontend sources and build bundles into ../gimel/*/dist and ../agentlab/webapp/dist
COPY web ./web
COPY agentlab/web ./agentlab/web
RUN mkdir -p /src/gimel /src/agentlab/webapp \
 && cd /src/web && npm run build \
 && cd /src/agentlab/web && npm run build

# ==============================================================================
# Stage 2: Python runtime packaging both Playground and Production modes
# ==============================================================================
FROM python:3.12-slim AS runtime
WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    GIMEL_BASE_DATA=/data \
    GIMEL_HOST=0.0.0.0 \
    GIMEL_NO_BROWSER=1 \
    GIMEL_ENABLE_ROBOTS=0

# Install Python package + PostgreSQL driver for production mode
COPY pyproject.toml README.md ./
COPY gimel ./gimel
COPY agentlab ./agentlab
COPY --from=web-builder /src/gimel/webapp/dist ./gimel/webapp/dist
COPY --from=web-builder /src/gimel/studio/dist ./gimel/studio/dist
COPY --from=web-builder /src/gimel/twin/dist ./gimel/twin/dist
COPY --from=web-builder /src/agentlab/webapp/dist ./agentlab/webapp/dist

RUN pip install --no-cache-dir . "psycopg[binary]>=3.2" \
 && useradd --create-home --uid 10001 gimel \
 && mkdir -p /data/playground /data/production \
 && chown -R gimel:gimel /data /app

USER gimel
VOLUME ["/data"]
EXPOSE 8040 8041

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import os, urllib.request; p = os.environ.get('GIMEL_PORT') or ('8041' if os.environ.get('GIMEL_MODE') == 'production' else '8040'); urllib.request.urlopen(f'http://127.0.0.1:{p}/api/health', timeout=3)" || exit 1

ENTRYPOINT ["python", "-m", "gimel.launcher"]
CMD ["--mode", "playground"]
