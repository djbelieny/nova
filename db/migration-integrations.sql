-- Migration: Per-user integrations + Nova status table
-- Run this in Supabase SQL Editor (or via Supabase MCP)

-- ============================================================
-- USER INTEGRATIONS TABLE
-- ============================================================
-- Stores OAuth tokens and status for per-user MCP integrations
-- (Google Personal, Google Work, Notion, Zoom)

CREATE TABLE IF NOT EXISTS user_integrations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  user_id UUID NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,          -- 'google-personal', 'google-work', 'notion', 'zoom'
  status TEXT NOT NULL DEFAULT 'disconnected'
    CHECK (status IN ('disconnected', 'pending', 'connected', 'error')),
  credentials JSONB DEFAULT '{}',  -- encrypted tokens/keys (provider-specific)
  metadata JSONB DEFAULT '{}',     -- account email, display name, etc.
  UNIQUE(user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_user_integrations_user ON user_integrations(user_id);
CREATE INDEX IF NOT EXISTS idx_user_integrations_provider ON user_integrations(provider);

ALTER TABLE user_integrations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON user_integrations FOR ALL USING (true);

-- ============================================================
-- NOVA STATUS TABLE (single-row, updated by relay)
-- ============================================================
-- Mini App dashboard reads this for live stats

CREATE TABLE IF NOT EXISTS nova_status (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- single row
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  uptime_since TIMESTAMPTZ DEFAULT NOW(),
  calls_total INTEGER DEFAULT 0,
  calls_success INTEGER DEFAULT 0,
  calls_failed INTEGER DEFAULT 0,
  calls_by_model JSONB DEFAULT '{}',
  rate_limit_hits INTEGER DEFAULT 0,
  last_rate_limit_at TIMESTAMPTZ,
  avg_duration_ms DOUBLE PRECISION DEFAULT 0,
  active_slots INTEGER DEFAULT 0,
  max_slots INTEGER DEFAULT 2,
  queue_depth INTEGER DEFAULT 0,
  active_tasks INTEGER DEFAULT 0,
  pending_approvals INTEGER DEFAULT 0
);

ALTER TABLE nova_status ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON nova_status FOR ALL USING (true);

-- Insert the single status row
INSERT INTO nova_status (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- RPC: Get user integrations
-- ============================================================

CREATE OR REPLACE FUNCTION get_user_integrations(p_user_id UUID)
RETURNS TABLE (
  id UUID,
  provider TEXT,
  status TEXT,
  metadata JSONB,
  updated_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    ui.id,
    ui.provider,
    ui.status,
    ui.metadata,
    ui.updated_at
  FROM user_integrations ui
  WHERE ui.user_id = p_user_id
  ORDER BY ui.provider;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- RPC: Upsert user integration
-- ============================================================

CREATE OR REPLACE FUNCTION upsert_user_integration(
  p_user_id UUID,
  p_provider TEXT,
  p_status TEXT,
  p_credentials JSONB DEFAULT '{}',
  p_metadata JSONB DEFAULT '{}'
)
RETURNS UUID AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO user_integrations (user_id, provider, status, credentials, metadata, updated_at)
  VALUES (p_user_id, p_provider, p_status, p_credentials, p_metadata, NOW())
  ON CONFLICT (user_id, provider) DO UPDATE SET
    status = EXCLUDED.status,
    credentials = CASE WHEN EXCLUDED.credentials = '{}'::JSONB THEN user_integrations.credentials ELSE EXCLUDED.credentials END,
    metadata = CASE WHEN EXCLUDED.metadata = '{}'::JSONB THEN user_integrations.metadata ELSE EXCLUDED.metadata END,
    updated_at = NOW()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql;
