#!/usr/bin/env bash
# Personalizes macOS launchd plist files with the actual project path.
# Run once after cloning: bash scripts/setup-macos.sh

set -euo pipefail

NOVA_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "Nova dir: $NOVA_DIR"

for plist in "$NOVA_DIR"/setup/*.plist; do
  if grep -q "/path/to/nova" "$plist"; then
    sed -i '' "s|/path/to/nova|$NOVA_DIR|g" "$plist"
    echo "  Updated: $(basename "$plist")"
  fi
done

echo "Done. Load services with:"
echo "  launchctl load $NOVA_DIR/setup/com.nova.dream.plist"
echo "  launchctl load $NOVA_DIR/setup/com.nova.memwright.plist"
