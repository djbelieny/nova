/**
 * Nova — Connector CLI (`nova connector …`)
 *
 *   nova connector list                       built-ins + configured status
 *   nova connector test <id>                  verify credentials with a read action
 *   nova connector run <id> <action> --input '{"limit":5}'
 *
 * Credentials come from env vars (see each connector's list) or the shared_credentials store.
 * Write actions are consequential — run them through a gated flow in production.
 */

import { getDb } from "./db.ts";
import { listConnectors, getConnector, isConnectorConfigured, runConnectorAction } from "./connectors/registry.ts";

function runList(): number {
  const db = getDb();
  for (const c of listConnectors()) {
    const ok = isConnectorConfigured(c, db);
    const actions = Object.keys(c.actions).join(", ");
    console.log(`  ${ok ? "●" : "○"} ${c.id} — ${c.label}  [${ok ? "configured" : `set ${c.credEnv.join(", ")}`}]`);
    console.log(`      actions: ${actions}`);
  }
  return 0;
}

/** `nova connector describe <id>` — introspect a connector's actions + params (mcp2cli-style --help). */
function runDescribe(id: string): number {
  const c = getConnector(id);
  if (!c) { console.error(`  Unknown connector: ${id}`); return 1; }
  console.log(`  ${c.id} — ${c.label}  (auth: ${c.authKind}; creds: ${c.credEnv.join(", ")})`);
  console.log("  actions:");
  for (const [name, a] of Object.entries(c.actions)) {
    const params = (a.inputs || []).map(i => i.required ? `${i.name}*` : i.name).join(", ");
    console.log(`   • ${name}${a.write ? " [write — gate this]" : ""} — ${a.description}${params ? `  params: { ${params} }` : ""}`);
    for (const i of a.inputs || []) if (i.description) console.log(`       ${i.name}: ${i.description}`);
  }
  if (c.triggers?.length) console.log(`  triggers (automation sources): ${c.triggers.map(t => t.event).join(", ")}`);
  console.log(`  call: nova connector run ${c.id} <action> --input '{"key":"value"}'`);
  return 0;
}

async function runTest(id: string): Promise<number> {
  const db = getDb();
  const c = getConnector(id);
  if (!c) { console.error(`  Unknown connector: ${id}`); return 1; }
  if (!isConnectorConfigured(c, db)) { console.error(`  ${id} not configured — set ${c.credEnv.join(", ")}`); return 1; }
  // Use the first non-write action as a read probe.
  const probe = Object.entries(c.actions).find(([, a]) => !a.write)?.[0];
  if (!probe) { console.log(`  ${id} configured (no read action to probe).`); return 0; }
  const r = await runConnectorAction(db, id, probe, { limit: 1 });
  if (r.ok) { console.log(`  ✓ ${id}.${probe} ok`); return 0; }
  console.error(`  ✗ ${id}.${probe}: ${r.error}`);
  return 1;
}

async function runAction(id: string, action: string, rest: string[]): Promise<number> {
  const i = rest.indexOf("--input");
  let input: Record<string, any> = {};
  if (i >= 0 && rest[i + 1]) { try { input = JSON.parse(rest[i + 1]); } catch { console.error("  --input must be JSON"); return 1; } }
  const r = await runConnectorAction(getDb(), id, action, input);
  if (!r.ok) { console.error(`  ✗ ${r.error}`); return 1; }
  console.log(JSON.stringify(r.data, null, 2).slice(0, 4000));
  return 0;
}

/** `nova connector set|rotate <id> NAME=value …` — store credentials encrypted at rest. */
function runSet(id: string, pairs: string[]): number {
  const c = getConnector(id);
  if (!c) { console.error(`  Unknown connector: ${id}`); return 1; }
  const creds: Record<string, string> = {};
  for (const p of pairs) { const i = p.indexOf("="); if (i > 0) creds[p.slice(0, i)] = p.slice(i + 1); }
  if (!Object.keys(creds).length) { console.error(`  Usage: nova connector set ${id} ${c.credEnv.map(e => `${e}=…`).join(" ")}`); return 1; }
  const db = getDb();
  const by = db.getUsersByRole("admin")[0]?.id || "cli";
  db.setConnectorSecret(id, creds, by);
  console.log(`  ✓ Stored ${Object.keys(creds).join(", ")} for ${id} (encrypted at rest). Rotations logged: ${db.listSecretRotations(id).length}.`);
  return 0;
}

export async function runConnectorCli(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "list": case undefined: return runList();
    case "describe": case "help": return rest[0] ? runDescribe(rest[0]) : (console.error("  Usage: nova connector describe <id>"), 1);
    case "test": return rest[0] ? runTest(rest[0]) : (console.error("  Usage: nova connector test <id>"), 1);
    case "run": return rest[0] && rest[1] ? runAction(rest[0], rest[1], rest.slice(2)) : (console.error("  Usage: nova connector run <id> <action> --input '{…}'"), 1);
    case "set": case "rotate": return rest[0] ? runSet(rest[0], rest.slice(1)) : (console.error("  Usage: nova connector set <id> NAME=value …"), 1);
    default:
      console.error(`  Unknown subcommand: ${sub}\n  Usage: nova connector list|test <id>|run <id> <action>|set <id> NAME=value`);
      return 1;
  }
}

if (import.meta.main) {
  runConnectorCli(process.argv.slice(2)).then(c => process.exit(c)).catch(err => { console.error(`\n  Error: ${err?.message || err}`); process.exit(1); });
}
