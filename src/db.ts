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
import { join, dirname } from "path";
import { mkdirSync, existsSync, readdirSync, renameSync } from "fs";
import * as sqliteVec from "sqlite-vec";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

// ============================================================
// Credential Encryption (AES-256-GCM)
// ============================================================

if (!process.env.NOVA_ENCRYPTION_KEY) {
  console.warn("[db] NOVA_ENCRYPTION_KEY not set — OAuth tokens stored unencrypted. Generate one with: openssl rand -hex 32");
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
const DATA_DIR = join(PROJECT_ROOT, "data");
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
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
        preferences TEXT DEFAULT '{"proactive_checkin":true,"morning_briefing":true,"briefing_hour":9,"voice_responses":false}',
        profile_text TEXT DEFAULT '',
        active INTEGER DEFAULT 1,
        ai_provider TEXT DEFAULT 'claude',
        ai_config TEXT DEFAULT '{}',
        team_id TEXT
      )
    `);
    // Safe migration for existing databases
    try { this.db.run(`ALTER TABLE users ADD COLUMN ai_provider TEXT DEFAULT 'claude'`); } catch {}
    try { this.db.run(`ALTER TABLE users ADD COLUMN ai_config TEXT DEFAULT '{}'`); } catch {}
    try { this.db.run(`ALTER TABLE users ADD COLUMN kapso_api_key TEXT`); } catch {}
    try { this.db.run(`ALTER TABLE users ADD COLUMN kapso_phone_number_id TEXT`); } catch {}
    try { this.db.run(`ALTER TABLE users ADD COLUMN team_id TEXT`); } catch {}
    try { this.db.run(`ALTER TABLE users ADD COLUMN approval_rules TEXT`); } catch {}
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_users_whatsapp_id ON users(whatsapp_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_users_slack_id ON users(slack_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_users_kapso_phone ON users(kapso_phone_number_id)`);

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

    // Migration: add agent_slug and exec_role columns to cost_tracking
    try { this.db.run(`ALTER TABLE cost_tracking ADD COLUMN agent_slug TEXT`); } catch {}
    try { this.db.run(`ALTER TABLE cost_tracking ADD COLUMN exec_role TEXT`); } catch {}
    try { this.db.run(`ALTER TABLE cost_tracking ADD COLUMN request_id TEXT`); } catch {}

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
    // Safe migration for existing databases
    try { this.db.run(`ALTER TABLE memory ADD COLUMN last_accessed_at TEXT DEFAULT (datetime('now'))`); } catch {}
    try { this.db.run(`ALTER TABLE memory ADD COLUMN weight REAL DEFAULT 1.0`); } catch {}
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

    // Per-user job role (e.g. "developer", "account_manager", "designer")
    try { this.db.run(`ALTER TABLE users ADD COLUMN job_role TEXT DEFAULT 'general'`); } catch {}
  }

  close(): void {
    this.db.close();
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
    // Safe migration for existing databases
    try { this.db.run(`ALTER TABLE memory ADD COLUMN last_accessed_at TEXT DEFAULT (datetime('now'))`); } catch {}
    try { this.db.run(`ALTER TABLE memory ADD COLUMN weight REAL DEFAULT 1.0`); } catch {}
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
        user_id TEXT
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_execution_patterns_user ON execution_patterns(user_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_execution_patterns_success ON execution_patterns(success_count DESC)`);

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
    return readdirSync(USERS_DIR)
      .filter(f => f.endsWith(".db"))
      .map(f => f.replace(".db", ""));
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
  }): string {
    const id = uuid();
    const udb = this.getUserDb(data.user_id);
    udb.db.run(`
      INSERT INTO agent_tasks (id, agent, description, status, user_id, parent_task_id, request_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      data.agent,
      data.description,
      data.status || "pending",
      data.user_id,
      data.parent_task_id || null,
      data.request_id || null,
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
      SELECT id, title, trigger_at, recurrence, timezone, created_by, status, condition
      FROM scheduled_tasks
      WHERE user_id = ? AND status = 'active'
      ORDER BY trigger_at ASC
    `).all(userId) as any[];
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

  findScheduledTaskByTitle(userId: string, searchText: string): any | null {
    const udb = this.getUserDb(userId);
    return udb.db.query(`
      SELECT id FROM scheduled_tasks
      WHERE user_id = ? AND status = 'active' AND title LIKE ? COLLATE NOCASE
      LIMIT 1
    `).get(userId, `%${searchText}%`) as any;
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
      SELECT id, success_count, fail_count, avg_duration_ms
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
  }): void {
    const udb = this.getUserDb(data.user_id);
    udb.db.run(`
      INSERT INTO execution_patterns (id, task_signature, plan, success_count, fail_count, avg_duration_ms, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      uuid(),
      data.task_signature,
      JSON.stringify(data.plan),
      data.success_count,
      data.fail_count,
      data.avg_duration_ms,
      data.user_id,
    ]);
  }

  updatePattern(id: string, updates: Record<string, any>): void {
    const setClauses: string[] = [];
    const values: any[] = [];

    for (const [key, val] of Object.entries(updates)) {
      setClauses.push(`${key} = ?`);
      values.push(key === "plan" ? JSON.stringify(val) : val);
    }

    setClauses.push(`updated_at = datetime('now')`);
    values.push(id);

    const sql = `UPDATE execution_patterns SET ${setClauses.join(", ")} WHERE id = ?`;
    this.runOnAllUserDbs(db => db.run(sql, values));
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
      service, key, value
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
      db.query(`SELECT * FROM pending_approvals WHERE id = ? AND status = 'pending'`).get(approvalId) as any
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
      WHERE user_id = ? AND status = 'pending'
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
