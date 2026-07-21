// tests/process-engine.test.ts
import { test, expect } from "bun:test";
import { getDb } from "../src/db.ts";
import { startProcess, advanceProcess, resumeDueTimers, resumeOnEvent, cancelProcess, computeWaitUntil } from "../src/process-engine.ts";
import type { ProcessStep } from "../src/db.ts";

let seq = 0;
function newUser() {
  const db = getDb();
  const u = db.upsertUser({ telegram_id: `pr-${Date.now()}-${seq++}`, name: "PR", role: "member" });
  return { db, userId: u.id };
}

function recordingRunner() {
  const calls: string[] = [];
  const run = async (_u: string, desc: string) => { calls.push(desc); return { success: true, result: `ok:${desc}` }; };
  return { calls, run };
}

test("computeWaitUntil handles relative and absolute", () => {
  const now = new Date("2026-07-21T00:00:00Z");
  expect(computeWaitUntil("+2h", now)).toBe("2026-07-21 02:00:00");
  expect(computeWaitUntil("+3d", now)).toBe("2026-07-24 00:00:00");
  expect(computeWaitUntil("2026-08-01T12:00:00Z", now)).toBe("2026-08-01 12:00:00");
});

test("runs action steps in order to completion", async () => {
  const { db, userId } = newUser();
  const { calls, run } = recordingRunner();
  const steps: ProcessStep[] = [
    { type: "action", agent: "kai", description: "Write {{topic}}" },
    { type: "action", agent: "orion", description: "Email it" },
  ];
  const { id, result } = await startProcess(db, { userId, name: "p1", steps, context: { topic: "launch" } }, run);
  expect(result.state).toBe("done");
  expect(calls).toEqual(["Write launch", "Email it"]);
  expect(db.getProcess(userId, id)!.state).toBe("done");
});

test("pauses at a timer wait and resumes when due", async () => {
  const { db, userId } = newUser();
  const { calls, run } = recordingRunner();
  const steps: ProcessStep[] = [
    { type: "action", description: "step A" },
    { type: "wait", until: "+1h" },
    { type: "action", description: "step B" },
  ];
  const { id } = await startProcess(db, { userId, name: "timed", steps }, run);
  let p = db.getProcess(userId, id)!;
  expect(p.state).toBe("waiting");
  expect(calls).toEqual(["step A"]);

  // Not due yet → no resume
  expect(await resumeDueTimers(db, run)).toBeGreaterThanOrEqual(0);
  // Force the timer into the past, then resume
  db.updateProcess(userId, id, { waitUntil: "2000-01-01 00:00:00" });
  await resumeDueTimers(db, run);
  p = db.getProcess(userId, id)!;
  expect(p.state).toBe("done");
  expect(calls).toEqual(["step A", "step B"]);
});

test("pauses at an event wait and resumes on the named event", async () => {
  const { db, userId } = newUser();
  const { calls, run } = recordingRunner();
  const steps: ProcessStep[] = [
    { type: "action", description: "send contract" },
    { type: "wait", event: "signature.done" },
    { type: "action", description: "invoice" },
  ];
  const { id } = await startProcess(db, { userId, name: "sig", steps }, run);
  expect(db.getProcess(userId, id)!.state).toBe("waiting");

  await resumeOnEvent(db, "other.event", run);
  expect(db.getProcess(userId, id)!.state).toBe("waiting"); // unrelated event

  await resumeOnEvent(db, "signature.done", run);
  expect(db.getProcess(userId, id)!.state).toBe("done");
  expect(calls).toEqual(["send contract", "invoice"]);
});

test("a failed step halts the process", async () => {
  const { db, userId } = newUser();
  const run = async (_u: string, desc: string) => desc === "boom" ? { success: false, result: "err" } : { success: true, result: "ok" };
  const steps: ProcessStep[] = [{ type: "action", description: "ok1" }, { type: "action", description: "boom" }, { type: "action", description: "never" }];
  const { id } = await startProcess(db, { userId, name: "fail", steps }, run);
  expect(db.getProcess(userId, id)!.state).toBe("failed");
});

test("cancel halts a waiting process", async () => {
  const { db, userId } = newUser();
  const { run } = recordingRunner();
  const { id } = await startProcess(db, { userId, name: "c", steps: [{ type: "wait", until: "+5d" }, { type: "action", description: "x" }] }, run);
  expect(cancelProcess(db, userId, id)).toBe(true);
  expect(db.getProcess(userId, id)!.state).toBe("cancelled");
});
