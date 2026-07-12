-- Migration: Task Artifacts Registry
-- Tracks files and deliverables produced by agent tasks with disk verification.

CREATE TABLE IF NOT EXISTS task_artifacts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  task_id UUID REFERENCES agent_tasks(id),
  user_id UUID NOT NULL REFERENCES users(id),
  artifact_type TEXT NOT NULL,              -- 'file', 'image', 'document', 'project', 'code'
  file_path TEXT,                           -- disk path (e.g., ~/.nova/workspace/projects/courseme)
  file_name TEXT,                           -- human-readable name
  file_size BIGINT,                        -- bytes, verified on disk
  description TEXT,                         -- what this artifact is
  verified BOOLEAN DEFAULT FALSE,           -- true only after stat() confirms existence
  delivered BOOLEAN DEFAULT FALSE,          -- true after sent to user via Telegram
  metadata JSONB DEFAULT '{}'              -- extra info (mime type, dimensions, etc.)
);

CREATE INDEX IF NOT EXISTS idx_task_artifacts_task ON task_artifacts(task_id);
CREATE INDEX IF NOT EXISTS idx_task_artifacts_user ON task_artifacts(user_id);
CREATE INDEX IF NOT EXISTS idx_task_artifacts_type ON task_artifacts(artifact_type);
