-- Runs last (after 001_executive_board.sql created the tables/functions).
-- Grants the trusted nova_board role full access to the board schema. RLS is
-- still enabled on the tables, but nova_board bypasses it (BYPASSRLS in 00-roles.sh).
GRANT USAGE ON SCHEMA public TO nova_board;
GRANT ALL ON ALL TABLES IN SCHEMA public TO nova_board;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO nova_board;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO nova_board;

-- Future-proof: same defaults for anything created later in this schema.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO nova_board;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO nova_board;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO nova_board;
