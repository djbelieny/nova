#!/bin/bash
# Runs first (alphabetically before 001_executive_board.sql) during Postgres init.
# Creates the PostgREST role trio:
#   - nova_board       : the single trusted role. BYPASSRLS so it can read/write the
#                        board tables, whose migration enables RLS with no policies.
#   - nova_board_anon  : locked-down role for unauthenticated requests (no grants).
#   - authenticator    : login role PostgREST connects as, then SET ROLE into the
#                        role named in the request JWT's "role" claim.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
  CREATE ROLE nova_board NOLOGIN BYPASSRLS;
  CREATE ROLE nova_board_anon NOLOGIN;
  CREATE ROLE authenticator NOINHERIT LOGIN PASSWORD '${AUTHENTICATOR_PASSWORD}';
  GRANT nova_board TO authenticator;
  GRANT nova_board_anon TO authenticator;
SQL
