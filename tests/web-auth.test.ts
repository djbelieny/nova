// tests/web-auth.test.ts
import { test, expect } from "bun:test";
import { hashPassword, verifyPassword, verifyLogin, MASTER_USER_ID } from "../src/web-auth.ts";
import { getDb } from "../src/db.ts";

test("hash + verify password roundtrip", async () => {
  const h = await hashPassword("s3cret!");
  expect(await verifyPassword("s3cret!", h)).toBe(true);
  expect(await verifyPassword("wrong", h)).toBe(false);
});

test("verifyLogin authenticates a real user", async () => {
  const db = getDb();
  const user = db.upsertUser({ telegram_id: "tg-login-1", name: "Login User", role: "member" });
  const id = user.id;
  db.setUsername(id, "loginuser");
  db.setUserPassword(id, await hashPassword("pw123456"), false);
  const ok = await verifyLogin(db, "loginuser", "pw123456");
  expect(ok).toEqual({ userId: id, role: "member", mustChange: false });
  expect(await verifyLogin(db, "loginuser", "bad")).toBeNull();
  expect(await verifyLogin(db, "ghost", "x")).toBeNull();
});

test("verifyLogin honors the master bootstrap", async () => {
  const savedUser = process.env.DASHBOARD_USER;
  const savedPass = process.env.DASHBOARD_PASS;
  process.env.DASHBOARD_USER = "admin";
  process.env.DASHBOARD_PASS = "masterpw";
  const db = getDb();
  const ok = await verifyLogin(db, "admin", "masterpw");
  expect(ok).toEqual({ userId: MASTER_USER_ID, role: "admin", mustChange: false });
  if (savedUser !== undefined) process.env.DASHBOARD_USER = savedUser;
  else delete process.env.DASHBOARD_USER;
  if (savedPass !== undefined) process.env.DASHBOARD_PASS = savedPass;
  else delete process.env.DASHBOARD_PASS;
});

test("verifyLogin blocks master bootstrap when DASHBOARD_PASS is unset", async () => {
  const savedPass = process.env.DASHBOARD_PASS;
  delete process.env.DASHBOARD_PASS;
  process.env.DASHBOARD_USER = "admin";
  const db = getDb();
  expect(await verifyLogin(db, "admin", "anything")).toBeNull();
  if (savedPass !== undefined) process.env.DASHBOARD_PASS = savedPass;
});
