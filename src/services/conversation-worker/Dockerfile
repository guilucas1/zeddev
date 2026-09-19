# The conversation worker image. Build from the repository root:
#
#     docker build -f src/services/conversation-worker/Dockerfile -t zeddev-conversation-worker .
#
# Same shape as the API and gateway images: no compile step (Node 24 runs the
# TypeScript sources directly), nothing tier-specific baked in, and the service
# refuses to start if any value it needs is missing. It listens on no port: its
# only input is the job queue in PostgreSQL.

FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY src ./src
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

USER node

# Node as PID 1 receives SIGTERM directly; main.ts stops claiming and lets
# in-flight jobs finish within WORKER_SHUTDOWN_GRACE. One cut short is not lost:
# its lease expires and another worker runs it again.
CMD ["node", "src/services/conversation-worker/main.ts"]
