#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "Pulling latest..."
git pull origin main

echo "Rebuilding images..."
docker compose build --no-cache

echo "Restarting services..."
docker compose up -d

echo "Updated to: $(git log -1 --format='%h %s')"
echo "Check status: docker compose ps"
