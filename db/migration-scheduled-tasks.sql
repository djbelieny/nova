-- Scheduled Tasks Migration
-- Enables proactive scheduling: reminders, recurring tasks, and Nova self-scheduled follow-ups.
-- Run this in Supabase SQL Editor or via Supabase MCP.

-- ============================================================
-- SCHEDULED TASKS TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  user_id UUID NOT NULL REFERENCES users(id),
  created_by TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user', 'nova')),
  title TEXT NOT NULL,
  instructions TEXT NOT NULL,
  trigger_at TIMESTAMPTZ,
  recurrence TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  condition TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'cancelled', 'failed')),
  last_run_at TIMESTAMPTZ,
  last_result TEXT,
  run_count INTEGER DEFAULT 0,
  max_runs INTEGER,
  expires_at TIMESTAMPTZ,
  notify_user BOOLEAN DEFAULT true,
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due
  ON scheduled_tasks(trigger_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_user
  ON scheduled_tasks(user_id, status);

-- RLS
ALTER TABLE scheduled_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON scheduled_tasks FOR ALL USING (true);

-- ============================================================
-- RPC: Get due tasks (for dispatcher)
-- ============================================================

CREATE OR REPLACE FUNCTION get_due_tasks()
RETURNS TABLE (
  id UUID,
  user_id UUID,
  created_by TEXT,
  title TEXT,
  instructions TEXT,
  trigger_at TIMESTAMPTZ,
  recurrence TEXT,
  timezone TEXT,
  condition TEXT,
  max_runs INTEGER,
  run_count INTEGER,
  metadata JSONB
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    st.id, st.user_id, st.created_by, st.title, st.instructions,
    st.trigger_at, st.recurrence, st.timezone, st.condition,
    st.max_runs, st.run_count, st.metadata
  FROM scheduled_tasks st
  WHERE st.status = 'active'
    AND st.trigger_at <= NOW()
    AND (st.expires_at IS NULL OR st.expires_at > NOW())
  ORDER BY st.trigger_at ASC
  LIMIT 10;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- RPC: Get scheduled tasks for a user (for context injection)
-- ============================================================

CREATE OR REPLACE FUNCTION get_scheduled_tasks(p_user_id UUID)
RETURNS TABLE (
  id UUID,
  title TEXT,
  trigger_at TIMESTAMPTZ,
  recurrence TEXT,
  timezone TEXT,
  created_by TEXT,
  status TEXT,
  condition TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    st.id, st.title, st.trigger_at, st.recurrence,
    st.timezone, st.created_by, st.status, st.condition
  FROM scheduled_tasks st
  WHERE st.user_id = p_user_id
    AND st.status = 'active'
  ORDER BY st.trigger_at ASC;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- RPC: Get user info for dispatcher (telegram_id + timezone + name)
-- ============================================================

CREATE OR REPLACE FUNCTION get_user_for_dispatch(p_user_id UUID)
RETURNS TABLE (
  id UUID,
  telegram_id TEXT,
  name TEXT,
  timezone TEXT,
  profile_text TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT u.id, u.telegram_id, u.name, u.timezone, u.profile_text
  FROM users u
  WHERE u.id = p_user_id
  LIMIT 1;
END;
$$ LANGUAGE plpgsql;
