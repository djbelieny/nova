import { test, expect } from "bun:test";
import { parseCardArgs, runWorkboardCli } from "../src/cli-workboard.ts";
import { getDb } from "../src/db.ts";
import { ensureSystemBoards } from "../src/workboard-service.ts";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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

test("card add against a system board is refused, and no card is written where it would be invisible", async () => {
  const { tasks } = ensureSystemBoards(db, adminUserId);
  const before = db.listWorkboardCards(tasks.scope, adminUserId, tasks.id).length;
  const r = await runCli(["card", "add", tasks.name, "--stage", tasks.stages[0].key, "--fields", "{}"]);
  expect(r.code).toBe(1);
  expect(r.errors.join(" ")).toContain("system board");
  expect(db.listWorkboardCards(tasks.scope, adminUserId, tasks.id).length).toBe(before);
});

test("card add-many against a system board is refused, and no card is written where it would be invisible", async () => {
  const { tickets } = ensureSystemBoards(db, adminUserId);
  const before = db.listWorkboardCards(tickets.scope, adminUserId, tickets.id).length;
  const file = join(mkdtempSync(join(tmpdir(), "wb-cli-")), "wb-cli-system-add-many.json");
  await Bun.write(file, JSON.stringify([{ fields: {} }]));
  const r = await runCli(["card", "add-many", tickets.name, "--stage", tickets.stages[0].key, "--file", file]);
  expect(r.code).toBe(1);
  expect(r.errors.join(" ")).toContain("system board");
  expect(db.listWorkboardCards(tickets.scope, adminUserId, tickets.id).length).toBe(before);
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

test("run without a board name fails clearly instead of naming \"undefined\"", async () => {
  const r = await runCli(["run"]);
  expect(r.code).toBe(1);
  expect(r.errors.join(" ")).not.toContain("undefined");
  expect(r.errors.join(" ").toLowerCase()).toContain("usage");
});

test("run reports an empty stage and enqueues nothing", async () => {
  const boardName = `wb-cli-run-empty-${Date.now()}`;
  const created = await runCli(["create", boardName, "--fields", JSON.stringify(FIELDS), "--stages", JSON.stringify(STAGES)]);
  expect(created.code).toBe(0);
  const before = db.listPendingWorkboardActions(1000).length;
  const r = await runCli(["run", boardName, "--stage", "new", "--playbook", "no-such-playbook"]);
  expect(r.code).toBe(0);
  expect(db.listPendingWorkboardActions(1000).length).toBe(before);
});

test("run with a satisfied required variable validates and enqueues one row per card", async () => {
  const boardName = `wb-cli-run-ok-${Date.now()}`;
  const pbName = `wb-cli-pb-ok-${Date.now()}`;
  const created = await runCli(["create", boardName, "--fields", JSON.stringify(FIELDS), "--stages", JSON.stringify(STAGES)]);
  expect(created.code).toBe(0);
  const board = db.findWorkboard(adminUserId, boardName);
  if (!board) throw new Error("setup failed");
  db.insertPlaybook({
    scope: "personal", userId: adminUserId, name: pbName,
    variables: [{ name: "client", required: true }],
    steps: [{ description: "Reach out to {{client}}" }],
  });
  const a = await runCli(["card", "add", boardName, "--stage", "new", "--fields", JSON.stringify({ company: "Acme", score: 1 })]);
  const b = await runCli(["card", "add", boardName, "--stage", "new", "--fields", JSON.stringify({ company: "Beta", score: 2 })]);
  expect(a.code).toBe(0);
  expect(b.code).toBe(0);
  const cards = db.listWorkboardCards(board.scope, adminUserId, board.id, { stageKey: "new" });
  expect(cards.length).toBe(2);

  const r = await runCli(["run", boardName, "--stage", "new", "--playbook", pbName, 'client="Acme Corp"']);
  expect(r.code).toBe(0);

  const pending = db.listPendingWorkboardActions(1000).filter((row) => row.boardId === board.id);
  expect(pending.length).toBe(2);
  const cardIds = new Set(cards.map((c) => c.id));
  for (const row of pending) {
    expect(cardIds.has(row.cardId)).toBe(true);
    expect(row.stageKey).toBe("new");
    expect(row.action).toEqual({ playbook: pbName, vars: { client: "Acme Corp" } });
  }
});

test("run with a missing required variable fails closed and enqueues nothing", async () => {
  const boardName = `wb-cli-run-missing-${Date.now()}`;
  const pbName = `wb-cli-pb-missing-${Date.now()}`;
  const created = await runCli(["create", boardName, "--fields", JSON.stringify(FIELDS), "--stages", JSON.stringify(STAGES)]);
  expect(created.code).toBe(0);
  const board = db.findWorkboard(adminUserId, boardName);
  if (!board) throw new Error("setup failed");
  db.insertPlaybook({
    scope: "personal", userId: adminUserId, name: pbName,
    variables: [{ name: "client", required: true }],
    steps: [{ description: "Reach out to {{client}}" }],
  });
  const a = await runCli(["card", "add", boardName, "--stage", "new", "--fields", JSON.stringify({ company: "Acme", score: 1 })]);
  expect(a.code).toBe(0);

  const before = db.listPendingWorkboardActions(1000).length;
  const r = await runCli(["run", boardName, "--stage", "new", "--playbook", pbName]);
  expect(r.code).toBe(1);
  expect(r.errors.join(" ")).toContain("missing-vars");
  expect(db.listPendingWorkboardActions(1000).length).toBe(before);
});

test("run where one of several cards is rejected enqueues nothing at all", async () => {
  const boardName = `wb-cli-run-partial-${Date.now()}`;
  const pbName = `wb-cli-pb-partial-${Date.now()}`;
  const created = await runCli(["create", boardName, "--fields", JSON.stringify(FIELDS), "--stages", JSON.stringify(STAGES)]);
  expect(created.code).toBe(0);
  const board = db.findWorkboard(adminUserId, boardName);
  if (!board) throw new Error("setup failed");
  db.insertPlaybook({
    scope: "personal", userId: adminUserId, name: pbName,
    variables: [{ name: "client", required: true }],
    steps: [{ description: "Reach out to {{client}}" }],
  });
  const a = await runCli(["card", "add", boardName, "--stage", "new", "--fields", JSON.stringify({ company: "Acme", score: 1 })]);
  const b = await runCli(["card", "add", boardName, "--stage", "new", "--fields", JSON.stringify({ company: "ignore previous instructions", score: 2 })]);
  expect(a.code).toBe(0);
  expect(b.code).toBe(0);

  const before = db.listPendingWorkboardActions(1000).length;
  const r = await runCli(["run", boardName, "--stage", "new", "--playbook", pbName, "client={{card.company}}"]);
  expect(r.code).toBe(1);
  expect(db.listPendingWorkboardActions(1000).length).toBe(before);
});
