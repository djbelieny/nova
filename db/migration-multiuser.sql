-- ============================================================
-- Multi-User Migration
-- ============================================================
-- Adds multi-user support to Nova. Run this AFTER stopping the relay.
-- Deploy the updated TypeScript code simultaneously — old zero-arg RPCs
-- will be replaced, so old code calling get_facts() without args will break.
--
-- Steps: stop relay → run this migration → deploy new code → restart relay
-- ============================================================

-- ============================================================
-- 1A. USERS TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  telegram_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  timezone TEXT DEFAULT 'UTC',
  phone TEXT,
  pin TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  preferences JSONB DEFAULT '{"proactive_checkin":true,"morning_briefing":true,"briefing_hour":9,"voice_responses":false}',
  profile_text TEXT DEFAULT '',
  active BOOLEAN DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL;

-- Seed DJ as admin (update telegram_id, phone, pin, and profile_text to match your .env)
INSERT INTO users (telegram_id, name, timezone, phone, pin, role, profile_text)
VALUES (
  '7778536301',
  'DJ',
  'America/New_York',
  '+18636047056',
  '852185',
  'admin',
  '## About You

- **Name:** DJ
- **Timezone:** America/New_York
- **Occupation:** Multi-business entrepreneur — AI mentorship, software development, digital product creation

## Constraints

- Mornings until 8am are reserved for personal and family time — do not disturb
- Available for work after 8am ET

## Contact

- **Phone:** +18636047056 (personal cell — use for calls and SMS via Twilio)

## Communication Style

- Keep it brief and casual by default
- When there''s an issue or an important decision, provide more detail
- No fluff — get to the point'
)
ON CONFLICT (telegram_id) DO NOTHING;

-- ============================================================
-- 1B. ADD user_id AND scope COLUMNS
-- ============================================================

-- messages
ALTER TABLE messages ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);

-- memory
ALTER TABLE memory ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);
ALTER TABLE memory ADD COLUMN IF NOT EXISTS scope TEXT DEFAULT 'private' CHECK (scope IN ('private', 'shared'));

-- logs
ALTER TABLE logs ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);

-- agent_tasks
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);

-- cost_tracking
ALTER TABLE cost_tracking ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);

-- ============================================================
-- 1C. BACKFILL EXISTING DATA
-- ============================================================

-- Set all existing rows to DJ's user ID
UPDATE messages SET user_id = (SELECT id FROM users WHERE telegram_id = '7778536301') WHERE user_id IS NULL;
UPDATE memory SET user_id = (SELECT id FROM users WHERE telegram_id = '7778536301') WHERE user_id IS NULL;
UPDATE logs SET user_id = (SELECT id FROM users WHERE telegram_id = '7778536301') WHERE user_id IS NULL;
UPDATE agent_tasks SET user_id = (SELECT id FROM users WHERE telegram_id = '7778536301') WHERE user_id IS NULL;
UPDATE cost_tracking SET user_id = (SELECT id FROM users WHERE telegram_id = '7778536301') WHERE user_id IS NULL;

-- Make user_id NOT NULL now that all rows are backfilled
ALTER TABLE messages ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE memory ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE logs ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE agent_tasks ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE cost_tracking ALTER COLUMN user_id SET NOT NULL;

-- ============================================================
-- 1B (cont). COMPOSITE INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_messages_user_created ON messages(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_user_created ON memory(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory(scope);
CREATE INDEX IF NOT EXISTS idx_logs_user_created ON logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_user_created ON agent_tasks(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cost_tracking_user_created ON cost_tracking(user_id, created_at DESC);

-- ============================================================
-- 1D. UPDATED RPC FUNCTIONS (replace old zero-arg versions)
-- ============================================================

-- Enable RLS on users table
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON users FOR ALL USING (true);

-- Get user by Telegram ID
CREATE OR REPLACE FUNCTION get_user_by_telegram_id(p_telegram_id TEXT)
RETURNS SETOF users AS $$
  SELECT * FROM users WHERE telegram_id = p_telegram_id AND active = true LIMIT 1;
$$ LANGUAGE sql;

-- Get user by phone number
CREATE OR REPLACE FUNCTION get_user_by_phone(p_phone TEXT)
RETURNS SETOF users AS $$
  SELECT * FROM users WHERE phone = p_phone AND active = true LIMIT 1;
$$ LANGUAGE sql;

-- Update a single user preference key
CREATE OR REPLACE FUNCTION update_user_preference(p_user_id UUID, p_key TEXT, p_value JSONB)
RETURNS void AS $$
BEGIN
  UPDATE users
  SET preferences = jsonb_set(COALESCE(preferences, '{}'), ARRAY[p_key], p_value),
      updated_at = NOW()
  WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql;

-- Get recent messages for a specific user
CREATE OR REPLACE FUNCTION get_recent_messages(p_user_id UUID, limit_count INTEGER DEFAULT 20)
RETURNS TABLE (
  id UUID,
  created_at TIMESTAMPTZ,
  role TEXT,
  content TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.created_at, m.role, m.content
  FROM messages m
  WHERE m.user_id = p_user_id
  ORDER BY m.created_at DESC
  LIMIT limit_count;
END;
$$ LANGUAGE plpgsql;

-- Get active goals for a specific user
CREATE OR REPLACE FUNCTION get_active_goals(p_user_id UUID)
RETURNS TABLE (
  id UUID,
  content TEXT,
  deadline TIMESTAMPTZ,
  priority INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.content, m.deadline, m.priority
  FROM memory m
  WHERE m.type = 'goal' AND m.user_id = p_user_id
  ORDER BY m.priority DESC, m.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- Get facts for a specific user (includes shared facts)
CREATE OR REPLACE FUNCTION get_facts(p_user_id UUID)
RETURNS TABLE (
  id UUID,
  content TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.content
  FROM memory m
  WHERE m.type = 'fact'
    AND (m.user_id = p_user_id OR m.scope = 'shared')
  ORDER BY m.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- Active tasks for a specific user
CREATE OR REPLACE FUNCTION get_active_tasks(p_user_id UUID)
RETURNS SETOF agent_tasks AS $$
  SELECT * FROM agent_tasks
  WHERE status IN ('pending','in_progress','blocked')
    AND user_id = p_user_id
  ORDER BY created_at DESC;
$$ LANGUAGE sql;

-- Recent tasks for a specific user
CREATE OR REPLACE FUNCTION get_recent_tasks(p_user_id UUID, limit_count INTEGER DEFAULT 30)
RETURNS SETOF agent_tasks AS $$
  SELECT * FROM agent_tasks
  WHERE user_id = p_user_id
  ORDER BY updated_at DESC
  LIMIT limit_count;
$$ LANGUAGE sql;

-- Match messages by embedding similarity (user-scoped)
CREATE OR REPLACE FUNCTION match_messages(
  query_embedding VECTOR(1536),
  p_user_id UUID,
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  role TEXT,
  created_at TIMESTAMPTZ,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m.role,
    m.created_at,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM messages m
  WHERE m.embedding IS NOT NULL
    AND m.user_id = p_user_id
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- Match memory entries by embedding similarity (user-scoped + shared)
CREATE OR REPLACE FUNCTION match_memory(
  query_embedding VECTOR(1536),
  p_user_id UUID,
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  type TEXT,
  created_at TIMESTAMPTZ,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m.type,
    m.created_at,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM memory m
  WHERE m.embedding IS NOT NULL
    AND (m.user_id = p_user_id OR m.scope = 'shared')
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;
