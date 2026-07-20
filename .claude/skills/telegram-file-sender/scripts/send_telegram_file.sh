#!/bin/bash
# Send a file as a document attachment via Telegram Bot API
# Usage: send_telegram_file.sh <file_path> [caption]
#
# Environment variables required:
#   TELEGRAM_BOT_TOKEN - Bot token from @BotFather
#   TELEGRAM_USER_ID   - Recipient's Telegram user ID

set -euo pipefail

FILE_PATH="${1:?Usage: send_telegram_file.sh <file_path> [caption]}"
CAPTION="${2:-}"
BOT_TOKEN="${TELEGRAM_BOT_TOKEN:?TELEGRAM_BOT_TOKEN not set}"
CHAT_ID="${TELEGRAM_USER_ID:?TELEGRAM_USER_ID not set}"

if [ ! -f "$FILE_PATH" ]; then
  echo "Error: File not found: $FILE_PATH" >&2
  exit 1
fi

# Check file size (Telegram limit: 50MB for bots)
FILE_SIZE=$(stat -f%z "$FILE_PATH" 2>/dev/null || stat -c%s "$FILE_PATH" 2>/dev/null)
MAX_SIZE=$((50 * 1024 * 1024))
if [ "$FILE_SIZE" -gt "$MAX_SIZE" ]; then
  echo "Error: File exceeds Telegram's 50MB limit ($(( FILE_SIZE / 1024 / 1024 ))MB)" >&2
  exit 1
fi

API_URL="https://api.telegram.org/bot${BOT_TOKEN}/sendDocument"

if [ -n "$CAPTION" ]; then
  RESPONSE=$(curl -s -X POST "$API_URL" \
    -F "chat_id=$CHAT_ID" \
    -F "document=@$FILE_PATH" \
    -F "caption=$CAPTION" \
    -F "parse_mode=Markdown")
else
  RESPONSE=$(curl -s -X POST "$API_URL" \
    -F "chat_id=$CHAT_ID" \
    -F "document=@$FILE_PATH")
fi

# Check if the request was successful
OK=$(echo "$RESPONSE" | grep -o '"ok":true' || true)
if [ -n "$OK" ]; then
  echo "File sent successfully: $(basename "$FILE_PATH")"
else
  ERROR=$(echo "$RESPONSE" | grep -o '"description":"[^"]*"' | head -1 || echo "$RESPONSE")
  echo "Error sending file: $ERROR" >&2
  exit 1
fi
