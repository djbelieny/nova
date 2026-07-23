import { test, expect } from "bun:test";
import { getDb } from "../src/db.ts";
import { addCards, createBoard } from "../src/workboard-service.ts";
import { mapRemoteRecord, planUpsert, pullBoard, type ConnectorBinding } from "../src/workboard-sync.ts";

let seq = 0;
const BINDING: ConnectorBinding = {
  connector: "hubspot",
  readAction: "list_contacts",
  externalIdPath: "id",
  fieldMap: { company: "properties.company", email: "properties.email" },
};

function seed(binding: ConnectorBinding | null = BINDING) {
  const db = getDb();
  const u = db.upsertUser({ telegram_id: `wbs2-${Date.now()}-${seq++}`, name: "S User", role: "admin" });
  const created = createBoard(db, u.id, {
    name: "crm",
    fields: [
      { key: "company", label: "Company", type: "text", required: true, primary: true },
      { key: "email", label: "Email", type: "email" },
    ],
    stages: [{ key: "new", label: "New", order: 0 }],
  });
  if (!created.ok) throw new Error(created.errors.join(", "));
  const board = binding ? db.updateWorkboard("personal", u.id, created.value.id, { connectorBinding: binding })! : created.value;
  return { db, userId: u.id, board };
}

test("mapRemoteRecord reads dot paths into board fields", () => {
  const mapped = mapRemoteRecord(BINDING, { id: "42", properties: { company: "Acme", email: "a@acme.com" } });
  expect(mapped.externalId).toBe("42");
  expect(mapped.fields).toEqual({ company: "Acme", email: "a@acme.com" });
});

test("mapRemoteRecord yields a null externalId when the path is absent", () => {
  expect(mapRemoteRecord(BINDING, { properties: { company: "Acme" } }).externalId).toBe(null);
});

test("planUpsert splits incoming records into creates and updates by external id", () => {
  const existing = [{ id: "c1", externalId: "42", fields: { company: "Old" } } as any];
  const plan = planUpsert(existing, [
    { externalId: "42", fields: { company: "Acme" } },
    { externalId: "43", fields: { company: "Globex" } },
  ]);
  expect(plan.update).toEqual([{ id: "c1", fields: { company: "Acme" } }]);
  expect(plan.create.length).toBe(1);
});

test("planUpsert never deletes cards that the remote no longer returns", () => {
  const existing = [{ id: "c1", externalId: "42", fields: {} } as any];
  const plan = planUpsert(existing, []);
  expect(plan.create.length).toBe(0);
  expect(plan.update.length).toBe(0);
});

test("pullBoard creates cards from a stubbed connector response", async () => {
  const { db, userId, board } = seed();
  const runAction = async () => ({ ok: true, data: [
    { id: "42", properties: { company: "Acme", email: "a@acme.com" } },
    { id: "43", properties: { company: "Globex", email: "g@globex.com" } },
  ] });
  const r = await pullBoard(db, userId, board, { runAction: runAction as any });
  expect(r.created).toBe(2);
  expect(db.listWorkboardCards("personal", userId, board.id).length).toBe(2);
});

test("a failed pull changes nothing and reports the error", async () => {
  const { db, userId, board } = seed();
  addCards(db, userId, board, "new", [{ fields: { company: "Existing" } }], "user");
  const runAction = async () => ({ ok: false, error: "hubspot is not configured" });
  const r = await pullBoard(db, userId, board, { runAction: runAction as any });
  expect(r.errors.length).toBe(1);
  expect(db.listWorkboardCards("personal", userId, board.id).length).toBe(1);
});

test("pullBoard refuses an unbound board", async () => {
  const { db, userId, board } = seed(null);
  const r = await pullBoard(db, userId, board, { runAction: (async () => ({ ok: true, data: [] })) as any });
  expect(r.errors.join(" ")).toContain("not bound");
});

test("pullBoard refuses a board with no stages", async () => {
  const { db, userId, board } = seed();
  const noStages = db.updateWorkboard("personal", userId, board.id, { stages: [] })!;
  const r = await pullBoard(db, userId, noStages, { runAction: (async () => ({ ok: true, data: [] })) as any });
  expect(r.errors.join(" ")).toContain("no stages");
  expect(db.listWorkboardCards("personal", userId, board.id).length).toBe(0);
});

test("a record that fails field validation is skipped, not fatal — the rest of the pull still lands", async () => {
  const { db, userId, board } = seed();
  const runAction = async () => ({ ok: true, data: [
    { id: "42", properties: { email: "no-company@acme.com" } }, // company required, absent -> invalid
    { id: "43", properties: { company: "Globex", email: "g@globex.com" } },
  ] });
  const r = await pullBoard(db, userId, board, { runAction: runAction as any });
  expect(r.created).toBe(1);
  expect(r.errors.length).toBe(1);
  const cards = db.listWorkboardCards("personal", userId, board.id);
  expect(cards.length).toBe(1);
  expect(cards[0].fields.company).toBe("Globex");
});

test("a second pull over the same records updates existing cards instead of duplicating them", async () => {
  const { db, userId, board } = seed();
  const records = [
    { id: "42", properties: { company: "Acme", email: "a@acme.com" } },
    { id: "43", properties: { company: "Globex", email: "g@globex.com" } },
  ];
  const runAction = async () => ({ ok: true, data: records });
  const first = await pullBoard(db, userId, board, { runAction: runAction as any });
  expect(first.created).toBe(2);
  expect(first.updated).toBe(0);

  records[0].properties.company = "Acme Corp";
  const second = await pullBoard(db, userId, board, { runAction: runAction as any });
  expect(second.created).toBe(0);
  expect(second.updated).toBe(2);

  const cards = db.listWorkboardCards("personal", userId, board.id);
  expect(cards.length).toBe(2);
  expect(cards.find((c) => c.externalId === "42")?.fields.company).toBe("Acme Corp");
});
