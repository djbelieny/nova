#!/usr/bin/env bash
# Generate standalone CLI binaries for each MCP server using mcporter
# Run after: npm install / pnpm install
# Outputs to: scripts/tools/
# These pre-compiled CLIs eliminate the 2-3 round-trip overhead of mcp2cli discovery

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS_DIR="$SCRIPT_DIR/tools"
mkdir -p "$TOOLS_DIR"

# Check if mcporter is available
if ! command -v mcporter &>/dev/null; then
  echo "[generate-tool-clis] mcporter not found — skipping CLI generation (install with: npm i -g mcporter)"
  exit 0
fi

echo "[generate-tool-clis] Generating tool CLIs..."

# Generate CLI for each MCP server
# Format: mcporter generate-cli <server-command> --output <binary-name>
SERVERS=(
  "notion:node ~/.nvm/versions/node/v23.11.1/lib/node_modules/@notionhq/notion-mcp-server/bin/cli.mjs"
  "clickup:node ~/.nvm/versions/node/v23.11.1/lib/node_modules/@chykalophia/clickup-mcp-server/dist/index.js"
  "zoom:node ~/.nvm/versions/node/v23.11.1/lib/node_modules/@prathamesh0901/zoom-mcp-server/dist/index.js"
  "firecrawl:~/.nvm/versions/node/v23.11.1/bin/firecrawl-mcp"
  "tavily:~/.nvm/versions/node/v23.11.1/bin/tavily-mcp"
  "exa:~/.nvm/versions/node/v23.11.1/bin/exa-mcp-server"
)

for entry in "${SERVERS[@]}"; do
  name="${entry%%:*}"
  cmd="${entry#*:}"
  output="$TOOLS_DIR/${name}-cli"

  echo "  Generating $name CLI → $output"
  mcporter generate-cli "$cmd" --output "$output" || echo "  [WARN] Failed to generate $name CLI — skipping"
done

echo "[generate-tool-clis] Done. Binaries in $TOOLS_DIR/"
echo "  Note: mcporter is pre-1.0 — verify each binary before using in production"
