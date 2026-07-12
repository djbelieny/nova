#!/bin/bash
# One-time setup for executive node systemd services
# Usage: sudo bash /opt/nova/scripts/setup-execs.sh
set -euo pipefail

EXEC_ROLES="ceo cfo cmo cto coo research critic"

echo "Installing executive systemd services..."

for role in $EXEC_ROLES; do
  src="/opt/nova/daemon/nova-exec-${role}.service"
  dst="/etc/systemd/system/nova-exec-${role}.service"

  if [ ! -f "$src" ]; then
    echo "ERROR: $src not found"
    exit 1
  fi

  cp "$src" "$dst"
  echo "  Installed nova-exec-${role}.service"
done

# Install systemd resource limit drop-ins to prevent any single exec from OOM-ing the box
echo ""
echo "Installing resource limit overrides..."
for role in $EXEC_ROLES; do
  override_dir="/etc/systemd/system/nova-exec-${role}.service.d"
  mkdir -p "$override_dir"
  cat > "${override_dir}/limits.conf" <<'LIMITS'
[Service]
CPUQuota=50%
MemoryMax=1G
TasksMax=30
LIMITS
  echo "  Resource limits for nova-exec-${role}"
done

echo ""
echo "Reloading systemd daemon..."
systemctl daemon-reload

echo "Enabling services for boot persistence..."
for role in $EXEC_ROLES; do
  systemctl enable "nova-exec-${role}"
done

echo ""
echo "=== Setup complete ==="
echo ""
echo "IMPORTANT: Before starting the services, ensure each .env.{role} file"
echo "exists at /opt/nova/ with the correct TELEGRAM_BOT_TOKEN and API keys."
echo ""
echo "Required .env files:"
for role in $EXEC_ROLES; do
  if [ -f "/opt/nova/.env.${role}" ]; then
    echo "  .env.${role}  ✓"
  else
    echo "  .env.${role}  ✗ MISSING"
  fi
done
echo ""
echo "To start all executive services:"
echo "  systemctl start nova-exec-ceo nova-exec-cfo nova-exec-cmo nova-exec-cto nova-exec-coo nova-exec-research nova-exec-critic"
echo ""
echo "To check status:"
echo "  systemctl status nova-exec-*"
