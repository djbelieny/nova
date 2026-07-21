// tests/policy.test.ts
import { test, expect } from "bun:test";
import { getDb } from "../src/db.ts";
import { evaluatePolicies, policyForcesApproval, runContentChecks, departmentForAgent } from "../src/policy.ts";

let seq = 0;
function newUser() {
  const db = getDb();
  const u = db.upsertUser({ telegram_id: `po-${Date.now()}-${seq++}`, name: "PO", role: "member" });
  return { db, userId: u.id };
}

test("no policies → allow (behavior identical to today)", () => {
  const { db, userId } = newUser();
  const r = evaluatePolicies(db, { userId, agent: "helios", actionType: "ad.spend", estimateUsd: 100 });
  expect(r.decision).toBe("allow");
  expect(policyForcesApproval(r)).toBe(false);
});

test("runContentChecks flags PII and profanity", () => {
  expect(runContentChecks("SSN 123-45-6789", ["pii"])).toContain("pii:SSN");
  expect(runContentChecks("email me at a@b.com", ["pii"]).length).toBeGreaterThan(0);
  expect(runContentChecks("this is shit", ["profanity"])).toContain("profanity");
  expect(runContentChecks("all clean here", ["pii", "profanity"])).toEqual([]);
});

test("departmentForAgent maps specialists", () => {
  expect(departmentForAgent("helios")).toBe("marketing");
  expect(departmentForAgent("lex")).toBe("legal");
  expect(departmentForAgent("unknown")).toBeNull();
});

test("spend_cap policy forces approval over budget", () => {
  const { db, userId } = newUser();
  db.insertPolicy({ userId, scope: "org", kind: "spend_cap", config: { period: "day", capUsd: 50 } });
  // No spend yet; estimate 100 > 50 → require approval
  const r = evaluatePolicies(db, { userId, agent: "helios", actionType: "ad.spend", estimateUsd: 100 });
  expect(r.decision).toBe("require-approval");
  expect(policyForcesApproval(r)).toBe(true);
  expect(r.reasons[0]).toContain("spend cap");
  // Estimate under cap → allow
  const r2 = evaluatePolicies(db, { userId, agent: "helios", actionType: "ad.spend", estimateUsd: 10 });
  expect(r2.decision).toBe("allow");
});

test("approval_matrix routes to named approvers", () => {
  const { db, userId } = newUser();
  db.insertPolicy({ userId, scope: "org", kind: "approval_matrix", config: { actionType: "email.send", approvers: ["boss-id"], minApproverRole: "admin", escalateAfterMin: 30 } });
  const r = evaluatePolicies(db, { userId, agent: "orion", actionType: "email.send" });
  expect(r.decision).toBe("require-approval");
  expect(r.approvers).toContain("boss-id");
  expect(r.escalateAfterMin).toBe(30);
  // Different action type → policy doesn't apply
  const r2 = evaluatePolicies(db, { userId, agent: "orion", actionType: "ad.spend" });
  expect(r2.decision).toBe("allow");
});

test("content_check blocks on PII when onFail=block", () => {
  const { db, userId } = newUser();
  db.insertPolicy({ userId, scope: "org", kind: "content_check", config: { checks: ["pii"], onFail: "block" } });
  const r = evaluatePolicies(db, { userId, agent: "kai", actionType: "content.publish", content: "customer SSN 123-45-6789 here" });
  expect(r.decision).toBe("block");
  expect(policyForcesApproval(r)).toBe(true);
});

test("department-scoped policy only applies to that department", () => {
  const { db, userId } = newUser();
  db.insertPolicy({ userId, scope: "department", scopeRef: "marketing", kind: "approval_matrix", config: { approvers: ["cmo"] } });
  expect(evaluatePolicies(db, { userId, agent: "helios", actionType: "x" }).decision).toBe("require-approval"); // marketing
  expect(evaluatePolicies(db, { userId, agent: "lex", actionType: "x" }).decision).toBe("allow"); // legal
});

test("db: policy list/enable/delete", () => {
  const { db, userId } = newUser();
  const p = db.insertPolicy({ userId, kind: "spend_cap", config: { period: "day", capUsd: 10 } });
  expect(db.listPolicies(userId)).toHaveLength(1);
  db.setPolicyEnabled(userId, p.id, false);
  expect(db.listPolicies(userId, true)).toHaveLength(0);
  db.deletePolicy(userId, p.id);
  expect(db.listPolicies(userId)).toHaveLength(0);
});
