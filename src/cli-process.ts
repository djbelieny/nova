/**
 * Nova — Durable Process CLI (`nova process …`)
 *
 *   nova process list [--state waiting|running|done]
 *   nova process show <id>
 *   nova process cancel <id>
 *   nova process start <name> --from-playbook <playbook>   (a durable run of a playbook)
 *
 * Processes advance in the background (timers resume via the task dispatcher; events via
 * a signal). Each action step runs a normal task; consequential ones pass the gate.
 */

import { getDb, type DatabaseType, type ProcessStep } from "./db.ts";

function adminId(db: DatabaseType): string {
  const admin = db.getUsersByRole("admin")[0];
  if (!admin) throw new Error("No user found — run `nova init` first.");
  return admin.id;
}

function runList(state?: string): number {
  const db = getDb();
  const procs = db.listProcesses(adminId(db), state);
  if (!procs.length) { console.log("  No processes."); return 0; }
  for (const p of procs) {
    const wait = p.state === "waiting" ? (p.waitUntil ? ` until ${p.waitUntil}` : p.waitEvent ? ` for ${p.waitEvent}` : "") : "";
    console.log(`  ${p.state.padEnd(9)} ${p.name}  (step ${p.currentStep}/${p.steps.length}${wait})  id=${p.id}`);
  }
  return 0;
}

function runShow(id: string): number {
  const db = getDb();
  const p = db.getProcess(adminId(db), id);
  if (!p) { console.error(`  No process ${id}`); return 1; }
  console.log(`  ${p.name} — ${p.state} (step ${p.currentStep}/${p.steps.length})`);
  p.steps.forEach((s, i) => {
    const mark = i < p.currentStep ? "✓" : i === p.currentStep ? "▶" : " ";
    const body = s.type === "wait" ? `wait ${s.until || s.event || "?"}` : `[${s.agent || "general"}] ${s.description}`;
    console.log(`   ${mark} ${i + 1}. ${body}`);
  });
  return 0;
}

function runCancel(id: string): number {
  const db = getDb();
  const userId = adminId(db);
  const p = db.getProcess(userId, id);
  if (!p) { console.error(`  No process ${id}`); return 1; }
  db.updateProcess(userId, id, { state: "cancelled" });
  console.log(`  ✓ Cancelled "${p.name}"`);
  return 0;
}

function runStart(rest: string[]): number {
  const positional = rest.filter(a => !a.startsWith("--"));
  const name = positional[0];
  const fromIdx = rest.indexOf("--from-playbook");
  const pbName = fromIdx >= 0 ? rest[fromIdx + 1] : null;
  if (!name || !pbName) { console.error("  Usage: nova process start <name> --from-playbook <playbook>"); return 1; }
  const db = getDb();
  const userId = adminId(db);
  const pb = db.findPlaybook(userId, pbName);
  if (!pb) { console.error(`  No playbook "${pbName}"`); return 1; }
  const steps: ProcessStep[] = pb.steps.map(s => ({ type: "action", agent: s.agent, description: s.description }));
  const proc = db.insertProcess({ userId, name, steps, playbookId: pb.id });
  console.log(`  ✓ Created durable process "${name}" from playbook "${pbName}" (${steps.length} steps) — id ${proc.id}`);
  console.log(`  It will advance in the background. Watch it: nova process show ${proc.id}`);
  return 0;
}

export function runProcessCli(argv: string[]): number {
  const [sub, ...rest] = argv;
  const stateIdx = rest.indexOf("--state");
  const state = stateIdx >= 0 ? rest[stateIdx + 1] : undefined;
  const id = rest.find(a => !a.startsWith("--")) || "";
  switch (sub) {
    case "list": case undefined: return runList(state);
    case "show": return id ? runShow(id) : (console.error("  Usage: nova process show <id>"), 1);
    case "cancel": return id ? runCancel(id) : (console.error("  Usage: nova process cancel <id>"), 1);
    case "start": return runStart(rest);
    default:
      console.error(`  Unknown subcommand: ${sub}\n  Usage: nova process list|show <id>|cancel <id>|start <name> --from-playbook <pb>`);
      return 1;
  }
}

if (import.meta.main) {
  try { process.exit(runProcessCli(process.argv.slice(2))); }
  catch (err: any) { console.error(`\n  Error: ${err?.message || err}`); process.exit(1); }
}
