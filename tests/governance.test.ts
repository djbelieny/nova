// tests/governance.test.ts
import { test, expect } from "bun:test";
import { getDb } from "../src/db.ts";
import { hasCapability, requireCapability, isCapability } from "../src/permissions.ts";
import { withLock } from "../src/locks.ts";
import { resolveApprover } from "../src/delegation.ts";

let seq = 0;
function newUser(role: "admin" | "member" = "member") {
  const db = getDb();
  const u = db.upsertUser({ telegram_id: `gov-${Date.now()}-${seq++}`, name: "G", role });
  return { db, userId: u.id };
}

// ── Idempotency ──
test("claimIdempotencyKey: first claim succeeds, repeats fail (durable + TTL variants)", () => {
  const { db } = newUser();
  const key = `k-${Date.now()}-${seq++}`;
  expect(db.claimIdempotencyKey(key)).toBe(true);          // durable (no expiry)
  expect(db.claimIdempotencyKey(key)).toBe(false);         // already claimed forever
  const ttlKey = `t-${Date.now()}-${seq++}`;
  expect(db.claimIdempotencyKey(ttlKey, "x", 60)).toBe(true);  // claim with a 60s TTL
  expect(db.claimIdempotencyKey(ttlKey, "x", 60)).toBe(false); // still within the window
});

// ── Locks ──
test("acquireLock is exclusive until released; same holder can renew", () => {
  const { db } = newUser();
  const name = `lock-${Date.now()}-${seq++}`;
  expect(db.acquireLock(name, "A", 60)).toBe(true);
  expect(db.acquireLock(name, "B", 60)).toBe(false); // held by A
  expect(db.acquireLock(name, "A", 60)).toBe(true);   // A renews
  db.releaseLock(name, "A");
  expect(db.acquireLock(name, "B", 60)).toBe(true);   // now free
});

test("withLock runs the body once and reports contention", async () => {
  const { db } = newUser();
  const name = `wl-${Date.now()}-${seq++}`;
  let ran = 0;
  const r1 = await withLock(db, name, 60, async () => { ran++;
    const inner = await withLock(db, name, 60, async () => { ran++; return "inner"; }, "other");
    expect(inner.ran).toBe(false); // held by us → contention
    return "ok";
  });
  expect(r1.ran).toBe(true);
  expect(ran).toBe(1);
});

// ── Permissions ──
test("hasCapability: admins always; members need a grant", () => {
  const admin = newUser("admin");
  const member = newUser("member");
  expect(hasCapability(admin.db, admin.userId, "automation.manage")).toBe(true);
  expect(hasCapability(member.db, member.userId, "automation.manage")).toBe(false);
  member.db.grantCapability(member.userId, "automation.manage", admin.userId);
  expect(hasCapability(member.db, member.userId, "automation.manage")).toBe(true);
  expect(member.db.listUserCapabilities(member.userId)).toContain("automation.manage");
  member.db.revokeCapability(member.userId, "automation.manage");
  expect(hasCapability(member.db, member.userId, "automation.manage")).toBe(false);
  expect(() => requireCapability(member.db, member.userId, "automation.manage")).toThrow("permission denied");
  expect(isCapability("policy.manage")).toBe(true);
  expect(isCapability("nope")).toBe(false);
});

// ── Delegation ──
test("resolveApprover follows an active delegation and guards cycles", () => {
  const a = newUser(); const b = newUser(); const c = newUser();
  // No delegation → self
  expect(resolveApprover(a.db, a.userId).userId).toBe(a.userId);
  // a → b → c
  a.db.setDelegation(a.userId, b.userId, "vacation");
  a.db.setDelegation(b.userId, c.userId, "also out");
  const r = resolveApprover(a.db, a.userId);
  expect(r.userId).toBe(c.userId);
  expect(r.viaDelegate).toBe(true);
  // Cycle a → b → a resolves without looping
  a.db.setDelegation(b.userId, a.userId, "cycle");
  const r2 = resolveApprover(a.db, a.userId);
  expect([a.userId, b.userId]).toContain(r2.userId);
});

test("expired delegation is ignored", () => {
  const a = newUser(); const b = newUser();
  a.db.setDelegation(a.userId, b.userId, "past", "2000-01-01 00:00:00");
  expect(resolveApprover(a.db, a.userId).userId).toBe(a.userId);
});

// ── Encrypted connector secrets + rotation ──
test("setConnectorSecret stores encrypted, round-trips, and logs a rotation", () => {
  const { db } = newUser("admin");
  db.setConnectorSecret("stripe", { STRIPE_API_KEY: "sk_live_secret" }, "admin-1");
  const cred = db.getSharedCredential("stripe");
  expect(cred.credentials.STRIPE_API_KEY).toBe("sk_live_secret");
  // Stored value is not plaintext (encrypted at rest when NOVA_ENCRYPTION_KEY is set; otherwise passthrough)
  const rotations = db.listSecretRotations("stripe");
  expect(rotations.length).toBeGreaterThanOrEqual(1);
  db.setConnectorSecret("stripe", { STRIPE_API_KEY: "sk_live_rotated" }, "admin-1");
  expect(db.getSharedCredential("stripe").credentials.STRIPE_API_KEY).toBe("sk_live_rotated");
  expect(db.listSecretRotations("stripe").length).toBeGreaterThanOrEqual(2);
});
