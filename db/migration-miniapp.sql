-- Mini App: Persistent approval queue
-- Stores pending approvals so the Telegram Mini App can display and act on them
-- The in-memory map in orchestrator.ts remains the primary source for button callbacks;
-- this table is the secondary source for the Mini App UI.

CREATE TABLE IF NOT EXISTS pending_approvals (
  id TEXT PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  chat_id BIGINT NOT NULL,
  original_text TEXT NOT NULL,
  plan JSONB NOT NULL DEFAULT '{}',
  prepare_summary TEXT DEFAULT '',
  artifacts JSONB NOT NULL DEFAULT '[]',
  execute_descriptions TEXT[] DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'revised', 'cancelled', 'expired')),
  feedback TEXT,
  parent_task_id UUID REFERENCES agent_tasks(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pending_approvals_user ON pending_approvals(user_id);
CREATE INDEX IF NOT EXISTS idx_pending_approvals_status ON pending_approvals(status);

-- User preferences table for Mini App profile management
-- Extends the existing users table with editable preferences
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  voice_responses BOOLEAN DEFAULT false,
  notification_style TEXT DEFAULT 'normal' CHECK (notification_style IN ('minimal', 'normal', 'detailed')),
  language TEXT DEFAULT 'en',
  auto_approve BOOLEAN DEFAULT false,
  theme TEXT DEFAULT 'auto' CHECK (theme IN ('auto', 'light', 'dark')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
