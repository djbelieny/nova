/**
 * Local SQLite Database Module — Split Architecture
 *
 * Split structure for per-user data isolation:
 *   data/shared.db         — users, nova_status, logs, cost_tracking, shared memory
 *   data/users/{id}.db     — messages, private memory, tasks, approvals, etc.
 *
 * The DatabaseManager facade maintains the same API as the old single-DB Database class.
 * Auto-migrates from single nova.db on first run.
 *
 * Usage: import { getDb } from "./db.ts";
 *        const db = getDb();
 *        db.saveMessage({ ... });
 */

import { Database as BunDatabase } from "bun:sqlite";
import { join, dirname, resolve } from "path";
import { mkdirSync, existsSync, readdirSync, renameSync } from "fs";
import * as sqliteVec from "sqlite-vec";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

// ============================================================
// Credential Encryption (AES-256-GCM)
// ============================================================

if (!process.env.NOVA_ENCRYPTION_KEY) {
  if (process.env.NODE_ENV === "test") {
    console.warn("[db] NOVA_ENCRYPTION_KEY not set — test mode, credentials stored unencrypted.");
  } else {
    console.error("[db] NOVA_ENCRYPTION_KEY is not set. OAuth tokens will be stored unencrypted.");
    console.error("[db] Generate one with: openssl rand -hex 32");
    console.error("[db] Add it to .env as: NOVA_ENCRYPTION_KEY=<value>");
    process.exit(1);
  }
}

const ENCRYPTION_KEY = process.env.NOVA_ENCRYPTION_KEY
  ? Buffer.from(process.env.NOVA_ENCRYPTION_KEY, "hex")
  : null;

function encryptCredentials(plaintext: string): string {
  if (!ENCRYPTION_KEY) return plaintext;
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `enc:${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decryptCredentials(value: string): string {
  if (!value.startsWith("enc:") || !ENCRYPTION_KEY) return value;
  const parts = value.slice(4).split(":");
  if (parts.length !== 3) return value;
  const [ivB64, authTagB64, encB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const encrypted = Buffer.from(encB64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

const PROJECT_ROOT = dirname(dirname(import.meta.path));
// NOVA_DB_DIR overrides the data directory (tests use this to avoid touching live data)
const DATA_DIR = process.env.NOVA_DB_DIR
  ? resolve(process.env.NOVA_DB_DIR)
  : join(PROJECT_ROOT, "data");
const SHARED_DB_PATH = join(DATA_DIR, "shared.db");
const USERS_DIR = join(DATA_DIR, "users");
const LEGACY_DB_PATH = join(DATA_DIR, "nova.db");

// ============================================================
// Types
// ============================================================

export interface ApprovalRule {
  category: string;       // e.g. "social_post", "email", "ad_spend", "content", "research"
  auto_approve: boolean;
  limit_usd?: number;     // max spend per execution for auto-approve
  agent_slugs?: string[]; // if set, only applies to these agents
}

export interface DbUser {
  id: string;
  created_at: string;
  updated_at: string;
  telegram_id: string;
  name: string;
  timezone: string;
  phone: string | null;
  pin: string | null;
  whatsapp_id: string | null;
  slack_id: string | null;
  role: string;
  preferences: Record<string, any>;
  profile_text: string;
  active: number; // SQLite boolean
  approval_rules: string | null;
}

export interface DbMessage {
  id: string;
  created_at: string;
  role: string;
  content: string;
  channel: string;
  metadata: string; // JSON string
  user_id: string;
  embedding: Buffer | null;
}

export interface DbMemory {
  id: string;
  created_at: string;
  updated_at: string;
  last_accessed_at: string;
  weight: number;
  type: string;
  content: string;
  deadline: string | null;
  completed_at: string | null;
  priority: number;
  metadata: string;
  user_id: string;
  scope: string;
  embedding: Buffer | null;
}

export interface VectorMatch {
  id: string;
  content: string;
  role?: string;
  type?: string;
  created_at: string;
  similarity: number;
}

export interface UserProject {
  id: string;
  userId: string;
  name: string;
  repoUrl?: string;
  localPath?: string;
  defaultBranch: string;
  runtime?: string;
  createdAt: number;
}

export interface SupportTicket {
  id: string;
  user_id: string;
  created_at: string;
  updated_at: string;
  source: string;
  client_email: string;
  client_name: string | null;
  resend_message_id: string | null;
  subject: string;
  body_raw: string;
  classification: string | null;
  severity: string | null;
  project_id: string | null;
  status: string;
  branch_name: string | null;
  diff_summary: string | null;
  test_results: string | null;
  deploy_result: string | null;
  last_error: string | null;
}

export interface ActionLedgerEntry {
  user_id: string;
  agent: string;
  action_type: string;
  phase: "prepare" | "execute" | "verify";
  autonomy_level?: number;
  approval_id?: string | null;
  sandbox_backend?: string;
  cost_usd?: number;
  outcome: "success" | "failed" | "rejected" | "rolled_back";
  verification?: unknown;
  artifacts?: unknown[];
}

export interface ActionLedgerRow extends ActionLedgerEntry {
  id: string;
  created_at: string;
}

export interface AutonomyGrantRow {
  agent: string;
  action_type: string;
  level: number;
  clean_runs: number;
  spend_cap_action: number | null;
  spend_cap_daily: number | null;
  demoted_at: string | null;
}

export interface AgentTaskRow {
  id: string;
  created_at: string;
  updated_at: string;
  agent: string;
  description: string;
  status: string;
  result: string | null;
  metadata: string;
  user_id: string;
  parent_task_id: string | null;
  request_id: string | null;
  task_type: string | null;
  project_id: string | null;
  confidence_score: number | null;
  revised: number | null;
  created_by: string | null;
}

export interface CsConfig {
  id: number;
  businessName: string;
  agentName: string;
  greeting: string;
  tone: string;
  language: string;
  responseLength: string;
  fallbackMessage: string;
  businessHours: string | null;
  escalationSla: string;
  offHoursMessage: string | null;
  widgetColor: string;
  widgetPosition: string;
  updatedAt: number;
}

export interface CsDocument {
  id: string;
  filename: string;
  fileSize: number;
  mimeType: string;
  status: string;
  chunkCount: number;
  errorMessage: string | null;
  uploadedAt: number;
}

export interface CsSession {
  id: string;
  channelType: string;
  channelSessionId: string;
  customerName: string | null;
  customerEmail: string | null;
  platformUserId: string | null;
  status: string;
  resolutionAttempts: number;
  ghlContactId: string | null;
  ghlTicketId: string | null;
  startedAt: number;
  lastActivity: number;
}

export interface CsMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  retrievedChunkIds: string | null;
  topSimilarity: number | null;
  createdAt: number;
}

// ============================================================
// Helpers
// ============================================================

function uuid(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

/** Convert a number[] embedding to a Float32Array buffer for sqlite-vec. */
export function embeddingToBlob(embedding: number[]): Buffer {
  const f32 = new Float32Array(embedding);
  return Buffer.from(f32.buffer);
}

/** Convert a sqlite-vec blob back to number[]. */
export function blobToEmbedding(blob: Buffer): number[] {
  const f32 = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  return Array.from(f32);
}

/** Parse a JSON column, returning fallback on error. */
function parseJson<T>(val: string | null | undefined, fallback: T): T {
  if (!val) return fallback;
  try {
    return JSON.parse(val);
  } catch {
    return fallback;
  }
}

/** Parse a TEXT[] stored as JSON array. */
function parseTextArray(val: string | null | undefined): string[] {
  return parseJson(val, []);
}

/** Check if a table exists in a database. */
function tableExists(db: BunDatabase, name: string): boolean {
  const row = db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name) as any;
  return !!row;
}

/** Open a BunDatabase with sqlite-vec and standard pragmas. */
function openDb(dbPath: string): BunDatabase {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new BunDatabase(dbPath);
  sqliteVec.load(db);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA busy_timeout = 5000");
  return db;
}

// macOS: use Homebrew's SQLite which supports dynamic extensions
if (process.platform === "darwin") {
  const brewSqlite = "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib";
  if (existsSync(brewSqlite)) {
    BunDatabase.setCustomSQLite(brewSqlite);
  }
}

// ============================================================
// SharedDatabase — users, nova_status, logs, cost_tracking, shared memory
// ============================================================

class SharedDatabase {
  readonly db: BunDatabase;

  constructor(dbPath: string = SHARED_DB_PATH) {
    this.db = openDb(dbPath);
    this.db.run("PRAGMA foreign_keys = ON");
    this.createSchema();
  }

  private createSchema(): void {
    try {
      this.db.run("BEGIN");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS llm_traces (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        created_at TEXT DEFAULT (datetime('now')),
        trace_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt TEXT NOT NULL,
        response TEXT NOT NULL,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0.0,
        duration_ms INTEGER DEFAULT 0,
        metadata TEXT DEFAULT '{}'
      )
    `);
    try { this.db.run(`CREATE INDEX IF NOT EXISTS idx_traces_user_trace ON llm_traces(user_id, trace_id)`); } catch {}

    this.db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        telegram_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        timezone TEXT DEFAULT 'UTC',
        phone TEXT,
        pin TEXT,
        whatsapp_id TEXT,
        slack_id TEXT,
        kapso_api_key TEXT,
        kapso_phone_number_id TEXT,
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
        preferences TEXT DEFAULT '{"proactive_checkin":true,"morning_briefing":true,"briefing_hour":9,"voice_responses":false}',
        profile_text TEXT DEFAULT '',
        active INTEGER DEFAULT 1,
        ai_provider TEXT DEFAULT 'claude',
        ai_config TEXT DEFAULT '{}',
        team_id TEXT
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_users_whatsapp_id ON users(whatsapp_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_users_slack_id ON users(slack_id)`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS nova_status (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        updated_at TEXT DEFAULT (datetime('now')),
        uptime_since TEXT DEFAULT (datetime('now')),
        calls_total INTEGER DEFAULT 0,
        calls_success INTEGER DEFAULT 0,
        calls_failed INTEGER DEFAULT 0,
        calls_by_model TEXT DEFAULT '{}',
        rate_limit_hits INTEGER DEFAULT 0,
        last_rate_limit_at TEXT,
        avg_duration_ms REAL DEFAULT 0,
        active_slots INTEGER DEFAULT 0,
        max_slots INTEGER DEFAULT 2,
        queue_depth INTEGER DEFAULT 0,
        active_tasks INTEGER DEFAULT 0,
        pending_approvals INTEGER DEFAULT 0
      )
    `);
    this.db.run(`INSERT OR IGNORE INTO nova_status (id) VALUES (1)`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS logs (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        created_at TEXT DEFAULT (datetime('now')),
        level TEXT DEFAULT 'info' CHECK (level IN ('debug', 'info', 'warn', 'error')),
        event TEXT NOT NULL,
        message TEXT,
        metadata TEXT DEFAULT '{}',
        session_id TEXT,
        duration_ms INTEGER,
        user_id TEXT
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at DESC)`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS cost_tracking (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        created_at TEXT DEFAULT (datetime('now')),
        provider TEXT DEFAULT 'claude',
        model TEXT NOT NULL,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0,
        cache_creation_tokens INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        session_id TEXT,
        metadata TEXT DEFAULT '{}',
        user_id TEXT
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_cost_tracking_created_at ON cost_tracking(created_at DESC)`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS memory (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        last_accessed_at TEXT DEFAULT (datetime('now')),
        weight REAL DEFAULT 1.0,
        type TEXT NOT NULL CHECK (type IN ('fact', 'goal', 'completed_goal', 'preference')),
        content TEXT NOT NULL,
        deadline TEXT,
        completed_at TEXT,
        priority INTEGER DEFAULT 0,
        metadata TEXT DEFAULT '{}',
        user_id TEXT NOT NULL,
        scope TEXT DEFAULT 'shared' CHECK (scope IN ('private', 'shared')),
        embedding BLOB
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memory_user_created ON memory(user_id, created_at DESC)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memory_type ON memory(type)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory(scope)`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS service_state (
        service TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (service, key)
      )
    `);

    // Cross-user access grants
    this.db.run(`
      CREATE TABLE IF NOT EXISTS user_access_grants (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        grantor_user_id TEXT NOT NULL,
        grantee_user_id TEXT NOT NULL,
        level TEXT NOT NULL CHECK(level IN ('none','tasks-only','tasks+goals','full-summary')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(grantor_user_id, grantee_user_id)
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_grants_grantee ON user_access_grants(grantee_user_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_grants_grantor ON user_access_grants(grantor_user_id)`);

    // Webhook triggers (shared — cross-user definitions)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS webhook_triggers (
        id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        user_id             TEXT NOT NULL,
        name                TEXT NOT NULL,
        source              TEXT NOT NULL,
        secret              TEXT NOT NULL,
        pipeline            TEXT NOT NULL,
        enabled             INTEGER DEFAULT 1,
        created_at          TEXT DEFAULT (datetime('now')),
        last_triggered_at   TEXT,
        trigger_count       INTEGER DEFAULT 0,
        UNIQUE(user_id, name)
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_webhook_triggers_user ON webhook_triggers(user_id)`);

    // Agent reputation (global, shared across users)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS agent_reputation (
        id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        agent_slug      TEXT NOT NULL UNIQUE,
        total_tasks     INTEGER DEFAULT 0,
        success_count   INTEGER DEFAULT 0,
        fail_count      INTEGER DEFAULT 0,
        revision_count  INTEGER DEFAULT 0,
        avg_confidence  REAL DEFAULT 0.0,
        last_task_at    TEXT,
        updated_at      TEXT DEFAULT (datetime('now'))
      )
    `);

    // Lifecycle tracker for conversation messages written to Memwright with short-term TTL.
    // id = Memwright memory ID (opaque foreign key; content lives in Memwright, not here).
    // Pruned weekly by memory-review.ts; promoted entries are skipped during pruning.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS short_term_memories (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        promoted   INTEGER DEFAULT 0
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_stm_expires ON short_term_memories(expires_at, promoted)`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS action_log (
        key TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        result TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        dedup_window_hours REAL NOT NULL
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_action_log_user ON action_log(user_id, created_at)`);

    // ── CS / SDR Mode ──────────────────────────────────────────────────────
    this.db.run(`
      CREATE TABLE IF NOT EXISTS cs_config (
        id INTEGER PRIMARY KEY DEFAULT 1,
        business_name TEXT NOT NULL DEFAULT 'Our Company',
        agent_name TEXT NOT NULL DEFAULT 'Maya',
        greeting TEXT NOT NULL DEFAULT 'Hi! I''m Maya, how can I help you today?',
        tone TEXT NOT NULL DEFAULT 'friendly',
        language TEXT NOT NULL DEFAULT 'en',
        response_length TEXT NOT NULL DEFAULT 'balanced',
        fallback_message TEXT NOT NULL DEFAULT 'I don''t have specific information on that. Let me connect you with our team.',
        business_hours TEXT,
        escalation_sla TEXT NOT NULL DEFAULT 'within 4 hours',
        off_hours_message TEXT,
        widget_color TEXT NOT NULL DEFAULT '#0066FF',
        widget_position TEXT NOT NULL DEFAULT 'bottom-right',
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      )
    `);
    this.db.run(`INSERT OR IGNORE INTO cs_config (id) VALUES (1)`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS cs_documents (
        id TEXT PRIMARY KEY,
        filename TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        mime_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'processing',
        chunk_count INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        uploaded_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS cs_knowledge (
        id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL REFERENCES cs_documents(id) ON DELETE CASCADE,
        chunk_text TEXT NOT NULL,
        embedding BLOB NOT NULL,
        chunk_index INTEGER NOT NULL,
        token_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      )
    `);
    try { this.db.run(`CREATE INDEX IF NOT EXISTS idx_cs_knowledge_doc ON cs_knowledge(doc_id)`); } catch {}

    this.db.run(`
      CREATE TABLE IF NOT EXISTS cs_sessions (
        id TEXT PRIMARY KEY,
        channel_type TEXT NOT NULL,
        channel_session_id TEXT NOT NULL,
        customer_name TEXT,
        customer_email TEXT,
        platform_user_id TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        resolution_attempts INTEGER NOT NULL DEFAULT 0,
        ghl_contact_id TEXT,
        ghl_ticket_id TEXT,
        started_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        last_activity INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        UNIQUE(channel_type, channel_session_id)
      )
    `);
    try { this.db.run(`CREATE INDEX IF NOT EXISTS idx_cs_sessions_status ON cs_sessions(status)`); } catch {}

    this.db.run(`
      CREATE TABLE IF NOT EXISTS cs_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES cs_sessions(id),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        retrieved_chunk_ids TEXT,
        top_similarity REAL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      )
    `);
    try { this.db.run(`CREATE INDEX IF NOT EXISTS idx_cs_messages_session ON cs_messages(session_id, created_at)`); } catch {}

    // Shared credentials (OAuth tokens, API keys, model keys — encrypted at rest)
    this.db.run(`CREATE TABLE IF NOT EXISTS shared_credentials (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      provider TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('oauth','api_key','model_key')),
      credentials TEXT NOT NULL DEFAULT '{}',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

      this.db.run("COMMIT");
    } catch (err) {
      try { this.db.run("ROLLBACK"); } catch {}
      throw new Error(`Database migration failed (shared.db): ${err instanceof Error ? err.message : String(err)}. Cannot start Nova.`);
    }

    // Safe migrations for existing databases — run AFTER the transaction
    try { this.db.run(`ALTER TABLE users ADD COLUMN ai_provider TEXT DEFAULT 'claude'`); } catch {}
    try { this.db.run(`ALTER TABLE users ADD COLUMN ai_config TEXT DEFAULT '{}'`); } catch {}
    try { this.db.run(`ALTER TABLE users ADD COLUMN kapso_api_key TEXT`); } catch {}
    try { this.db.run(`ALTER TABLE users ADD COLUMN kapso_phone_number_id TEXT`); } catch {}
    // Index must come after the ALTERs so pre-kapso databases upgrade cleanly
    try { this.db.run(`CREATE INDEX IF NOT EXISTS idx_users_kapso_phone ON users(kapso_phone_number_id)`); } catch {}
    try { this.db.run(`ALTER TABLE users ADD COLUMN team_id TEXT`); } catch {}
    try { this.db.run(`ALTER TABLE users ADD COLUMN approval_rules TEXT`); } catch {}
    // Migration: add agent_slug and exec_role columns to cost_tracking
    try { this.db.run(`ALTER TABLE cost_tracking ADD COLUMN agent_slug TEXT`); } catch {}
    try { this.db.run(`ALTER TABLE cost_tracking ADD COLUMN exec_role TEXT`); } catch {}
    try { this.db.run(`ALTER TABLE cost_tracking ADD COLUMN request_id TEXT`); } catch {}
    // Safe migration for existing databases
    try { this.db.run(`ALTER TABLE memory ADD COLUMN last_accessed_at TEXT DEFAULT (datetime('now'))`); } catch {}
    try { this.db.run(`ALTER TABLE memory ADD COLUMN weight REAL DEFAULT 1.0`); } catch {}
    // Per-user job role (e.g. "developer", "account_manager", "designer")
    try { this.db.run(`ALTER TABLE users ADD COLUMN job_role TEXT DEFAULT 'general'`); } catch {}
    // Dashboard auth columns
    try { this.db.run(`ALTER TABLE users ADD COLUMN username TEXT`); } catch {}
    try { this.db.run(`ALTER TABLE users ADD COLUMN password_hash TEXT`); } catch {}
    try { this.db.run(`ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0`); } catch {}
    // Onboarding: timestamp of the first-run welcome so it fires exactly once
    try { this.db.run(`ALTER TABLE users ADD COLUMN onboarded_at TEXT`); } catch {}
    try { this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL`); } catch {}
  }

  close(): void {
    this.db.close();
  }

  // ── CS / SDR Mode Methods ────────────────────────────────────────────────

  getCsConfig(): CsConfig {
    const row = this.db.query(`SELECT * FROM cs_config WHERE id = 1`).get() as any;
    return {
      id: row.id,
      businessName: row.business_name,
      agentName: row.agent_name,
      greeting: row.greeting,
      tone: row.tone,
      language: row.language,
      responseLength: row.response_length,
      fallbackMessage: row.fallback_message,
      businessHours: row.business_hours,
      escalationSla: row.escalation_sla,
      offHoursMessage: row.off_hours_message,
      widgetColor: row.widget_color,
      widgetPosition: row.widget_position,
      updatedAt: row.updated_at,
    };
  }

  saveCsConfig(config: Partial<CsConfig>): void {
    const fields: string[] = [];
    const values: any[] = [];

    if (config.businessName !== undefined) { fields.push('business_name = ?'); values.push(config.businessName); }
    if (config.agentName !== undefined) { fields.push('agent_name = ?'); values.push(config.agentName); }
    if (config.greeting !== undefined) { fields.push('greeting = ?'); values.push(config.greeting); }
    if (config.tone !== undefined) { fields.push('tone = ?'); values.push(config.tone); }
    if (config.language !== undefined) { fields.push('language = ?'); values.push(config.language); }
    if (config.responseLength !== undefined) { fields.push('response_length = ?'); values.push(config.responseLength); }
    if (config.fallbackMessage !== undefined) { fields.push('fallback_message = ?'); values.push(config.fallbackMessage); }
    if (config.businessHours !== undefined) { fields.push('business_hours = ?'); values.push(config.businessHours); }
    if (config.escalationSla !== undefined) { fields.push('escalation_sla = ?'); values.push(config.escalationSla); }
    if (config.offHoursMessage !== undefined) { fields.push('off_hours_message = ?'); values.push(config.offHoursMessage); }
    if (config.widgetColor !== undefined) { fields.push('widget_color = ?'); values.push(config.widgetColor); }
    if (config.widgetPosition !== undefined) { fields.push('widget_position = ?'); values.push(config.widgetPosition); }

    if (fields.length === 0) return;
    fields.push('updated_at = ?');
    values.push(Math.floor(Date.now() / 1000));
    values.push(1);
    this.db.run(`UPDATE cs_config SET ${fields.join(', ')} WHERE id = ?`, values);
  }

  createCsDocument(id: string, filename: string, fileSize: number, mimeType: string): void {
    this.db.run(
      `INSERT INTO cs_documents (id, filename, file_size, mime_type, status) VALUES (?, ?, ?, ?, 'processing')`,
      [id, filename, fileSize, mimeType]
    );
  }

  updateCsDocumentStatus(id: string, status: string, chunkCount?: number, errorMessage?: string): void {
    this.db.run(
      `UPDATE cs_documents SET status = ?, chunk_count = COALESCE(?, chunk_count), error_message = ? WHERE id = ?`,
      [status, chunkCount ?? null, errorMessage ?? null, id]
    );
  }

  getCsDocuments(): CsDocument[] {
    const rows = this.db.query(`SELECT * FROM cs_documents ORDER BY uploaded_at DESC`).all() as any[];
    return rows.map(r => ({
      id: r.id,
      filename: r.filename,
      fileSize: r.file_size,
      mimeType: r.mime_type,
      status: r.status,
      chunkCount: r.chunk_count,
      errorMessage: r.error_message,
      uploadedAt: r.uploaded_at,
    }));
  }

  deleteCsDocument(id: string): void {
    this.db.run(`DELETE FROM cs_documents WHERE id = ?`, [id]);
  }

  insertCsKnowledgeChunk(
    id: string,
    docId: string,
    chunkText: string,
    embedding: Float32Array,
    chunkIndex: number,
    tokenCount: number
  ): void {
    const blob = Buffer.from(embedding.buffer);
    this.db.run(
      `INSERT INTO cs_knowledge (id, doc_id, chunk_text, embedding, chunk_index, token_count) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, docId, chunkText, blob, chunkIndex, tokenCount]
    );
  }

  searchCsKnowledge(queryEmbedding: Float32Array, limit: number): Array<{ id: string; chunk_text: string; similarity: number }> {
    const blob = Buffer.from(queryEmbedding.buffer);
    const rows = this.db.query(`
      SELECT id, chunk_text,
        (1.0 - vec_distance_cosine(embedding, ?)) AS similarity
      FROM cs_knowledge
      WHERE embedding IS NOT NULL
      ORDER BY vec_distance_cosine(embedding, ?) ASC
      LIMIT ?
    `).all(blob, blob, limit) as any[];
    return rows.map(r => ({ id: r.id, chunk_text: r.chunk_text, similarity: r.similarity }));
  }

  createCsSession(id: string, channelType: string, channelSessionId: string, platformUserId?: string): CsSession {
    const now = Math.floor(Date.now() / 1000);
    this.db.run(
      `INSERT INTO cs_sessions (id, channel_type, channel_session_id, platform_user_id, started_at, last_activity)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, channelType, channelSessionId, platformUserId ?? null, now, now]
    );
    return this.getCsSession(channelType, channelSessionId)!;
  }

  getCsSession(channelType: string, channelSessionId: string): CsSession | null {
    const row = this.db.query(
      `SELECT * FROM cs_sessions WHERE channel_type = ? AND channel_session_id = ?`
    ).get(channelType, channelSessionId) as any;
    if (!row) return null;
    return {
      id: row.id,
      channelType: row.channel_type,
      channelSessionId: row.channel_session_id,
      customerName: row.customer_name,
      customerEmail: row.customer_email,
      platformUserId: row.platform_user_id,
      status: row.status,
      resolutionAttempts: row.resolution_attempts,
      ghlContactId: row.ghl_contact_id,
      ghlTicketId: row.ghl_ticket_id,
      startedAt: row.started_at,
      lastActivity: row.last_activity,
    };
  }

  updateCsSession(id: string, updates: Partial<CsSession>): void {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.customerName !== undefined) { fields.push('customer_name = ?'); values.push(updates.customerName); }
    if (updates.customerEmail !== undefined) { fields.push('customer_email = ?'); values.push(updates.customerEmail); }
    if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
    if (updates.resolutionAttempts !== undefined) { fields.push('resolution_attempts = ?'); values.push(updates.resolutionAttempts); }
    if (updates.ghlContactId !== undefined) { fields.push('ghl_contact_id = ?'); values.push(updates.ghlContactId); }
    if (updates.ghlTicketId !== undefined) { fields.push('ghl_ticket_id = ?'); values.push(updates.ghlTicketId); }
    if (updates.lastActivity !== undefined) { fields.push('last_activity = ?'); values.push(updates.lastActivity); }
    if (updates.platformUserId !== undefined) { fields.push('platform_user_id = ?'); values.push(updates.platformUserId); }

    if (fields.length === 0) return;
    values.push(id);
    this.db.run(`UPDATE cs_sessions SET ${fields.join(', ')} WHERE id = ?`, values);
  }

  addCsMessage(
    id: string,
    sessionId: string,
    role: string,
    content: string,
    retrievedChunkIds?: string[],
    topSimilarity?: number
  ): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.run(
      `INSERT INTO cs_messages (id, session_id, role, content, retrieved_chunk_ids, top_similarity, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        sessionId,
        role,
        content,
        retrievedChunkIds ? JSON.stringify(retrievedChunkIds) : null,
        topSimilarity ?? null,
        now,
      ]
    );
  }

  getCsMessages(sessionId: string, limit = 50): CsMessage[] {
    const rows = this.db.query(
      `SELECT * FROM cs_messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?`
    ).all(sessionId, limit) as any[];
    return rows.map(r => ({
      id: r.id,
      sessionId: r.session_id,
      role: r.role,
      content: r.content,
      retrievedChunkIds: r.retrieved_chunk_ids,
      topSimilarity: r.top_similarity,
      createdAt: r.created_at,
    }));
  }

  getCsSessions(status?: string): CsSession[] {
    const rows = status
      ? this.db.query(`SELECT * FROM cs_sessions WHERE status = ? ORDER BY last_activity DESC`).all(status) as any[]
      : this.db.query(`SELECT * FROM cs_sessions ORDER BY last_activity DESC`).all() as any[];
    return rows.map(r => ({
      id: r.id,
      channelType: r.channel_type,
      channelSessionId: r.channel_session_id,
      customerName: r.customer_name,
      customerEmail: r.customer_email,
      platformUserId: r.platform_user_id,
      status: r.status,
      resolutionAttempts: r.resolution_attempts,
      ghlContactId: r.ghl_contact_id,
      ghlTicketId: r.ghl_ticket_id,
      startedAt: r.started_at,
      lastActivity: r.last_activity,
    }));
  }
}

// ============================================================
// UserDatabase — per-user: messages, private memory, tasks, etc.
// ============================================================

const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

function validateUserId(userId: string): void {
  if (!UUID_RE.test(userId)) {
    throw new Error(`Invalid userId: must be a UUID — got "${userId}"`);
  }
}

class UserDatabase {
  readonly db: BunDatabase;
  readonly userId: string;

  constructor(userId: string) {
    this.userId = userId;
    const dbPath = join(USERS_DIR, `${userId}.db`);
    this.db = openDb(dbPath);
    this.createSchema();
  }

  private createSchema(): void {
    try {
      this.db.run("BEGIN");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        created_at TEXT DEFAULT (datetime('now')),
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        channel TEXT DEFAULT 'telegram',
        metadata TEXT DEFAULT '{}',
        user_id TEXT NOT NULL,
        embedding BLOB
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_messages_user_created ON messages(user_id, created_at DESC)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel)`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS memory (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        last_accessed_at TEXT DEFAULT (datetime('now')),
        weight REAL DEFAULT 1.0,
        type TEXT NOT NULL CHECK (type IN ('fact', 'goal', 'completed_goal', 'preference')),
        content TEXT NOT NULL,
        deadline TEXT,
        completed_at TEXT,
        priority INTEGER DEFAULT 0,
        metadata TEXT DEFAULT '{}',
        user_id TEXT NOT NULL,
        scope TEXT DEFAULT 'private' CHECK (scope IN ('private', 'shared')),
        embedding BLOB
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memory_user_created ON memory(user_id, created_at DESC)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memory_type ON memory(type)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory(scope)`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS agent_tasks (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        agent TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','in_progress','done','completed','blocked','cancelled')),
        result TEXT,
        metadata TEXT DEFAULT '{}',
        user_id TEXT NOT NULL,
        parent_task_id TEXT REFERENCES agent_tasks(id),
        request_id TEXT
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_agent_tasks_user_created ON agent_tasks(user_id, created_at DESC)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_agent_tasks_parent ON agent_tasks(parent_task_id)`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS task_artifacts (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        created_at TEXT DEFAULT (datetime('now')),
        task_id TEXT REFERENCES agent_tasks(id),
        user_id TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        file_path TEXT,
        file_name TEXT,
        file_size INTEGER,
        description TEXT,
        verified INTEGER DEFAULT 0,
        delivered INTEGER DEFAULT 0,
        metadata TEXT DEFAULT '{}'
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_task_artifacts_task ON task_artifacts(task_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_task_artifacts_user ON task_artifacts(user_id)`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        user_id TEXT NOT NULL,
        created_by TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user', 'nova')),
        title TEXT NOT NULL,
        instructions TEXT NOT NULL,
        trigger_at TEXT,
        next_run_at TEXT,
        recurrence TEXT,
        timezone TEXT NOT NULL DEFAULT 'UTC',
        condition TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'cancelled', 'failed')),
        last_run_at TEXT,
        last_result TEXT,
        run_count INTEGER DEFAULT 0,
        max_runs INTEGER,
        expires_at TEXT,
        notify_user INTEGER DEFAULT 1,
        metadata TEXT DEFAULT '{}'
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due ON scheduled_tasks(trigger_at) WHERE status = 'active'`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_user ON scheduled_tasks(user_id, status)`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS execution_patterns (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        task_signature TEXT NOT NULL,
        plan TEXT NOT NULL,
        success_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,
        avg_duration_ms REAL DEFAULT 0,
        user_id TEXT,
        winning_strategy INTEGER DEFAULT 1
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_execution_patterns_user ON execution_patterns(user_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_execution_patterns_success ON execution_patterns(success_count DESC)`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS action_ledger (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        created_at TEXT DEFAULT (datetime('now')),
        agent TEXT NOT NULL,
        action_type TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('prepare', 'execute', 'verify')),
        autonomy_level INTEGER DEFAULT 0,
        approval_id TEXT,
        sandbox_backend TEXT,
        cost_usd REAL DEFAULT 0,
        outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failed', 'rejected', 'rolled_back')),
        verification TEXT,
        artifacts TEXT
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_action_ledger_agent ON action_ledger(agent, action_type, created_at DESC)`);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS autonomy_grants (
        agent TEXT NOT NULL,
        action_type TEXT NOT NULL,
        level INTEGER NOT NULL DEFAULT 0,
        clean_runs INTEGER NOT NULL DEFAULT 0,
        spend_cap_action REAL,
        spend_cap_daily REAL,
        demoted_at TEXT,
        PRIMARY KEY (agent, action_type)
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS user_integrations (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'disconnected'
          CHECK (status IN ('disconnected', 'pending', 'connected', 'error')),
        credentials TEXT DEFAULT '{}',
        metadata TEXT DEFAULT '{}',
        UNIQUE(user_id, provider)
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_user_integrations_user ON user_integrations(user_id)`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS pending_approvals (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        chat_id INTEGER NOT NULL,
        original_text TEXT NOT NULL,
        plan TEXT NOT NULL DEFAULT '{}',
        prepare_summary TEXT DEFAULT '',
        prepare_results TEXT DEFAULT '[]',
        artifacts TEXT NOT NULL DEFAULT '[]',
        execute_descriptions TEXT DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'revised', 'cancelled', 'expired')),
        feedback TEXT,
        parent_task_id TEXT REFERENCES agent_tasks(id),
        workspace_dir TEXT,
        workflow_type TEXT DEFAULT 'generic',
        request_id TEXT,
        expires_at TEXT NOT NULL DEFAULT (datetime('now', '+24 hours')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_pending_approvals_user ON pending_approvals(user_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_pending_approvals_status ON pending_approvals(status)`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS revision_sessions (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        user_id TEXT NOT NULL,
        original_text TEXT NOT NULL,
        plan TEXT NOT NULL DEFAULT '{}',
        prepare_results TEXT NOT NULL DEFAULT '[]',
        artifacts TEXT NOT NULL DEFAULT '[]',
        parent_task_id TEXT REFERENCES agent_tasks(id),
        workspace_dir TEXT,
        workflow_type TEXT DEFAULT 'generic',
        request_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed', 'cancelled')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_revision_sessions_user_status ON revision_sessions(user_id, status)`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS workflow_preferences (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        user_id TEXT NOT NULL,
        workflow_type TEXT NOT NULL,
        task_signature TEXT NOT NULL,
        plan TEXT NOT NULL,
        success_count INTEGER DEFAULT 1,
        last_used_at TEXT DEFAULT (datetime('now')),
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_prefs_unique ON workflow_preferences(user_id, task_signature)`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_contacts (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        user_id TEXT NOT NULL,
        phone TEXT NOT NULL,
        name TEXT,
        role TEXT NOT NULL DEFAULT 'allowed'
          CHECK (role IN ('allowed', 'blocked', 'vip')),
        permissions TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(user_id, phone)
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_wa_contacts_user ON whatsapp_contacts(user_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_wa_contacts_phone ON whatsapp_contacts(user_id, phone)`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS whatsapp_groups (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        user_id TEXT NOT NULL,
        group_jid TEXT NOT NULL,
        name TEXT,
        active INTEGER DEFAULT 1,
        permissions TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(user_id, group_jid)
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_wa_groups_user ON whatsapp_groups(user_id)`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS inter_user_messages (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        from_user_id TEXT NOT NULL,
        to_user_id TEXT NOT NULL,
        content TEXT NOT NULL,
        delivered INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_ium_to_user ON inter_user_messages(to_user_id, delivered)`);

    // Agent-to-agent inbox
    this.db.run(`
      CREATE TABLE IF NOT EXISTS agent_messages (
        id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        created_at  TEXT DEFAULT (datetime('now')),
        from_agent  TEXT NOT NULL,
        to_agent    TEXT NOT NULL,
        thread_id   TEXT NOT NULL,
        user_id     TEXT NOT NULL,
        subject     TEXT,
        body        TEXT NOT NULL,
        reply_to    TEXT REFERENCES agent_messages(id),
        status      TEXT DEFAULT 'unread' CHECK (status IN ('unread','read','replied')),
        reply_body  TEXT
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_agent_messages_to ON agent_messages(to_agent, status)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_agent_messages_thread ON agent_messages(thread_id)`);

    // Budget ledger
    this.db.run(`
      CREATE TABLE IF NOT EXISTS budget_ledger (
        id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        created_at   TEXT DEFAULT (datetime('now')),
        user_id      TEXT NOT NULL,
        agent_slug   TEXT NOT NULL,
        category     TEXT NOT NULL,
        description  TEXT,
        amount_usd   REAL NOT NULL,
        approved_by  TEXT NOT NULL DEFAULT 'auto' CHECK (approved_by IN ('auto','user','cfo')),
        status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','flagged')),
        task_id      TEXT REFERENCES agent_tasks(id),
        metadata     TEXT DEFAULT '{}'
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_budget_ledger_user ON budget_ledger(user_id, agent_slug, created_at)`);

    // Budget rules
    this.db.run(`
      CREATE TABLE IF NOT EXISTS budget_rules (
        id                 TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        user_id            TEXT NOT NULL,
        agent_slug         TEXT,
        category           TEXT,
        per_action_limit   REAL NOT NULL DEFAULT 100.0,
        daily_limit        REAL,
        monthly_limit      REAL,
        auto_approve_under REAL DEFAULT 10.0,
        created_at         TEXT DEFAULT (datetime('now')),
        UNIQUE(user_id, agent_slug, category)
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_budget_rules_user ON budget_rules(user_id)`);

    // Projects
    this.db.run(`
      CREATE TABLE IF NOT EXISTS projects (
        id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        created_at   TEXT DEFAULT (datetime('now')),
        updated_at   TEXT DEFAULT (datetime('now')),
        user_id      TEXT NOT NULL,
        name         TEXT NOT NULL,
        description  TEXT,
        phase        TEXT DEFAULT 'discovery' CHECK (phase IN ('discovery','planning','execution','review','complete','paused')),
        owner_agents TEXT DEFAULT '[]',
        decisions    TEXT DEFAULT '[]',
        artifacts    TEXT DEFAULT '[]',
        next_actions TEXT DEFAULT '[]',
        metadata     TEXT DEFAULT '{}',
        archived     INTEGER DEFAULT 0
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id, archived)`);

    // Calendar rules for predictive scheduling
    this.db.run(`
      CREATE TABLE IF NOT EXISTS calendar_rules (
        id                    TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        user_id               TEXT NOT NULL,
        name                  TEXT NOT NULL,
        event_keywords        TEXT NOT NULL DEFAULT '[]',
        trigger_hours_before  INTEGER DEFAULT 2,
        pipeline_template     TEXT NOT NULL,
        enabled               INTEGER DEFAULT 1,
        created_at            TEXT DEFAULT (datetime('now'))
      )
    `);

    // Queued prep tasks (predictive scheduler)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS queued_prep_tasks (
        id                  TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        user_id             TEXT NOT NULL,
        calendar_event_id   TEXT NOT NULL,
        event_title         TEXT NOT NULL,
        event_start_at      TEXT NOT NULL,
        rule_id             TEXT REFERENCES calendar_rules(id),
        task_id             TEXT REFERENCES agent_tasks(id),
        status              TEXT DEFAULT 'pending' CHECK (status IN ('pending','running','done','skipped')),
        created_at          TEXT DEFAULT (datetime('now'))
      )
    `);
    this.db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_queued_prep_unique ON queued_prep_tasks(user_id, calendar_event_id, rule_id)`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS session_summaries (
        id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        user_id      TEXT NOT NULL,
        session_key  TEXT NOT NULL,
        summary      TEXT NOT NULL,
        last_updated TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(user_id, session_key)
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_session_summaries_user ON session_summaries(user_id, last_updated)`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS task_schemas (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        name TEXT NOT NULL,
        trigger_embedding BLOB NOT NULL,
        compressed_context TEXT NOT NULL,
        expected_tools TEXT DEFAULT '[]',
        execution_template TEXT NOT NULL,
        success_rate REAL DEFAULT 1.0,
        use_count INTEGER DEFAULT 0,
        last_used TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS escalation_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        message_embedding BLOB,
        tier_reached INTEGER NOT NULL,
        execution_plan TEXT,
        success INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS trust_scores (
        task_type TEXT NOT NULL,
        user_id TEXT NOT NULL,
        level INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        last_success TEXT,
        last_failure TEXT,
        manually_set INTEGER DEFAULT 0,
        PRIMARY KEY (task_type, user_id)
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS learned_skills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        trigger_phrases TEXT NOT NULL,
        skill_path TEXT NOT NULL,
        success_count INTEGER DEFAULT 0,
        avg_duration_ms INTEGER DEFAULT 0,
        source_signature TEXT,
        created_at DATETIME DEFAULT (datetime('now')),
        updated_at DATETIME DEFAULT (datetime('now'))
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_learned_skills_slug ON learned_skills(slug)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_learned_skills_source ON learned_skills(source_signature)`);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS user_projects (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        repo_url TEXT,
        local_path TEXT,
        default_branch TEXT NOT NULL DEFAULT 'main',
        runtime TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        UNIQUE(user_id, name)
      )
    `);

    this.db.run(`CREATE TABLE IF NOT EXISTS support_tickets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      source TEXT NOT NULL DEFAULT 'resend',
      client_email TEXT NOT NULL,
      client_name TEXT,
      resend_message_id TEXT,
      subject TEXT NOT NULL,
      body_raw TEXT NOT NULL,
      classification TEXT,
      severity TEXT,
      project_id TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      branch_name TEXT,
      diff_summary TEXT,
      test_results TEXT,
      deploy_result TEXT,
      last_error TEXT
    )`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets(user_id, status)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_tickets_msgid ON support_tickets(user_id, resend_message_id)`);

      this.db.run("COMMIT");
    } catch (err) {
      try { this.db.run("ROLLBACK"); } catch {}
      throw new Error(`Database migration failed (user db: ${this.userId}): ${err instanceof Error ? err.message : String(err)}. Cannot start Nova.`);
    }

    // Safe migrations for existing databases — run AFTER the transaction
    // Safe migration for existing databases
    try { this.db.run(`ALTER TABLE memory ADD COLUMN last_accessed_at TEXT DEFAULT (datetime('now'))`); } catch {}
    try { this.db.run(`ALTER TABLE memory ADD COLUMN weight REAL DEFAULT 1.0`); } catch {}
    // Safe migration for existing databases
    try { this.db.run(`ALTER TABLE execution_patterns ADD COLUMN winning_strategy INTEGER DEFAULT 1`); } catch {}
    // Memory extensions for goal engine
    try { this.db.run(`ALTER TABLE memory ADD COLUMN last_reviewed_at TEXT`); } catch {}
    try { this.db.run(`ALTER TABLE memory ADD COLUMN progress_notes TEXT DEFAULT '[]'`); } catch {}
    // Agent tasks extensions for confidence + reputation
    try { this.db.run(`ALTER TABLE agent_tasks ADD COLUMN confidence_score REAL`); } catch {}
    try { this.db.run(`ALTER TABLE agent_tasks ADD COLUMN revised INTEGER DEFAULT 0`); } catch {}
    try { this.db.run(`ALTER TABLE agent_tasks ADD COLUMN created_by TEXT DEFAULT 'user'`); } catch {}
    // Cost tracking extension for confidence
    try { this.db.run(`ALTER TABLE cost_tracking ADD COLUMN confidence_score REAL`); } catch {}
    // Approval expiry
    try { this.db.run(`ALTER TABLE pending_approvals ADD COLUMN expires_at TEXT NOT NULL DEFAULT (datetime('now', '+24 hours'))`); } catch {}
    // User feedback ratings on execution patterns
    try { this.db.run(`ALTER TABLE execution_patterns ADD COLUMN user_rating INTEGER`); } catch {}
    try { this.db.run(`ALTER TABLE execution_patterns ADD COLUMN rated_at DATETIME`); } catch {}
    try { this.db.run("ALTER TABLE agent_tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'standard'"); } catch {}
    try { this.db.run("ALTER TABLE agent_tasks ADD COLUMN project_id TEXT"); } catch {}
    // user_projects: ticket-pipeline config columns
    try { this.db.run(`ALTER TABLE user_projects ADD COLUMN test_command TEXT`); } catch {}
    try { this.db.run(`ALTER TABLE user_projects ADD COLUMN build_command TEXT`); } catch {}
    try { this.db.run(`ALTER TABLE user_projects ADD COLUMN deploy_command TEXT`); } catch {}
    try { this.db.run(`ALTER TABLE user_projects ADD COLUMN rollback_command TEXT`); } catch {}
    try { this.db.run(`ALTER TABLE user_projects ADD COLUMN client_match TEXT`); } catch {}
    try { this.db.run(`ALTER TABLE user_projects ADD COLUMN github_remote TEXT`); } catch {}
  }

  close(): void {
    this.db.close();
  }
}

// ============================================================
// DatabaseManager — public facade, same API as old Database class
// ============================================================

export class Database {
  private shared: SharedDatabase;
  private userDbs = new Map<string, UserDatabase>();
  private maxCachedDbs = 10;

  constructor() {
    // Auto-migrate from legacy single nova.db if needed
    if (existsSync(LEGACY_DB_PATH) && !existsSync(SHARED_DB_PATH)) {
      this.migrateFromLegacyDb();
    }
    this.shared = new SharedDatabase();
  }

  /** Get the raw shared BunDatabase for advanced queries. */
  get raw(): BunDatabase {
    return this.shared.db;
  }

  /** Get the shared database object. */
  get sharedDb(): SharedDatabase {
    return this.shared;
  }

  close(): void {
    for (const [, db] of this.userDbs) db.close();
    this.userDbs.clear();
    this.shared.close();
  }

  // ---- Internal helpers ----

  private getUserDb(userId: string): UserDatabase {
    validateUserId(userId);
    let db = this.userDbs.get(userId);
    if (db) {
      // Move to end of map (most recently used)
      this.userDbs.delete(userId);
      this.userDbs.set(userId, db);
      return db;
    }

    // Evict oldest if at capacity
    if (this.userDbs.size >= this.maxCachedDbs) {
      const oldest = this.userDbs.entries().next().value;
      if (oldest) {
        oldest[1].close();
        this.userDbs.delete(oldest[0]);
      }
    }

    db = new UserDatabase(userId);
    this.userDbs.set(userId, db);
    return db;
  }

  /** Get the raw BunDatabase for a specific user (for tests/admin). */
  getUserRaw(userId: string): BunDatabase {
    return this.getUserDb(userId).db;
  }

  private getAllUserIds(): string[] {
    if (!existsSync(USERS_DIR)) return [];
    const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$|^[0-9a-f]{32}$/i;
    return readdirSync(USERS_DIR)
      .filter(f => f.endsWith(".db"))
      .map(f => f.replace(".db", ""))
      .filter(id => UUID_RE.test(id));
  }

  /** Collect results from all user databases. */
  private queryAllUserDbs<T>(fn: (db: BunDatabase) => T[]): T[] {
    const results: T[] = [];
    for (const userId of this.getAllUserIds()) {
      results.push(...fn(this.getUserDb(userId).db));
    }
    return results;
  }

  /** Find first non-null result across all user databases. */
  private findInUserDbs<T>(fn: (db: BunDatabase) => T | null): T | null {
    for (const userId of this.getAllUserIds()) {
      const result = fn(this.getUserDb(userId).db);
      if (result) return result;
    }
    return null;
  }

  /** Run a mutation on all user databases. */
  private runOnAllUserDbs(fn: (db: BunDatabase) => void): void {
    for (const userId of this.getAllUserIds()) {
      fn(this.getUserDb(userId).db);
    }
  }

  // ============================================================
  // Users (→ shared.db)
  // ============================================================

  getUserByTelegramId(telegramId: string): any | null {
    const row = this.shared.db.query(
      `SELECT * FROM users WHERE telegram_id = ? AND active = 1 LIMIT 1`
    ).get(telegramId) as any;
    if (!row) return null;
    row.preferences = parseJson(row.preferences, {});
    return row;
  }

  getUserByPhone(phone: string): any | null {
    const row = this.shared.db.query(
      `SELECT * FROM users WHERE phone = ? AND active = 1 LIMIT 1`
    ).get(phone) as any;
    if (!row) return null;
    row.preferences = parseJson(row.preferences, {});
    return row;
  }

  getUserByWhatsappId(whatsappId: string): any | null {
    const row = this.shared.db.query(
      `SELECT * FROM users WHERE whatsapp_id = ? LIMIT 1`
    ).get(whatsappId) as any;
    if (!row) return null;
    row.preferences = parseJson(row.preferences, {});
    return row;
  }

  getUserBySlackId(slackId: string): any | null {
    const row = this.shared.db.query(
      `SELECT * FROM users WHERE slack_id = ? LIMIT 1`
    ).get(slackId) as any;
    if (!row) return null;
    row.preferences = parseJson(row.preferences, {});
    return row;
  }

  getUserById(userId: string): any | null {
    const row = this.shared.db.query(
      `SELECT * FROM users WHERE id = ? LIMIT 1`
    ).get(userId) as any;
    if (!row) return null;
    row.preferences = parseJson(row.preferences, {});
    return row;
  }

  // ---- Onboarding (first-run welcome) ----

  /** Returns the ISO timestamp of the user's first-run welcome, or null if they haven't been onboarded. */
  getOnboardedAt(userId: string): string | null {
    const row = this.shared.db.query(
      `SELECT onboarded_at FROM users WHERE id = ? LIMIT 1`
    ).get(userId) as any;
    return row?.onboarded_at ?? null;
  }

  /** Marks the user as onboarded (idempotent — only sets the timestamp the first time). */
  setOnboardedAt(userId: string): void {
    this.shared.db.run(
      `UPDATE users SET onboarded_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND onboarded_at IS NULL`,
      [userId]
    );
  }

  // ---- Approval Rules ----

  getApprovalRules(userId: string): ApprovalRule[] {
    const user = this.getUserById(userId);
    if (!user?.approval_rules) return [];
    try {
      return JSON.parse(user.approval_rules);
    } catch {
      return [];
    }
  }

  setApprovalRules(userId: string, rules: ApprovalRule[]): void {
    this.shared.db.run(
      `UPDATE users SET approval_rules = ?, updated_at = datetime('now') WHERE id = ?`,
      [JSON.stringify(rules), userId]
    );
  }

  // ---- Kapso (WhatsApp Cloud API) credentials ----

  setKapsoCredentials(userId: string, apiKey: string, phoneNumberId: string): void {
    this.shared.db.run(
      `UPDATE users SET kapso_api_key = ?, kapso_phone_number_id = ?, updated_at = datetime('now') WHERE id = ?`,
      [encryptCredentials(apiKey), phoneNumberId, userId]
    );
  }

  clearKapsoCredentials(userId: string): void {
    this.shared.db.run(
      `UPDATE users SET kapso_api_key = NULL, kapso_phone_number_id = NULL, updated_at = datetime('now') WHERE id = ?`,
      [userId]
    );
  }

  getKapsoCredentials(userId: string): { kapso_api_key: string | null; kapso_phone_number_id: string | null } | null {
    const row = this.shared.db.query(
      `SELECT kapso_api_key, kapso_phone_number_id FROM users WHERE id = ? LIMIT 1`
    ).get(userId) as any;
    if (!row) return null;
    return {
      kapso_api_key: row.kapso_api_key ? decryptCredentials(row.kapso_api_key) : null,
      kapso_phone_number_id: row.kapso_phone_number_id,
    };
  }

  getUserByKapsoPhoneNumberId(phoneNumberId: string): any | null {
    const row = this.shared.db.query(
      `SELECT * FROM users WHERE kapso_phone_number_id = ? LIMIT 1`
    ).get(phoneNumberId) as any;
    if (!row) return null;
    row.preferences = parseJson(row.preferences, {});
    return row;
  }

  getUsersWithKapso(): any[] {
    const rows = this.shared.db.query(
      `SELECT * FROM users WHERE kapso_api_key IS NOT NULL AND kapso_phone_number_id IS NOT NULL AND active = 1`
    ).all() as any[];
    return rows.map((r) => {
      r.preferences = parseJson(r.preferences, {});
      return r;
    });
  }

  upsertUser(data: {
    telegram_id: string;
    name: string;
    timezone?: string;
    phone?: string;
    pin?: string;
    role?: string;
    preferences?: Record<string, any>;
    profile_text?: string;
  }): any {
    const id = uuid();
    this.shared.db.run(`
      INSERT INTO users (id, telegram_id, name, timezone, phone, pin, role, preferences, profile_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (telegram_id) DO UPDATE SET
        name = COALESCE(excluded.name, users.name),
        timezone = COALESCE(excluded.timezone, users.timezone),
        phone = COALESCE(excluded.phone, users.phone),
        pin = COALESCE(excluded.pin, users.pin),
        updated_at = datetime('now')
    `, [
      id,
      data.telegram_id,
      data.name,
      data.timezone || "UTC",
      data.phone || null,
      data.pin || null,
      data.role || "member",
      JSON.stringify(data.preferences || {}),
      data.profile_text || "",
    ]);
    return this.getUserByTelegramId(data.telegram_id);
  }

  updateUserPreference(userId: string, key: string, value: any): void {
    const row = this.shared.db.query(`SELECT preferences FROM users WHERE id = ?`).get(userId) as any;
    if (!row) return;
    const prefs = parseJson(row.preferences, {});
    prefs[key] = value;
    this.shared.db.run(
      `UPDATE users SET preferences = ?, updated_at = datetime('now') WHERE id = ?`,
      [JSON.stringify(prefs), userId]
    );
  }

  updateUser(userId: string, updates: Record<string, any>): any | null {
    const allowed = ["name", "timezone", "phone", "pin", "profile_text", "active", "preferences", "ai_provider", "ai_config"];
    const setClauses: string[] = [];
    const values: any[] = [];

    for (const [key, val] of Object.entries(updates)) {
      if (!allowed.includes(key)) continue;
      setClauses.push(`${key} = ?`);
      values.push(key === "preferences" ? JSON.stringify(val) : val);
    }

    if (setClauses.length === 0) return this.getUserById(userId);

    setClauses.push(`updated_at = datetime('now')`);
    values.push(userId);

    this.shared.db.run(
      `UPDATE users SET ${setClauses.join(", ")} WHERE id = ?`,
      values
    );
    return this.getUserById(userId);
  }

  getAllActiveUsers(): any[] {
    const rows = this.shared.db.query(
      `SELECT * FROM users WHERE active = 1`
    ).all() as any[];
    return rows.map((r) => {
      r.preferences = parseJson(r.preferences, {});
      return r;
    });
  }

  getUserByUsername(username: string): any | null {
    return this.shared.db.query(`SELECT * FROM users WHERE username = ? AND active = 1`).get(username) as any ?? null;
  }

  setUsername(userId: string, username: string): void {
    this.shared.db.run(`UPDATE users SET username = ?, updated_at = datetime('now') WHERE id = ?`, [username, userId]);
  }

  setUserPassword(userId: string, passwordHash: string, mustChange: boolean): void {
    this.shared.db.run(
      `UPDATE users SET password_hash = ?, must_change_password = ?, updated_at = datetime('now') WHERE id = ?`,
      [passwordHash, mustChange ? 1 : 0, userId]
    );
  }

  // ============================================================
  // Shared Credentials (→ shared.db)
  // ============================================================

  upsertSharedCredential(data: { provider: string; kind: string; credentials: Record<string, any>; created_by: string }): void {
    this.shared.db.run(`
      INSERT INTO shared_credentials (id, provider, kind, credentials, created_by)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        kind = excluded.kind,
        credentials = excluded.credentials,
        created_by = excluded.created_by,
        updated_at = datetime('now')
    `, [uuid(), data.provider, data.kind, encryptCredentials(JSON.stringify(data.credentials || {})), data.created_by]);
  }

  getSharedCredential(provider: string): any | null {
    const row = this.shared.db.query(`SELECT provider, kind, credentials, metadata FROM shared_credentials WHERE provider = ?`).get(provider) as any;
    if (!row) return null;
    return {
      provider: row.provider,
      kind: row.kind,
      credentials: parseJson(decryptCredentials(row.credentials), {}),
      metadata: parseJson(row.metadata, {}),
    };
  }

  listSharedCredentials(): any[] {
    return this.shared.db.query(`SELECT provider, kind, created_by, updated_at FROM shared_credentials ORDER BY provider ASC`).all() as any[];
  }

  deleteSharedCredential(provider: string): void {
    this.shared.db.run(`DELETE FROM shared_credentials WHERE provider = ?`, [provider]);
  }

  getUsersByRole(role: string): any[] {
    const rows = this.shared.db.query(
      `SELECT * FROM users WHERE role = ? AND active = 1`
    ).all(role) as any[];
    return rows.map((r) => {
      r.preferences = parseJson(r.preferences, {});
      return r;
    });
  }

  getTeamMembers(teamId: string): any[] {
    const rows = this.shared.db.query(
      `SELECT * FROM users WHERE team_id = ? AND active = 1`
    ).all(teamId) as any[];
    return rows.map((r) => {
      r.preferences = parseJson(r.preferences, {});
      return r;
    });
  }

  getTeamRoster(teamId: string): Array<{ id: string; name: string; telegram_id: string; timezone: string }> {
    return this.shared.db.query(
      `SELECT id, name, telegram_id, timezone FROM users WHERE team_id = ? AND active = 1 ORDER BY name`
    ).all(teamId) as any[];
  }

  getUsersByTeam(teamId: string): any[] {
    return this.getTeamMembers(teamId);
  }

  // ============================================================
  // Inter-user messaging (→ recipient's user DB)
  // ============================================================

  saveInterUserMessage(msg: { from_user_id: string; to_user_id: string; content: string }): void {
    const udb = this.getUserDb(msg.to_user_id);
    udb.db.run(
      `INSERT INTO inter_user_messages (from_user_id, to_user_id, content) VALUES (?, ?, ?)`,
      [msg.from_user_id, msg.to_user_id, msg.content]
    );
  }

  getPendingMessages(userId: string): Array<{ id: string; from_user_id: string; content: string; created_at: string }> {
    const udb = this.getUserDb(userId);
    return udb.db.query(
      `SELECT id, from_user_id, content, created_at FROM inter_user_messages WHERE to_user_id = ? AND delivered = 0 ORDER BY created_at`
    ).all(userId) as any[];
  }

  markMessageDelivered(userId: string, messageId: string): void {
    const udb = this.getUserDb(userId);
    udb.db.run(`UPDATE inter_user_messages SET delivered = 1 WHERE id = ?`, [messageId]);
  }

  // ============================================================
  // Cross-User Access Grants
  // ============================================================

  /** Get the access level that grantorId has given to granteeId (null = no grant). */
  getAccessGrant(grantorId: string, granteeId: string): string | null {
    const row = this.shared.db.query(
      `SELECT level FROM user_access_grants WHERE grantor_user_id = ? AND grantee_user_id = ? LIMIT 1`
    ).get(grantorId, granteeId) as any;
    return row?.level ?? null;
  }

  /** Set or update the access level that grantorId gives to granteeId. Level 'none' removes the grant. */
  setAccessGrant(grantorId: string, granteeId: string, level: string): void {
    if (level === "none") {
      this.shared.db.run(
        `DELETE FROM user_access_grants WHERE grantor_user_id = ? AND grantee_user_id = ?`,
        [grantorId, granteeId]
      );
    } else {
      this.shared.db.run(
        `INSERT INTO user_access_grants (grantor_user_id, grantee_user_id, level)
         VALUES (?, ?, ?)
         ON CONFLICT(grantor_user_id, grantee_user_id) DO UPDATE SET level = excluded.level`,
        [grantorId, granteeId, level]
      );
    }
  }

  /** Get all users who have granted granteeId access (and the level). */
  getGrantedUsers(granteeId: string): Array<{ grantor_user_id: string; level: string }> {
    return this.shared.db.query(
      `SELECT grantor_user_id, level FROM user_access_grants WHERE grantee_user_id = ?`
    ).all(granteeId) as any[];
  }

  /** Set job role for a user (e.g. "developer", "account_manager", "designer"). */
  setJobRole(userId: string, jobRole: string): void {
    this.shared.db.run(
      `UPDATE users SET job_role = ?, updated_at = datetime('now') WHERE id = ?`,
      [jobRole, userId]
    );
  }

  /** Get job role for a user. */
  getJobRole(userId: string): string {
    const row = this.shared.db.query(
      `SELECT job_role FROM users WHERE id = ? LIMIT 1`
    ).get(userId) as any;
    return row?.job_role || "general";
  }

  // ============================================================
  // Messages (→ user DB)
  // ============================================================

  saveMessage(data: {
    role: string;
    content: string;
    channel?: string;
    metadata?: Record<string, unknown>;
    user_id: string;
    embedding?: number[] | null;
  }): string {
    const id = uuid();
    const udb = this.getUserDb(data.user_id);
    udb.db.run(`
      INSERT INTO messages (id, role, content, channel, metadata, user_id, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      data.role,
      data.content,
      data.channel || "telegram",
      JSON.stringify(data.metadata || {}),
      data.user_id,
      data.embedding ? embeddingToBlob(data.embedding) : null,
    ]);
    return id;
  }

  getRecentMessages(userId: string, limit: number = 20): any[] {
    const udb = this.getUserDb(userId);
    return udb.db.query(`
      SELECT id, created_at, role, content
      FROM messages
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(userId, limit) as any[];
  }

  countTodayMessages(userId: string, opts?: {
    role?: string;
    metadataFilter?: Record<string, any>;
  }): number {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    let sql = `SELECT COUNT(*) as count FROM messages WHERE user_id = ? AND created_at >= ?`;
    const params: any[] = [userId, todayStart.toISOString()];

    if (opts?.role) {
      sql += ` AND role = ?`;
      params.push(opts.role);
    }

    if (opts?.metadataFilter) {
      for (const [key, value] of Object.entries(opts.metadataFilter)) {
        sql += ` AND json_extract(metadata, ?) = ?`;
        params.push(`$.${key}`, typeof value === "string" ? value : JSON.stringify(value));
      }
    }

    const udb = this.getUserDb(userId);
    const row = udb.db.query(sql).get(...params) as any;
    return row?.count || 0;
  }

  getLastUserMessage(userId: string): any | null {
    const udb = this.getUserDb(userId);
    return udb.db.query(`
      SELECT created_at FROM messages
      WHERE user_id = ? AND role = 'user'
      ORDER BY created_at DESC LIMIT 1
    `).get(userId) as any;
  }

  hasRecentActivity(userId: string, withinMinutes: number): boolean {
    const cutoff = new Date(Date.now() - withinMinutes * 60 * 1000).toISOString();
    const udb = this.getUserDb(userId);
    const row = udb.db.query(`
      SELECT id FROM messages
      WHERE user_id = ? AND role = 'user' AND created_at >= ?
      LIMIT 1
    `).get(userId, cutoff) as any;
    return !!row;
  }

  getMessagesForDashboard(opts?: { userId?: string; limit?: number }): any[] {
    const limit = opts?.limit || 50;
    if (opts?.userId) {
      const udb = this.getUserDb(opts.userId);
      return udb.db.query(`
        SELECT id, created_at, role, content, channel, metadata
        FROM messages WHERE user_id = ?
        ORDER BY created_at DESC LIMIT ?
      `).all(opts.userId, limit) as any[];
    }
    // Aggregate from all user DBs
    const all = this.queryAllUserDbs(db =>
      db.query(`
        SELECT id, created_at, role, content, channel, metadata
        FROM messages ORDER BY created_at DESC LIMIT ?
      `).all(limit) as any[]
    );
    return all.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
  }

  getMessageCountSince(since: string, userId?: string): number {
    if (userId) {
      const udb = this.getUserDb(userId);
      const row = udb.db.query(
        `SELECT COUNT(*) as count FROM messages WHERE created_at >= ? AND user_id = ?`
      ).get(since, userId) as any;
      return row?.count || 0;
    }
    let total = 0;
    for (const uid of this.getAllUserIds()) {
      const udb = this.getUserDb(uid);
      const row = udb.db.query(
        `SELECT COUNT(*) as count FROM messages WHERE created_at >= ?`
      ).get(since) as any;
      total += row?.count || 0;
    }
    return total;
  }

  getMessagesSince(since: string, userId?: string): any[] {
    if (userId) {
      const udb = this.getUserDb(userId);
      return udb.db.query(`
        SELECT channel, role, created_at FROM messages
        WHERE created_at >= ? AND user_id = ?
      `).all(since, userId) as any[];
    }
    return this.queryAllUserDbs(db =>
      db.query(`SELECT channel, role, created_at FROM messages WHERE created_at >= ?`).all(since) as any[]
    );
  }

  // ============================================================
  // Vector Search (sqlite-vec)
  // ============================================================

  matchMessages(queryEmbedding: number[], userId: string, opts?: {
    matchThreshold?: number;
    matchCount?: number;
  }): VectorMatch[] {
    const threshold = opts?.matchThreshold ?? 0.7;
    const limit = opts?.matchCount ?? 10;
    const blob = embeddingToBlob(queryEmbedding);

    const udb = this.getUserDb(userId);
    const rows = udb.db.query(`
      SELECT id, content, role, created_at,
        (1.0 - vec_distance_cosine(embedding, ?)) AS similarity
      FROM messages
      WHERE user_id = ? AND embedding IS NOT NULL
      ORDER BY vec_distance_cosine(embedding, ?) ASC
      LIMIT ?
    `).all(blob, userId, blob, limit) as any[];

    return rows.filter((r: any) => r.similarity > threshold);
  }

  matchMemory(queryEmbedding: number[], userId: string, opts?: {
    matchThreshold?: number;
    matchCount?: number;
  }): VectorMatch[] {
    const threshold = opts?.matchThreshold ?? 0.7;
    const limit = opts?.matchCount ?? 10;
    const blob = embeddingToBlob(queryEmbedding);

    // Query user DB (private memory)
    const udb = this.getUserDb(userId);
    const userRows = udb.db.query(`
      SELECT id, content, type, created_at,
        (1.0 - vec_distance_cosine(embedding, ?)) AS similarity
      FROM memory
      WHERE user_id = ? AND embedding IS NOT NULL
      ORDER BY vec_distance_cosine(embedding, ?) ASC
      LIMIT ?
    `).all(blob, userId, blob, limit) as any[];

    // Query shared DB (shared memory)
    const sharedRows = this.shared.db.query(`
      SELECT id, content, type, created_at,
        (1.0 - vec_distance_cosine(embedding, ?)) AS similarity
      FROM memory
      WHERE embedding IS NOT NULL
      ORDER BY vec_distance_cosine(embedding, ?) ASC
      LIMIT ?
    `).all(blob, blob, limit) as any[];

    // Merge by similarity, filter threshold, take top N
    const all = [...userRows, ...sharedRows]
      .filter((r: any) => r.similarity > threshold)
      .sort((a: any, b: any) => b.similarity - a.similarity)
      .slice(0, limit);

    return all;
  }

  // ============================================================
  // Memory (Facts, Goals) — routed by scope
  // ============================================================

  insertMemory(data: {
    type: string;
    content: string;
    user_id: string;
    scope?: string;
    deadline?: string | null;
    embedding?: number[] | null;
    priority?: number;
    weight?: number;
  }): string {
    const id = uuid();
    const scope = data.scope || "private";
    const targetDb = scope === "shared" ? this.shared.db : this.getUserDb(data.user_id).db;

    targetDb.run(`
      INSERT INTO memory (id, type, content, user_id, scope, deadline, embedding, priority, weight, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `, [
      id,
      data.type,
      data.content,
      data.user_id,
      scope,
      data.deadline || null,
      data.embedding ? embeddingToBlob(data.embedding) : null,
      data.priority || 0,
      data.weight ?? 1.0,
    ]);
    return id;
  }

  updateMemoryAccessTime(id: string): void {
    const sql = `UPDATE memory SET last_accessed_at = datetime('now') WHERE id = ?`;
    this.shared.db.run(sql, [id]);
    this.runOnAllUserDbs(db => db.run(sql, [id]));
  }

  updateMultipleMemoryAccessTimes(ids: string[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    const sql = `UPDATE memory SET last_accessed_at = datetime('now') WHERE id IN (${placeholders})`;
    this.shared.db.run(sql, ids);
    this.runOnAllUserDbs(db => db.run(sql, ids));
  }

  updateMemoryWeight(id: string, weight: number): void {
    const sql = `UPDATE memory SET weight = ? WHERE id = ?`;
    this.shared.db.run(sql, [weight, id]);
    this.runOnAllUserDbs(db => db.run(sql, [weight, id]));
  }

  updateMemory(id: string, updates: Partial<DbMemory>): void {
    const ALLOWED_FIELDS = new Set(["type", "content", "deadline", "completed_at", "priority", "scope", "weight", "last_accessed_at", "embedding"]);
    const fields = Object.keys(updates).filter(k => ALLOWED_FIELDS.has(k));
    if (fields.length === 0) return;

    const setClause = fields.map(f => `${f} = ?`).join(", ");
    const values = fields.map(f => (updates as any)[f]);
    const sql = `UPDATE memory SET ${setClause}, updated_at = datetime('now') WHERE id = ?`;

    this.shared.db.run(sql, [...values, id]);
    this.runOnAllUserDbs(db => db.run(sql, [...values, id]));
  }

  getFacts(userId: string): any[] {
    // Private facts from user DB
    const udb = this.getUserDb(userId);
    const privateFacts = udb.db.query(`
      SELECT id, content FROM memory
      WHERE type = 'fact' AND user_id = ?
      ORDER BY created_at DESC
    `).all(userId) as any[];

    // Shared facts from shared DB
    const sharedFacts = this.shared.db.query(`
      SELECT id, content FROM memory
      WHERE type = 'fact' AND scope = 'shared'
      ORDER BY created_at DESC
    `).all() as any[];

    return [...privateFacts, ...sharedFacts];
  }

  getActiveGoals(userId: string): any[] {
    const udb = this.getUserDb(userId);
    return udb.db.query(`
      SELECT id, content, deadline, priority FROM memory
      WHERE type = 'goal' AND user_id = ?
      ORDER BY priority DESC, created_at DESC
    `).all(userId) as any[];
  }

  findMemoryByContent(userId: string, type: string, searchText: string): any | null {
    // Check user DB first
    const udb = this.getUserDb(userId);
    const userResult = udb.db.query(`
      SELECT id FROM memory
      WHERE type = ? AND user_id = ? AND content LIKE ? COLLATE NOCASE
      LIMIT 1
    `).get(type, userId, `%${searchText}%`) as any;
    if (userResult) return userResult;

    // Check shared DB
    return this.shared.db.query(`
      SELECT id FROM memory
      WHERE type = ? AND user_id = ? AND content LIKE ? COLLATE NOCASE
      LIMIT 1
    `).get(type, userId, `%${searchText}%`) as any;
  }



  getMemoryForDashboard(opts?: { type?: string; userId?: string; limit?: number }): any[] {
    const limit = opts?.limit || 100;
    let sql = `SELECT id, created_at, updated_at, last_accessed_at, weight, type, content, deadline, completed_at, priority, scope FROM memory`;
    const conditions: string[] = [];
    const params: any[] = [];

    if (opts?.type) { conditions.push(`type = ?`); params.push(opts.type); }
    if (opts?.userId) { conditions.push(`user_id = ?`); params.push(opts.userId); }

    if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    // Query both shared and user DBs
    const sharedRows = this.shared.db.query(sql).all(...params) as any[];

    let userRows: any[];
    if (opts?.userId) {
      userRows = this.getUserDb(opts.userId).db.query(sql).all(...params) as any[];
    } else {
      userRows = this.queryAllUserDbs(db => db.query(sql).all(...params) as any[]);
    }

    return [...sharedRows, ...userRows]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  }

  deleteMemoryEntries(ids: string[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    const sql = `DELETE FROM memory WHERE id IN (${placeholders})`;
    // Delete from shared
    this.shared.db.run(sql, ids);
    // Delete from all user DBs
    this.runOnAllUserDbs(db => db.run(sql, ids));
  }

  getAllFacts(): any[] {
    // Shared facts
    const sharedFacts = this.shared.db.query(`
      SELECT id, type, content, created_at, user_id, scope
      FROM memory WHERE type = 'fact'
      ORDER BY created_at DESC
    `).all() as any[];

    // Private facts from all user DBs
    const userFacts = this.queryAllUserDbs(db =>
      db.query(`
        SELECT id, type, content, created_at, user_id, scope
        FROM memory WHERE type = 'fact'
        ORDER BY created_at DESC
      `).all() as any[]
    );

    return [...sharedFacts, ...userFacts];
  }

  getCompletedGoalsBefore(cutoffDate: string): any[] {
    // Check shared
    const sharedGoals = this.shared.db.query(`
      SELECT id, type, content, created_at, user_id, scope
      FROM memory
      WHERE type = 'completed_goal' AND completed_at < ?
    `).all(cutoffDate) as any[];

    // Check all user DBs
    const userGoals = this.queryAllUserDbs(db =>
      db.query(`
        SELECT id, type, content, created_at, user_id, scope
        FROM memory
        WHERE type = 'completed_goal' AND completed_at < ?
      `).all(cutoffDate) as any[]
    );

    return [...sharedGoals, ...userGoals];
  }

  // ============================================================
  // Tasks (→ user DB)
  // ============================================================

  insertTask(data: {
    agent: string;
    description: string;
    status?: string;
    user_id: string;
    parent_task_id?: string | null;
    request_id?: string | null;
    created_by?: string;
  }): string {
    const id = uuid();
    const udb = this.getUserDb(data.user_id);
    udb.db.run(`
      INSERT INTO agent_tasks (id, agent, description, status, user_id, parent_task_id, request_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      data.agent,
      data.description,
      data.status || "pending",
      data.user_id,
      data.parent_task_id || null,
      data.request_id || null,
      data.created_by || "user",
    ]);
    return id;
  }

  getActiveTasks(userId: string): any[] {
    const udb = this.getUserDb(userId);
    return udb.db.query(`
      SELECT * FROM agent_tasks
      WHERE status IN ('pending', 'in_progress', 'blocked') AND user_id = ?
      ORDER BY created_at DESC
    `).all(userId) as any[];
  }

  updateTask(id: string, updates: Record<string, any>): void {
    const setClauses: string[] = [];
    const values: any[] = [];

    for (const [key, val] of Object.entries(updates)) {
      setClauses.push(`${key} = ?`);
      values.push(val);
    }

    setClauses.push(`updated_at = datetime('now')`);
    values.push(id);

    const sql = `UPDATE agent_tasks SET ${setClauses.join(", ")} WHERE id = ?`;
    this.runOnAllUserDbs(db => db.run(sql, values));
  }

  findTaskByDescription(userId: string, statuses: string[], searchText: string): any | null {
    const udb = this.getUserDb(userId);
    const placeholders = statuses.map(() => "?").join(",");
    return udb.db.query(`
      SELECT id FROM agent_tasks
      WHERE status IN (${placeholders}) AND user_id = ? AND description LIKE ? COLLATE NOCASE
      LIMIT 1
    `).get(...statuses, userId, `%${searchText}%`) as any;
  }

  getAgentTaskStats(userId: string): any[] {
    const udb = this.getUserDb(userId);
    return udb.db.query(`
      SELECT agent, status FROM agent_tasks WHERE user_id = ?
    `).all(userId) as any[];
  }

  getTasksByAgent(userId: string, agent: string, limit: number = 20): any[] {
    const udb = this.getUserDb(userId);
    return udb.db.query(`
      SELECT * FROM agent_tasks WHERE user_id = ? AND agent = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(userId, agent, limit) as any[];
  }

  getParentTasks(userId: string, limit: number = 50): any[] {
    const udb = this.getUserDb(userId);
    return udb.db.query(`
      SELECT * FROM agent_tasks WHERE user_id = ? AND parent_task_id IS NULL
      ORDER BY created_at DESC LIMIT ?
    `).all(userId, limit) as any[];
  }

  getSubtasksByParentIds(parentIds: string[]): any[] {
    if (parentIds.length === 0) return [];
    const placeholders = parentIds.map(() => "?").join(",");
    const sql = `SELECT * FROM agent_tasks WHERE parent_task_id IN (${placeholders}) ORDER BY created_at ASC`;
    return this.queryAllUserDbs(db => db.query(sql).all(...parentIds) as any[]);
  }

  getTaskById(taskId: string, userId?: string): any | null {
    if (userId) {
      const udb = this.getUserDb(userId);
      return udb.db.query(
        `SELECT * FROM agent_tasks WHERE id = ? AND user_id = ?`
      ).get(taskId, userId) as any;
    }
    return this.findInUserDbs(db =>
      db.query(`SELECT * FROM agent_tasks WHERE id = ?`).get(taskId) as any
    );
  }

  getArtifactsByTaskIds(taskIds: string[]): any[] {
    if (taskIds.length === 0) return [];
    const placeholders = taskIds.map(() => "?").join(",");
    const sql = `SELECT * FROM task_artifacts WHERE task_id IN (${placeholders}) ORDER BY created_at ASC`;
    return this.queryAllUserDbs(db => db.query(sql).all(...taskIds) as any[]);
  }

  // ============================================================
  // Scheduled Tasks (→ user DB)
  // ============================================================

  insertScheduledTask(data: {
    user_id: string;
    created_by?: string;
    title: string;
    instructions: string;
    trigger_at?: string | null;
    recurrence?: string | null;
    timezone?: string;
    condition?: string | null;
    max_runs?: number | null;
  }): string {
    const id = uuid();
    const udb = this.getUserDb(data.user_id);
    udb.db.run(`
      INSERT INTO scheduled_tasks (id, user_id, created_by, title, instructions, trigger_at, next_run_at, recurrence, timezone, condition, max_runs)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      data.user_id,
      data.created_by || "user",
      data.title,
      data.instructions,
      data.trigger_at || null,
      data.trigger_at || null,
      data.recurrence || null,
      data.timezone || "UTC",
      data.condition || null,
      data.max_runs ?? null,
    ]);
    return id;
  }

  getScheduledTasks(userId: string): any[] {
    const udb = this.getUserDb(userId);
    return udb.db.query(`
      SELECT id, title, instructions, COALESCE(next_run_at, trigger_at) AS trigger_at, recurrence, timezone, created_by, status, condition
      FROM scheduled_tasks
      WHERE user_id = ? AND status = 'active'
      ORDER BY COALESCE(next_run_at, trigger_at) ASC
    `).all(userId) as any[];
  }

  cancelScheduledTask(userId: string, taskId: string): boolean {
    const udb = this.getUserDb(userId);
    const result = udb.db.run(
      `UPDATE scheduled_tasks SET status = 'cancelled', updated_at = datetime('now') WHERE id = ? AND user_id = ?`,
      [taskId, userId]
    );
    return (result.changes ?? 0) > 0;
  }

  getDueTasks(): any[] {
    const nowStr = new Date().toISOString();
    const sql = `
      SELECT id, user_id, created_by, title, instructions, trigger_at, recurrence,
             timezone, condition, max_runs, run_count, metadata
      FROM scheduled_tasks
      WHERE status = 'active' AND trigger_at <= ?
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY trigger_at ASC
      LIMIT 10
    `;
    return this.queryAllUserDbs(db => db.query(sql).all(nowStr, nowStr) as any[]);
  }

  updateScheduledTask(id: string, updates: Record<string, any>, userId?: string): void {
    const setClauses: string[] = [];
    const values: any[] = [];

    for (const [key, val] of Object.entries(updates)) {
      setClauses.push(`${key} = ?`);
      values.push(val);
    }

    setClauses.push(`updated_at = datetime('now')`);
    values.push(id);

    if (userId) {
      values.push(userId);
      const sql = `UPDATE scheduled_tasks SET ${setClauses.join(", ")} WHERE id = ? AND user_id = ?`;
      const udb = this.getUserDb(userId);
      udb.db.run(sql, values);
    } else {
      const sql = `UPDATE scheduled_tasks SET ${setClauses.join(", ")} WHERE id = ?`;
      this.runOnAllUserDbs(db => db.run(sql, values));
    }
  }

  findScheduledTaskByTitle(
    userId: string,
    searchText: string,
    statuses: string[] = ["active", "paused"]
  ): any | null {
    const udb = this.getUserDb(userId);
    const placeholders = statuses.map(() => "?").join(", ");
    return udb.db.query(`
      SELECT id, title, status, recurrence FROM scheduled_tasks
      WHERE user_id = ? AND status IN (${placeholders}) AND title LIKE ? COLLATE NOCASE
      ORDER BY COALESCE(next_run_at, trigger_at) ASC
      LIMIT 1
    `).get(userId, ...statuses, `%${searchText}%`) as any;
  }

  // Active + paused tasks — the set a user can manage (pause/resume/edit/cancel).
  getManageableScheduledTasks(userId: string): any[] {
    const udb = this.getUserDb(userId);
    return udb.db.query(`
      SELECT id, title, instructions, COALESCE(next_run_at, trigger_at) AS trigger_at, recurrence, timezone, created_by, status, condition
      FROM scheduled_tasks
      WHERE user_id = ? AND status IN ('active', 'paused')
      ORDER BY status ASC, COALESCE(next_run_at, trigger_at) ASC
    `).all(userId) as any[];
  }

  getUpcomingScheduledTasks(userId: string, fromTime: string, toTime: string, limit: number = 5): any[] {
    const udb = this.getUserDb(userId);
    return udb.db.query(`
      SELECT title, next_run_at FROM scheduled_tasks
      WHERE user_id = ? AND status = 'active'
        AND next_run_at >= ? AND next_run_at <= ?
      ORDER BY next_run_at ASC LIMIT ?
    `).all(userId, fromTime, toTime, limit) as any[];
  }

  // ============================================================
  // Integrations (→ user DB)
  // ============================================================

  getUserIntegrations(userId: string): any[] {
    const udb = this.getUserDb(userId);
    return udb.db.query(`
      SELECT id, provider, status, metadata, updated_at
      FROM user_integrations
      WHERE user_id = ?
      ORDER BY provider
    `).all(userId) as any[];
  }

  upsertIntegration(data: {
    user_id: string;
    provider: string;
    status: string;
    credentials?: Record<string, any>;
    metadata?: Record<string, any>;
  }): void {
    const udb = this.getUserDb(data.user_id);
    udb.db.run(`
      INSERT INTO user_integrations (id, user_id, provider, status, credentials, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, provider) DO UPDATE SET
        status = excluded.status,
        credentials = CASE WHEN excluded.credentials = '{}' THEN user_integrations.credentials ELSE excluded.credentials END,
        metadata = CASE WHEN excluded.metadata = '{}' THEN user_integrations.metadata ELSE excluded.metadata END,
        updated_at = datetime('now')
    `, [
      uuid(),
      data.user_id,
      data.provider,
      data.status,
      encryptCredentials(JSON.stringify(data.credentials || {})),
      JSON.stringify(data.metadata || {}),
    ]);
  }

  getIntegrationCredentials(userId: string, provider: string): any | null {
    const udb = this.getUserDb(userId);
    const row = udb.db.query(`
      SELECT credentials, metadata FROM user_integrations
      WHERE user_id = ? AND provider = ? AND status = 'connected'
      LIMIT 1
    `).get(userId, provider) as any;
    if (!row) return null;
    return {
      credentials: parseJson(decryptCredentials(row.credentials), {}),
      metadata: parseJson(row.metadata, {}),
    };
  }

  getConnectedIntegrations(userId: string): any[] {
    const udb = this.getUserDb(userId);
    const rows = udb.db.query(`
      SELECT provider, status, credentials, metadata FROM user_integrations
      WHERE user_id = ? AND status = 'connected'
    `).all(userId) as any[];
    return rows.map((r) => ({
      ...r,
      credentials: parseJson(decryptCredentials(r.credentials), {}),
      metadata: parseJson(r.metadata, {}),
    }));
  }

  // ============================================================
  // WhatsApp Contacts (→ user DB)
  // ============================================================

  getWhatsappContact(userId: string, phone: string): any | null {
    const udb = this.getUserDb(userId);
    const row = udb.db.query(
      `SELECT * FROM whatsapp_contacts WHERE user_id = ? AND phone = ? LIMIT 1`
    ).get(userId, phone) as any;
    if (!row) return null;
    row.permissions = parseJson(row.permissions, {});
    return row;
  }

  getWhatsappContacts(userId: string): any[] {
    const udb = this.getUserDb(userId);
    const rows = udb.db.query(
      `SELECT * FROM whatsapp_contacts WHERE user_id = ? ORDER BY name, phone`
    ).all(userId) as any[];
    return rows.map((r) => {
      r.permissions = parseJson(r.permissions, {});
      return r;
    });
  }

  upsertWhatsappContact(userId: string, phone: string, name: string | null, role: string, permissions: Record<string, any>): void {
    const udb = this.getUserDb(userId);
    udb.db.run(`
      INSERT INTO whatsapp_contacts (id, user_id, phone, name, role, permissions)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, phone) DO UPDATE SET
        name = excluded.name,
        role = excluded.role,
        permissions = excluded.permissions,
        updated_at = datetime('now')
    `, [uuid(), userId, phone, name, role, JSON.stringify(permissions)]);
  }

  deleteWhatsappContact(userId: string, phone: string): void {
    const udb = this.getUserDb(userId);
    udb.db.run(
      `DELETE FROM whatsapp_contacts WHERE user_id = ? AND phone = ?`,
      [userId, phone]
    );
  }

  // ============================================================
  // WhatsApp Groups (→ user DB)
  // ============================================================

  getWhatsappGroup(userId: string, groupJid: string): any | null {
    const udb = this.getUserDb(userId);
    const row = udb.db.query(
      `SELECT * FROM whatsapp_groups WHERE user_id = ? AND group_jid = ? LIMIT 1`
    ).get(userId, groupJid) as any;
    if (!row) return null;
    row.permissions = parseJson(row.permissions, {});
    return row;
  }

  getWhatsappGroups(userId: string): any[] {
    const udb = this.getUserDb(userId);
    const rows = udb.db.query(
      `SELECT * FROM whatsapp_groups WHERE user_id = ? ORDER BY name, group_jid`
    ).all(userId) as any[];
    return rows.map((r) => {
      r.permissions = parseJson(r.permissions, {});
      return r;
    });
  }

  upsertWhatsappGroup(userId: string, groupJid: string, name: string | null, active: number, permissions: Record<string, any>): void {
    const udb = this.getUserDb(userId);
    udb.db.run(`
      INSERT INTO whatsapp_groups (id, user_id, group_jid, name, active, permissions)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, group_jid) DO UPDATE SET
        name = excluded.name,
        active = excluded.active,
        permissions = excluded.permissions
    `, [uuid(), userId, groupJid, name, active, JSON.stringify(permissions)]);
  }

  deleteWhatsappGroup(userId: string, groupJid: string): void {
    const udb = this.getUserDb(userId);
    udb.db.run(
      `DELETE FROM whatsapp_groups WHERE user_id = ? AND group_jid = ?`,
      [userId, groupJid]
    );
  }

  // ============================================================
  // Patterns (→ user DB)
  // ============================================================

  findPatterns(userId: string, minSuccess: number = 2, limit: number = 10): any[] {
    const udb = this.getUserDb(userId);
    const rows = udb.db.query(`
      SELECT * FROM execution_patterns
      WHERE user_id = ? AND success_count >= ?
      ORDER BY success_count DESC
      LIMIT ?
    `).all(userId, minSuccess, limit) as any[];
    return rows.map((r) => {
      r.plan = parseJson(r.plan, { subtasks: [] });
      return r;
    });
  }

  findPatternBySignature(userId: string, signature: string): any | null {
    const udb = this.getUserDb(userId);
    const row = udb.db.query(`
      SELECT id, success_count, fail_count, avg_duration_ms, winning_strategy
      FROM execution_patterns
      WHERE task_signature = ? AND user_id = ?
      LIMIT 1
    `).get(signature, userId) as any;
    return row || null;
  }

  saveLlmTrace(data: {
    trace_id: string;
    user_id: string;
    provider: string;
    model: string;
    prompt: string;
    response: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    duration_ms: number;
    metadata?: any;
  }): void {
    this.shared.db.run(`
      INSERT INTO llm_traces (trace_id, user_id, provider, model, prompt, response, input_tokens, output_tokens, cost_usd, duration_ms, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      data.trace_id,
      data.user_id,
      data.provider,
      data.model,
      data.prompt,
      data.response,
      data.input_tokens,
      data.output_tokens,
      data.cost_usd,
      data.duration_ms,
      data.metadata ? JSON.stringify(data.metadata) : "{}"
    ]);
  }

  insertPattern(data: {
    task_signature: string;
    plan: any;
    success_count: number;
    fail_count: number;
    avg_duration_ms: number;
    user_id: string;
    winning_strategy?: number;
  }): void {
    const udb = this.getUserDb(data.user_id);
    udb.db.run(`
      INSERT INTO execution_patterns (id, task_signature, plan, success_count, fail_count, avg_duration_ms, user_id, winning_strategy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      uuid(),
      data.task_signature,
      JSON.stringify(data.plan),
      data.success_count,
      data.fail_count,
      data.avg_duration_ms,
      data.user_id,
      data.winning_strategy ?? 1,
    ]);
  }

  updatePattern(id: string, updates: Record<string, any>, userId: string): void {
    const setClauses: string[] = [];
    const values: any[] = [];

    for (const [key, val] of Object.entries(updates)) {
      setClauses.push(`${key} = ?`);
      values.push(key === "plan" ? JSON.stringify(val) : val);
    }

    setClauses.push(`updated_at = datetime('now')`);
    values.push(id);

    const sql = `UPDATE execution_patterns SET ${setClauses.join(", ")} WHERE id = ?`;
    this.getUserDb(userId).db.run(sql, values);
  }

  ratePattern(userId: string, patternId: string, rating: 1 | -1): void {
    const udb = this.getUserDb(userId);
    udb.db.run(
      `UPDATE execution_patterns SET user_rating = ?, rated_at = datetime('now') WHERE id = ?`,
      [rating, patternId]
    );
  }

  findMostRecentSuccessfulPattern(userId: string): any | null {
    const udb = this.getUserDb(userId);
    const row = udb.db.query(`
      SELECT * FROM execution_patterns
      WHERE user_id = ? AND success_count > 0
      ORDER BY id DESC
      LIMIT 1
    `).get(userId) as any;
    if (!row) return null;
    row.plan = typeof row.plan === "string" ? JSON.parse(row.plan) : row.plan;
    return row;
  }

  // ============================================================
  // Learned Skills (→ user DB)
  // ============================================================

  insertLearnedSkill(userId: string, data: {
    slug: string;
    trigger_phrases: string[];
    skill_path: string;
    success_count: number;
    avg_duration_ms: number;
    source_signature: string;
  }): void {
    const udb = this.getUserDb(userId);
    udb.db.run(`
      INSERT OR REPLACE INTO learned_skills (slug, trigger_phrases, skill_path, success_count, avg_duration_ms, source_signature, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `, [
      data.slug,
      JSON.stringify(data.trigger_phrases),
      data.skill_path,
      data.success_count,
      data.avg_duration_ms,
      data.source_signature,
    ]);
  }

  getLearnedSkills(userId: string): any[] {
    const udb = this.getUserDb(userId);
    return udb.db.query(`SELECT * FROM learned_skills ORDER BY success_count DESC`).all() as any[];
  }

  deleteLearnedSkill(userId: string, slug: string): void {
    const udb = this.getUserDb(userId);
    udb.db.run(`DELETE FROM learned_skills WHERE slug = ?`, [slug]);
  }

  findLearnedSkillByTrigger(userId: string, phrase: string): any | null {
    const skills = this.getLearnedSkills(userId);
    const normalized = phrase.toLowerCase().trim();
    for (const skill of skills) {
      const triggers: string[] = parseJson(skill.trigger_phrases, []);
      if (triggers.some((t) => normalized.includes(t))) return skill;
    }
    return null;
  }

  // ============================================================
  // Nova Status (→ shared.db)
  // ============================================================

  upsertNovaStatus(data: Record<string, any>): void {
    const sets: string[] = [];
    const vals: any[] = [];

    for (const [key, val] of Object.entries(data)) {
      if (key === "id") continue;
      sets.push(`${key} = ?`);
      vals.push(typeof val === "object" ? JSON.stringify(val) : val);
    }

    sets.push(`updated_at = datetime('now')`);

    this.shared.db.run(`UPDATE nova_status SET ${sets.join(", ")} WHERE id = 1`, vals);
  }

  getNovaStatus(): any | null {
    return this.shared.db.query(`SELECT * FROM nova_status WHERE id = 1`).get() as any;
  }

  // ============================================================
  // Service State (→ shared.db)
  // ============================================================

  getServiceState(service: string, key: string): string | null {
    const row = this.shared.db.query(
      `SELECT value FROM service_state WHERE service = ? AND key = ?`
    ).get(service, key) as { value: string } | null;
    return row?.value ?? null;
  }

  setServiceState(service: string, key: string, value: string): void {
    this.shared.db.run(
      `INSERT INTO service_state (service, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(service, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      [service, key, value]
    );
  }

  // ============================================================
  // Cost Tracking (→ shared.db)
  // ============================================================

  insertCostEntry(data: {
    provider?: string;
    model: string;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
    cost_usd?: number;
    duration_ms?: number;
    session_id?: string;
    user_id?: string;
    metadata?: Record<string, unknown>;
    agent_slug?: string;
    exec_role?: string;
    request_id?: string;
  }): void {
    this.shared.db.run(`
      INSERT INTO cost_tracking (id, provider, model, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens, cost_usd, duration_ms,
        session_id, metadata, user_id, agent_slug, exec_role, request_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      uuid(),
      data.provider || "claude",
      data.model,
      data.input_tokens || 0,
      data.output_tokens || 0,
      data.cache_read_tokens || 0,
      data.cache_creation_tokens || 0,
      data.cost_usd || 0,
      data.duration_ms || 0,
      data.session_id || null,
      JSON.stringify(data.metadata || {}),
      data.user_id || null,
      data.agent_slug || null,
      data.exec_role || null,
      data.request_id || null,
    ]);
  }

  // ============================================================
  // Dashboard / Query Helpers
  // ============================================================

  getMessagesFiltered(opts: { limit?: number; userId?: string; channel?: string; since?: string; order?: "asc" | "desc" }): any[] {
    const conditions: string[] = [];
    const params: any[] = [];
    if (opts.userId) { conditions.push("user_id = ?"); params.push(opts.userId); }
    if (opts.channel) { conditions.push("channel = ?"); params.push(opts.channel); }
    if (opts.since) { conditions.push("created_at >= ?"); params.push(opts.since); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const order = opts.order === "asc" ? "ASC" : "DESC";
    const sql = `SELECT id, created_at, role, content, channel, metadata, user_id FROM messages ${where} ORDER BY created_at ${order} LIMIT ?`;
    const limit = opts.limit || 50;

    if (opts.userId) {
      const udb = this.getUserDb(opts.userId);
      return udb.db.query(sql).all(...params, limit) as any[];
    }

    const all = this.queryAllUserDbs(db => db.query(sql).all(...params, limit) as any[]);
    return all
      .sort((a, b) => order === "ASC" ? a.created_at.localeCompare(b.created_at) : b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  }

  countMessages(opts: { userId?: string; since?: string }): number {
    const conditions: string[] = [];
    const params: any[] = [];
    if (opts.userId) { conditions.push("user_id = ?"); params.push(opts.userId); }
    if (opts.since) { conditions.push("created_at >= ?"); params.push(opts.since); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT COUNT(*) as cnt FROM messages ${where}`;

    if (opts.userId) {
      const udb = this.getUserDb(opts.userId);
      const row = udb.db.query(sql).get(...params) as any;
      return row?.cnt || 0;
    }

    let total = 0;
    for (const uid of this.getAllUserIds()) {
      const udb = this.getUserDb(uid);
      const row = udb.db.query(sql).get(...params) as any;
      total += row?.cnt || 0;
    }
    return total;
  }

  getMemoryFiltered(opts: { type?: string; userId?: string; limit?: number }): any[] {
    const conditions: string[] = [];
    const params: any[] = [];
    if (opts.type && opts.type !== "all") { conditions.push("type = ?"); params.push(opts.type); }
    if (opts.userId) { conditions.push("user_id = ?"); params.push(opts.userId); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit || 100;
    const sql = `SELECT id, created_at, type, content, deadline, completed_at, priority, scope, last_accessed_at, weight FROM memory ${where} ORDER BY created_at DESC LIMIT ?`;

    // Query shared
    const sharedRows = this.shared.db.query(sql).all(...params, limit) as any[];

    // Query user DBs
    let userRows: any[];
    if (opts.userId) {
      userRows = this.getUserDb(opts.userId).db.query(sql).all(...params, limit) as any[];
    } else {
      userRows = this.queryAllUserDbs(db => db.query(sql).all(...params, limit) as any[]);
    }

    return [...sharedRows, ...userRows]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  }

  getCostEntries(opts: { since?: string; userId?: string; order?: "asc" | "desc" }): any[] {
    const conditions: string[] = [];
    const params: any[] = [];
    if (opts.since) { conditions.push("created_at >= ?"); params.push(opts.since); }
    if (opts.userId) { conditions.push("user_id = ?"); params.push(opts.userId); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const order = opts.order === "asc" ? "ASC" : "DESC";
    return this.shared.db.query(
      `SELECT provider, model, cost_usd, input_tokens, output_tokens, created_at, user_id FROM cost_tracking ${where} ORDER BY created_at ${order}`
    ).all(...params) as any[];
  }

  getCostSummary(userId?: string): {
    today: number;
    month: number;
    allTime: number;
    topAgents: Array<{ agent_slug: string; total_cost: number }>;
  } {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const userFilter = userId ? "AND user_id = ?" : "";
    const userParam = userId ? [userId] : [];

    const todayRow = this.shared.db.query(
      `SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_tracking WHERE created_at >= ? ${userFilter}`
    ).get(todayStart.toISOString(), ...userParam) as any;

    const monthRow = this.shared.db.query(
      `SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_tracking WHERE created_at >= ? ${userFilter}`
    ).get(monthStart.toISOString(), ...userParam) as any;

    const allTimeRow = this.shared.db.query(
      `SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_tracking ${userId ? "WHERE user_id = ?" : ""}`
    ).get(...userParam) as any;

    const topAgents = this.shared.db.query(
      `SELECT agent_slug, SUM(cost_usd) as total_cost
       FROM cost_tracking
       WHERE agent_slug IS NOT NULL AND created_at >= ? ${userFilter}
       GROUP BY agent_slug
       ORDER BY total_cost DESC
       LIMIT 5`
    ).all(monthStart.toISOString(), ...userParam) as any[];

    return {
      today: todayRow?.total ?? 0,
      month: monthRow?.total ?? 0,
      allTime: allTimeRow?.total ?? 0,
      topAgents,
    };
  }

  getCostSummary24h(): Array<{ provider: string; model: string; total_cost: number; call_count: number }> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    return this.shared.db.query(`
      SELECT provider, model,
             SUM(cost_usd) as total_cost,
             COUNT(*) as call_count
      FROM cost_tracking
      WHERE created_at > ?
      GROUP BY provider, model
      ORDER BY total_cost DESC
    `).all(since) as any[];
  }

  getAgentTasksRecent(opts: { userId?: string; limit?: number }): any[] {
    const conditions: string[] = [];
    const params: any[] = [];
    if (opts.userId) { conditions.push("user_id = ?"); params.push(opts.userId); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit || 30;
    const sql = `SELECT id, created_at, updated_at, agent, description, status, result, metadata FROM agent_tasks ${where} ORDER BY updated_at DESC LIMIT ?`;

    if (opts.userId) {
      const udb = this.getUserDb(opts.userId);
      return udb.db.query(sql).all(...params, limit) as any[];
    }

    const all = this.queryAllUserDbs(db => db.query(sql).all(...params, limit) as any[]);
    return all.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, limit);
  }

  // ============================================================
  // Approvals (→ user DB)
  // ============================================================

  insertApproval(data: {
    id: string;
    user_id: string;
    chat_id: number | string;
    original_text: string;
    plan: any;
    prepare_summary?: string;
    prepare_results?: any[];
    artifacts?: any[];
    execute_descriptions?: string[];
    parent_task_id?: string | null;
    workspace_dir?: string | null;
    workflow_type?: string;
    request_id?: string | null;
    status?: string;
  }): void {
    const udb = this.getUserDb(data.user_id);
    udb.db.run(`
      INSERT INTO pending_approvals (id, user_id, chat_id, original_text, plan,
        prepare_summary, prepare_results, artifacts, execute_descriptions,
        parent_task_id, workspace_dir, workflow_type, request_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `, [
      data.id,
      data.user_id,
      data.chat_id,
      data.original_text,
      JSON.stringify(data.plan),
      data.prepare_summary || "",
      JSON.stringify(data.prepare_results || []),
      JSON.stringify((data.artifacts || []).map((a: any) => ({ type: a.type, value: a.value, source: a.source }))),
      JSON.stringify(data.execute_descriptions || []),
      data.parent_task_id || null,
      data.workspace_dir || null,
      data.workflow_type || "generic",
      data.request_id || null,
    ]);
  }

  getApproval(approvalId: string): any | null {
    const row = this.findInUserDbs(db =>
      db.query(`SELECT * FROM pending_approvals WHERE id = ? AND status = 'pending' AND expires_at > datetime('now')`).get(approvalId) as any
    );
    if (!row) return null;
    row.plan = parseJson(row.plan, {});
    row.prepare_results = parseJson(row.prepare_results, []);
    row.artifacts = parseJson(row.artifacts, []);
    row.execute_descriptions = parseJson(row.execute_descriptions, []);
    return row;
  }

  getPendingApprovals(userId: string): any[] {
    const udb = this.getUserDb(userId);
    const rows = udb.db.query(`
      SELECT id, chat_id, original_text, plan, prepare_results, artifacts,
             parent_task_id, prepare_summary, execute_descriptions,
             workspace_dir, workflow_type, request_id, created_at
      FROM pending_approvals
      WHERE user_id = ? AND status = 'pending' AND expires_at > datetime('now')
      ORDER BY created_at DESC
    `).all(userId) as any[];
    return rows.map((r) => {
      r.plan = parseJson(r.plan, {});
      r.prepare_results = parseJson(r.prepare_results, []);
      r.artifacts = parseJson(r.artifacts, []);
      r.execute_descriptions = parseJson(r.execute_descriptions, []);
      return r;
    });
  }

  updateApprovalStatus(approvalId: string, status: string, feedback?: string | null, userId?: string): void {
    if (userId) {
      const udb = this.getUserDb(userId);
      udb.db.run(
        `UPDATE pending_approvals SET status = ?, feedback = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`,
        [status, feedback || null, approvalId, userId]
      );
    } else {
      // Fallback for internal callers (orchestrator) — still scoped by id
      const sql = `UPDATE pending_approvals SET status = ?, feedback = ?, updated_at = datetime('now') WHERE id = ?`;
      this.runOnAllUserDbs(db => db.run(sql, [status, feedback || null, approvalId]));
    }
  }

  getApprovalsByIds(ids: string[], userId: string): any[] {
    if (ids.length === 0) return [];
    const udb = this.getUserDb(userId);
    const placeholders = ids.map(() => "?").join(",");
    return udb.db.query(`
      SELECT id, status, feedback FROM pending_approvals
      WHERE id IN (${placeholders}) AND user_id = ?
    `).all(...ids, userId) as any[];
  }

  cancelExpiredApprovals(userId: string): { id: string; chat_id: number; original_text: string }[] {
    const udb = this.getUserDb(userId);
    const expired = udb.db.query(`
      SELECT id, chat_id, original_text FROM pending_approvals
      WHERE user_id = ? AND status = 'pending' AND expires_at <= datetime('now')
    `).all(userId) as any[];
    if (expired.length > 0) {
      const placeholders = expired.map(() => "?").join(",");
      udb.db.run(
        `UPDATE pending_approvals SET status = 'expired', updated_at = datetime('now') WHERE id IN (${placeholders})`,
        expired.map((r: any) => r.id)
      );
    }
    return expired;
  }

  // ============================================================
  // Revision Sessions (→ user DB)
  // ============================================================

  insertRevisionSession(data: {
    id: string;
    user_id: string;
    original_text: string;
    plan: any;
    prepare_results: any[];
    artifacts: any[];
    parent_task_id?: string | null;
    workspace_dir?: string | null;
    workflow_type?: string;
    request_id?: string | null;
    status?: string;
  }): void {
    const udb = this.getUserDb(data.user_id);
    udb.db.run(`
      INSERT INTO revision_sessions (id, user_id, original_text, plan, prepare_results,
        artifacts, parent_task_id, workspace_dir, workflow_type, request_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `, [
      data.id,
      data.user_id,
      data.original_text.substring(0, 2000),
      JSON.stringify(data.plan),
      JSON.stringify(data.prepare_results),
      JSON.stringify((data.artifacts || []).map((a: any) => ({ type: a.type, value: a.value, source: a.source }))),
      data.parent_task_id || null,
      data.workspace_dir || null,
      data.workflow_type || "generic",
      data.request_id || null,
    ]);
  }

  getLatestPendingRevisionSession(userId: string): any | null {
    const udb = this.getUserDb(userId);
    const row = udb.db.query(`
      SELECT * FROM revision_sessions
      WHERE user_id = ? AND status = 'pending'
      ORDER BY created_at DESC LIMIT 1
    `).get(userId) as any;
    if (!row) return null;
    row.plan = parseJson(row.plan, { subtasks: [] });
    row.prepare_results = parseJson(row.prepare_results, []);
    row.artifacts = parseJson(row.artifacts, []);
    return row;
  }

  updateRevisionSessionStatus(id: string, status: string): void {
    const sql = `UPDATE revision_sessions SET status = ?, updated_at = datetime('now') WHERE id = ?`;
    this.runOnAllUserDbs(db => db.run(sql, [status, id]));
  }

  // ============================================================
  // Workflow Preferences (→ user DB)
  // ============================================================

  upsertWorkflowPreference(data: {
    user_id: string;
    workflow_type: string;
    task_signature: string;
    plan: any;
  }): void {
    const udb = this.getUserDb(data.user_id);
    udb.db.run(`
      INSERT INTO workflow_preferences (id, user_id, workflow_type, task_signature, plan, success_count, last_used_at)
      VALUES (?, ?, ?, ?, ?, 1, datetime('now'))
      ON CONFLICT (user_id, task_signature) DO UPDATE SET
        plan = excluded.plan,
        success_count = workflow_preferences.success_count + 1,
        last_used_at = datetime('now')
    `, [uuid(), data.user_id, data.workflow_type, data.task_signature, JSON.stringify(data.plan)]);
  }

  // ============================================================
  // Artifacts (→ user DB)
  // ============================================================

  insertArtifact(data: {
    task_id?: string | null;
    user_id: string;
    artifact_type: string;
    file_path?: string | null;
    file_name?: string | null;
    file_size?: number | null;
    description?: string | null;
    verified?: boolean;
    delivered?: boolean;
    metadata?: Record<string, any>;
  }): void {
    const udb = this.getUserDb(data.user_id);
    udb.db.run(`
      INSERT INTO task_artifacts (id, task_id, user_id, artifact_type, file_path,
        file_name, file_size, description, verified, delivered, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      uuid(),
      data.task_id || null,
      data.user_id,
      data.artifact_type,
      data.file_path || null,
      data.file_name || null,
      data.file_size || null,
      data.description || null,
      data.verified ? 1 : 0,
      data.delivered ? 1 : 0,
      JSON.stringify(data.metadata || {}),
    ]);
  }

  getTaskArtifacts(taskId: string): any[] {
    return this.queryAllUserDbs(db =>
      db.query(`SELECT * FROM task_artifacts WHERE task_id = ?`).all(taskId) as any[]
    );
  }

  // ============================================================
  // Logs (→ shared.db)
  // ============================================================

  insertLog(data: {
    level?: string;
    event: string;
    message?: string;
    metadata?: Record<string, unknown>;
    session_id?: string;
    duration_ms?: number;
    user_id?: string;
  }): void {
    this.shared.db.run(`
      INSERT INTO logs (id, level, event, message, metadata, session_id, duration_ms, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      uuid(),
      data.level || "info",
      data.event,
      data.message || null,
      JSON.stringify(data.metadata || {}),
      data.session_id || null,
      data.duration_ms || null,
      data.user_id || null,
    ]);
  }

  // ============================================================
  // Data retention — periodic cleanup of old records
  // ============================================================

  runRetentionCleanup(): { logsDeleted: number; costDeleted: number } {
    const logsResult = this.shared.db.run(
      `DELETE FROM logs WHERE created_at < datetime('now', '-30 days')`
    );
    const costResult = this.shared.db.run(
      `DELETE FROM cost_tracking WHERE created_at < datetime('now', '-90 days')`
    );
    return {
      logsDeleted: logsResult.changes,
      costDeleted: costResult.changes,
    };
  }

  // ============================================================
  // Auto-migration from legacy single nova.db
  // ============================================================

  private migrateFromLegacyDb(): void {
    console.log("[db] Auto-migrating from nova.db to split structure...");

    const legacy = openDb(LEGACY_DB_PATH);

    // 1. Create shared.db and copy shared tables
    const shared = new SharedDatabase();

    // Copy users
    if (tableExists(legacy, "users")) {
      const users = legacy.query(`SELECT * FROM users`).all() as any[];
      for (const u of users) {
        shared.db.run(`
          INSERT OR IGNORE INTO users (id, created_at, updated_at, telegram_id, name, timezone,
            phone, pin, whatsapp_id, slack_id, role, preferences, profile_text, active)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [u.id, u.created_at, u.updated_at, u.telegram_id, u.name, u.timezone,
            u.phone, u.pin, u.whatsapp_id, u.slack_id, u.role, u.preferences, u.profile_text, u.active]);
      }
      console.log(`[db]   Migrated ${users.length} users`);
    }

    // Copy nova_status
    if (tableExists(legacy, "nova_status")) {
      const status = legacy.query(`SELECT * FROM nova_status WHERE id = 1`).get() as any;
      if (status) {
        const cols = Object.keys(status).filter(k => k !== "id");
        const sets = cols.map(c => `${c} = ?`);
        const vals = cols.map(c => status[c]);
        shared.db.run(`UPDATE nova_status SET ${sets.join(", ")} WHERE id = 1`, vals);
      }
    }

    // Copy logs
    if (tableExists(legacy, "logs")) {
      const logs = legacy.query(`SELECT * FROM logs`).all() as any[];
      for (const l of logs) {
        shared.db.run(`
          INSERT OR IGNORE INTO logs (id, created_at, level, event, message, metadata, session_id, duration_ms, user_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [l.id, l.created_at, l.level, l.event, l.message, l.metadata, l.session_id, l.duration_ms, l.user_id]);
      }
      console.log(`[db]   Migrated ${logs.length} log entries`);
    }

    // Copy cost_tracking
    if (tableExists(legacy, "cost_tracking")) {
      const costs = legacy.query(`SELECT * FROM cost_tracking`).all() as any[];
      for (const c of costs) {
        shared.db.run(`
          INSERT OR IGNORE INTO cost_tracking (id, created_at, provider, model, input_tokens, output_tokens,
            cache_read_tokens, cache_creation_tokens, cost_usd, duration_ms, session_id, metadata, user_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [c.id, c.created_at, c.provider, c.model, c.input_tokens, c.output_tokens,
            c.cache_read_tokens, c.cache_creation_tokens, c.cost_usd, c.duration_ms, c.session_id, c.metadata, c.user_id]);
      }
      console.log(`[db]   Migrated ${costs.length} cost entries`);
    }

    // Copy shared memory
    if (tableExists(legacy, "memory")) {
      const sharedMem = legacy.query(`SELECT * FROM memory WHERE scope = 'shared'`).all() as any[];
      for (const m of sharedMem) {
        shared.db.run(`
          INSERT OR IGNORE INTO memory (id, created_at, updated_at, type, content, deadline,
            completed_at, priority, metadata, user_id, scope, embedding)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [m.id, m.created_at, m.updated_at, m.type, m.content, m.deadline,
            m.completed_at, m.priority, m.metadata, m.user_id, m.scope, m.embedding]);
      }
      console.log(`[db]   Migrated ${sharedMem.length} shared memory entries`);
    }

    shared.close();

    // 2. Get all user IDs and create per-user databases
    const userIds = new Set<string>();
    if (tableExists(legacy, "users")) {
      const rows = legacy.query(`SELECT id FROM users`).all() as any[];
      for (const r of rows) userIds.add(r.id);
    }

    const userTables = [
      { name: "messages", cols: "id, created_at, role, content, channel, metadata, user_id, embedding" },
      { name: "agent_tasks", cols: "id, created_at, updated_at, agent, description, status, result, metadata, user_id, parent_task_id, request_id" },
      { name: "task_artifacts", cols: "id, created_at, task_id, user_id, artifact_type, file_path, file_name, file_size, description, verified, delivered, metadata" },
      { name: "scheduled_tasks", cols: "id, created_at, updated_at, user_id, created_by, title, instructions, trigger_at, next_run_at, recurrence, timezone, condition, status, last_run_at, last_result, run_count, max_runs, expires_at, notify_user, metadata" },
      { name: "execution_patterns", cols: "id, created_at, updated_at, task_signature, plan, success_count, fail_count, avg_duration_ms, user_id" },
      { name: "pending_approvals", cols: "id, user_id, chat_id, original_text, plan, prepare_summary, prepare_results, artifacts, execute_descriptions, status, feedback, parent_task_id, workspace_dir, workflow_type, request_id, created_at, updated_at" },
      { name: "revision_sessions", cols: "id, user_id, original_text, plan, prepare_results, artifacts, parent_task_id, workspace_dir, workflow_type, request_id, status, created_at, updated_at" },
      { name: "workflow_preferences", cols: "id, user_id, workflow_type, task_signature, plan, success_count, last_used_at, created_at" },
      { name: "user_integrations", cols: "id, created_at, updated_at, user_id, provider, status, credentials, metadata" },
    ];

    for (const userId of userIds) {
      const udb = new UserDatabase(userId);
      let totalRows = 0;

      // Copy private memory
      if (tableExists(legacy, "memory")) {
        const privateMem = legacy.query(`SELECT * FROM memory WHERE user_id = ? AND (scope != 'shared' OR scope IS NULL)`).all(userId) as any[];
        for (const m of privateMem) {
          udb.db.run(`
            INSERT OR IGNORE INTO memory (id, created_at, updated_at, type, content, deadline,
              completed_at, priority, metadata, user_id, scope, embedding)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [m.id, m.created_at, m.updated_at, m.type, m.content, m.deadline,
              m.completed_at, m.priority, m.metadata, m.user_id, m.scope || "private", m.embedding]);
        }
        totalRows += privateMem.length;
      }

      // Copy per-user tables
      for (const { name, cols } of userTables) {
        if (!tableExists(legacy, name)) continue;
        const colList = cols.split(", ");
        const rows = legacy.query(`SELECT ${cols} FROM ${name} WHERE user_id = ?`).all(userId) as any[];
        const placeholders = colList.map(() => "?").join(", ");
        for (const row of rows) {
          const values = colList.map(c => (row as any)[c]);
          udb.db.run(`INSERT OR IGNORE INTO ${name} (${cols}) VALUES (${placeholders})`, values);
        }
        totalRows += rows.length;
      }

      udb.close();
      console.log(`[db]   User ${userId}: migrated ${totalRows} rows`);
    }

    legacy.close();
    renameSync(LEGACY_DB_PATH, LEGACY_DB_PATH + ".migrated");
    console.log("[db] Migration complete. Legacy nova.db renamed to nova.db.migrated");
  }

  // ============================================================
  // Agent Messages / Inbox (→ user DB)
  // ============================================================

  insertAgentMessage(data: {
    from_agent: string;
    to_agent: string;
    thread_id: string;
    user_id: string;
    subject?: string | null;
    body: string;
    reply_to?: string | null;
  }): string {
    const udb = this.getUserDb(data.user_id);
    const id = uuid();
    udb.db.run(`
      INSERT INTO agent_messages (id, from_agent, to_agent, thread_id, user_id, subject, body, reply_to)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, data.from_agent, data.to_agent, data.thread_id, data.user_id, data.subject || null, data.body, data.reply_to || null]);
    return id;
  }

  getAgentInbox(agentSlug: string, threadId: string, userId: string): any[] {
    const udb = this.getUserDb(userId);
    return udb.db.query(`
      SELECT * FROM agent_messages
      WHERE to_agent = ? AND thread_id = ? AND user_id = ?
      ORDER BY created_at ASC
    `).all(agentSlug, threadId, userId) as any[];
  }

  getAgentMessageById(messageId: string): any | null {
    for (const uid of this.getAllUserIds()) {
      const udb = this.getUserDb(uid);
      const row = udb.db.query(`SELECT * FROM agent_messages WHERE id = ? LIMIT 1`).get(messageId) as any;
      if (row) return row;
    }
    return null;
  }

  markAgentMessageReplied(messageId: string, replyBody: string): void {
    this.runOnAllUserDbs(db => db.run(
      `UPDATE agent_messages SET status = 'replied', reply_body = ? WHERE id = ?`,
      [replyBody, messageId]
    ));
  }

  // ============================================================
  // Budget (→ user DB)
  // ============================================================

  insertBudgetEntry(data: {
    user_id: string;
    agent_slug: string;
    category: string;
    description?: string;
    amount_usd: number;
    approved_by?: string;
    status?: string;
    task_id?: string | null;
    metadata?: Record<string, any>;
  }): string {
    const udb = this.getUserDb(data.user_id);
    const id = uuid();
    udb.db.run(`
      INSERT INTO budget_ledger (id, user_id, agent_slug, category, description, amount_usd, approved_by, status, task_id, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, data.user_id, data.agent_slug, data.category, data.description || null,
        data.amount_usd, data.approved_by || 'auto', data.status || 'pending',
        data.task_id || null, JSON.stringify(data.metadata || {})]);
    return id;
  }

  approveBudgetEntry(id: string): void {
    this.runOnAllUserDbs(db => db.run(
      `UPDATE budget_ledger SET status = 'approved', approved_by = 'user' WHERE id = ?`, [id]
    ));
  }

  rejectBudgetEntry(id: string, reason?: string): void {
    const meta = reason ? JSON.stringify({ rejection_reason: reason }) : '{}';
    this.runOnAllUserDbs(db => db.run(
      `UPDATE budget_ledger SET status = 'rejected', metadata = json_patch(metadata, ?) WHERE id = ?`,
      [meta, id]
    ));
  }

  getBudgetEntries(userId: string, opts: { since?: string; agentSlug?: string; status?: string } = {}): any[] {
    const udb = this.getUserDb(userId);
    const conditions = ['user_id = ?'];
    const params: any[] = [userId];
    if (opts.since) { conditions.push('created_at >= ?'); params.push(opts.since); }
    if (opts.agentSlug) { conditions.push('agent_slug = ?'); params.push(opts.agentSlug); }
    if (opts.status) { conditions.push('status = ?'); params.push(opts.status); }
    return udb.db.query(
      `SELECT * FROM budget_ledger WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`
    ).all(...params) as any[];
  }

  getBudgetRules(userId: string): any[] {
    const udb = this.getUserDb(userId);
    return udb.db.query(`SELECT * FROM budget_rules WHERE user_id = ? ORDER BY agent_slug, category`).all(userId) as any[];
  }

  upsertBudgetRule(data: {
    user_id: string;
    agent_slug?: string | null;
    category?: string | null;
    per_action_limit?: number;
    daily_limit?: number | null;
    monthly_limit?: number | null;
    auto_approve_under?: number;
  }): void {
    const udb = this.getUserDb(data.user_id);
    udb.db.run(`
      INSERT INTO budget_rules (id, user_id, agent_slug, category, per_action_limit, daily_limit, monthly_limit, auto_approve_under)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (user_id, agent_slug, category) DO UPDATE SET
        per_action_limit = excluded.per_action_limit,
        daily_limit = excluded.daily_limit,
        monthly_limit = excluded.monthly_limit,
        auto_approve_under = excluded.auto_approve_under
    `, [uuid(), data.user_id, data.agent_slug || null, data.category || null,
        data.per_action_limit ?? 100.0, data.daily_limit ?? null,
        data.monthly_limit ?? null, data.auto_approve_under ?? 10.0]);
  }

  getDailyBudgetSpend(userId: string, agentSlug?: string): number {
    const udb = this.getUserDb(userId);
    const conditions = ["user_id = ?", "status = 'approved'", "created_at >= datetime('now', 'start of day')"];
    const params: any[] = [userId];
    if (agentSlug) { conditions.push('agent_slug = ?'); params.push(agentSlug); }
    const row = udb.db.query(
      `SELECT COALESCE(SUM(amount_usd), 0) as total FROM budget_ledger WHERE ${conditions.join(' AND ')}`
    ).get(...params) as any;
    return row?.total || 0;
  }

  getMonthlyBudgetSpend(userId: string): number {
    const udb = this.getUserDb(userId);
    const row = udb.db.query(`
      SELECT COALESCE(SUM(amount_usd), 0) as total FROM budget_ledger
      WHERE user_id = ? AND status = 'approved' AND created_at >= datetime('now', 'start of month')
    `).get(userId) as any;
    return row?.total || 0;
  }

  // ============================================================
  // Webhook Triggers (→ shared.db)
  // ============================================================

  getWebhookTrigger(userId: string, webhookId: string): any | null {
    // Look up by name first (friendly webhook URL), then by id
    const byName = this.shared.db.query(
      `SELECT * FROM webhook_triggers WHERE user_id = ? AND name = ? AND enabled = 1 LIMIT 1`
    ).get(userId, webhookId) as any;
    if (byName) return byName;
    return this.shared.db.query(
      `SELECT * FROM webhook_triggers WHERE id = ? AND user_id = ? AND enabled = 1 LIMIT 1`
    ).get(webhookId, userId) as any;
  }

  deleteWebhookTrigger(userId: string, name: string): void {
    this.shared.db.run(
      `DELETE FROM webhook_triggers WHERE user_id = ? AND name = ?`,
      [userId, name]
    );
  }

  getWebhookTriggerByName(userId: string, name: string): any | null {
    return this.shared.db.query(
      `SELECT * FROM webhook_triggers WHERE user_id = ? AND name = ? LIMIT 1`
    ).get(userId, name) as any;
  }

  listWebhookTriggers(userId: string): any[] {
    return this.shared.db.query(
      `SELECT * FROM webhook_triggers WHERE user_id = ? ORDER BY name`
    ).all(userId) as any[];
  }

  upsertWebhookTrigger(data: {
    user_id: string;
    name: string;
    source: string;
    secret: string;
    pipeline: string;
    enabled?: number;
  }): string {
    const existing = this.getWebhookTriggerByName(data.user_id, data.name);
    if (existing) {
      this.shared.db.run(`
        UPDATE webhook_triggers SET source = ?, secret = ?, pipeline = ?, enabled = ? WHERE id = ?
      `, [data.source, data.secret, data.pipeline, data.enabled ?? 1, existing.id]);
      return existing.id;
    }
    const id = uuid();
    this.shared.db.run(`
      INSERT INTO webhook_triggers (id, user_id, name, source, secret, pipeline, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [id, data.user_id, data.name, data.source, data.secret, data.pipeline, data.enabled ?? 1]);
    return id;
  }

  recordWebhookFire(webhookId: string): void {
    this.shared.db.run(`
      UPDATE webhook_triggers SET last_triggered_at = datetime('now'), trigger_count = trigger_count + 1 WHERE id = ?
    `, [webhookId]);
  }

  insertWebhookLog(data: {
    webhook_id: string;
    user_id: string;
    source?: string;
    payload?: string;
    pipeline_triggered?: string;
    task_id?: string | null;
    status?: string;
  }): void {
    const udb = this.getUserDb(data.user_id);
    udb.db.run(`
      CREATE TABLE IF NOT EXISTS webhook_logs (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        created_at TEXT DEFAULT (datetime('now')),
        webhook_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        source TEXT,
        payload TEXT,
        pipeline_triggered TEXT,
        task_id TEXT,
        status TEXT DEFAULT 'ok'
      )
    `);
    udb.db.run(`
      INSERT INTO webhook_logs (id, webhook_id, user_id, source, payload, pipeline_triggered, task_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [uuid(), data.webhook_id, data.user_id, data.source || null,
        data.payload || null, data.pipeline_triggered || null,
        data.task_id || null, data.status || 'ok']);
  }

  // ============================================================
  // Agent Reputation (→ shared.db)
  // ============================================================

  recordAgentOutcome(agentSlug: string, outcome: { success: boolean; revised?: boolean; confidenceScore?: number }): void {
    this.shared.db.run(`
      INSERT INTO agent_reputation (id, agent_slug, total_tasks, success_count, fail_count, revision_count, avg_confidence, last_task_at, updated_at)
      VALUES (?, ?, 1, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(agent_slug) DO UPDATE SET
        total_tasks = total_tasks + 1,
        success_count = success_count + ?,
        fail_count = fail_count + ?,
        revision_count = revision_count + ?,
        avg_confidence = CASE WHEN ? IS NOT NULL THEN (avg_confidence * total_tasks + ?) / (total_tasks + 1) ELSE avg_confidence END,
        last_task_at = datetime('now'),
        updated_at = datetime('now')
    `, [
      uuid(), agentSlug,
      outcome.success ? 1 : 0, outcome.success ? 0 : 1,
      outcome.revised ? 1 : 0, outcome.confidenceScore ?? null,
      outcome.success ? 1 : 0, outcome.success ? 0 : 1,
      outcome.revised ? 1 : 0,
      outcome.confidenceScore ?? null, outcome.confidenceScore ?? 0,
    ]);
  }

  getAgentReputation(agentSlug: string): any | null {
    return this.shared.db.query(
      `SELECT * FROM agent_reputation WHERE agent_slug = ? LIMIT 1`
    ).get(agentSlug) as any;
  }

  getAllAgentReputations(): any[] {
    return this.shared.db.query(
      `SELECT * FROM agent_reputation ORDER BY (CAST(success_count AS REAL)/NULLIF(total_tasks,0)) DESC`
    ).all() as any[];
  }

  // ============================================================
  // Projects (→ user DB)
  // ============================================================

  insertProject(data: {
    user_id: string;
    name: string;
    description?: string;
    phase?: string;
    owner_agents?: string[];
  }): string {
    const udb = this.getUserDb(data.user_id);
    const id = uuid();
    udb.db.run(`
      INSERT INTO projects (id, user_id, name, description, phase, owner_agents)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [id, data.user_id, data.name, data.description || null,
        data.phase || 'discovery', JSON.stringify(data.owner_agents || [])]);
    return id;
  }

  getStrategicProjects(userId: string, includeArchived = false): any[] {
    const udb = this.getUserDb(userId);
    const rows = udb.db.query(`
      SELECT * FROM projects WHERE user_id = ? ${includeArchived ? '' : 'AND archived = 0'}
      ORDER BY updated_at DESC
    `).all(userId) as any[];
    return rows.map(r => ({
      ...r,
      owner_agents: JSON.parse(r.owner_agents || '[]'),
      decisions: JSON.parse(r.decisions || '[]'),
      artifacts: JSON.parse(r.artifacts || '[]'),
      next_actions: JSON.parse(r.next_actions || '[]'),
      metadata: JSON.parse(r.metadata || '{}'),
    }));
  }

  getStrategicProjectByName(userId: string, name: string): any | null {
    const udb = this.getUserDb(userId);
    const row = udb.db.query(`
      SELECT * FROM projects WHERE user_id = ? AND name LIKE ? AND archived = 0 ORDER BY updated_at DESC LIMIT 1
    `).get(userId, `%${name}%`) as any;
    if (!row) return null;
    return {
      ...row,
      owner_agents: JSON.parse(row.owner_agents || '[]'),
      decisions: JSON.parse(row.decisions || '[]'),
      artifacts: JSON.parse(row.artifacts || '[]'),
      next_actions: JSON.parse(row.next_actions || '[]'),
      metadata: JSON.parse(row.metadata || '{}'),
    };
  }

  getProjectById(userId: string, projectId: string): any | null {
    const udb = this.getUserDb(userId);
    const row = udb.db.query(`SELECT * FROM projects WHERE id = ? AND user_id = ? LIMIT 1`).get(projectId, userId) as any;
    if (!row) return null;
    return {
      ...row,
      owner_agents: JSON.parse(row.owner_agents || '[]'),
      decisions: JSON.parse(row.decisions || '[]'),
      artifacts: JSON.parse(row.artifacts || '[]'),
      next_actions: JSON.parse(row.next_actions || '[]'),
      metadata: JSON.parse(row.metadata || '{}'),
    };
  }

  updateProject(projectId: string, userId: string, updates: Record<string, any>): void {
    const udb = this.getUserDb(userId);
    const setClauses: string[] = ['updated_at = datetime(\'now\')'];
    const values: any[] = [];
    for (const [key, val] of Object.entries(updates)) {
      setClauses.push(`${key} = ?`);
      values.push(typeof val === 'object' ? JSON.stringify(val) : val);
    }
    values.push(projectId, userId);
    udb.db.run(`UPDATE projects SET ${setClauses.join(', ')} WHERE id = ? AND user_id = ?`, values);
  }

  appendProjectDecision(projectId: string, userId: string, decision: { date: string; decision: string; agent?: string }): void {
    const udb = this.getUserDb(userId);
    const row = udb.db.query(`SELECT decisions FROM projects WHERE id = ? AND user_id = ?`).get(projectId, userId) as any;
    if (!row) return;
    const decisions = JSON.parse(row.decisions || '[]');
    decisions.push(decision);
    udb.db.run(`UPDATE projects SET decisions = ?, updated_at = datetime('now') WHERE id = ?`, [JSON.stringify(decisions), projectId]);
  }

  appendProjectArtifact(projectId: string, userId: string, artifact: { name: string; ref: string; date: string }): void {
    const udb = this.getUserDb(userId);
    const row = udb.db.query(`SELECT artifacts FROM projects WHERE id = ? AND user_id = ?`).get(projectId, userId) as any;
    if (!row) return;
    const artifacts = JSON.parse(row.artifacts || '[]');
    artifacts.push(artifact);
    udb.db.run(`UPDATE projects SET artifacts = ?, updated_at = datetime('now') WHERE id = ?`, [JSON.stringify(artifacts), projectId]);
  }

  // ============================================================
  // Calendar Rules (→ user DB)
  // ============================================================

  getCalendarRules(userId: string): any[] {
    const udb = this.getUserDb(userId);
    return udb.db.query(`
      SELECT * FROM calendar_rules WHERE user_id = ? AND enabled = 1 ORDER BY name
    `).all(userId) as any[];
  }

  upsertCalendarRule(data: {
    user_id: string;
    name: string;
    event_keywords: string[];
    trigger_hours_before: number;
    pipeline_template: string;
    enabled?: number;
  }): void {
    const udb = this.getUserDb(data.user_id);
    udb.db.run(`
      INSERT INTO calendar_rules (id, user_id, name, event_keywords, trigger_hours_before, pipeline_template, enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO UPDATE SET
        event_keywords = excluded.event_keywords,
        trigger_hours_before = excluded.trigger_hours_before,
        pipeline_template = excluded.pipeline_template,
        enabled = excluded.enabled
    `, [uuid(), data.user_id, data.name, JSON.stringify(data.event_keywords),
        data.trigger_hours_before, data.pipeline_template, data.enabled ?? 1]);
  }

  upsertQueuedPrepTask(data: {
    user_id: string;
    calendar_event_id: string;
    event_title: string;
    event_start_at: string;
    rule_id?: string | null;
    task_id?: string | null;
    status?: string;
  }): boolean {
    const udb = this.getUserDb(data.user_id);
    try {
      udb.db.run(`
        INSERT INTO queued_prep_tasks (id, user_id, calendar_event_id, event_title, event_start_at, rule_id, task_id, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [uuid(), data.user_id, data.calendar_event_id, data.event_title,
          data.event_start_at, data.rule_id || null, data.task_id || null, data.status || 'pending']);
      return true; // new entry
    } catch {
      return false; // duplicate (unique constraint)
    }
  }

  getActiveQueuedPrepTasks(userId: string): any[] {
    const udb = this.getUserDb(userId);
    return udb.db.query(`
      SELECT * FROM queued_prep_tasks WHERE user_id = ? AND status IN ('pending','running')
      ORDER BY event_start_at ASC
    `).all(userId) as any[];
  }

  // ============================================================
  // Memory Goal Extensions
  // ============================================================

  getGoalsNeedingReview(userId: string, staleAfterMinutes = 360): any[] {
    const udb = this.getUserDb(userId);
    return udb.db.query(`
      SELECT * FROM memory
      WHERE user_id = ? AND type = 'goal' AND completed_at IS NULL
        AND (last_reviewed_at IS NULL OR last_reviewed_at < datetime('now', ?))
      ORDER BY priority DESC, created_at ASC
      LIMIT 20
    `).all(userId, `-${staleAfterMinutes} minutes`) as any[];
  }

  getGoals(userId: string): any[] {
    const udb = this.getUserDb(userId);
    return udb.db.query(`
      SELECT * FROM memory
      WHERE user_id = ? AND type = 'goal' AND completed_at IS NULL
      ORDER BY priority DESC, created_at ASC
    `).all(userId) as any[];
  }

  updateGoalProgress(memoryId: string, userId: string, note: string, taskId?: string): void {
    const udb = this.getUserDb(userId);
    const row = udb.db.query(`SELECT progress_notes FROM memory WHERE id = ?`).get(memoryId) as any;
    const notes = JSON.parse(row?.progress_notes || '[]');
    notes.push({ date: new Date().toISOString(), note: note.slice(0, 200), task_id: taskId || null });
    udb.db.run(`
      UPDATE memory SET last_reviewed_at = datetime('now'), progress_notes = ? WHERE id = ?
    `, [JSON.stringify(notes.slice(-20)), memoryId]); // keep last 20
  }

  // ============================================================
  // Session Summaries (→ user DB)
  // ============================================================

  upsertSessionSummary(userId: string, sessionKey: string, summary: string): void {
    const udb = this.getUserDb(userId);
    udb.db.run(`
      INSERT INTO session_summaries(user_id, session_key, summary, last_updated)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(user_id, session_key) DO UPDATE SET
        summary = excluded.summary,
        last_updated = datetime('now')
    `, [userId, sessionKey, summary]);
  }

  /** Returns the active session summary, or null if none exists or it expired (>4h old).
   *  Callers treat both cases identically — no distinction is needed. */
  getSessionSummary(userId: string, sessionKey: string): { summary: string } | null {
    const udb = this.getUserDb(userId);
    const row = udb.db.query(`
      SELECT summary FROM session_summaries
      WHERE user_id = ? AND session_key = ? AND last_updated > datetime('now', '-4 hours')
      LIMIT 1
    `).get(userId, sessionKey) as { summary: string } | null;
    return row ?? null;
  }

  // ============================================================
  // Short-Term Memories (→ shared.db)
  // ============================================================

  insertShortTermMemory(userId: string, memwrightId: string, expiresAt: string): void {
    this.shared.db.run(`
      INSERT OR IGNORE INTO short_term_memories(id, user_id, expires_at) VALUES (?, ?, ?)
    `, [memwrightId, userId, expiresAt]);
  }

  markShortTermMemoryPromoted(memwrightId: string): boolean {
    const result = this.shared.db.run(`
      UPDATE short_term_memories SET promoted = 1 WHERE id = ? AND promoted = 0
    `, [memwrightId]);
    return result.changes > 0;
  }

  getExpiredShortTermMemories(): Array<{ id: string; user_id: string }> {
    return this.shared.db.query(`
      SELECT id, user_id FROM short_term_memories
      WHERE expires_at < datetime('now') AND promoted = 0
    `).all() as Array<{ id: string; user_id: string }>;
  }

  deleteShortTermMemory(id: string): void {
    this.shared.db.run(`DELETE FROM short_term_memories WHERE id = ?`, [id]);
  }

  // ============================================================
  // Task Schemas (→ user DB)
  // ============================================================

  insertTaskSchema(userId: string, schema: {
    name: string;
    trigger_embedding: Buffer;
    compressed_context: string;
    expected_tools: string;
    execution_template: string;
    success_rate: number;
    use_count: number;
    last_used: string | null;
  }): string {
    const udb = this.getUserDb(userId);
    const id = uuid();
    udb.db.run(`
      INSERT INTO task_schemas (id, name, trigger_embedding, compressed_context, expected_tools, execution_template, success_rate, use_count, last_used)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      schema.name,
      schema.trigger_embedding,
      schema.compressed_context,
      schema.expected_tools,
      schema.execution_template,
      schema.success_rate,
      schema.use_count,
      schema.last_used,
    ]);
    return id;
  }

  getTaskSchemas(userId: string): any[] {
    const udb = this.getUserDb(userId);
    return udb.db.query(`SELECT * FROM task_schemas ORDER BY use_count DESC`).all() as any[];
  }

  updateSchemaExecution(schemaId: string, success: boolean): void {
    const userIds = this.getAllUserIds();
    for (const uid of userIds) {
      const udb = this.getUserDb(uid);
      const row = udb.db.query(`SELECT use_count, success_rate FROM task_schemas WHERE id = ?`).get(schemaId) as any;
      if (!row) continue;
      const newCount = row.use_count + 1;
      const successValue = success ? 1 : 0;
      const newRate = (row.success_rate * row.use_count + successValue) / newCount;
      udb.db.run(
        `UPDATE task_schemas SET use_count = ?, success_rate = ?, last_used = datetime('now') WHERE id = ?`,
        [newCount, newRate, schemaId],
      );
      break;
    }
  }

  // ============================================================
  // Escalation Log (→ user DB)
  // ============================================================

  insertEscalationLog(userId: string, data: {
    message_embedding: Buffer | null;
    tier_reached: number;
    execution_plan: string | null;
    success: boolean;
  }): void {
    const udb = this.getUserDb(userId);
    udb.db.run(`
      INSERT INTO escalation_log (user_id, message_embedding, tier_reached, execution_plan, success)
      VALUES (?, ?, ?, ?, ?)
    `, [userId, data.message_embedding, data.tier_reached, data.execution_plan, data.success ? 1 : 0]);
  }

  getEscalationLogs(userId: string, limit = 50): any[] {
    const udb = this.getUserDb(userId);
    return udb.db.query(
      `SELECT * FROM escalation_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
    ).all(userId, limit) as any[];
  }

  // ============================================================
  // Trust Scores (→ user DB)
  // ============================================================

  getTrustScore(userId: string, taskType: string): any | null {
    const udb = this.getUserDb(userId);
    return udb.db.query(
      `SELECT * FROM trust_scores WHERE user_id = ? AND task_type = ? LIMIT 1`
    ).get(userId, taskType) as any | null;
  }

  upsertTrustScore(userId: string, taskType: string, data: {
    level: number;
    success_count: number;
    last_success?: string | null;
    last_failure?: string | null;
    manually_set?: boolean;
  }): void {
    const udb = this.getUserDb(userId);
    udb.db.run(`
      INSERT INTO trust_scores (task_type, user_id, level, success_count, last_success, last_failure, manually_set)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_type, user_id) DO UPDATE SET
        level = excluded.level,
        success_count = excluded.success_count,
        last_success = COALESCE(excluded.last_success, trust_scores.last_success),
        last_failure = COALESCE(excluded.last_failure, trust_scores.last_failure),
        manually_set = excluded.manually_set
    `, [
      taskType,
      userId,
      data.level,
      data.success_count,
      data.last_success ?? null,
      data.last_failure ?? null,
      data.manually_set ? 1 : 0,
    ]);
  }

  // ============================================================
  // Action Log (→ shared.db, cross-session dedup)
  // ============================================================

  checkActionLog(key: string): any | null {
    return this.shared.db.query(
      `SELECT key, status, created_at, dedup_window_hours FROM action_log WHERE key = ? AND (status = 'pending' OR status = 'completed' OR (status = 'failed' AND datetime(created_at, '+' || CAST(dedup_window_hours AS TEXT) || ' hours') > datetime('now'))) LIMIT 1`
    ).get(key) as any | null;
  }

  insertActionLog(
    key: string,
    userId: string,
    actionType: string,
    payloadHash: string,
    dedupWindowHours: number,
  ): boolean {
    const createdAt = new Date().toISOString();
    const result = this.shared.db.run(`
      INSERT OR IGNORE INTO action_log (key, user_id, action_type, payload_hash, status, created_at, dedup_window_hours)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `, [key, userId, actionType, payloadHash, createdAt, dedupWindowHours]);
    return result.changes > 0;
  }

  updateActionLog(key: string, status: string, result: string): void {
    this.shared.db.run(`
      UPDATE action_log SET status = ?, result = ?, completed_at = datetime('now') WHERE key = ?
    `, [status, result, key]);
  }

  // ============================================================
  // User Projects (→ user DB)
  // ============================================================

  addProject(userId: string, params: {
    name: string;
    repoUrl?: string;
    localPath?: string;
    defaultBranch?: string;
    runtime?: string;
  }): string {
    const id = uuid();
    const udb = this.getUserDb(userId);
    udb.db.run(
      `INSERT INTO user_projects (id, user_id, name, repo_url, local_path, default_branch, runtime)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, userId, params.name, params.repoUrl ?? null, params.localPath ?? null,
       params.defaultBranch ?? 'main', params.runtime ?? null]
    );
    return id;
  }

  getProjects(userId: string): UserProject[] {
    const udb = this.getUserDb(userId);
    return udb.db.query(
      `SELECT id, user_id AS userId, name, repo_url AS repoUrl, local_path AS localPath,
              default_branch AS defaultBranch, runtime, created_at AS createdAt
       FROM user_projects WHERE user_id = ? ORDER BY name`
    ).all(userId) as UserProject[];
  }

  getProject(userId: string, projectId: string): UserProject | null {
    const udb = this.getUserDb(userId);
    return udb.db.query(
      `SELECT id, user_id AS userId, name, repo_url AS repoUrl, local_path AS localPath,
              default_branch AS defaultBranch, runtime, created_at AS createdAt
       FROM user_projects WHERE id = ? AND user_id = ?`
    ).get(projectId, userId) as UserProject | null;
  }

  getProjectByName(userId: string, name: string): UserProject | null {
    const udb = this.getUserDb(userId);
    return udb.db.query(
      `SELECT id, user_id AS userId, name, repo_url AS repoUrl, local_path AS localPath,
              default_branch AS defaultBranch, runtime, created_at AS createdAt
       FROM user_projects WHERE name = ? AND user_id = ?`
    ).get(name, userId) as UserProject | null;
  }

  removeProject(userId: string, projectId: string): void {
    const udb = this.getUserDb(userId);
    udb.db.run(`DELETE FROM user_projects WHERE id = ? AND user_id = ?`, [projectId, userId]);
  }

  createDevTask(userId: string, projectId: string, description: string): string {
    const id = uuid();
    const udb = this.getUserDb(userId);
    udb.db.run(
      `INSERT INTO agent_tasks (id, user_id, agent, description, status, task_type, project_id, created_at)
       VALUES (?, ?, 'architect', ?, 'pending', 'dev', ?, datetime('now'))`,
      [id, userId, description, projectId]
    );
    return id;
  }

  updateDevTaskStatus(userId: string, taskId: string, status: string, result?: string): void {
    const udb = this.getUserDb(userId);
    udb.db.run(
      `UPDATE agent_tasks SET status = ?, result = ?, updated_at = datetime('now')
       WHERE id = ? AND user_id = ?`,
      [status, result ?? null, taskId, userId]
    );
  }

  // ============================================================
  // Support Tickets (→ user DB)
  // ============================================================

  insertSupportTicket(data: {
    user_id: string; source: string; client_email: string; client_name?: string | null;
    resend_message_id?: string | null; subject: string; body_raw: string;
  }): string {
    const id = uuid();
    const udb = this.getUserDb(data.user_id);
    udb.db.run(`
      INSERT INTO support_tickets (id, user_id, source, client_email, client_name, resend_message_id, subject, body_raw, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new')
    `, [id, data.user_id, data.source, data.client_email, data.client_name || null,
        data.resend_message_id || null, data.subject, data.body_raw]);
    return id;
  }

  // ============================================================
  // Action Ledger (→ user DB)
  // ============================================================

  recordAction(e: ActionLedgerEntry): string {
    const udb = this.getUserDb(e.user_id);
    const row = udb.db.query(
      `INSERT INTO action_ledger (agent, action_type, phase, autonomy_level, approval_id, sandbox_backend, cost_usd, outcome, verification, artifacts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    ).get(
      e.agent, e.action_type, e.phase, e.autonomy_level ?? 0, e.approval_id ?? null,
      e.sandbox_backend ?? null, e.cost_usd ?? 0, e.outcome,
      e.verification ? JSON.stringify(e.verification) : null,
      e.artifacts ? JSON.stringify(e.artifacts) : null,
    ) as { id: string };
    return row.id;
  }

  getActions(userId: string, opts: { agent?: string; actionType?: string; limit?: number } = {}): ActionLedgerRow[] {
    const udb = this.getUserDb(userId);
    const where: string[] = [];
    const params: any[] = [];
    if (opts.agent) { where.push("agent = ?"); params.push(opts.agent); }
    if (opts.actionType) { where.push("action_type = ?"); params.push(opts.actionType); }
    const sql = `SELECT * FROM action_ledger ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`;
    params.push(opts.limit ?? 100);
    return (udb.db.query(sql).all(...params) as any[]).map((r) => ({
      ...r, user_id: userId,
      verification: r.verification ? JSON.parse(r.verification) : undefined,
      artifacts: r.artifacts ? JSON.parse(r.artifacts) : undefined,
    }));
  }

  // ── Autonomy grants (per-user governance) ─────────────────────────────────

  /** Governance setter: set level + caps without disturbing the earned clean-run streak. */
  setAutonomyGrant(userId: string, grant: {
    agent: string;
    action_type: string;
    level: number;
    spend_cap_action?: number | null;
    spend_cap_daily?: number | null;
  }): AutonomyGrantRow {
    const udb = this.getUserDb(userId);
    udb.db.run(
      `INSERT INTO autonomy_grants (agent, action_type, level, spend_cap_action, spend_cap_daily)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent, action_type) DO UPDATE SET
         level = excluded.level,
         spend_cap_action = excluded.spend_cap_action,
         spend_cap_daily = excluded.spend_cap_daily`,
      [grant.agent, grant.action_type, grant.level,
       grant.spend_cap_action ?? null, grant.spend_cap_daily ?? null]
    );
    return udb.db.query(
      `SELECT agent, action_type, level, clean_runs, spend_cap_action, spend_cap_daily, demoted_at
       FROM autonomy_grants WHERE agent = ? AND action_type = ?`
    ).get(grant.agent, grant.action_type) as AutonomyGrantRow;
  }

  /** Sum of today's execute-phase spend for an (agent, action_type) — feeds per-day cap checks. */
  getDailyActionSpend(userId: string, agent: string, actionType: string): number {
    const udb = this.getUserDb(userId);
    const row = udb.db.query(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM action_ledger
       WHERE agent = ? AND action_type = ? AND phase = 'execute' AND date(created_at) = date('now')`
    ).get(agent, actionType) as { total: number };
    return row?.total ?? 0;
  }

  // ============================================================
  // Autonomy Grants (→ user DB) — materialized ladder state
  // ============================================================

  getAutonomyGrant(userId: string, agent: string, actionType: string): AutonomyGrantRow | null {
    const udb = this.getUserDb(userId);
    const row = udb.db.query(
      `SELECT agent, action_type, level, clean_runs, spend_cap_action, spend_cap_daily, demoted_at
       FROM autonomy_grants WHERE agent = ? AND action_type = ?`
    ).get(agent, actionType) as AutonomyGrantRow | null;
    return row ?? null;
  }

  upsertAutonomyGrant(userId: string, grant: AutonomyGrantRow): void {
    const udb = this.getUserDb(userId);
    udb.db.run(
      `INSERT INTO autonomy_grants (agent, action_type, level, clean_runs, spend_cap_action, spend_cap_daily, demoted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent, action_type) DO UPDATE SET
         level = excluded.level,
         clean_runs = excluded.clean_runs,
         spend_cap_action = excluded.spend_cap_action,
         spend_cap_daily = excluded.spend_cap_daily,
         demoted_at = excluded.demoted_at`,
      [grant.agent, grant.action_type, grant.level, grant.clean_runs,
       grant.spend_cap_action, grant.spend_cap_daily, grant.demoted_at]
    );
  }

  listAutonomyGrants(userId: string): AutonomyGrantRow[] {
    const udb = this.getUserDb(userId);
    return udb.db.query(
      `SELECT agent, action_type, level, clean_runs, spend_cap_action, spend_cap_daily, demoted_at
       FROM autonomy_grants ORDER BY agent, action_type`
    ).all() as AutonomyGrantRow[];
  }

  updateActionVerification(userId: string, actionId: string, verification: unknown): void {
    const udb = this.getUserDb(userId);
    udb.db.run(
      `UPDATE action_ledger SET verification = ? WHERE id = ?`,
      [JSON.stringify(verification), actionId],
    );
  }

  getSupportTicket(userId: string, id: string): SupportTicket | null {
    const udb = this.getUserDb(userId);
    return udb.db.query(`SELECT * FROM support_tickets WHERE user_id = ? AND id = ?`).get(userId, id) as SupportTicket | null;
  }

  findTicketByMessageId(userId: string, messageId: string): SupportTicket | null {
    const udb = this.getUserDb(userId);
    return udb.db.query(`SELECT * FROM support_tickets WHERE user_id = ? AND resend_message_id = ?`).get(userId, messageId) as SupportTicket | null;
  }

  getTicketsByStatus(userId: string, statuses: string[]): SupportTicket[] {
    const udb = this.getUserDb(userId);
    const ph = statuses.map(() => "?").join(", ");
    return udb.db.query(`SELECT * FROM support_tickets WHERE user_id = ? AND status IN (${ph}) ORDER BY created_at ASC`).all(userId, ...statuses) as SupportTicket[];
  }

  // All recent tickets for the operator (for the Kanban board), newest activity first.
  getRecentSupportTickets(userId: string, limit: number = 200): SupportTicket[] {
    const udb = this.getUserDb(userId);
    const n = Math.max(1, Math.min(1000, Math.floor(limit)));
    return udb.db.query(`SELECT * FROM support_tickets WHERE user_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT ?`).all(userId, n) as SupportTicket[];
  }

  updateSupportTicket(userId: string, id: string, updates: Record<string, any>): void {
    const ALLOWED = new Set([
      "source", "client_email", "client_name", "resend_message_id", "subject", "body_raw",
      "classification", "severity", "project_id", "status", "branch_name", "diff_summary",
      "test_results", "deploy_result", "last_error",
    ]);
    const keys = Object.keys(updates).filter(k => ALLOWED.has(k));
    if (keys.length === 0) return;
    const set = keys.map(k => `${k} = ?`);
    set.push(`updated_at = datetime('now')`);
    const vals = [...keys.map(k => updates[k]), id, userId];
    this.getUserDb(userId).db.run(`UPDATE support_tickets SET ${set.join(", ")} WHERE id = ? AND user_id = ?`, vals);
  }

  getUserProjectById(userId: string, id: string): any | null {
    const udb = this.getUserDb(userId);
    return udb.db.query(`SELECT * FROM user_projects WHERE user_id = ? AND id = ?`).get(userId, id) as any;
  }

  getProjectByClientMatch(userId: string, clientEmail: string): any | null {
    const udb = this.getUserDb(userId);
    const rows = udb.db.query(`SELECT * FROM user_projects WHERE user_id = ? AND client_match IS NOT NULL AND client_match != ''`).all(userId) as any[];
    const email = clientEmail.toLowerCase();
    const domain = email.split("@").pop() || "";
    for (const r of rows) {
      const cm = String(r.client_match).toLowerCase();
      if (cm.startsWith("@")) {
        const dom = cm.slice(1);
        if (domain === dom || domain.endsWith("." + dom)) return r;
      } else {
        if (email === cm) return r;
      }
    }
    return null;
  }

  // Test helper — minimal project upsert (real project CRUD is out of scope for the thin slice)
  upsertUserProjectForTest(userId: string, p: { name: string; repo_url?: string; client_match?: string; test_command?: string; deploy_command?: string; rollback_command?: string; local_path?: string }): string {
    const id = uuid();
    const udb = this.getUserDb(userId);
    udb.db.run(`INSERT INTO user_projects (id, user_id, name, repo_url, local_path, client_match, test_command, deploy_command, rollback_command)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, name) DO UPDATE SET local_path=excluded.local_path, client_match=excluded.client_match, test_command=excluded.test_command, deploy_command=excluded.deploy_command, rollback_command=excluded.rollback_command`,
      [id, userId, p.name, p.repo_url || null, p.local_path || null, p.client_match || null, p.test_command || null, p.deploy_command || null, p.rollback_command || null]);
    const row = udb.db.query(`SELECT id FROM user_projects WHERE user_id = ? AND name = ?`).get(userId, p.name) as any;
    return row.id;
  }

  hasInProgressDevTask(userId: string, projectId: string): boolean {
    const udb = this.getUserDb(userId);
    const row = udb.db.query(
      `SELECT COUNT(*) as count FROM agent_tasks
       WHERE user_id = ? AND project_id = ? AND task_type = 'dev' AND status = 'in_progress'`
    ).get(userId, projectId) as { count: number } | null;
    return (row?.count ?? 0) > 0;
  }

  resetStaleInProgressTasks(): void {
    for (const userId of this.getAllUserIds()) {
      try {
        const udb = this.getUserDb(userId);
        udb.db.run(
          `UPDATE agent_tasks SET status = 'cancelled', result = 'Cancelled: service restarted'
           WHERE status = 'in_progress'`
        );
      } catch {}
    }
  }

  getPendingDevTasks(): Array<{ userId: string; task: AgentTaskRow }> {
    const results: Array<{ userId: string; task: AgentTaskRow }> = [];
    for (const userId of this.getAllUserIds()) {
      const udb = this.getUserDb(userId);
      const tasks = udb.db.query(
        `SELECT * FROM agent_tasks WHERE user_id = ? AND task_type = 'dev' AND status = 'pending'
         ORDER BY created_at ASC`
      ).all(userId) as AgentTaskRow[];
      for (const task of tasks) {
        results.push({ userId, task });
      }
    }
    return results;
  }

  // ── CS / SDR Mode — proxy to SharedDatabase ──────────────────────────────

  getCsConfig(): CsConfig { return this.shared.getCsConfig(); }
  saveCsConfig(config: Partial<CsConfig>): void { this.shared.saveCsConfig(config); }
  createCsDocument(id: string, filename: string, fileSize: number, mimeType: string): void {
    this.shared.createCsDocument(id, filename, fileSize, mimeType);
  }
  updateCsDocumentStatus(id: string, status: string, chunkCount?: number, errorMessage?: string): void {
    this.shared.updateCsDocumentStatus(id, status, chunkCount, errorMessage);
  }
  getCsDocuments(): CsDocument[] { return this.shared.getCsDocuments(); }
  deleteCsDocument(id: string): void { this.shared.deleteCsDocument(id); }
  insertCsKnowledgeChunk(id: string, docId: string, chunkText: string, embedding: Float32Array, chunkIndex: number, tokenCount: number): void {
    this.shared.insertCsKnowledgeChunk(id, docId, chunkText, embedding, chunkIndex, tokenCount);
  }
  searchCsKnowledge(queryEmbedding: Float32Array, limit: number): Array<{ id: string; chunk_text: string; similarity: number }> {
    return this.shared.searchCsKnowledge(queryEmbedding, limit);
  }
  createCsSession(id: string, channelType: string, channelSessionId: string, platformUserId?: string): CsSession {
    return this.shared.createCsSession(id, channelType, channelSessionId, platformUserId);
  }
  getCsSession(channelType: string, channelSessionId: string): CsSession | null {
    return this.shared.getCsSession(channelType, channelSessionId);
  }
  updateCsSession(id: string, updates: Partial<CsSession>): void { this.shared.updateCsSession(id, updates); }
  addCsMessage(id: string, sessionId: string, role: string, content: string, retrievedChunkIds?: string[], topSimilarity?: number): void {
    this.shared.addCsMessage(id, sessionId, role, content, retrievedChunkIds, topSimilarity);
  }
  getCsMessages(sessionId: string, limit?: number): CsMessage[] { return this.shared.getCsMessages(sessionId, limit); }
  getCsSessions(status?: string): CsSession[] { return this.shared.getCsSessions(status); }
}

// ============================================================
// Singleton
// ============================================================

let _db: Database | null = null;

export function getDb(): Database {
  if (!_db) {
    _db = new Database();
  }
  return _db;
}

export type { Database as DatabaseType };
