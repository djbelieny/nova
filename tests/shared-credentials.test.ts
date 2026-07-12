// tests/shared-credentials.test.ts
import { test, expect } from "bun:test";
import { getDb } from "../src/db.ts";

test("upsert + get + list(masked) + delete shared credential", () => {
  const db = getDb();
  db.upsertSharedCredential({ provider: "notion", kind: "oauth", credentials: { access_token: "tok-xyz" }, created_by: "admin-1" });
  const got = db.getSharedCredential("notion");
  expect(got?.kind).toBe("oauth");
  expect(got?.credentials.access_token).toBe("tok-xyz");

  const list = db.listSharedCredentials();
  const row = list.find(r => r.provider === "notion");
  expect(row).toBeTruthy();
  expect(JSON.stringify(row)).not.toContain("tok-xyz"); // never leak secrets

  db.deleteSharedCredential("notion");
  expect(db.getSharedCredential("notion")).toBeNull();
});
