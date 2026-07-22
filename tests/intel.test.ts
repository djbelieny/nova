// tests/intel.test.ts — Group 4 Intelligence: semantic triggers + value ranking
import { test, expect } from "bun:test";
import { evaluateConditionsAsync, type EmbedFn } from "../src/automation-engine.ts";
import { parseWhen } from "../src/cli-automation.ts";
import { getDb } from "../src/db.ts";
import { rankAgentsByValue, rankDepartmentsByValue } from "../src/roi.ts";

let seq = 0;
function newUser() {
  const db = getDb();
  const u = db.upsertUser({ telegram_id: `intel-${Date.now()}-${seq++}`, name: "Intel", role: "member" });
  return { db, userId: u.id };
}

// A fake embedder: maps known phrases to chosen 3-dim vectors (L2-normalized like all-MiniLM).
const fakeVectors: Record<string, number[]> = {
  "this is a customer complaint about a refund": [1, 0, 0],
  "a customer complaint": [1, 0, 0], // identical direction → cosine 1
  "the weather is sunny today": [0, 1, 0], // orthogonal → cosine 0
};
const fakeEmbed: EmbedFn = async (text: string) => fakeVectors[text] ?? null;

test("evaluateConditionsAsync: semantic passes on near-identical vectors", async () => {
  const event = { body: "this is a customer complaint about a refund" };
  const ok = await evaluateConditionsAsync(
    event,
    [{ field: "body", op: "semantic", value: "a customer complaint", threshold: 0.5 }],
    fakeEmbed
  );
  expect(ok).toBe(true);
});

test("evaluateConditionsAsync: semantic fails on orthogonal vectors", async () => {
  const event = { body: "the weather is sunny today" };
  const ok = await evaluateConditionsAsync(
    event,
    [{ field: "body", op: "semantic", value: "a customer complaint", threshold: 0.5 }],
    fakeEmbed
  );
  expect(ok).toBe(false);
});

test("evaluateConditionsAsync: semantic fails safe when an embedding is null", async () => {
  const event = { body: "unknown text not in fake map" };
  const ok = await evaluateConditionsAsync(
    event,
    [{ field: "body", op: "semantic", value: "a customer complaint" }],
    fakeEmbed
  );
  expect(ok).toBe(false);
});

test("evaluateConditionsAsync: normal ops still evaluate through async path", async () => {
  expect(await evaluateConditionsAsync({ amount: 50 }, [{ field: "amount", op: "gt", value: 10 }], fakeEmbed)).toBe(true);
  expect(await evaluateConditionsAsync({ amount: 5 }, [{ field: "amount", op: "gt", value: 10 }], fakeEmbed)).toBe(false);
});

test("evaluateConditionsAsync: AND across semantic + normal", async () => {
  const event = { body: "this is a customer complaint about a refund", amount: 50 };
  const ok = await evaluateConditionsAsync(
    event,
    [
      { field: "body", op: "semantic", value: "a customer complaint", threshold: 0.5 },
      { field: "amount", op: "gt", value: 10 },
    ],
    fakeEmbed
  );
  expect(ok).toBe(true);
});

test("parseWhen: quoted semantic value with trailing threshold", () => {
  expect(parseWhen('body:semantic:"a customer complaint":0.55')).toEqual({
    field: "body",
    op: "semantic",
    value: "a customer complaint",
    threshold: 0.55,
  });
});

test("parseWhen: quoted semantic value without threshold", () => {
  expect(parseWhen('body:semantic:"a customer complaint"')).toEqual({
    field: "body",
    op: "semantic",
    value: "a customer complaint",
  });
});

test("parseWhen: non-semantic conditions unchanged", () => {
  expect(parseWhen("amount:gt:1000")).toEqual({ field: "amount", op: "gt", value: "1000" });
  expect(parseWhen("email:eq:a:b")).toEqual({ field: "email", op: "eq", value: "a:b" });
});

test("rankAgentsByValue: agents sorted desc by value", () => {
  const { db, userId } = newUser();
  db.insertRoiEvent(userId, { agent: "orion", department: "marketing", valueUsd: 300, minutesSaved: 60 });
  db.insertRoiEvent(userId, { agent: "helios", department: "marketing", valueUsd: 900, minutesSaved: 120 });
  db.insertRoiEvent(userId, { agent: "digit", department: "data", valueUsd: 100, minutesSaved: 30 });
  const ranked = rankAgentsByValue(db, userId, 7);
  expect(ranked.map((r) => r.agent)).toEqual(["helios", "orion", "digit"]);
  expect(ranked[0].valueUsd).toBe(900);
  expect(ranked[0].hoursSaved).toBe(2);
});

test("rankDepartmentsByValue: departments sorted desc by value", () => {
  const { db, userId } = newUser();
  db.insertRoiEvent(userId, { agent: "orion", department: "marketing", valueUsd: 300, minutesSaved: 60 });
  db.insertRoiEvent(userId, { agent: "helios", department: "marketing", valueUsd: 900, minutesSaved: 120 });
  db.insertRoiEvent(userId, { agent: "digit", department: "data", valueUsd: 100, minutesSaved: 30 });
  const ranked = rankDepartmentsByValue(db, userId, 7);
  expect(ranked[0].department).toBe("marketing");
  expect(ranked[0].valueUsd).toBe(1200);
  expect(ranked[1].department).toBe("data");
});
