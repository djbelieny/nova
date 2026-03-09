-- ============================================================================
-- 001_executive_board.sql
-- Executive Board System — Supabase Migration
--
-- Creates the schema for Nova's executive board: a multi-exec orchestration
-- layer with inter-exec messaging, board meeting sessions, delegations,
-- decision memory with confidence/outcome tracking, and proactive run
-- deduplication.
-- ============================================================================

-- 1. exec_nodes — Executive node registry and health
CREATE TABLE IF NOT EXISTS exec_nodes (
  id              TEXT PRIMARY KEY,                -- e.g. "ceo", "cfo", "nova"
  role            TEXT NOT NULL,
  status          TEXT DEFAULT 'offline',          -- online | offline | busy
  last_heartbeat  TIMESTAMPTZ,
  vps_host        TEXT,
  metadata        JSONB DEFAULT '{}'
);

-- 2. board_sessions — Board meeting sessions (created before exec_messages so FK works)
CREATE TABLE IF NOT EXISTS board_sessions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),
  user_id             TEXT NOT NULL,
  question            TEXT NOT NULL,
  status              TEXT DEFAULT 'convened',     -- convened | analyzing | critiquing | synthesizing | presented | decided | cancelled
  board_members       TEXT[] DEFAULT '{}',
  options             JSONB DEFAULT '[]',
  chosen_option       TEXT,
  decision_rationale  TEXT,
  consensus           TEXT,                        -- relay baton
  follow_up_of        UUID,                        -- parent session
  cost_usd            REAL DEFAULT 0,
  metadata            JSONB DEFAULT '{}'
);

-- 3. exec_messages — Inter-executive messaging
CREATE TABLE IF NOT EXISTS exec_messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        TIMESTAMPTZ DEFAULT now(),
  from_role         TEXT NOT NULL,
  to_role           TEXT,                          -- NULL = broadcast
  type              TEXT NOT NULL,                 -- brief | request | response | alert
  subject           TEXT,
  content           TEXT NOT NULL,
  read_by           TEXT[] DEFAULT '{}',
  metadata          JSONB DEFAULT '{}',
  board_session_id  UUID REFERENCES board_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_exec_messages_to_role_created
  ON exec_messages (to_role, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_exec_messages_unread
  ON exec_messages (to_role, created_at DESC)
  WHERE read_by = '{}';

-- 4. board_contributions — Individual exec contributions to board meetings
CREATE TABLE IF NOT EXISTS board_contributions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ DEFAULT now(),
  session_id    UUID NOT NULL REFERENCES board_sessions(id),
  role          TEXT NOT NULL,
  contribution  TEXT NOT NULL,
  is_critique   BOOLEAN DEFAULT false,
  metadata      JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_board_contributions_session
  ON board_contributions (session_id);

-- 5. delegations — Task delegations between execs and agents
CREATE TABLE IF NOT EXISTS delegations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at        TIMESTAMPTZ DEFAULT now(),
  updated_at        TIMESTAMPTZ DEFAULT now(),
  requesting_role   TEXT NOT NULL,
  assigned_agent    TEXT,
  assigned_by       TEXT DEFAULT 'coo',
  task_description  TEXT NOT NULL,
  status            TEXT DEFAULT 'pending',        -- pending | assigned | in_progress | completed | failed | cancelled
  result            TEXT,
  artifacts         JSONB DEFAULT '[]',
  node_id           TEXT,
  user_id           TEXT NOT NULL,
  metadata          JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_delegations_status_created
  ON delegations (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_delegations_requesting_role
  ON delegations (requesting_role);

-- 6. decisions — Decision memory with confidence + outcome tracking
CREATE TABLE IF NOT EXISTS decisions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at          TIMESTAMPTZ DEFAULT now(),
  user_id             TEXT NOT NULL,
  question            TEXT NOT NULL,
  chosen_option       TEXT NOT NULL,
  rationale           TEXT,
  confidence          REAL DEFAULT 0.5,            -- 0-1
  outcome             TEXT DEFAULT 'pending',      -- pending | success | failed | revised
  outcome_notes       TEXT,
  outcome_at          TIMESTAMPTZ,
  board_session_id    UUID REFERENCES board_sessions(id),
  contributing_roles  TEXT[] DEFAULT '{}',
  cost_usd            REAL DEFAULT 0,
  metadata            JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_decisions_user_created
  ON decisions (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_decisions_pending_outcomes
  ON decisions (outcome, created_at DESC)
  WHERE outcome = 'pending';

-- 7. decision_log — Append-only history for meta-learning
CREATE TABLE IF NOT EXISTS decision_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  TIMESTAMPTZ DEFAULT now(),
  event_type  TEXT NOT NULL,                       -- decision_made | outcome_recorded | confidence_updated | stalling_detected
  decision_id UUID REFERENCES decisions(id),
  role        TEXT,
  data        JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_decision_log_created
  ON decision_log (created_at DESC);

-- 8. exec_heartbeats — Heartbeats for monitoring
CREATE TABLE IF NOT EXISTS exec_heartbeats (
  node_id       TEXT PRIMARY KEY,
  role          TEXT NOT NULL,
  last_seen     TIMESTAMPTZ DEFAULT now(),
  status        TEXT DEFAULT 'online',
  active_tasks  INTEGER DEFAULT 0,
  metadata      JSONB DEFAULT '{}'
);

-- 9. projects — Project-level autonomous execution
CREATE TABLE IF NOT EXISTS projects (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),
  user_id             TEXT NOT NULL,
  title               TEXT NOT NULL,
  description         TEXT,
  status              TEXT DEFAULT 'planning',     -- planning | active | paused | completed | failed
  board_session_id    UUID REFERENCES board_sessions(id),
  work_items          JSONB DEFAULT '[]',
  progress_pct        INTEGER DEFAULT 0,
  next_milestone      TEXT,
  completion_criteria TEXT,
  metadata            JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_projects_active
  ON projects (status)
  WHERE status = 'active';

-- 10. proactive_runs — Tracks proactive processing to avoid duplicates
CREATE TABLE IF NOT EXISTS proactive_runs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  TIMESTAMPTZ DEFAULT now(),
  role        TEXT NOT NULL,
  source      TEXT NOT NULL,                       -- zoom | trends | leads | sheets | retrospective
  source_id   TEXT,                                -- e.g. Zoom meeting ID
  status      TEXT DEFAULT 'completed',
  output_type TEXT,                                -- notion_doc | sheet_update | brief | delegation
  output_ref  TEXT,                                -- Notion page ID, Sheet URL, etc.
  metadata    JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_proactive_runs_source
  ON proactive_runs (source, source_id);

CREATE INDEX IF NOT EXISTS idx_proactive_runs_role_created
  ON proactive_runs (role, created_at DESC);
