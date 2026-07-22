// tests/trust.test.ts — Group 2: dry-run, run observability, retries + dead-letter.
import { test, expect } from "bun:test";
import { getDb } from "../src/db.ts";
import { dispatchAutomation } from "../src/automation-engine.ts";
import { simulateAutomation } from "../src/simulate.ts";

let seq = 0;
function newUser() {
  const db = getDb();
  const u = db.upsertUser({ telegram_id: `trust-${Date.now()}-${seq++}`, name: "N", role: "member" });
  return { db, userId: u.id };
}

test("simulateAutomation previews without executing anything", () => {
  const { db, userId } = newUser();
  const a = db.insertAutomation({
    userId, name: "sim-preview", sourceType: "webhook", actionType: "agent", actionRef: "helios",
    actionConfig: { template: "Follow up with {{contact.name}}" },
  });

  const sim = simulateAutomation(db, a, { contact: { name: "Sam" } });
  expect(sim.wouldFire).toBe(true);
  expect(sim.agentSlug).toBe("helios");
  expect(sim.taskDescription).toBe("Follow up with Sam");

  // No side effects: no automation_run and no run_event for this automation.
  expect(db.countAutomationRunsSince(a.id, 60)).toBe(0);
  expect(db.listRunEvents(userId, { kind: "automation" }).filter((e) => e.refId === a.id)).toHaveLength(0);

  // A gated event previews as would-not-fire, still no side effects.
  const gated = simulateAutomation(db, db.insertAutomation({
    userId, name: "sim-gated", sourceType: "webhook", actionType: "agent", actionRef: "bridge",
    conditions: [{ field: "amount", op: "gt", value: 1000 }], actionConfig: { template: "x {{amount}}" },
  }), { amount: 5 });
  expect(gated.wouldFire).toBe(false);
  expect(gated.reason).toBe("conditions-not-met");
});

test("dispatchAutomation records a 'fired' run_event", async () => {
  const { db, userId } = newUser();
  const a = db.insertAutomation({
    userId, name: "fire-obs", sourceType: "webhook", actionType: "agent", actionRef: "bridge",
    actionConfig: { template: "New lead {{name}}" },
  });
  const dispatchAgent = async () => "task-abc";

  const r = await dispatchAutomation(db, db.getAutomation(userId, a.id)!, { name: "Acme" }, dispatchAgent);
  expect(r.fired).toBe(true);

  const events = db.listRunEvents(userId, { kind: "automation" }).filter((e) => e.refId === a.id);
  expect(events.length).toBeGreaterThanOrEqual(1);
  expect(events[0].status).toBe("fired");
  expect(events[0].detail).toContain("task-abc");
});

test("exhausted retries write a dead_letter + failed run_event", async () => {
  const { db, userId } = newUser();
  const a = db.insertAutomation({
    userId, name: "fail-dlq", sourceType: "webhook", actionType: "agent", actionRef: "helios",
    actionConfig: { template: "Handle {{name}}" },
  });
  let attempts = 0;
  const dispatchAgent = async () => { attempts++; throw new Error("boom"); };

  const r = await dispatchAutomation(db, db.getAutomation(userId, a.id)!, { name: "Zed" }, dispatchAgent);
  expect(r.fired).toBe(false);
  expect(r.reason).toBe("failed");
  expect(attempts).toBe(3); // retried up to 3 times

  const dls = db.listDeadLetters(userId).filter((d) => d.refId === a.id);
  expect(dls.length).toBeGreaterThanOrEqual(1);
  expect(dls[0].error).toContain("boom");
  expect(JSON.parse(dls[0].payload!)).toEqual({ name: "Zed" });

  const failed = db.listRunEvents(userId, { kind: "automation" }).filter((e) => e.refId === a.id && e.status === "failed");
  expect(failed.length).toBeGreaterThanOrEqual(1);

  // getDeadLetter / deleteDeadLetter facade round-trip.
  const one = db.getDeadLetter(userId, dls[0].id);
  expect(one?.id).toBe(dls[0].id);
  db.deleteDeadLetter(userId, dls[0].id);
  expect(db.getDeadLetter(userId, dls[0].id)).toBeNull();
});

test("listRunEvents filters by kind; countRunEventFailures counts the window", () => {
  const { db, userId } = newUser();
  const ref = `ref-${Date.now()}-${seq++}`;
  db.insertRunEvent(userId, { kind: "process", refId: ref, refName: "p", status: "waiting" });
  db.insertRunEvent(userId, { kind: "process", refId: ref, refName: "p", status: "failed" });
  db.insertRunEvent(userId, { kind: "playbook", refId: ref, refName: "pb", status: "started" });

  const procEvents = db.listRunEvents(userId, { kind: "process" }).filter((e) => e.refId === ref);
  expect(procEvents).toHaveLength(2);
  expect(procEvents.every((e) => e.kind === "process")).toBe(true);

  const playbookEvents = db.listRunEvents(userId, { kind: "playbook" }).filter((e) => e.refId === ref);
  expect(playbookEvents).toHaveLength(1);

  expect(db.countRunEventFailures(userId, ref, 60)).toBe(1);
  // A different ref's failures are not counted.
  expect(db.countRunEventFailures(userId, `${ref}-other`, 60)).toBe(0);
});
