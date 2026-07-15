# deploy/sandbox/Dockerfile
# Sandbox image for Nova agent task execution (NOVA_SANDBOX_BACKEND=docker).
# Bundles the AI CLIs + mcp2cli so no host binaries are mounted. Build:
#   docker build -t nova-sandbox:latest deploy/sandbox
#
# Pin CLI versions for reproducible builds by passing build args, e.g.:
#   docker build --build-arg CLAUDE_VERSION=1.2.3 -t nova-sandbox:latest deploy/sandbox
FROM oven/bun:1-slim

ARG CLAUDE_VERSION=latest
ARG GEMINI_VERSION=latest
ARG MCP2CLI_VERSION=latest

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

RUN bun install -g \
      @anthropic-ai/claude-code@${CLAUDE_VERSION} \
      @google/gemini-cli@${GEMINI_VERSION} \
      mcp2cli@${MCP2CLI_VERSION}

WORKDIR /workspace
ENV HOME=/workspace
