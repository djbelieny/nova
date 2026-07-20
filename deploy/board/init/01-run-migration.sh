#!/bin/bash
# Runs after 00-roles.sh, before 02-grants.sql. Applies the shared board migration
# (mounted read-only at /migrations to avoid a nested bind mount inside the initdb dir).
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -f /migrations/001_executive_board.sql
