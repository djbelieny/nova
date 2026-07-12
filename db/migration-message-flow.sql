-- Message Flow Tracking & Revision Session Persistence
-- Tracks the full flow: user message → task group → approval → execution
-- Ensures approvals and revision sessions never expire and survive restarts.

-- Add flow tracking columns to pending_approvals
ALTER TABLE pending_approvals ADD COLUMN IF NOT EXISTS workspace_dir TEXT;
ALTER TABLE pending_approvals ADD COLUMN IF NOT EXISTS workflow_type TEXT DEFAULT 'generic';
ALTER TABLE pending_approvals ADD COLUMN IF NOT EXISTS request_id TEXT;
ALTER TABLE pending_approvals ADD COLUMN IF NOT EXISTS prepare_results JSONB DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_pending_approvals_request ON pending_approvals(request_id);

-- Add request_id to agent_tasks for message-to-task linking
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS request_id TEXT;
CREATE INDEX IF NOT EXISTS idx_agent_tasks_request ON agent_tasks(request_id);

-- Revision sessions — persisted so they survive restarts and long delays
CREATE TABLE IF NOT EXISTS revision_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  original_text TEXT NOT NULL,
  plan JSONB NOT NULL DEFAULT '{}',
  prepare_results JSONB NOT NULL DEFAULT '[]',
  artifacts JSONB NOT NULL DEFAULT '[]',
  parent_task_id UUID REFERENCES agent_tasks(id),
  workspace_dir TEXT,
  workflow_type TEXT DEFAULT 'generic',
  request_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id)  -- one active revision session per user
);

CREATE INDEX IF NOT EXISTS idx_revision_sessions_user ON revision_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_revision_sessions_status ON revision_sessions(status);
