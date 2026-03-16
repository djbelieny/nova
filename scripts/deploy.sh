#!/bin/bash
# Nova production deployment script
# Usage: bash /opt/nova/scripts/deploy.sh
set -euo pipefail

cd /opt/nova

echo "Pulling latest production branch..."
sudo -u nova git pull origin production

echo "Installing dependencies..."
bun install

# Ensure mcp2cli is available (exec nodes use it for on-demand MCP tool access
# instead of spawning persistent MCP server processes)
if ! command -v mcp2cli &>/dev/null; then
  echo "Installing mcp2cli globally..."
  npm install -g mcp2cli
fi

# Ensure gws CLI is available (replaces @presto-ai/google-workspace-mcp)
if ! command -v gws &>/dev/null; then
  echo "Installing gws CLI globally..."
  npm install -g @anthropic-ai/gws
fi

# Migrate from Supabase if credentials are set and shared.db doesn't exist yet
if [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_ANON_KEY:-}" ] && [ ! -f /opt/nova/data/shared.db ]; then
  echo "Running Supabase → SQLite migration..."
  bun run migrate:supabase
fi

# Ensure nova user owns data and user directories
echo "Fixing file ownership..."
chown -R nova:nova /opt/nova/.nova /opt/nova/data 2>/dev/null || true

# Install/update cron schedule and restart cron service
if [ -f /opt/nova/config/nova.cron ]; then
  echo "Updating cron schedule..."
  cp /opt/nova/config/nova.cron /etc/cron.d/nova
  chmod 644 /etc/cron.d/nova
  chown root:root /etc/cron.d/nova
  echo "Reloading cron daemon..."
  service cron reload
fi

echo "Restarting services..."
systemctl restart nova-relay nova-voice nova-dashboard nova-miniapp

# Restart executive services with staggered delays to avoid resource storm.
# Order: no-MCP execs first, then MCP-enabled execs last.
EXEC_SERVICES="nova-exec-coo nova-exec-critic nova-exec-ceo nova-exec-cfo nova-exec-cmo nova-exec-cto nova-exec-research"
for svc in $EXEC_SERVICES; do
  if systemctl is-enabled "$svc" &>/dev/null; then
    systemctl restart "$svc"
    echo "  Restarted $svc"
    sleep 5  # stagger to avoid CPU/RAM storm from concurrent MCP spawns
  fi
done

echo "Deployed: $(sudo -u nova git log -1 --format='%h %s')"
echo "Services restarted. Check status with: systemctl status nova-relay nova-voice nova-dashboard nova-miniapp nova-exec-*"
