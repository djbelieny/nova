// tests/learning-loop-wiring.test.ts
// Component B (wiring) unit tests: the pure `prop:` callback parser and the
// approve/reject paths the relay callback branch drives, against a temp DB.
import { test, expect } from "bun:test";
import { existsSync } from "fs";
import { getDb } from "../src/db.ts";
import {
  approveProposal,
  rejectProposal,
  parseProposalCallback,
} from "../src/learning-loop.ts";

let seq = 0;
function newUser() {
  const db = getDb();
  const user = db.upsertUser({ telegram_id: `llw-${Date.now()}-${seq++}`, name: "LLW User", role: "member" });
  return { db, userId: user.id };
}

// Mirrors the confirmation message the relay `prop:` branch produces on approve.
function approveConfirmation(res: { ok: boolean; slug?: string }): string {
  return res.ok
    ? (res.slug ? "✓ Saved as a learned skill." : "✓ Saved to memory.")
    : "Couldn't save that idea — it may already have been decided.";
}

test("parseProposalCallback parses approve", () => {
  expect(parseProposalCallback("prop:12:approve")).toEqual({ id: 12, action: "approve" });
});

test("parseProposalCallback parses reject", () => {
  expect(parseProposalCallback("prop:7:reject")).toEqual({ id: 7, action: "reject" });
});

test("parseProposalCallback rejects malformed / foreign callback data", () => {
  expect(parseProposalCallback("prop:12:maybe")).toBeNull();
  expect(parseProposalCallback("prop:abc:approve")).toBeNull();
  expect(parseProposalCallback("prop:12")).toBeNull();
  expect(parseProposalCallback("apv:12:approve")).toBeNull();
  expect(parseProposalCallback("")).toBeNull();
});

test("approve path: seeded skill proposal becomes a learned_skills row + approved", async () => {
  const { db, userId } = newUser();
  const id = db.insertSkillProposal(userId, {
    kind: "skill",
    title: "Wiring approve builder",
    description: "Assemble the wiring report",
    body: JSON.stringify({
      triggers: ["wiring", "approve", "builder"],
      body: "1. gather 2. build 3. ship",
      plan: { subtasks: [{ description: "a" }, { description: "b" }] },
    }),
    source_signature: "wiring approve builder report",
    rationale: "recurs",
  });
  expect(db.countPendingProposals(userId)).toBe(1);

  const parsed = parseProposalCallback(`prop:${id}:approve`);
  expect(parsed).toEqual({ id, action: "approve" });

  const res = await approveProposal(db, userId, parsed!.id);
  expect(res.ok).toBe(true);
  expect(res.slug).toBeTruthy();
  expect(approveConfirmation(res)).toBe("✓ Saved as a learned skill.");

  const row = db.getLearnedSkills(userId).find((s: any) => s.slug === res.slug);
  expect(row).toBeTruthy();
  expect(existsSync(row.skill_path)).toBe(true);
  expect(row.skill_path).toContain(".nova/skills/learned");

  expect(db.getProposal(userId, id).status).toBe("approved");
  expect(db.countPendingProposals(userId)).toBe(0);
});

test("reject path: seeded proposal becomes rejected, no learned skill", async () => {
  const { db, userId } = newUser();
  const id = db.insertSkillProposal(userId, {
    kind: "skill",
    title: "Wiring reject builder",
    body: JSON.stringify({ triggers: ["reject"], body: "steps", plan: null }),
    source_signature: "wiring reject builder",
  });

  const parsed = parseProposalCallback(`prop:${id}:reject`);
  expect(parsed).toEqual({ id, action: "reject" });

  const res = await rejectProposal(db, userId, parsed!.id);
  expect(res.ok).toBe(true);
  expect(db.getProposal(userId, id).status).toBe("rejected");
  expect(db.getLearnedSkills(userId).length).toBe(0);
  expect(db.countPendingProposals(userId)).toBe(0);
});

test("approving an already-decided proposal yields the fallback confirmation", async () => {
  const { db, userId } = newUser();
  const id = db.insertSkillProposal(userId, {
    kind: "skill",
    title: "Already decided",
    body: JSON.stringify({ triggers: ["x"], body: "y", plan: null }),
    source_signature: "already decided sig",
  });
  db.decideProposal(userId, id, "rejected");

  const res = await approveProposal(db, userId, id);
  expect(res.ok).toBe(false);
  expect(approveConfirmation(res)).toBe("Couldn't save that idea — it may already have been decided.");
});
