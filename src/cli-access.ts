/**
 * Nova — Access / RBAC CLI (`nova access …`)
 *
 *   nova access capabilities                 list the governed capabilities
 *   nova access grant <@user> <capability>
 *   nova access revoke <@user> <capability>
 *   nova access list <@user>
 *
 * Admins can do everything by default; grants let a member manage a governed area
 * (automations, policies, connectors, playbooks, processes, access).
 */

import { getDb, type DatabaseType } from "./db.ts";
import { CAPABILITIES, isCapability } from "./permissions.ts";
import { resolveAssignee } from "./task-routing.ts";

function adminId(db: DatabaseType): string {
  const a = db.getUsersByRole("admin")[0];
  if (!a) throw new Error("No user found — run `nova init` first.");
  return a.id;
}

function runGrant(ref: string, cap: string, revoke: boolean): number {
  if (!isCapability(cap)) { console.error(`  Unknown capability "${cap}". One of: ${CAPABILITIES.join(", ")}`); return 1; }
  const db = getDb();
  const who = resolveAssignee(db, ref);
  if (!who) { console.error(`  No user matching "${ref}"`); return 1; }
  if (revoke) { db.revokeCapability(who.userId, cap); console.log(`  ✓ Revoked ${cap} from ${who.name}`); }
  else { db.grantCapability(who.userId, cap, adminId(db)); console.log(`  ✓ Granted ${cap} to ${who.name}`); }
  return 0;
}

function runList(ref: string): number {
  const db = getDb();
  const who = resolveAssignee(db, ref);
  if (!who) { console.error(`  No user matching "${ref}"`); return 1; }
  const u = db.getUserById(who.userId);
  const caps = db.listUserCapabilities(who.userId);
  console.log(`  ${who.name} — role: ${u?.role || "member"}`);
  console.log(`  grants: ${caps.length ? caps.join(", ") : "(none)"}${u?.role === "admin" ? "  (admin → all capabilities)" : ""}`);
  return 0;
}

export function runAccessCli(argv: string[]): number {
  const [sub, a, b] = argv;
  switch (sub) {
    case "capabilities": case "caps": console.log("  " + CAPABILITIES.join("\n  ")); return 0;
    case "grant": return a && b ? runGrant(a, b, false) : (console.error("  Usage: nova access grant <@user> <capability>"), 1);
    case "revoke": return a && b ? runGrant(a, b, true) : (console.error("  Usage: nova access revoke <@user> <capability>"), 1);
    case "list": return a ? runList(a) : (console.error("  Usage: nova access list <@user>"), 1);
    default:
      console.error("  Usage: nova access capabilities | grant <@user> <cap> | revoke <@user> <cap> | list <@user>");
      return 1;
  }
}

if (import.meta.main) {
  try { process.exit(runAccessCli(process.argv.slice(2))); }
  catch (err: any) { console.error(`\n  Error: ${err?.message || err}`); process.exit(1); }
}
