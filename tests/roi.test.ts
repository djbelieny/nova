// tests/roi.test.ts
import { test, expect } from "bun:test";
import { getDb } from "../src/db.ts";
import { parseValueTag, stripValueTags, recordValueFromText, rollupRoi, formatRoiDigest } from "../src/roi.ts";

let seq = 0;
function newUser() {
  const db = getDb();
  const u = db.upsertUser({ telegram_id: `roi-${Date.now()}-${seq++}`, name: "ROI", role: "member" });
  return { db, userId: u.id };
}

test("parseValueTag reads value, saved, dept, note", () => {
  const t = parseValueTag("[VALUE: $2,500 | SAVED: 45min | DEPT: marketing | NOTE: closed the deal]");
  expect(t).toEqual({ valueUsd: 2500, minutesSaved: 45, department: "marketing", note: "closed the deal" });
  const hrs = parseValueTag("[VALUE: SAVED: 2hours]");
  expect(hrs?.minutesSaved).toBe(120);
  expect(parseValueTag("no tag here")).toBeNull();
  expect(parseValueTag("[VALUE: DEPT: ops]")).toBeNull(); // no value/time → null
});

test("stripValueTags removes the tag", () => {
  expect(stripValueTags("Done. [VALUE: $100 | SAVED: 10min] thanks")).toBe("Done.  thanks");
});

test("recordValueFromText records an roi_event and returns cleaned text", () => {
  const { db, userId } = newUser();
  const clean = recordValueFromText(db, userId, "Sent the campaign. [VALUE: $1000 | SAVED: 30min]", "helios");
  expect(clean).toBe("Sent the campaign.");
  const roi = db.getRoiSince(userId, 1);
  expect(roi.valueUsd).toBe(1000);
  expect(roi.minutesSaved).toBe(30);
  expect(roi.byDepartment["marketing"].valueUsd).toBe(1000); // helios → marketing
});

test("rollupRoi combines value events with execute stats", () => {
  const { db, userId } = newUser();
  db.insertRoiEvent(userId, { agent: "orion", department: "marketing", valueUsd: 500, minutesSaved: 120 });
  db.insertRoiEvent(userId, { agent: "digit", department: "data", valueUsd: 300, minutesSaved: 60 });
  // A couple of successful execute ledger rows (tasks automated + cost)
  db.recordAction({ user_id: userId, agent: "orion", action_type: "email.send", phase: "execute", outcome: "success", cost_usd: 0.5 });
  db.recordAction({ user_id: userId, agent: "digit", action_type: "report", phase: "execute", outcome: "success", cost_usd: 0.3 });
  const r = rollupRoi(db, userId, 7);
  expect(r.valueUsd).toBe(800);
  expect(r.hoursSaved).toBe(3);
  expect(r.tasksAutomated).toBe(2);
  expect(r.costUsd).toBeCloseTo(0.8, 1);
  expect(r.netUsd).toBeCloseTo(799.2, 1);
  expect(r.byDepartment.marketing.valueUsd).toBe(500);
});

test("formatRoiDigest renders", () => {
  const digest = formatRoiDigest({ periodDays: 7, tasksAutomated: 5, hoursSaved: 3, valueUsd: 800, costUsd: 1, netUsd: 799, byDepartment: { marketing: { valueUsd: 500, hoursSaved: 2 } }, byAgent: {} });
  expect(digest).toContain("Tasks automated");
  expect(digest).toContain("$800");
  expect(digest).toContain("marketing");
});
