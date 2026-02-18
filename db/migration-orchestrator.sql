-- Migration: Task Orchestration & Learning System
-- Adds execution_patterns table and parent_task_id to agent_tasks

-- ============================================================
-- EXECUTION PATTERNS TABLE (Learning System)
-- ============================================================
CREATE TABLE IF NOT EXISTS execution_patterns (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  task_signature TEXT NOT NULL,
  plan JSONB NOT NULL,
  success_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0,
  avg_duration_ms FLOAT DEFAULT 0,
  user_id UUID REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_execution_patterns_signature ON execution_patterns(task_signature);
CREATE INDEX IF NOT EXISTS idx_execution_patterns_user ON execution_patterns(user_id);
CREATE INDEX IF NOT EXISTS idx_execution_patterns_success ON execution_patterns(success_count DESC);

-- RLS
ALTER TABLE execution_patterns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON execution_patterns FOR ALL USING (true);

-- ============================================================
-- ADD parent_task_id TO agent_tasks
-- ============================================================
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS parent_task_id UUID REFERENCES agent_tasks(id);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_parent ON agent_tasks(parent_task_id);
