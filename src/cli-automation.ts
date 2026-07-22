/**
 * Nova — Automation CLI (`nova automation …`)
 *
 *   nova automation list
 *   nova automation add <name> --agent <slug> --template "Follow up with {{contact.name}}"
 *   nova automation add <name> --playbook <name> --var client={{contact.name}}
 *       [--when amount:gt:1000] [--dedupe {{contact.email}}] [--rate 10]
 *   nova automation url <name>            show the POST endpoint + secret
 *   nova automation enable|disable <name>
 *   nova automation remove <name>
 *
 * Automations fire an agent task or a playbook when an event arrives (webhook today,
 * metric polling built in, connector sources in a later phase). Every fire runs through
 * the approval gate.
 */

import { getDb, type DatabaseType } from "./db.ts";
import { generateWebhookSecret } from "./webhook-server.ts";
import { simulateAutomation } from "./simulate.ts";

function adminId(db: DatabaseType): string {
  const admin = db.getUsersByRole("admin")[0];
  if (!admin) throw new Error("No user found — run `nova init` first.");
  return admin.id;
}

function baseUrl(): string {
  return (process.env.PUBLIC_BASE_URL || process.env.WEBHOOK_BASE_URL || `http://localhost:${process.env.WEBHOOK_PORT || 8788}`).replace(/\/$/, "");
}

interface Flags { [k: string]: string | string[] | boolean; }
function parseFlags(rest: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : "true";
      if (key === "when" || key === "var") { (flags[key] ||= []) as string[]; (flags[key] as string[]).push(val); }
      else flags[key] = val;
    } else positional.push(a);
  }
  return { positional, flags };
}

function runList(): number {
  const db = getDb();
  const autos = db.listAutomations(adminId(db));
  if (!autos.length) { console.log("  No automations. Add one: nova automation add <name> --agent <slug> --template \"…\""); return 0; }
  for (const a of autos) {
    const action = a.actionType === "playbook" ? `playbook:${a.actionRef}` : `agent:${a.actionRef}`;
    console.log(`  ${a.enabled ? "●" : "○"} ${a.name}  [${a.sourceType} → ${action}]  fired ${a.fireCount}×`);
  }
  return 0;
}

function runAdd(rest: string[]): number {
  const { positional, flags } = parseFlags(rest);
  const name = positional[0];
  if (!name) { console.error("  Usage: nova automation add <name> --agent <slug> --template \"…\"  |  --playbook <name> --var k=…"); return 1; }
  const db = getDb();
  const userId = adminId(db);

  const conditions = ((flags.when as string[]) || []).map((w) => {
    const [field, op, ...v] = w.split(":");
    return { field, op, value: v.join(":") };
  });

  let actionType: "agent" | "playbook";
  let actionRef: string;
  let actionConfig: Record<string, any> = {};
  if (flags.playbook) {
    actionType = "playbook";
    actionRef = String(flags.playbook);
    const vars: Record<string, string> = {};
    for (const v of (flags.var as string[]) || []) { const idx = v.indexOf("="); if (idx > 0) vars[v.slice(0, idx)] = v.slice(idx + 1); }
    actionConfig = { vars };
  } else if (flags.agent) {
    actionType = "agent";
    actionRef = String(flags.agent);
    actionConfig = { template: String(flags.template || `Handle event: {{.}}`) };
  } else {
    console.error("  Specify --agent <slug> (with --template) or --playbook <name> (with --var).");
    return 1;
  }

  const secret = generateWebhookSecret();
  const a = db.insertAutomation({
    userId, name,
    sourceType: String(flags.source || "webhook"),
    sourceConfig: flags.url ? { url: String(flags.url), valuePath: flags.valuePath ? String(flags.valuePath) : undefined } : {},
    conditions, actionType, actionRef, actionConfig,
    dedupeKey: flags.dedupe ? String(flags.dedupe) : null,
    rateLimitPerHour: flags.rate ? Number(flags.rate) : null,
    secret,
  });
  console.log(`  ✓ Added automation "${name}" (${actionType}:${actionRef})`);
  if ((flags.source || "webhook") === "webhook") {
    console.log(`  POST ${baseUrl()}/automation/${userId}/${a.id}`);
    console.log(`  Sign the body: X-Nova-Signature: sha256=HMAC_SHA256(body, "${secret}")`);
  }
  return 0;
}

function findByName(db: DatabaseType, userId: string, name: string) {
  return db.listAutomations(userId).find((a) => a.name === name) || null;
}

function runUrl(name: string): number {
  const db = getDb(); const userId = adminId(db);
  const a = findByName(db, userId, name);
  if (!a) { console.error(`  No automation "${name}"`); return 1; }
  console.log(`  POST ${baseUrl()}/automation/${userId}/${a.id}`);
  if (a.secret) console.log(`  X-Nova-Signature: sha256=HMAC_SHA256(body, "${a.secret}")`);
  return 0;
}

function runToggle(name: string, enabled: boolean): number {
  const db = getDb(); const userId = adminId(db);
  const a = findByName(db, userId, name);
  if (!a) { console.error(`  No automation "${name}"`); return 1; }
  db.setAutomationEnabled(userId, a.id, enabled);
  console.log(`  ✓ ${name} ${enabled ? "enabled" : "disabled"}`);
  return 0;
}

function runRemove(name: string): number {
  const db = getDb(); const userId = adminId(db);
  const a = findByName(db, userId, name);
  if (!a) { console.error(`  No automation "${name}"`); return 1; }
  db.deleteAutomation(userId, a.id);
  console.log(`  ✓ Removed "${name}"`);
  return 0;
}

function runSimulate(rest: string[]): number {
  const { positional, flags } = parseFlags(rest);
  const name = positional[0];
  if (!name) { console.error("  Usage: nova automation simulate <name> --event '{\"amount\":1200}'"); return 1; }
  const db = getDb(); const userId = adminId(db);
  const a = db.listAutomations(userId).find((x) => x.name === name);
  if (!a) { console.error(`  No automation "${name}"`); return 1; }
  let event: Record<string, any> = {};
  if (flags.event) {
    try { event = JSON.parse(String(flags.event)); }
    catch (err: any) { console.error(`  Invalid --event JSON: ${err?.message || err}`); return 1; }
  }
  const sim = simulateAutomation(db, a, event);
  console.log(`  Simulating "${name}" (nothing is dispatched):`);
  if (sim.wouldFire) {
    console.log(`  ✓ Would fire → agent:${sim.agentSlug}`);
    console.log(`    Task: ${sim.taskDescription}`);
  } else {
    console.log(`  ✗ Would NOT fire — ${sim.reason}`);
  }
  return 0;
}

export function runAutomationCli(argv: string[]): number {
  const [sub, ...rest] = argv;
  const name = rest.find((a) => !a.startsWith("--")) || "";
  switch (sub) {
    case "list": case undefined: return runList();
    case "add": return runAdd(rest);
    case "url": return name ? runUrl(name) : (console.error("  Usage: nova automation url <name>"), 1);
    case "enable": return name ? runToggle(name, true) : (console.error("  Usage: nova automation enable <name>"), 1);
    case "disable": return name ? runToggle(name, false) : (console.error("  Usage: nova automation disable <name>"), 1);
    case "remove": case "rm": return name ? runRemove(name) : (console.error("  Usage: nova automation remove <name>"), 1);
    case "simulate": case "dry-run": return runSimulate(rest);
    default:
      console.error(`  Unknown subcommand: ${sub}\n  Usage: nova automation list|add|url|enable|disable|remove|simulate`);
      return 1;
  }
}

if (import.meta.main) {
  try { process.exit(runAutomationCli(process.argv.slice(2))); }
  catch (err: any) { console.error(`\n  Error: ${err?.message || err}`); process.exit(1); }
}
