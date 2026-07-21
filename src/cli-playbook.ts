/**
 * Nova — Playbook CLI (`nova playbook …`)
 *
 *   nova playbook list
 *   nova playbook seed                      load the starter library
 *   nova playbook show <name>
 *   nova playbook remove <name> [--team]
 *
 * Running a playbook happens in a conversation (Telegram, /playbook run, or `nova chat`)
 * because execution flows through the approval gate; the CLI manages the library.
 */

import { getDb, type DatabaseType, type PlaybookScope } from "./db.ts";
import { describePlaybook, SEED_PLAYBOOKS } from "./playbooks.ts";

function adminId(db: DatabaseType): string {
  const admin = db.getUsersByRole("admin")[0];
  if (!admin) throw new Error("No user found — run `nova init` first.");
  return admin.id;
}

function runList(): number {
  const db = getDb();
  const pbs = db.listPlaybooksVisible(adminId(db));
  if (!pbs.length) { console.log("  No playbooks. Load starters: nova playbook seed"); return 0; }
  for (const p of pbs) console.log(`  ${describePlaybook(p)}`);
  return 0;
}

function runSeed(): number {
  const db = getDb();
  const userId = adminId(db);
  let n = 0;
  for (const s of SEED_PLAYBOOKS) {
    if (!db.findPlaybook(userId, s.name)) { db.insertPlaybook({ ...s, scope: "personal", userId }); n++; }
  }
  console.log(`  ✓ Loaded ${n} starter playbook${n === 1 ? "" : "s"}. Run one in chat: /playbook run <name> key=value`);
  return 0;
}

function runShow(name: string): number {
  const db = getDb();
  const pb = db.findPlaybook(adminId(db), name);
  if (!pb) { console.error(`  No playbook named "${name}"`); return 1; }
  console.log(`  ${pb.name} (v${pb.version}, ${pb.scope})`);
  if (pb.description) console.log(`  ${pb.description}`);
  if (pb.variables.length) console.log(`  vars: ${pb.variables.map(v => v.required ? `${v.name}*` : v.name).join(", ")}`);
  pb.steps.forEach((s, i) => console.log(`   ${i + 1}. [${s.agent || "general"}/${s.phase || "prepare"}] ${s.description}`));
  return 0;
}

function runRemove(name: string, team: boolean): number {
  const db = getDb();
  const scope: PlaybookScope = team ? "team" : "personal";
  const userId = adminId(db);
  const pb = db.getPlaybookByName(scope, userId, name);
  if (!pb) { console.error(`  No ${scope} playbook named "${name}"`); return 1; }
  db.deletePlaybook(scope, userId, pb.id);
  console.log(`  ✓ Removed "${name}" (${scope})`);
  return 0;
}

export function runPlaybookCli(argv: string[]): number {
  const [sub, ...rest] = argv;
  const team = rest.includes("--team");
  const positional = rest.filter(a => !a.startsWith("--"));
  switch (sub) {
    case "list": case undefined: return runList();
    case "seed": return runSeed();
    case "show": return positional[0] ? runShow(positional[0]) : (console.error("  Usage: nova playbook show <name>"), 1);
    case "remove": case "rm": return positional[0] ? runRemove(positional[0], team) : (console.error("  Usage: nova playbook remove <name> [--team]"), 1);
    case "run":
      console.log("  Run playbooks in a conversation so they pass the approval gate:");
      console.log(`    • Telegram/Discord/chat: /playbook run ${positional[0] || "<name>"} key=value`);
      console.log("    • Terminal: nova chat");
      return 0;
    default:
      console.error(`  Unknown subcommand: ${sub}\n  Usage: nova playbook list|seed|show <name>|remove <name> [--team]`);
      return 1;
  }
}

if (import.meta.main) {
  try { process.exit(runPlaybookCli(process.argv.slice(2))); }
  catch (err: any) { console.error(`\n  Error: ${err?.message || err}`); process.exit(1); }
}
