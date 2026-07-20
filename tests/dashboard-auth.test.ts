// tests/dashboard-auth.test.ts
import { test, expect } from "bun:test";
import { getDb } from "../src/db.ts";
import { changeOwnPassword, adminCreateUser, adminResetPassword, isAdminRole } from "../src/dashboard.ts";
import { hashPassword, verifyLogin } from "../src/web-auth.ts";

test("set username + password and look up by username", () => {
  const db = getDb();
  // Seed a user (users table requires telegram_id NOT NULL UNIQUE)
  // upsertUser returns the full user object; capture .id
  const user = db.upsertUser({ telegram_id: "tg-auth-1", name: "Auth User", role: "member" });
  const id = user.id;
  db.setUsername(id, "authuser");
  db.setUserPassword(id, "hash-abc", true);
  const u = db.getUserByUsername("authuser");
  expect(u?.id).toBe(id);
  expect(u?.password_hash).toBe("hash-abc");
  expect(u?.must_change_password).toBe(1);
  expect(db.getUserByUsername("nobody")).toBeNull();
});

test("changeOwnPassword verifies current and sets new", async () => {
  const db = getDb();
  const user = db.upsertUser({ telegram_id: "tg-pw-1", name: "PW User", role: "member" });
  const id = user.id;
  db.setUserPassword(id, await hashPassword("oldpw123"), true);
  expect((await changeOwnPassword(id, "wrong", "newpw123")).ok).toBe(false);
  const ok = await changeOwnPassword(id, "oldpw123", "newpw123");
  expect(ok.ok).toBe(true);
  const u = db.getUserById(id);
  expect(u.must_change_password).toBe(0);
});

// Authz regression: isAdminRole is the pure predicate used by the fetch handler to gate
// system-wide routes and admin pages. Route-level enforcement requires a live server, but
// the predicate logic is unit-testable here. The tsc + build gates confirm no type regressions.
test("isAdminRole correctly classifies admin vs member roles", () => {
  expect(isAdminRole("admin")).toBe(true);
  expect(isAdminRole("member")).toBe(false);
  expect(isAdminRole(undefined)).toBe(false);
  expect(isAdminRole("")).toBe(false);
  // __master__ bootstrap is stored with role "admin" so it evaluates as admin
  expect(isAdminRole("admin")).toBe(true);
});

test("adminCreateUser provisions a login with a temp password + must-change", async () => {
  const db = getDb();
  // Idempotent across re-runs: the shared test DB persists, so clear any prior fixture
  db.raw.run("DELETE FROM users WHERE telegram_id = 'tg-admincreate-1' OR username = 'newhire'");
  const r = await adminCreateUser({ name: "New Hire", username: "newhire", telegram_id: "tg-admincreate-1", role: "member" });
  expect(r.ok).toBe(true);
  expect(r.tempPassword && r.tempPassword.length >= 10).toBe(true);
  const auth = await verifyLogin(db, "newhire", r.tempPassword!);
  expect(auth?.mustChange).toBe(true);
  expect((await adminResetPassword("nonexistent-id")).ok).toBe(false);
});
