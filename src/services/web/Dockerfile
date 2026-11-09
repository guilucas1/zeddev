# The dashboard image. Build from the repository root:
#
#     docker build -f src/services/web/Dockerfile -t zeddev-web .
#
# Same shape as the other service images: no compile step, nothing tier-specific
# baked in, and the service refuses to start if a value it needs is missing. The
# browser modules are type-stripped once at startup from the sources in this
# image, so what a browser runs is derived from exactly these bytes.

FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY src ./src
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

USER node

EXPOSE 8082

# Node as PID 1 receives SIGTERM directly; main.ts drains within WEB_SHUTDOWN_GRACE.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/services/web/main.ts"]
