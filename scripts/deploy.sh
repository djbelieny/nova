#!/bin/bash
# Nova production deployment script
# Usage: bash /opt/nova/scripts/deploy.sh
set -euo pipefail

cd /opt/nova

echo "Pulling latest production branch..."
sudo -u nova git pull origin production

echo "Installing dependencies..."
bun install

echo "Restarting services..."
systemctl restart nova-relay nova-voice nova-dashboard nova-miniapp

echo "Deployed: $(sudo -u nova git log -1 --format='%h %s')"
echo "Services restarted. Check status with: systemctl status nova-relay nova-voice nova-dashboard nova-miniapp"
