import { test, expect } from "bun:test";
import { cleanResponseForUser } from "../src/channels/telegram.ts";
import { getDb } from "../src/db.ts";

// Split literal so the contiguous provider token never appears in source (see leak-scan.test.ts).
const STRIPE = "sk_live_" + "FAKEtest1234notrealSTRIPE";

test("cleanResponseForUser redacts a secret but keeps PII (owner-facing)", () => {
  const out = cleanResponseForUser(`Here is the key ${STRIPE} and your email a@b.com`);
  expect(out).not.toContain(STRIPE);
  expect(out).toContain("a@b.com"); // PII not stripped from the owner's own reply
});

test("insertLog scrubs secrets and PII from message + metadata", () => {
  const db = getDb();
  db.insertLog({ event: "t", message: `leak ${STRIPE} ssn 123-45-6789`, metadata: { note: "key AKIAIOSFODNN7EXAMPLE" } });
  const rows = db.raw.query("SELECT message, metadata FROM logs ORDER BY rowid DESC LIMIT 1").all() as any[];
  expect(rows[0].message).not.toContain("sk_live_");
  expect(rows[0].message).not.toContain("123-45-6789");
  expect(rows[0].metadata).not.toContain("AKIA");
});
