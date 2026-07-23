import { test, expect } from "bun:test";
import { parseCardArgs, runWorkboardCli } from "../src/cli-workboard.ts";
import { getDb } from "../src/db.ts";

const db = getDb();

test("parseCardArgs reads a --fields JSON blob", () => {
  const r = parseCardArgs(["--fields", '{"company":"Acme","score":80}']);
  expect(r.errors).toEqual([]);
  expect(r.fields).toEqual({ company: "Acme", score: 80 });
});

test("parseCardArgs reports malformed JSON instead of throwing", () => {
  const r = parseCardArgs(["--fields", "{not json"]);
  expect(r.errors.length).toBe(1);
  expect(r.errors[0]).toContain("--fields");
});

test("parseCardArgs returns empty fields when the flag is absent", () => {
  const r = parseCardArgs(["--stage", "new"]);
  expect(r.fields).toEqual({});
  expect(r.errors).toEqual([]);
});

db.upsertUser({ telegram_id: `tg-wb-cli-admin-${Date.now()}`, name: "WB CLI Admin", role: "admin" });
const adminUserId = db.getUsersByRole("admin")[0].id;

async function runCli(args: string[]): Promise<{ code: number; errors: string[] }> {
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...a: any[]) => { errors.push(a.join(" ")); };
  try {
    const code = await runWorkboardCli(args);
    return { code, errors };
  } finally {
    console.error = orig;
  }
}

const FIELDS = [
  { key: "company", label: "Company", type: "text", required: true, primary: true },
  { key: "score", label: "Score", type: "number" },
];
const STAGES = [{ key: "new", label: "New", order: 0 }];

test("create rejects a non-array --fields without throwing", async () => {
  const r = await runCli(["create", `wb-cli-bad1-${Date.now()}`, "--fields", '{"key":"company"}', "--stages", JSON.stringify(STAGES)]);
  expect(r.code).toBe(1);
  expect(r.errors.join(" ")).toContain("--fields");
});

test("create rejects a non-array --stages without throwing", async () => {
  const r = await runCli(["create", `wb-cli-bad3-${Date.now()}`, "--fields", JSON.stringify(FIELDS), "--stages", '{"key":"new"}']);
  expect(r.code).toBe(1);
  expect(r.errors.join(" ")).toContain("--stages");
});

test("create reports both flags when both --fields and --stages are the wrong shape", async () => {
  const r = await runCli(["create", `wb-cli-bad-both-${Date.now()}`, "--fields", "5", "--stages", '{"key":"new"}']);
  expect(r.code).toBe(1);
  const joined = r.errors.join(" ");
  expect(joined).toContain("--fields");
  expect(joined).toContain("--stages");
});

test("card add without a board name fails clearly instead of naming \"undefined\"", async () => {
  const r = await runCli(["card", "add"]);
  expect(r.code).toBe(1);
  expect(r.errors.join(" ")).not.toContain("undefined");
});

test("card add-many without a board name fails clearly instead of naming \"undefined\"", async () => {
  const r = await runCli(["card", "add-many"]);
  expect(r.code).toBe(1);
  expect(r.errors.join(" ")).not.toContain("undefined");
});

test("card move without a card id fails clearly instead of naming \"undefined\"", async () => {
  const r = await runCli(["card", "move"]);
  expect(r.code).toBe(1);
  expect(r.errors.join(" ")).not.toContain("undefined");
});

test("card update without a card id fails clearly instead of naming \"undefined\"", async () => {
  const r = await runCli(["card", "update"]);
  expect(r.code).toBe(1);
  expect(r.errors.join(" ")).not.toContain("undefined");
});

test("card add against a nonexistent board fails", async () => {
  const r = await runCli(["card", "add", "no-such-board-xyz", "--fields", "{}"]);
  expect(r.code).toBe(1);
  expect(r.errors.join(" ")).toContain("no-such-board-xyz");
});

test("create -> card add -> card update round-trips through the db facade", async () => {
  const boardName = `wb-cli-roundtrip-${Date.now()}`;
  const created = await runCli(["create", boardName, "--fields", JSON.stringify(FIELDS), "--stages", JSON.stringify(STAGES)]);
  expect(created.code).toBe(0);

  const board = db.findWorkboard(adminUserId, boardName);
  expect(board).not.toBeNull();
  if (!board) throw new Error("setup failed");

  const added = await runCli(["card", "add", boardName, "--stage", "new", "--fields", JSON.stringify({ company: "Acme", score: 10 })]);
  expect(added.code).toBe(0);

  const cards = db.listWorkboardCards(board.scope, adminUserId, board.id);
  expect(cards.length).toBe(1);
  const cardId = cards[0].id;

  const updated = await runCli(["card", "update", cardId, "--fields", JSON.stringify({ score: 42 })]);
  expect(updated.code).toBe(0);

  const cardAfter = db.getWorkboardCard(board.scope, adminUserId, cardId);
  expect(cardAfter?.fields.score).toBe(42);
  expect(cardAfter?.fields.company).toBe("Acme");
});
