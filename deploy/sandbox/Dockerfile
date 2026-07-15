# deploy/sandbox/Dockerfile
# Sandbox image for Nova agent task execution (NOVA_SANDBOX_BACKEND=docker).
# Bundles the AI CLIs + mcp2cli so no host binaries are mounted. Build:
#   docker build -t nova-sandbox:latest deploy/sandbox
#
# Pin versions for reproducible builds by passing build args, e.g.:
#   docker build --build-arg CLAUDE_VERSION=1.2.3 -t nova-sandbox:latest deploy/sandbox
FROM oven/bun:1-slim

# claude-code and gemini-cli are npm packages; mcp2cli is a PyPI package.
ARG CLAUDE_VERSION=latest
ARG GEMINI_VERSION=latest
ARG MCP2CLI_VERSION=1.6.0

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN bun install -g \
      @anthropic-ai/claude-code@${CLAUDE_VERSION} \
      @google/gemini-cli@${GEMINI_VERSION}

# Debian marks the system Python externally-managed (PEP 668); this is a
# single-purpose image, so installing into it directly is fine.
RUN pip3 install --no-cache-dir --break-system-packages "mcp2cli==${MCP2CLI_VERSION}"

WORKDIR /workspace
ENV HOME=/workspace
