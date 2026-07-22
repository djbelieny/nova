/**
 * Nova — Dead-letter CLI (`nova dlq list | retry <id> | drop <id>`)
 *
 * Automations that exhausted their retries are parked in the dead_letter table. This CLI
 * inspects them, retries one (re-running dispatchAutomation for the stored automation +
 * payload; on success the dead_letter row is dropped), or drops one permanently.
 */

import { getDb, type DatabaseType } from "./db.ts";
import { dispatchAutomation } from "./automation-engine.ts";

function adminId(db: DatabaseType): string {
  const admin = db.getUsersByRole("admin")[0];
  if (!admin) throw new Error("No user found — run `nova init` first.");
  return admin.id;
}

/** Headless dispatch for retries: insert a pending agent task, return its id. */
function makeDispatch(db: DatabaseType, createdBy = "dlq-retry") {
  return async (userId: string, agentSlug: string, taskDescription: string): Promise<string | null> => {
    try { return db.insertTask({ agent: agentSlug, description: taskDescription, status: "pending", user_id: userId, created_by: createdBy }); }
    catch { return null; }
  };
}

function runList(): number {
  const db = getDb();
  const rows = db.listDeadLetters(adminId(db));
  if (!rows.length) { console.log("  Dead-letter queue is empty."); return 0; }
  console.log("  Dead-letter queue:");
  for (const d of rows) {
    const when = (d.createdAt || "").replace("T", " ").slice(0, 19);
    console.log(`  ✗ ${d.id}  [${d.kind}] ${d.refName || d.refId || ""}  — ${d.error || "unknown error"}  ${when}`);
  }
  console.log("\n  Retry one: nova dlq retry <id>   Drop one: nova dlq drop <id>");
  return 0;
}

async function runRetry(id: string): Promise<number> {
  const db = getDb(); const userId = adminId(db);
  const dl = db.getDeadLetter(userId, id);
  if (!dl) { console.error(`  No dead-letter "${id}"`); return 1; }
  if (dl.kind !== "automation" || !dl.refId) { console.error(`  Only automation dead-letters can be retried.`); return 1; }
  const automation = db.getAutomation(userId, dl.refId);
  if (!automation) { console.error(`  The source automation no longer exists — drop it: nova dlq drop ${id}`); return 1; }
  let event: Record<string, any> = {};
  try { event = dl.payload ? JSON.parse(dl.payload) : {}; } catch { /* empty event */ }

  const outcome = await dispatchAutomation(db, automation, event, makeDispatch(db));
  if (outcome.fired) {
    db.deleteDeadLetter(userId, id);
    console.log(`  ✓ Retried "${automation.name}" → task ${outcome.taskId}. Dropped from the queue.`);
    return 0;
  }
  console.error(`  ✗ Retry did not fire (${outcome.reason || "unknown"}). Left in the queue.`);
  return 1;
}

function runDrop(id: string): number {
  const db = getDb(); const userId = adminId(db);
  const dl = db.getDeadLetter(userId, id);
  if (!dl) { console.error(`  No dead-letter "${id}"`); return 1; }
  db.deleteDeadLetter(userId, id);
  console.log(`  ✓ Dropped "${id}"`);
  return 0;
}

export async function runDlqCli(argv: string[]): Promise<number> {
  const [sub, arg] = argv;
  switch (sub) {
    case "list": case undefined: return runList();
    case "retry": return arg ? runRetry(arg) : (console.error("  Usage: nova dlq retry <id>"), 1);
    case "drop": case "rm": return arg ? runDrop(arg) : (console.error("  Usage: nova dlq drop <id>"), 1);
    default:
      console.error(`  Unknown subcommand: ${sub}\n  Usage: nova dlq list|retry <id>|drop <id>`);
      return 1;
  }
}

if (import.meta.main) {
  runDlqCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: any) => { console.error(`\n  Error: ${err?.message || err}`); process.exit(1); });
}
