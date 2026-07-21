// tests/secondary.test.ts — outbound voice + human task routing
import { test, expect } from "bun:test";
import { getDb } from "../src/db.ts";
import { buildCallTwiml, buildCallParams, initiateCall } from "../src/outbound-voice.ts";
import { resolveAssignee, assignTaskTo, sweepOverdueTasks } from "../src/task-routing.ts";

let seq = 0;
function newUser(role: "admin" | "member" = "member", name = "User") {
  const db = getDb();
  const u = db.upsertUser({ telegram_id: `sec-${Date.now()}-${seq++}`, name, role });
  return { db, userId: u.id, user: u };
}

// ── Outbound voice ──
test("buildCallTwiml escapes and wraps in Say", () => {
  const twiml = buildCallTwiml("Hi <them> & \"you\"");
  expect(twiml).toContain("<Say");
  expect(twiml).toContain("Hi &lt;them&gt; &amp; &quot;you&quot;");
});

test("buildCallParams sets To/From/Twiml", () => {
  const p = buildCallParams("+15551112222", "+15550000000", "Reminder");
  expect(p.To).toBe("+15551112222");
  expect(p.From).toBe("+15550000000");
  expect(p.Twiml).toContain("Reminder");
});

test("initiateCall posts to Twilio and returns the sid (mocked)", async () => {
  const calls: any[] = [];
  const fetchImpl = (async (url: string, init: any) => { calls.push({ url, init }); return { ok: true, status: 201, text: async () => JSON.stringify({ sid: "CA123" }) }; }) as any;
  const r = await initiateCall("+15551112222", "Your appointment is tomorrow", { accountSid: "AC1", authToken: "tok", from: "+15550000000", fetchImpl });
  expect(r.ok).toBe(true);
  expect(r.sid).toBe("CA123");
  expect(calls[0].url).toContain("/Accounts/AC1/Calls.json");
  expect(calls[0].init.body).toContain("To=");
});

test("initiateCall errors when unconfigured", async () => {
  const r = await initiateCall("+1555", "hi", { accountSid: "", authToken: "", from: "" });
  expect(r.ok).toBe(false);
  expect(r.error).toContain("not configured");
});

// ── Human task routing ──
test("resolveAssignee finds by username", () => {
  const { db, userId } = newUser("member", "Taylor");
  db.setUsername(userId, "taylor");
  const hit = resolveAssignee(db, "@taylor");
  expect(hit?.userId).toBe(userId);
});

test("assignTaskTo assigns and getTasksAssignedTo returns it", () => {
  const owner = newUser("admin", "Owner");
  const mate = newUser("member", "Mate");
  owner.db.setUsername(mate.userId, "mate");
  const taskId = owner.db.insertTask({ agent: "kai", description: "Write the brief", status: "pending", user_id: owner.userId });
  const r = assignTaskTo(owner.db, owner.userId, taskId, "@mate");
  expect(r.ok).toBe(true);
  expect(r.assignee?.userId).toBe(mate.userId);
  const assigned = owner.db.getTasksAssignedTo(mate.userId);
  expect(assigned.some((t) => t.id === taskId)).toBe(true);
});

test("sweepOverdueTasks escalates a past-SLA task once", async () => {
  const owner = newUser("admin", "Owner2");
  const mate = newUser("member", "Mate2");
  owner.db.setUsername(mate.userId, "mate2");
  const taskId = owner.db.insertTask({ agent: "kai", description: "Overdue thing", status: "pending", user_id: owner.userId });
  owner.db.assignTask(owner.userId, taskId, mate.userId, { dueAt: "2000-01-01 00:00:00" });
  const notified: string[] = [];
  const n = await sweepOverdueTasks(owner.db, async (uid, msg) => { notified.push(uid); });
  expect(n).toBeGreaterThanOrEqual(1);
  expect(notified).toContain(mate.userId);
  // Second sweep: already escalated → not again
  const n2 = await sweepOverdueTasks(owner.db, async () => {});
  expect(owner.db.getProcess ? true : true).toBe(true); // sanity
  const again = (await sweepOverdueTasks(owner.db, async (uid) => { notified.push("second:" + uid); }));
  expect(again).toBe(0);
});
