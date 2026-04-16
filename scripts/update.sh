#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "Pulling latest..."
git pull origin main

echo "Rebuilding images..."
docker compose build

# Load profile setting if .env exists
USE_FULL_PROFILE=false
if [ -f .env ]; then
  USE_FULL_PROFILE=$(grep "^USE_FULL_PROFILE=" .env 2>/dev/null | cut -d= -f2 | tr -d '"' || echo "false")
fi

echo "Restarting services..."
if [ "$USE_FULL_PROFILE" = "true" ]; then
  docker compose --profile full up -d
else
  docker compose up -d
fi

echo "Updated to: $(git log -1 --format='%h %s')"
echo "Check status: docker compose ps"
