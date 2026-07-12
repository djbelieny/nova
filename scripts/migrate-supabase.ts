/**
 * Nova — Supabase → SQLite Migration Script
 *
 * One-time migration that pulls production data from Supabase into the
 * split SQLite structure (shared.db + per-user DBs).
 *
 * Re-generates all embeddings locally using all-MiniLM-L6-v2 (384-dim)
 * since the old OpenAI embeddings (1536-dim) are incompatible.
 *
 * Requires SUPABASE_URL and SUPABASE_ANON_KEY in .env.
 *
 * Usage:
 *   bun run migrate:supabase          # normal run (INSERT OR IGNORE)
 *   bun run migrate:supabase -- --force   # drop and re-import
 *
 * Idempotent: uses INSERT OR IGNORE with original IDs.
 * --force flag wipes existing data and re-imports.
 */

import "dotenv/config";
import { getDb } from "../src/db.ts";
import { generateEmbedding } from "../src/embeddings.ts";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const FORCE = process.argv.includes("--force");

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env");
  process.exit(1);
}

// ============================================================
// Supabase REST API helpers
// ============================================================

const headers = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
};

async function supabaseFetch(table: string, opts?: {
  select?: string;
  filter?: string;
  order?: string;
  limit?: number;
  offset?: number;
}): Promise<any[]> {
  const params = new URLSearchParams();
  if (opts?.select) params.set("select", opts.select);
  if (opts?.filter) {
    // filter is raw PostgREST filter like "user_id=eq.abc"
    const url = `${SUPABASE_URL}/rest/v1/${table}?${opts.filter}&${params.toString()}`;
    return fetchPaginated(url, opts?.limit, opts?.offset);
  }
  if (opts?.order) params.set("order", opts.order);

  const url = `${SUPABASE_URL}/rest/v1/${table}?${params.toString()}`;
  return fetchPaginated(url, opts?.limit, opts?.offset);
}

async function fetchPaginated(baseUrl: string, batchSize: number = 1000, startOffset: number = 0): Promise<any[]> {
  const all: any[] = [];
  let offset = startOffset;

  while (true) {
    const separator = baseUrl.includes("?") ? "&" : "?";
    const url = `${baseUrl}${separator}limit=${batchSize}&offset=${offset}`;

    const res = await fetch(url, {
      headers: {
        ...headers,
        Range: `${offset}-${offset + batchSize - 1}`,
      },
    });

    if (!res.ok) {
      // 416 = Range Not Satisfiable (no more rows)
      if (res.status === 416) break;
      const text = await res.text();
      throw new Error(`Supabase fetch failed (${res.status}): ${text}`);
    }

    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;

    all.push(...rows);

    // If we got fewer rows than requested, we're done
    if (rows.length < batchSize) break;
    offset += batchSize;
  }

  return all;
}

async function tableExistsInSupabase(table: string): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?limit=0`, { headers });
    return res.ok;
  } catch {
    return false;
  }
}

// ============================================================
// Embedding re-generation
// ============================================================

let embedCount = 0;
let embedTotal = 0;

async function reEmbed(text: string): Promise<number[] | null> {
  embedCount++;
  if (embedCount % 50 === 0 || embedCount === embedTotal) {
    process.stdout.write(`\r  Embedding ${embedCount}/${embedTotal}...`);
  }
  return generateEmbedding(text);
}

// ============================================================
// Migration logic
// ============================================================

async function main() {
  console.log("Nova — Supabase → SQLite Migration");
  console.log(`Source: ${SUPABASE_URL}`);
  console.log(`Mode: ${FORCE ? "FORCE (re-import)" : "Normal (INSERT OR IGNORE)"}`);
  console.log("");

  const db = getDb();

  if (FORCE) {
    console.log("⚠ Force mode: clearing existing data...");
    db.raw.run("DELETE FROM memory");
    db.raw.run("DELETE FROM logs");
    db.raw.run("DELETE FROM cost_tracking");
    // User DBs will be cleared per-user below
  }

  // ---- 1. Users ----
  console.log("1. Migrating users...");
  const users = await supabaseFetch("users", { select: "*" });
  let userCount = 0;
  for (const u of users) {
    try {
      db.raw.run(`
        INSERT OR IGNORE INTO users (id, created_at, updated_at, telegram_id, name, timezone,
          phone, pin, whatsapp_id, slack_id, role, preferences, profile_text, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        u.id, u.created_at, u.updated_at, u.telegram_id, u.name, u.timezone || "UTC",
        u.phone || null, u.pin || null, u.whatsapp_id || null, u.slack_id || null,
        u.role || "member",
        typeof u.preferences === "string" ? u.preferences : JSON.stringify(u.preferences || {}),
        u.profile_text || "",
        u.active !== undefined ? (u.active ? 1 : 0) : 1,
      ]);
      userCount++;
    } catch (e: any) {
      console.warn(`  Skip user ${u.id}: ${e.message}`);
    }
  }
  console.log(`  ✓ ${userCount} users migrated`);

  // ---- 2. Messages (per user, with embedding re-generation) ----
  console.log("2. Migrating messages...");
  for (const u of users) {
    const messages = await supabaseFetch("messages", {
      filter: `user_id=eq.${u.id}`,
      select: "*",
    });

    if (messages.length === 0) continue;

    const userRaw = db.getUserRaw(u.id);

    if (FORCE) {
      userRaw.run("DELETE FROM messages WHERE user_id = ?", [u.id]);
    }

    embedTotal += messages.length;
    let count = 0;

    for (const m of messages) {
      try {
        const embedding = await reEmbed(m.content);
        const { embeddingToBlob } = await import("../src/db.ts");

        userRaw.run(`
          INSERT OR IGNORE INTO messages (id, created_at, role, content, channel, metadata, user_id, embedding)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          m.id, m.created_at, m.role, m.content, m.channel || "telegram",
          typeof m.metadata === "string" ? m.metadata : JSON.stringify(m.metadata || {}),
          m.user_id,
          embedding ? embeddingToBlob(embedding) : null,
        ]);
        count++;
      } catch (e: any) {
        console.warn(`  Skip message ${m.id}: ${e.message}`);
      }
    }

    console.log(`\n  ✓ User ${u.name}: ${count} messages`);
  }

  // ---- 3. Memory (split by scope) ----
  console.log("3. Migrating memory...");
  if (await tableExistsInSupabase("memory")) {
    const memories = await supabaseFetch("memory", { select: "*" });
    embedTotal += memories.length;
    let sharedCount = 0;
    let privateCount = 0;

    for (const m of memories) {
      try {
        const embedding = await reEmbed(m.content);
        const { embeddingToBlob } = await import("../src/db.ts");
        const scope = m.scope || "private";
        const embBlob = embedding ? embeddingToBlob(embedding) : null;

        const values = [
          m.id, m.created_at, m.updated_at, m.type, m.content, m.deadline || null,
          m.completed_at || null, m.priority || 0,
          typeof m.metadata === "string" ? m.metadata : JSON.stringify(m.metadata || {}),
          m.user_id, scope, embBlob,
        ];

        const sql = `
          INSERT OR IGNORE INTO memory (id, created_at, updated_at, type, content, deadline,
            completed_at, priority, metadata, user_id, scope, embedding)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        if (scope === "shared") {
          db.raw.run(sql, values);
          sharedCount++;
        } else {
          const userRaw = db.getUserRaw(m.user_id);
          userRaw.run(sql, values);
          privateCount++;
        }
      } catch (e: any) {
        console.warn(`  Skip memory ${m.id}: ${e.message}`);
      }
    }
    console.log(`\n  ✓ ${sharedCount} shared + ${privateCount} private memory entries`);
  }

  // ---- 4. Per-user tables ----
  const perUserTables = [
    "agent_tasks",
    "task_artifacts",
    "scheduled_tasks",
    "execution_patterns",
    "pending_approvals",
    "revision_sessions",
    "workflow_preferences",
    "user_integrations",
  ];

  console.log("4. Migrating per-user tables...");
  for (const table of perUserTables) {
    if (!(await tableExistsInSupabase(table))) {
      console.log(`  - ${table}: not found in Supabase, skipping`);
      continue;
    }

    let totalCount = 0;
    for (const u of users) {
      const rows = await supabaseFetch(table, {
        filter: `user_id=eq.${u.id}`,
        select: "*",
      });

      if (rows.length === 0) continue;

      const userRaw = db.getUserRaw(u.id);

      if (FORCE) {
        userRaw.run(`DELETE FROM ${table} WHERE user_id = ?`, [u.id]);
      }

      for (const row of rows) {
        try {
          const cols = Object.keys(row);
          const placeholders = cols.map(() => "?").join(", ");
          const values = cols.map(c => {
            const v = row[c];
            if (v === null || v === undefined) return null;
            if (typeof v === "object") return JSON.stringify(v);
            if (typeof v === "boolean") return v ? 1 : 0;
            return v;
          });

          userRaw.run(
            `INSERT OR IGNORE INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`,
            values
          );
          totalCount++;
        } catch (e: any) {
          // Silently skip rows that fail (e.g., column mismatch)
        }
      }
    }
    console.log(`  ✓ ${table}: ${totalCount} rows`);
  }

  // ---- 5. Global tables (logs, cost_tracking) ----
  console.log("5. Migrating global tables...");

  if (await tableExistsInSupabase("logs")) {
    const logs = await supabaseFetch("logs", { select: "*" });
    let count = 0;
    for (const l of logs) {
      try {
        db.raw.run(`
          INSERT OR IGNORE INTO logs (id, created_at, level, event, message, metadata, session_id, duration_ms, user_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          l.id, l.created_at, l.level || "info", l.event, l.message || null,
          typeof l.metadata === "string" ? l.metadata : JSON.stringify(l.metadata || {}),
          l.session_id || null, l.duration_ms || null, l.user_id || null,
        ]);
        count++;
      } catch {}
    }
    console.log(`  ✓ logs: ${count} rows`);
  }

  if (await tableExistsInSupabase("cost_tracking")) {
    const costs = await supabaseFetch("cost_tracking", { select: "*" });
    let count = 0;
    for (const c of costs) {
      try {
        db.raw.run(`
          INSERT OR IGNORE INTO cost_tracking (id, created_at, provider, model, input_tokens, output_tokens,
            cache_read_tokens, cache_creation_tokens, cost_usd, duration_ms, session_id, metadata, user_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          c.id, c.created_at, c.provider || "claude", c.model, c.input_tokens || 0,
          c.output_tokens || 0, c.cache_read_tokens || 0, c.cache_creation_tokens || 0,
          c.cost_usd || 0, c.duration_ms || 0, c.session_id || null,
          typeof c.metadata === "string" ? c.metadata : JSON.stringify(c.metadata || {}),
          c.user_id || null,
        ]);
        count++;
      } catch {}
    }
    console.log(`  ✓ cost_tracking: ${count} rows`);
  }

  // ---- 6. Nova status ----
  if (await tableExistsInSupabase("nova_status")) {
    const statusRows = await supabaseFetch("nova_status", { select: "*" });
    if (statusRows.length > 0) {
      const s = statusRows[0];
      const cols = Object.keys(s).filter(k => k !== "id");
      const sets = cols.map(c => `${c} = ?`);
      const vals = cols.map(c => {
        const v = s[c];
        if (typeof v === "object" && v !== null) return JSON.stringify(v);
        return v;
      });
      db.raw.run(`UPDATE nova_status SET ${sets.join(", ")} WHERE id = 1`, vals);
      console.log("  ✓ nova_status: updated");
    }
  }

  // ---- Summary ----
  console.log("");
  console.log("Migration complete!");
  console.log(`  Users: ${userCount}`);
  console.log(`  Embeddings re-generated: ${embedCount}`);
  console.log("");
  console.log("Verify with: bun run test:sqlite");
}

main().catch((err) => {
  console.error(`\nMigration failed: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
