// tests/dashboard-approvals-security.test.ts
//
// Security regression tests for the approval-resolve cross-user write vulnerability.
//
// Fix: POST /api/approvals/resolve now requires a session (401 if missing) and passes
// me.userId to resolveApproval → updateApprovalStatus, which scopes the UPDATE with
// `AND user_id = ?`. Without a userId, updateApprovalStatus fell back to runOnAllUserDbs,
// allowing any authenticated admin to resolve another user's approvals.
//
// These tests exercise updateApprovalStatus directly (the security seam) because
// resolveApproval is not exported. This is the right layer to test: the DB method is
// the gate and is fully exercised here.

import { test, expect } from "bun:test";
import { getDb } from "../src/db.ts";

function seedApproval(db: ReturnType<typeof getDb>, userId: string, approvalId: string): void {
  db.insertApproval({
    id: approvalId,
    user_id: userId,
    chat_id: 12345,
    original_text: "test approval",
    plan: { steps: [] },
  });
}

function getApprovalStatus(db: ReturnType<typeof getDb>, userId: string, approvalId: string): string | null {
  const rows = db.getApprovalsByIds([approvalId], userId);
  // getApprovalsByIds only returns rows scoped to that userId
  if (rows.length === 0) return null;
  return rows[0].status;
}

test("updateApprovalStatus with correct userId updates only that user's approval", () => {
  const db = getDb();

  const userA = db.upsertUser({ telegram_id: "tg-appsec-a", name: "UserA", role: "member" });
  const userB = db.upsertUser({ telegram_id: "tg-appsec-b", name: "UserB", role: "member" });

  const idA = `appsec-approval-a-${Date.now()}`;
  const idB = `appsec-approval-b-${Date.now()}`;

  seedApproval(db, userA.id, idA);
  seedApproval(db, userB.id, idB);

  // Resolve userA's approval correctly — scoped by userId
  db.updateApprovalStatus(idA, "approved", null, userA.id);

  // UserA's approval should now be "approved"
  expect(getApprovalStatus(db, userA.id, idA)).toBe("approved");

  // UserB's approval must remain untouched
  expect(getApprovalStatus(db, userB.id, idB)).toBe("pending");
});

test("updateApprovalStatus with wrong userId does NOT update the approval (cross-user blocked)", () => {
  const db = getDb();

  const userA = db.upsertUser({ telegram_id: "tg-appsec-c", name: "UserC", role: "member" });
  const userB = db.upsertUser({ telegram_id: "tg-appsec-d", name: "UserD", role: "member" });

  const idA = `appsec-crossuser-${Date.now()}`;
  seedApproval(db, userA.id, idA);

  // Attempt cross-user resolve: use userB's ID to target userA's approval
  db.updateApprovalStatus(idA, "approved", null, userB.id);

  // userA's approval must still be pending — the WHERE clause blocks the cross-user write
  expect(getApprovalStatus(db, userA.id, idA)).toBe("pending");
});

test("updateApprovalStatus with no userId falls back to all-user scan (internal orchestrator path)", () => {
  const db = getDb();

  const user = db.upsertUser({ telegram_id: "tg-appsec-e", name: "UserE", role: "member" });
  const id = `appsec-internal-${Date.now()}`;
  seedApproval(db, user.id, id);

  // Internal callers (orchestrator) may omit userId — this is intentional for the bot flow.
  // The route-level fix ensures the web API always passes userId; this test documents the
  // intentional fallback for internal use.
  db.updateApprovalStatus(id, "cancelled", null);

  // The approval should now be cancelled (all-user scan found it)
  expect(getApprovalStatus(db, user.id, id)).toBe("cancelled");
});
