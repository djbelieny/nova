/**
 * Nova — Executive Board: supabase.com → self-hosted migration
 *
 * Copies the 10 board tables from an existing supabase.com PostgREST endpoint to
 * a self-hosted Postgres + PostgREST stack (see deploy/board/). Only needed if you
 * already ran the board on supabase.com and want to keep that data.
 *
 * NOTE: distinct from scripts/migrate-supabase.ts, which imports the *app* data
 * (users/messages/memory) into SQLite. This one only touches the board schema.
 *
 * Source (supabase.com):  SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY)
 * Dest   (self-hosted):   BOARD_DB_URL + BOARD_DB_KEY
 *
 * Usage:
 *   bun run scripts/migrate-board-to-selfhosted.ts            # copy
 *   bun run scripts/migrate-board-to-selfhosted.ts --dry-run  # report row counts only
 *
 * Idempotent: rows carry their original UUID/PK and are upserted
 * (Prefer: resolution=merge-duplicates), so re-runs are safe.
 */

import "dotenv/config";

const SOURCE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SOURCE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";
const DEST_URL = (process.env.BOARD_DB_URL || "").replace(/\/$/, "");
const DEST_KEY = process.env.BOARD_DB_KEY || "";
const DRY_RUN = process.argv.includes("--dry-run");

if (!SOURCE_URL || !SOURCE_KEY) {
  console.error("Missing source. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY).");
  process.exit(1);
}
if (!DEST_URL || !DEST_KEY) {
  console.error("Missing destination. Set BOARD_DB_URL and BOARD_DB_KEY (see deploy/board/setup.sh output).");
  process.exit(1);
}

// FK-safe order: parents before children.
//   board_sessions  ← exec_messages, board_contributions, decisions, projects
//   decisions       ← decision_log
const TABLES = [
  "exec_nodes",
  "board_sessions",
  "exec_messages",
  "board_contributions",
  "delegations",
  "decisions",
  "decision_log",
  "exec_heartbeats",
  "projects",
  "proactive_runs",
] as const;

const BATCH = 1000;

function headers(key: string, prefer?: string): Record<string, string> {
  const h: Record<string, string> = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (prefer) h["Prefer"] = prefer;
  return h;
}

async function fetchAll(table: string): Promise<any[]> {
  const rows: any[] = [];
  let offset = 0;
  while (true) {
    const res = await fetch(`${SOURCE_URL}/rest/v1/${table}?limit=${BATCH}&offset=${offset}`, {
      headers: headers(SOURCE_KEY),
    });
    if (!res.ok) {
      if (res.status === 416) break;
      throw new Error(`source ${table} read failed (${res.status}): ${await res.text()}`);
    }
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    rows.push(...batch);
    if (batch.length < BATCH) break;
    offset += BATCH;
  }
  return rows;
}

async function upsert(table: string, rows: any[]): Promise<number> {
  if (rows.length === 0) return 0;
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const res = await fetch(`${DEST_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: headers(DEST_KEY, "resolution=merge-duplicates,return=minimal"),
      body: JSON.stringify(chunk),
    });
    if (!res.ok) throw new Error(`dest ${table} write failed (${res.status}): ${await res.text()}`);
    done += chunk.length;
  }
  return done;
}

async function main() {
  console.log("Nova — Board migration: supabase.com → self-hosted");
  console.log(`  Source: ${SOURCE_URL}`);
  console.log(`  Dest:   ${DEST_URL}`);
  console.log(`  Mode:   ${DRY_RUN ? "DRY RUN (read only)" : "COPY (upsert)"}`);
  console.log("");

  let grandTotal = 0;
  for (const table of TABLES) {
    const rows = await fetchAll(table);
    if (DRY_RUN) {
      console.log(`  ${table}: ${rows.length} rows in source`);
      grandTotal += rows.length;
      continue;
    }
    const written = await upsert(table, rows);
    grandTotal += written;
    console.log(`  ${table}: ${written} rows copied`);
  }

  console.log("");
  console.log(`${DRY_RUN ? "Would copy" : "Copied"} ${grandTotal} rows across ${TABLES.length} tables.`);
  if (!DRY_RUN) console.log("Point Nova at the self-hosted stack: set BOARD_DB_URL / BOARD_DB_KEY in .env.");
}

main().catch((err) => {
  console.error(`\nMigration failed: ${err.message}`);
  process.exit(1);
});
