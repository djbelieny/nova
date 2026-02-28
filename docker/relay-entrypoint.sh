#!/bin/sh
# Fix ownership of mounted .claude directory so nova user can write to it.
# This runs as root, then drops to nova via exec su-exec/gosu.
if [ -d /home/nova/.claude ]; then
  chown -R nova:nova /home/nova/.claude 2>/dev/null || true
fi
exec gosu nova "$@"
