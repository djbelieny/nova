#!/bin/bash
# Start the Memwright memory service for Nova
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="${MEMWRIGHT_DATA_DIR:-$PROJECT_DIR/data/memwright}"

mkdir -p "$DATA_DIR"

echo "[memwright] Starting on http://127.0.0.1:8765"
echo "[memwright] Data dir: $DATA_DIR"

MEMWRIGHT_DATA_DIR="$DATA_DIR" uvicorn agent_memory.api:app \
  --host 127.0.0.1 \
  --port 8765 \
  --reload
