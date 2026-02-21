FROM oven/bun:1 AS base
WORKDIR /app

# Install Node.js (needed for Claude Code CLI)
RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g @anthropic-ai/claude-code && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source
COPY . .

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD bun run setup/verify.ts || exit 1

# Default command
CMD ["bun", "run", "src/relay.ts"]
