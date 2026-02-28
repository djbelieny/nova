# ============================================================
# Nova — Dockerfile
# ============================================================
# Multi-stage build: install deps first, then copy source.
# Base: Bun runtime + Node.js 22 (for Claude Code CLI).
# ============================================================

# --- Stage 1: Install dependencies ---
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# --- Stage 2: Production image ---
FROM oven/bun:1
WORKDIR /app

# Install Node.js 22 (required for Claude Code CLI) and system deps
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates cron gosu && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    npm install -g @anthropic-ai/claude-code && \
    apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/* /root/.npm

# Create non-root user (Claude CLI blocks --bypassPermissions as root)
RUN groupadd -r nova && useradd -r -g nova -d /home/nova -m nova && \
    mkdir -p /app/.nova /home/nova/.claude

# Copy installed dependencies
COPY --from=deps /app/node_modules ./node_modules

# Copy source code
COPY --chown=nova:nova . .

# Make entrypoint scripts executable
RUN chmod +x docker/scheduler-entrypoint.sh docker/relay-entrypoint.sh 2>/dev/null || true

# Fix permissions on persistent dirs
RUN chown -R nova:nova /app /home/nova

# Expose service ports
#   3034 — Mini App
#   3033 — Dashboard
#   8080 — Voice Server (container-internal; mapped externally)
EXPOSE 3034 3033 8080

# Health check — verify core services are reachable
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD bun run setup/verify.ts || exit 1

# Entrypoint fixes mounted volume permissions then drops to nova user
ENTRYPOINT ["/app/docker/relay-entrypoint.sh"]

# Default: run the relay (main bot process)
CMD ["bun", "run", "src/relay.ts"]
