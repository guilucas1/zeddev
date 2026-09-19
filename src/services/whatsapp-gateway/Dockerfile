# The WhatsApp gateway image. Build from the repository root:
#
#     docker build -f src/services/whatsapp-gateway/Dockerfile -t zeddev-whatsapp-gateway .
#
# Same shape as the API image, for the same reasons: no compile step (Node 24
# runs the TypeScript sources directly), nothing tier-specific baked in, and the
# service refuses to start if any value it needs is missing.

FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY src ./src
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

USER node

EXPOSE 8081

# Node as PID 1 receives SIGTERM directly; main.ts stops accepting and lets
# in-flight notifications finish within GATEWAY_SHUTDOWN_GRACE. One cut short was
# never acknowledged, so Meta redelivers it.
CMD ["node", "src/services/whatsapp-gateway/main.ts"]
