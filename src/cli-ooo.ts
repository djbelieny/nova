/**
 * Nova — Out-of-office / delegation CLI (`nova ooo …`)
 *
 *   nova ooo set <@delegate> [reason] [--until 2026-08-01]
 *   nova ooo clear
 *   nova ooo status
 *
 * While you're out, work assigned to you (and approvals routed to you) goes to your
 * delegate instead. Operates on the admin user by default.
 */

import { getDb, type DatabaseType } from "./db.ts";
import { resolveAssignee } from "./task-routing.ts";
import { resolveApprover } from "./delegation.ts";

function adminId(db: DatabaseType): string {
  const a = db.getUsersByRole("admin")[0];
  if (!a) throw new Error("No user found — run `nova init` first.");
  return a.id;
}

export function runOooCli(argv: string[]): number {
  const [sub, ...rest] = argv;
  const db = getDb();
  const me = adminId(db);
  if (sub === "clear") { db.clearDelegation(me); console.log("  ✓ Out-of-office cleared."); return 0; }
  if (sub === "status" || sub === undefined) {
    const d = db.getActiveDelegation(me);
    if (!d) { console.log("  You are not out of office."); return 0; }
    const name = db.getUserById(d.delegateUserId)?.name || d.delegateUserId;
    console.log(`  Out of office → ${name}${d.until ? ` until ${d.until}` : ""}${d.reason ? ` (${d.reason})` : ""}`);
    return 0;
  }
  if (sub === "set") {
    const positional = rest.filter(a => !a.startsWith("--"));
    const untilIdx = rest.indexOf("--until");
    const until = untilIdx >= 0 ? rest[untilIdx + 1] : undefined;
    const ref = positional[0];
    const reason = positional.slice(1).join(" ") || undefined;
    if (!ref) { console.error("  Usage: nova ooo set <@delegate> [reason] [--until <date>]"); return 1; }
    const who = resolveAssignee(db, ref);
    if (!who) { console.error(`  No user matching "${ref}"`); return 1; }
    db.setDelegation(me, who.userId, reason, until ? until.replace("T", " ") : undefined);
    const chain = resolveApprover(db, me);
    console.log(`  ✓ Out of office → ${who.name}${until ? ` until ${until}` : ""}. Work now routes to ${db.getUserById(chain.userId)?.name || who.name}.`);
    return 0;
  }
  console.error("  Usage: nova ooo set <@delegate> [reason] [--until <date>] | clear | status");
  return 1;
}

if (import.meta.main) {
  try { process.exit(runOooCli(process.argv.slice(2))); }
  catch (err: any) { console.error(`\n  Error: ${err?.message || err}`); process.exit(1); }
}
