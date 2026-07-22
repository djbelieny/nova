/**
 * Nova — Activity CLI (`nova activity [--kind automation|process|playbook] [--limit N]`)
 * Unified run observability: recent run_events across automations, processes, and playbooks.
 */

import { getDb, type DatabaseType } from "./db.ts";

function adminId(db: DatabaseType): string {
  const admin = db.getUsersByRole("admin")[0];
  if (!admin) throw new Error("No user found — run `nova init` first.");
  return admin.id;
}

const ICON: Record<string, string> = {
  fired: "⚡", started: "▶", waiting: "⏳", done: "✅", skipped: "⏭", failed: "❌",
};
const KIND_ICON: Record<string, string> = { automation: "⚡", process: "🔁", playbook: "📋" };

export function runActivityCli(argv: string[]): number {
  const ki = argv.indexOf("--kind");
  const kind = ki >= 0 ? argv[ki + 1] : undefined;
  const li = argv.indexOf("--limit");
  const limit = li >= 0 ? Number(argv[li + 1]) || 20 : 20;

  const db = getDb();
  const events = db.listRunEvents(adminId(db), { kind, limit });
  if (!events.length) { console.log("  No activity yet."); return 0; }

  console.log(`  Recent activity${kind ? ` (${kind})` : ""}:`);
  for (const e of events) {
    const icon = ICON[e.status] || "•";
    const kicon = KIND_ICON[e.kind] || "•";
    const when = (e.createdAt || "").replace("T", " ").slice(0, 19);
    const ref = e.refName ? ` ${e.refName}` : "";
    const detail = e.detail ? `  — ${e.detail}` : "";
    console.log(`  ${icon} ${kicon} [${e.kind}] ${e.status}${ref}${detail}  ${when}`);
  }
  return 0;
}

if (import.meta.main) {
  try { process.exit(runActivityCli(process.argv.slice(2))); }
  catch (err: any) { console.error(`\n  Error: ${err?.message || err}`); process.exit(1); }
}
