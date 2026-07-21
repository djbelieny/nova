/**
 * Nova — Policy CLI (`nova policy …`)
 *
 *   nova policy add spend-cap --cap 500 --period month [--department marketing]
 *   nova policy add approval --action email.send --approver <userId> [--role admin] [--escalate 30]
 *   nova policy add content-check --checks pii,profanity --on-fail block
 *   nova policy list | remove <id> | enable <id> | disable <id>
 *
 * Policies are restrictive-only: they add friction (require approval / block / warn); they
 * never grant more autonomy than the earned-autonomy ladder already allows.
 */

import { getDb, type DatabaseType } from "./db.ts";

function adminId(db: DatabaseType): string {
  const admin = db.getUsersByRole("admin")[0];
  if (!admin) throw new Error("No user found — run `nova init` first.");
  return admin.id;
}

function flag(rest: string[], name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}

function runAdd(rest: string[]): number {
  const kind = rest[0];
  const db = getDb();
  const userId = adminId(db);
  const department = flag(rest, "department");
  const scope = department ? "department" : "org";

  if (kind === "spend-cap") {
    const cap = Number(flag(rest, "cap"));
    if (!cap) { console.error("  Usage: nova policy add spend-cap --cap <usd> [--period day|month] [--department <d>]"); return 1; }
    const period = flag(rest, "period") === "month" ? "month" : "day";
    db.insertPolicy({ userId, scope, scopeRef: department ?? null, kind: "spend_cap", config: { capUsd: cap, period, department } });
    console.log(`  ✓ Spend cap $${cap}/${period}${department ? ` for ${department}` : ""}`);
    return 0;
  }
  if (kind === "approval") {
    const approver = flag(rest, "approver");
    const action = flag(rest, "action");
    db.insertPolicy({ userId, scope, scopeRef: department ?? null, kind: "approval_matrix", config: {
      actionType: action, department, approvers: approver ? [approver] : [], minApproverRole: flag(rest, "role"),
      escalateAfterMin: flag(rest, "escalate") ? Number(flag(rest, "escalate")) : undefined,
    } });
    console.log(`  ✓ Approval required${action ? ` for ${action}` : ""}${approver ? ` by ${approver}` : ""}`);
    return 0;
  }
  if (kind === "content-check") {
    const checks = (flag(rest, "checks") || "pii").split(",").map(s => s.trim());
    const onFail = flag(rest, "on-fail") === "block" ? "block" : "warn";
    db.insertPolicy({ userId, scope, scopeRef: department ?? null, kind: "content_check", config: { checks, onFail, department } });
    console.log(`  ✓ Content check [${checks.join(", ")}] → ${onFail}`);
    return 0;
  }
  console.error("  Usage: nova policy add spend-cap|approval|content-check …");
  return 1;
}

function runList(): number {
  const db = getDb();
  const policies = db.listPolicies(adminId(db));
  if (!policies.length) { console.log("  No policies. Default behavior = the autonomy ladder alone."); return 0; }
  for (const p of policies) {
    const c = p.config;
    let desc = "";
    if (p.kind === "spend_cap") desc = `cap $${c.capUsd}/${c.period}`;
    else if (p.kind === "approval_matrix") desc = `approval${c.actionType ? ` for ${c.actionType}` : ""}${c.approvers?.length ? ` by ${c.approvers.join(",")}` : ""}`;
    else if (p.kind === "content_check") desc = `check [${(c.checks || []).join(",")}] → ${c.onFail}`;
    console.log(`  ${p.enabled ? "●" : "○"} [${p.kind}] ${desc} ${p.scope !== "org" ? `(${p.scope}:${p.scopeRef})` : ""}  id=${p.id}`);
  }
  return 0;
}

function runToggle(id: string, enabled: boolean): number {
  const db = getDb(); const userId = adminId(db);
  db.setPolicyEnabled(userId, id, enabled);
  console.log(`  ✓ Policy ${enabled ? "enabled" : "disabled"}`);
  return 0;
}

function runRemove(id: string): number {
  const db = getDb(); const userId = adminId(db);
  db.deletePolicy(userId, id);
  console.log(`  ✓ Removed policy ${id}`);
  return 0;
}

export function runPolicyCli(argv: string[]): number {
  const [sub, ...rest] = argv;
  const id = rest.find(a => !a.startsWith("--")) || "";
  switch (sub) {
    case "list": case undefined: return runList();
    case "add": return runAdd(rest);
    case "remove": case "rm": return id ? runRemove(id) : (console.error("  Usage: nova policy remove <id>"), 1);
    case "enable": return id ? runToggle(id, true) : (console.error("  Usage: nova policy enable <id>"), 1);
    case "disable": return id ? runToggle(id, false) : (console.error("  Usage: nova policy disable <id>"), 1);
    default:
      console.error(`  Unknown subcommand: ${sub}\n  Usage: nova policy list|add|remove|enable|disable`);
      return 1;
  }
}

if (import.meta.main) {
  try { process.exit(runPolicyCli(process.argv.slice(2))); }
  catch (err: any) { console.error(`\n  Error: ${err?.message || err}`); process.exit(1); }
}
