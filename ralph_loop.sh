#!/bin/bash
set -e

# Always operate relative to this script's location, not wherever it's invoked from
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="ralph-sandbox"
DOCKERFILE=".ralph/Dockerfile"

# Force rebuild with: ralph_loop --build plan
if [ "$1" = "--build" ]; then
    docker build -f "$DOCKERFILE" -t "$IMAGE_NAME" .
    shift
elif ! docker image inspect "$IMAGE_NAME" > /dev/null 2>&1; then
    echo "Image not found — building..."
    docker build -f "$DOCKERFILE" -t "$IMAGE_NAME" .
fi

docker run -it --rm \
    -v "$SCRIPT_DIR":/workspace \
    --env-file .env \
    -w /workspace \
    "$IMAGE_NAME" \
    bash -c 'chmod +x loop.sh && exec ./loop.sh "$@"' bash "$@"