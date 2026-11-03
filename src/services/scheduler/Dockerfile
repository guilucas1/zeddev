# The scheduler image. Build from the repository root:
#
#     docker build -f src/services/scheduler/Dockerfile -t zeddev-scheduler .
#
# Same shape as the other service images: no compile step (Node 24 runs the
# TypeScript sources directly), nothing tier-specific baked in, and the service
# refuses to start if any value it needs is missing. It listens on no port.

FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY src ./src
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

USER node

# Node as PID 1 receives SIGTERM directly; main.ts stops starting work and lets
# what is in flight finish within SCHEDULER_SHUTDOWN_GRACE.
CMD ["node", "src/services/scheduler/main.ts"]
