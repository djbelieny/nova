// tests/db-onboarding.test.ts
import { test, expect } from "bun:test";
import { getDb } from "../src/db.ts";

test("onboarded_at starts null and can be set once", () => {
  const db = getDb();
  const user = db.upsertUser({ telegram_id: "tg-onboard-1", name: "Onboard User", role: "member" });
  const id = user.id;

  expect(db.getOnboardedAt(id)).toBeNull();

  db.setOnboardedAt(id);
  const first = db.getOnboardedAt(id);
  expect(first).not.toBeNull();
  expect(typeof first).toBe("string");

  // Idempotent: a second call must not overwrite the original timestamp
  db.setOnboardedAt(id);
  expect(db.getOnboardedAt(id)).toBe(first);
});

test("getOnboardedAt returns null for an unknown user", () => {
  const db = getDb();
  expect(db.getOnboardedAt("does-not-exist")).toBeNull();
});
