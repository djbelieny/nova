FROM oven/bun:1.3-slim
WORKDIR /app

# System deps
RUN apt-get update && apt-get install -y \
    python3 python3-pip curl git build-essential \
    # Playwright browser dependencies
    chromium libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxrandr2 libgbm1 libasound2t64 libpangocairo-1.0-0 libpango-1.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Install claude CLI — works with ANTHROPIC_API_KEY or mounted OAuth credentials
# Use npm (bundled with nodejs) for packages that need postinstall scripts
RUN apt-get update && apt-get install -y nodejs npm && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code

# Install gws CLI — Google Workspace CLI
RUN bun install -g @googleworkspace/cli

# Install Python packages: memwright (memory service MCP) + mcp2cli (on-demand MCP bridge)
RUN pip3 install memwright mcp2cli --break-system-packages

# Install project dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Pre-install Playwright Chromium browser
RUN bunx playwright install chromium

# Copy source
COPY . .

# Default command — overridden per-service in docker-compose.yml
CMD ["bun", "run", "src/relay.ts"]
