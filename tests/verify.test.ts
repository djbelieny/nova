import { test, expect } from "bun:test";
import { verifyOutcome, recordVerification, type VerifyModelCall } from "../src/verify.ts";
import { getDb } from "../src/db.ts";

const U = "55555555-5555-4555-8555-555555555555";

const stub = (out: string): VerifyModelCall => async () => out;

test("parses a clean JSON verified verdict", async () => {
  const v = await verifyOutcome(
    { goal: "Send the launch email", result: "Email sent to 1,204 subscribers, message id abc" },
    stub(`{"status":"verified","reason":"send confirmed with message id","confidence":0.9}`),
  );
  expect(v.status).toBe("verified");
  expect(v.confidence).toBeCloseTo(0.9);
  expect(v.reason).toContain("message id");
});

test("parses a failed verdict", async () => {
  const v = await verifyOutcome(
    { goal: "Publish the blog post", result: "Draft saved but publish step errored" },
    stub(`{"status":"failed","reason":"publish never completed","confidence":0.8}`),
  );
  expect(v.status).toBe("failed");
});

test("parses an unverifiable verdict", async () => {
  const v = await verifyOutcome(
    { goal: "Improve brand sentiment over time", result: "Posted 3 uplifting updates" },
    stub(`{"status":"unverifiable","reason":"outcome not cheaply checkable","confidence":0.3}`),
  );
  expect(v.status).toBe("unverifiable");
});

test("extracts JSON embedded in surrounding prose", async () => {
  const v = await verifyOutcome(
    { goal: "Deploy the site", result: "Deployed to prod, HTTP 200 on /" },
    stub(`Here is my assessment:\n{"status":"verified","reason":"200 OK","confidence":0.75}\nDone.`),
  );
  expect(v.status).toBe("verified");
  expect(v.confidence).toBeCloseTo(0.75);
});

test("falls back to a VERDICT: tag when no JSON present", async () => {
  const v = await verifyOutcome(
    { goal: "Ship it", result: "shipped" },
    stub(`VERDICT: verified — the change is live`),
  );
  expect(v.status).toBe("verified");
});

test("returns unverifiable (never throws) on garbage model output", async () => {
  const v = await verifyOutcome(
    { goal: "x", result: "y" },
    stub(`totally unparseable !!! <<< >>>`),
  );
  expect(v.status).toBe("unverifiable");
  expect(v.confidence).toBeLessThanOrEqual(0.5);
});

test("returns unverifiable (never throws) when the model call itself throws", async () => {
  const throwing: VerifyModelCall = async () => {
    throw new Error("network down");
  };
  const v = await verifyOutcome({ goal: "x", result: "y" }, throwing);
  expect(v.status).toBe("unverifiable");
});

test("short-circuits to unverifiable for an empty result without calling the model", async () => {
  let called = false;
  const spy: VerifyModelCall = async () => {
    called = true;
    return `{"status":"verified","reason":"x","confidence":1}`;
  };
  const v = await verifyOutcome({ goal: "do a thing", result: "" }, spy);
  expect(called).toBe(false);
  expect(v.status).toBe("unverifiable");
});

test("clamps out-of-range confidence into [0,1]", async () => {
  const v = await verifyOutcome(
    { goal: "g", result: "r" },
    stub(`{"status":"verified","reason":"ok","confidence":5}`),
  );
  expect(v.confidence).toBeLessThanOrEqual(1);
  expect(v.confidence).toBeGreaterThanOrEqual(0);
});

test("normalizes unknown status strings to unverifiable", async () => {
  const v = await verifyOutcome(
    { goal: "g", result: "r" },
    stub(`{"status":"maybe","reason":"unsure","confidence":0.4}`),
  );
  expect(v.status).toBe("unverifiable");
});

test("recordVerification attaches the verdict to an existing ledger row", () => {
  const db = getDb();
  const id = db.recordAction({
    user_id: U, agent: "orion", action_type: "email.send",
    phase: "execute", outcome: "success",
  });
  recordVerification(U, id, { status: "verified", reason: "send confirmed", confidence: 0.9 }, db);
  const rows = db.getActions(U, { agent: "orion" });
  const row = rows.find((r) => r.id === id)!;
  expect(row.verification).toEqual({ status: "verified", reason: "send confirmed", confidence: 0.9 });
});

test("recordVerification never throws on a bad action id", () => {
  const db = getDb();
  expect(() =>
    recordVerification(U, "nonexistent-id", { status: "failed", reason: "x", confidence: 0.5 }, db),
  ).not.toThrow();
});
