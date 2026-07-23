import { test, expect } from "bun:test";
import { getDb } from "../src/db.ts";
import { addCards, createBoard } from "../src/workboard-service.ts";
import { buildPush, mapRemoteRecord, planUpsert, pullBoard, type ConnectorBinding } from "../src/workboard-sync.ts";
import { runWorkboardCli } from "../src/cli-workboard.ts";

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

/** Same admin-resolution the CLI uses (`db.getUsersByRole("admin")[0]`), so a board created here
 *  is the one `nova workboard sync` will actually find, regardless of test run order. */
function seedForCli(binding: ConnectorBinding | null = BINDING) {
  const db = getDb();
  const existing = db.getUsersByRole("admin")[0];
  const userId = existing ? existing.id : db.upsertUser({ telegram_id: `wbs2-cli-${Date.now()}-${seq++}`, name: "CLI Admin", role: "admin" }).id;
  const created = createBoard(db, userId, {
    name: `crm-cli-${Date.now()}-${seq++}`,
    fields: [
      { key: "company", label: "Company", type: "text", required: true, primary: true },
      { key: "email", label: "Email", type: "email" },
    ],
    stages: [{ key: "new", label: "New", order: 0 }],
  });
  if (!created.ok) throw new Error(created.errors.join(", "));
  const board = binding ? db.updateWorkboard("personal", userId, created.value.id, { connectorBinding: binding })! : created.value;
  return { db, userId, board };
}

async function runCli(argv: string[], opts: Parameters<typeof runWorkboardCli>[1] = {}) {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: any[]) => { logs.push(a.join(" ")); };
  console.error = (...a: any[]) => { errors.push(a.join(" ")); };
  try {
    const code = await runWorkboardCli(argv, opts);
    return { code, logs, errors };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
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
  if (!r.ok) throw new Error(r.error);
  expect(r.created).toBe(2);
  expect(db.listWorkboardCards("personal", userId, board.id).length).toBe(2);
});

test("a failed pull changes nothing and reports the error, not a partial success", async () => {
  const { db, userId, board } = seed();
  addCards(db, userId, board, "new", [{ fields: { company: "Existing" } }], "user");
  const runAction = async () => ({ ok: false, error: "hubspot is not configured" });
  const r = await pullBoard(db, userId, board, { runAction: runAction as any });
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("expected a fatal outcome");
  expect(r.error).toBe("hubspot is not configured");
  expect(db.listWorkboardCards("personal", userId, board.id).length).toBe(1);
});

test("pullBoard refuses an unbound board as a fatal outcome", async () => {
  const { db, userId, board } = seed(null);
  const r = await pullBoard(db, userId, board, { runAction: (async () => ({ ok: true, data: [] })) as any });
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("expected a fatal outcome");
  expect(r.error).toContain("not bound");
});

test("pullBoard refuses a board with no stages as a fatal outcome", async () => {
  const { db, userId, board } = seed();
  const noStages = db.updateWorkboard("personal", userId, board.id, { stages: [] })!;
  const r = await pullBoard(db, userId, noStages, { runAction: (async () => ({ ok: true, data: [] })) as any });
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("expected a fatal outcome");
  expect(r.error).toContain("no stages");
  expect(db.listWorkboardCards("personal", userId, board.id).length).toBe(0);
});

test("a record that fails field validation is skipped, not fatal — the rest of the pull still lands", async () => {
  const { db, userId, board } = seed();
  const runAction = async () => ({ ok: true, data: [
    { id: "42", properties: { email: "no-company@acme.com" } }, // company required, absent -> invalid
    { id: "43", properties: { company: "Globex", email: "g@globex.com" } },
  ] });
  const r = await pullBoard(db, userId, board, { runAction: runAction as any });
  if (!r.ok) throw new Error(r.error);
  expect(r.created).toBe(1);
  expect(r.skipped.length).toBe(1);
  expect(r.skipped[0].externalId).toBe("42");
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
  if (!first.ok) throw new Error(first.error);
  expect(first.created).toBe(2);
  expect(first.updated).toBe(0);

  records[0].properties.company = "Acme Corp";
  const second = await pullBoard(db, userId, board, { runAction: runAction as any });
  if (!second.ok) throw new Error(second.error);
  expect(second.created).toBe(0);
  expect(second.updated).toBe(2);

  const cards = db.listWorkboardCards("personal", userId, board.id);
  expect(cards.length).toBe(2);
  expect(cards.find((c) => c.externalId === "42")?.fields.company).toBe("Acme Corp");
});

test("CLI sync with a mix of valid and invalid records exits zero and reports both what landed and what was skipped", async () => {
  const { board } = seedForCli();
  const runAction = (async () => ({ ok: true, data: [
    { id: "42", properties: { email: "no-company@acme.com" } },
    { id: "43", properties: { company: "Globex", email: "g@globex.com" } },
  ] })) as any;
  const r = await runCli(["sync", board.name], { runAction });
  expect(r.code).toBe(0);
  const out = r.logs.join("\n");
  expect(out).toContain("1 created, 0 updated");
  expect(out).toContain("1 record skipped");
  expect(out).toContain("42");
});

test("CLI sync whose connector read fails exits non-zero and reports the failure", async () => {
  const { board } = seedForCli();
  const runAction = (async () => ({ ok: false, error: "hubspot is not configured" })) as any;
  const r = await runCli(["sync", board.name], { runAction });
  expect(r.code).toBe(1);
  expect(r.errors.join(" ")).toContain("hubspot is not configured");
});

test("the sync event records the skip count and reasons, not just created/updated", async () => {
  const { db, userId, board } = seed();
  const runAction = async () => ({ ok: true, data: [
    { id: "42", properties: { email: "no-company@acme.com" } },
    { id: "43", properties: { company: "Globex", email: "g@globex.com" } },
  ] });
  const r = await pullBoard(db, userId, board, { runAction: runAction as any });
  if (!r.ok) throw new Error(r.error);
  expect(r.skipped.length).toBe(1);

  const events = db.listWorkboardEvents(board.scope, userId, board.id, 5);
  const syncEvent = events.find((e) => e.kind === "sync");
  expect(syncEvent).toBeTruthy();
  expect(syncEvent?.detail?.skipped).toBe(1);
  expect(Array.isArray(syncEvent?.detail?.reasons)).toBe(true);
  expect(syncEvent?.detail?.reasons[0]).toContain("company");
});

test("a returned record count equal to the requested limit produces a truncation warning", async () => {
  const { db, userId } = seed(null);
  const created = createBoard(db, userId, {
    name: `crm-trunc-hit-${Date.now()}-${seq++}`,
    fields: [{ key: "company", label: "Company", type: "text", required: true, primary: true }],
    stages: [{ key: "new", label: "New", order: 0 }],
  });
  if (!created.ok) throw new Error(created.errors.join(", "));
  const board = db.updateWorkboard("personal", userId, created.value.id, {
    connectorBinding: { ...BINDING, input: { limit: 20 } },
  })!;
  const records = Array.from({ length: 20 }, (_, i) => ({ id: String(i + 1), properties: { company: `Co ${i + 1}` } }));
  const runAction = async () => ({ ok: true, data: records });
  const r = await pullBoard(db, userId, board, { runAction: runAction as any });
  if (!r.ok) throw new Error(r.error);
  expect(r.truncated).toBe(true);
  expect(r.warning).toBeTruthy();
});

test("one record fewer than the requested limit does not produce a truncation warning", async () => {
  const { db, userId } = seed(null);
  const created = createBoard(db, userId, {
    name: `crm-trunc-miss-${Date.now()}-${seq++}`,
    fields: [{ key: "company", label: "Company", type: "text", required: true, primary: true }],
    stages: [{ key: "new", label: "New", order: 0 }],
  });
  if (!created.ok) throw new Error(created.errors.join(", "));
  const board = db.updateWorkboard("personal", userId, created.value.id, {
    connectorBinding: { ...BINDING, input: { limit: 20 } },
  })!;
  const records = Array.from({ length: 19 }, (_, i) => ({ id: String(i + 1), properties: { company: `Co ${i + 1}` } }));
  const runAction = async () => ({ ok: true, data: records });
  const r = await pullBoard(db, userId, board, { runAction: runAction as any });
  if (!r.ok) throw new Error(r.error);
  expect(r.truncated).toBe(false);
  expect(r.warning).toBeUndefined();
});

test("pullBoard end-to-end never deletes cards the remote stops returning", async () => {
  const { db, userId, board } = seed();
  const seeded = addCards(db, userId, board, "new", [
    { fields: { company: "Acme", email: "a@acme.com" } },
    { fields: { company: "Globex", email: "g@globex.com" } },
  ], "user");
  if (!seeded.ok) throw new Error(seeded.errors.join(", "));

  const runAction = async () => ({ ok: true, data: [] });
  const r = await pullBoard(db, userId, board, { runAction: runAction as any });
  if (!r.ok) throw new Error(r.error);

  const cards = db.listWorkboardCards("personal", userId, board.id);
  expect(cards.length).toBe(2);
  expect(cards.map((c) => c.fields.company).sort()).toEqual(["Acme", "Globex"]);
});

test("a pull that updates mapped fields leaves an unmapped local field untouched", async () => {
  const db = getDb();
  const u = db.upsertUser({ telegram_id: `wbs2-unmapped-${Date.now()}-${seq++}`, name: "S User", role: "admin" });
  const created = createBoard(db, u.id, {
    name: `crm-unmapped-${Date.now()}-${seq++}`,
    fields: [
      { key: "company", label: "Company", type: "text", required: true, primary: true },
      { key: "email", label: "Email", type: "email" },
      { key: "notes", label: "Notes", type: "longtext" },
    ],
    stages: [{ key: "new", label: "New", order: 0 }],
  });
  if (!created.ok) throw new Error(created.errors.join(", "));
  const board = db.updateWorkboard("personal", u.id, created.value.id, { connectorBinding: BINDING })!;

  db.insertWorkboardCards(board.scope, u.id, [{
    boardId: board.id, stageKey: "new", title: "Acme",
    fields: { company: "Acme", email: "old@acme.com", notes: "call back Tuesday" },
    origin: "user", externalId: "42",
  }]);

  const runAction = async () => ({ ok: true, data: [
    { id: "42", properties: { company: "Acme Corp", email: "new@acme.com" } },
  ] });
  const r = await pullBoard(db, u.id, board, { runAction: runAction as any });
  if (!r.ok) throw new Error(r.error);
  expect(r.updated).toBe(1);

  const cards = db.listWorkboardCards("personal", u.id, board.id);
  expect(cards.length).toBe(1);
  expect(cards[0].fields.company).toBe("Acme Corp");
  expect(cards[0].fields.email).toBe("new@acme.com");
  expect(cards[0].fields.notes).toBe("call back Tuesday");
});

const PUSH_BINDING: ConnectorBinding = {
  ...BINDING,
  writeAction: "update_contact",
  stageField: "properties.lifecycle",
  stageMap: { new: "lead", won: "customer" },
};

test("buildPush maps the target stage onto the remote field", () => {
  const card = { id: "c1", externalId: "42", fields: { company: "Acme" } } as any;
  const p = buildPush(PUSH_BINDING, card, "won");
  expect("skip" in p).toBe(false);
  if (!("skip" in p)) {
    expect(p.connector).toBe("hubspot");
    expect(p.action).toBe("update_contact");
    expect(p.input.id).toBe("42");
    expect(p.input["properties.lifecycle"]).toBe("customer");
  }
});

test("buildPush skips a card with no external id", () => {
  const card = { id: "c1", externalId: null, fields: {} } as any;
  expect("skip" in buildPush(PUSH_BINDING, card, "won")).toBe(true);
});

test("buildPush skips when the binding is pull-only", () => {
  const card = { id: "c1", externalId: "42", fields: {} } as any;
  const p = buildPush(BINDING, card, "won");
  expect("skip" in p).toBe(true);
  if ("skip" in p) expect(p.skip).toContain("pull-only");
});

test("buildPush skips a stage with no remote equivalent", () => {
  const card = { id: "c1", externalId: "42", fields: {} } as any;
  expect("skip" in buildPush(PUSH_BINDING, card, "nurture")).toBe(true);
});
