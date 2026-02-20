-- Workflow Preferences
-- Stores user-approved workflow patterns so Nova can reuse plans the user liked.
-- When a user approves a plan and it succeeds, we store the workflow signature
-- so next time a similar request comes in, we use the approved plan directly.

CREATE TABLE IF NOT EXISTS workflow_preferences (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workflow_type text NOT NULL, -- 'social-media', 'email-campaign', 'blog-post', 'presentation', 'ad-campaign', 'generic'
  task_signature text NOT NULL, -- normalized keywords from the original request
  plan jsonb NOT NULL, -- the ExecutionPlan that was approved
  success_count int DEFAULT 1,
  last_used_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_workflow_prefs_user_type ON workflow_preferences(user_id, workflow_type);
CREATE INDEX IF NOT EXISTS idx_workflow_prefs_user_sig ON workflow_preferences(user_id, task_signature);

-- Unique constraint: one plan per user per signature
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_prefs_unique ON workflow_preferences(user_id, task_signature);
