-- Migration: Support multiple concurrent revision sessions per user
-- Previously limited to one revision session per user via UNIQUE(user_id).
-- Now supports multiple, keyed by session ID, so concurrent task flows
-- don't overwrite each other's revision context.

-- Drop the unique constraint on user_id (allows multiple pending sessions per user)
ALTER TABLE revision_sessions DROP CONSTRAINT IF EXISTS revision_sessions_user_id_key;

-- Add index for efficient lookup by user + status (replaces unique constraint)
CREATE INDEX IF NOT EXISTS idx_revision_sessions_user_status ON revision_sessions(user_id, status);
