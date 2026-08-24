FROM node:20-bookworm
RUN apt-get update && apt-get install -y git curl jq ripgrep && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code
WORKDIR /workspace