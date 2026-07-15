# deploy/sandbox/Dockerfile
# Sandbox image for Nova agent task execution (NOVA_SANDBOX_BACKEND=docker).
# Bundles the AI CLIs so no host binaries are mounted. Build:
#   docker build -t nova-sandbox:latest deploy/sandbox
FROM oven/bun:1-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

RUN bun install -g @anthropic-ai/claude-code @google/gemini-cli

WORKDIR /workspace
ENV HOME=/workspace
