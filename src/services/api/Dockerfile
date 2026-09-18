# The API service image. Build from the repository root:
#
#     docker build -f src/services/api/Dockerfile -t zeddev-api .
#
# There is no compile step: Node 24 runs the TypeScript sources directly, so the
# source tree *is* the artifact, and environment-portability.md's "same artifact
# on every tier" means exactly this image with different environment values.
# Nothing tier-specific is baked in — every value comes from the environment at
# run time, and the service refuses to start if one is missing.

FROM node:24-alpine

WORKDIR /app

# Manifests first, so the dependency layer is reused when only sources change.
# The platform has no third-party runtime dependencies; `npm ci` is here to link
# the @zeddev/* workspace packages, and --omit=dev leaves out the typechecker.
COPY package.json package-lock.json ./
COPY src ./src
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

# Not root: the service needs no privilege, and a compromise of it should not
# start with one.
USER node

EXPOSE 8080

# Node as PID 1 receives SIGTERM directly; main.ts handles it by draining
# in-flight requests and queued mail within API_SHUTDOWN_GRACE.
CMD ["node", "src/services/api/main.ts"]
