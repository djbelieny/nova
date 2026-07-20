-- Migration: Add WhatsApp and Slack identifiers to users table
-- Run this after the base schema is in place.

ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS slack_id TEXT;

CREATE INDEX IF NOT EXISTS idx_users_whatsapp_id ON users(whatsapp_id);
CREATE INDEX IF NOT EXISTS idx_users_slack_id ON users(slack_id);

-- Helper functions for user lookup by platform ID
CREATE OR REPLACE FUNCTION get_user_by_whatsapp_id(p_whatsapp_id TEXT)
RETURNS SETOF users
LANGUAGE sql STABLE
AS $$
  SELECT * FROM users WHERE whatsapp_id = p_whatsapp_id LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION get_user_by_slack_id(p_slack_id TEXT)
RETURNS SETOF users
LANGUAGE sql STABLE
AS $$
  SELECT * FROM users WHERE slack_id = p_slack_id LIMIT 1;
$$;
