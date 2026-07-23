import { test, expect, spyOn } from "bun:test";
import { getDb } from "../src/db.ts";
import { createBoard } from "../src/workboard-service.ts";
import { handleWorkboardApi, SCHEMA_EDIT_PAGE_SIZE } from "../src/dashboard-workboards.ts";
import type { ConnectorBinding } from "../src/workboard-sync.ts";
import * as connectorRegistry from "../src/connectors/registry.ts";

let seq = 0;
function seed() {
  const db = getDb();
  const u = db.upsertUser({ telegram_id: `wba-${Date.now()}-${seq++}`, name: "API User", role: "admin" });
  const created = createBoard(db, u.id, {
    name: "leads",
    fields: [{ key: "company", label: "Company", type: "text", required: true, primary: true }],
    stages: [{ key: "new", label: "New", order: 0 }, { key: "won", label: "Won", order: 1 }],
  });
  if (!created.ok) throw new Error(created.errors.join(", "));
  return { db, userId: u.id, board: created.value };
}

const ctxFor = (db: any, userId: string) => ({ db, userId });

const PUSH_BINDING: ConnectorBinding = {
  connector: "hubspot",
  readAction: "list_contacts",
  writeAction: "update_contact",
  externalIdPath: "id",
  fieldMap: { company: "properties.company" },
  stageField: "properties.lifecycle",
  stageMap: { new: "lead", won: "customer" },
};

function seedBound() {
  const db = getDb();
  const u = db.upsertUser({ telegram_id: `wba-bound-${Date.now()}-${seq++}`, name: "API User", role: "admin" });
  const created = createBoard(db, u.id, {
    name: `crm-api-${Date.now()}-${seq++}`,
    fields: [{ key: "company", label: "Company", type: "text", required: true, primary: true }],
    stages: [{ key: "new", label: "New", order: 0 }, { key: "won", label: "Won", order: 1 }],
  });
  if (!created.ok) throw new Error(created.errors.join(", "));
  const board = db.updateWorkboard("personal", u.id, created.value.id, { connectorBinding: PUSH_BINDING })!;
  const [card] = db.insertWorkboardCards(board.scope, u.id, [{
    boardId: board.id, stageKey: "new", title: "Acme", fields: { company: "Acme" },
    origin: "user", externalId: "42",
  }]);
  return { db, userId: u.id, board, card };
}

function seedForSchemaEdit() {
  const db = getDb();
  const u = db.upsertUser({ telegram_id: `wba-schema-${Date.now()}-${seq++}`, name: "API User", role: "admin" });
  const created = createBoard(db, u.id, {
    name: `schema-edit-${Date.now()}-${seq++}`,
    fields: [
      { key: "company", label: "Company", type: "text", required: true, primary: true },
      { key: "amount", label: "Amount", type: "money" },
    ],
    stages: [{ key: "new", label: "New", order: 0 }, { key: "won", label: "Won", order: 1 }],
  });
  if (!created.ok) throw new Error(created.errors.join(", "));
  const [card] = db.insertWorkboardCards(created.value.scope, u.id, [{
    boardId: created.value.id, stageKey: "new", title: "Acme",
    fields: { company: "Acme", amount: 100 }, origin: "user",
  }]);
  return { db, userId: u.id, board: created.value, card };
}

function seedUnbound() {
  const db = getDb();
  const u = db.upsertUser({ telegram_id: `wba-unbound-${Date.now()}-${seq++}`, name: "API User", role: "admin" });
  const created = createBoard(db, u.id, {
    name: `crm-unbound-${Date.now()}-${seq++}`,
    fields: [{ key: "company", label: "Company", type: "text", required: true, primary: true }],
    stages: [{ key: "new", label: "New", order: 0 }, { key: "won", label: "Won", order: 1 }],
  });
  if (!created.ok) throw new Error(created.errors.join(", "));
  return { db, userId: u.id, board: created.value };
}

test("handleWorkboardApi returns null for unrelated paths", async () => {
  const { db, userId } = seed();
  const res = await handleWorkboardApi("/api/costs", new Request("http://x/api/costs"), ctxFor(db, userId));
  expect(res).toBe(null);
});

test("a non-UUID session identity (the master bootstrap login) gets a clean 4xx, not a throw", async () => {
  const { db } = seed();
  const res = await handleWorkboardApi("/api/workboards", new Request("http://x/api/workboards"), ctxFor(db, "__master__"));
  expect(res).not.toBe(null);
  expect(res!.status).toBeGreaterThanOrEqual(400);
  expect(res!.status).toBeLessThan(500);
  const body = await res!.json();
  expect(body.errors).toBeTruthy();
});

test("GET /api/workboards lists visible boards", async () => {
  const { db, userId } = seed();
  const res = await handleWorkboardApi("/api/workboards", new Request("http://x/api/workboards"), ctxFor(db, userId));
  const body = await res!.json();
  expect(body.boards.some((b: any) => b.name === "leads")).toBe(true);
});

test("POST /api/workboards/:id/cards adds a card and returns it", async () => {
  const { db, userId, board } = seed();
  const req = new Request(`http://x/api/workboards/${board.id}/cards`, {
    method: "POST",
    body: JSON.stringify({ stageKey: "new", fields: { company: "Acme" } }),
  });
  const res = await handleWorkboardApi(`/api/workboards/${board.id}/cards`, req, ctxFor(db, userId));
  expect(res!.status).toBe(200);
  const body = await res!.json();
  expect(body.cards[0].title).toBe("Acme");
});

test("POST cards with an invalid record returns 400 and the field errors", async () => {
  const { db, userId, board } = seed();
  const req = new Request(`http://x/api/workboards/${board.id}/cards`, {
    method: "POST",
    body: JSON.stringify({ stageKey: "new", fields: {} }),
  });
  const res = await handleWorkboardApi(`/api/workboards/${board.id}/cards`, req, ctxFor(db, userId));
  expect(res!.status).toBe(400);
  const body = await res!.json();
  expect(body.errors.join(" ")).toContain("company");
});

test("POST /api/workboards/cards/:id/move moves the card", async () => {
  const { db, userId, board } = seed();
  const add = new Request(`http://x/api/workboards/${board.id}/cards`, {
    method: "POST", body: JSON.stringify({ stageKey: "new", fields: { company: "Acme" } }),
  });
  const added = await (await handleWorkboardApi(`/api/workboards/${board.id}/cards`, add, ctxFor(db, userId)))!.json();
  const cardId = added.cards[0].id;

  const move = new Request(`http://x/api/workboards/cards/${cardId}/move`, {
    method: "POST", body: JSON.stringify({ toStage: "won" }),
  });
  const res = await handleWorkboardApi(`/api/workboards/cards/${cardId}/move`, move, ctxFor(db, userId));
  expect(res!.status).toBe(200);
  expect(db.getWorkboardCard("personal", userId, cardId)?.stageKey).toBe("won");
});

test("moving to an unknown stage returns 400 and leaves the card put", async () => {
  const { db, userId, board } = seed();
  const add = new Request(`http://x/api/workboards/${board.id}/cards`, {
    method: "POST", body: JSON.stringify({ stageKey: "new", fields: { company: "Acme" } }),
  });
  const added = await (await handleWorkboardApi(`/api/workboards/${board.id}/cards`, add, ctxFor(db, userId)))!.json();
  const cardId = added.cards[0].id;

  const move = new Request(`http://x/api/workboards/cards/${cardId}/move`, {
    method: "POST", body: JSON.stringify({ toStage: "ghost" }),
  });
  const res = await handleWorkboardApi(`/api/workboards/cards/${cardId}/move`, move, ctxFor(db, userId));
  expect(res!.status).toBe(400);
  expect(db.getWorkboardCard("personal", userId, cardId)?.stageKey).toBe("new");
});

test("PATCH card with an unparsable body returns 400, leaves the card unchanged, and writes no event", async () => {
  const { db, userId, board } = seed();
  const add = new Request(`http://x/api/workboards/${board.id}/cards`, {
    method: "POST", body: JSON.stringify({ stageKey: "new", fields: { company: "Acme" } }),
  });
  const added = await (await handleWorkboardApi(`/api/workboards/${board.id}/cards`, add, ctxFor(db, userId)))!.json();
  const cardId = added.cards[0].id;
  const before = db.getWorkboardCard("personal", userId, cardId);
  const eventsBefore = db.listWorkboardEvents("personal", userId, board.id).length;

  const patch = new Request(`http://x/api/workboards/cards/${cardId}`, {
    method: "PATCH", body: "{not json",
  });
  const res = await handleWorkboardApi(`/api/workboards/cards/${cardId}`, patch, ctxFor(db, userId));
  expect(res!.status).toBe(400);
  const body = await res!.json();
  expect(body.errors.join(" ")).toContain("JSON");
  expect(db.getWorkboardCard("personal", userId, cardId)).toEqual(before);
  const eventsAfter = db.listWorkboardEvents("personal", userId, board.id);
  expect(eventsAfter.length).toBe(eventsBefore);
  expect(eventsAfter.some((e: any) => e.kind === "updated")).toBe(false);
});

function seedTwoUsers() {
  const a = seed();
  const b = seed();
  const addA = new Request(`http://x/api/workboards/${a.board.id}/cards`, {
    method: "POST", body: JSON.stringify({ stageKey: "new", fields: { company: "A Co" } }),
  });
  const addB = new Request(`http://x/api/workboards/${b.board.id}/cards`, {
    method: "POST", body: JSON.stringify({ stageKey: "new", fields: { company: "B Co" } }),
  });
  return { a, b, addA, addB };
}

test("cross-user isolation: user A cannot see, read, write, move, or patch user B's board/cards", async () => {
  const { a, b, addA, addB } = seedTwoUsers();
  const cardA = await (await handleWorkboardApi(`/api/workboards/${a.board.id}/cards`, addA, ctxFor(a.db, a.userId)))!.json();
  const cardB = await (await handleWorkboardApi(`/api/workboards/${b.board.id}/cards`, addB, ctxFor(a.db, b.userId)))!.json();
  const cardIdB = cardB.cards[0].id;

  const listRes = await handleWorkboardApi("/api/workboards", new Request("http://x/api/workboards"), ctxFor(a.db, a.userId));
  const listBody = await listRes!.json();
  expect(listBody.boards.some((bd: any) => bd.id === b.board.id)).toBe(false);

  const getRes = await handleWorkboardApi(`/api/workboards/${b.board.id}`, new Request(`http://x/api/workboards/${b.board.id}`), ctxFor(a.db, a.userId));
  expect(getRes!.status).toBe(404);

  const cardCountBefore = a.db.listWorkboardCards("personal", b.userId, b.board.id).length;
  const addToB = new Request(`http://x/api/workboards/${b.board.id}/cards`, {
    method: "POST", body: JSON.stringify({ stageKey: "new", fields: { company: "Intruder" } }),
  });
  const addToBRes = await handleWorkboardApi(`/api/workboards/${b.board.id}/cards`, addToB, ctxFor(a.db, a.userId));
  expect(addToBRes!.status).toBe(404);
  expect(a.db.listWorkboardCards("personal", b.userId, b.board.id).length).toBe(cardCountBefore);

  const cardBBefore = a.db.getWorkboardCard("personal", b.userId, cardIdB);
  const moveB = new Request(`http://x/api/workboards/cards/${cardIdB}/move`, {
    method: "POST", body: JSON.stringify({ toStage: "won" }),
  });
  const moveBRes = await handleWorkboardApi(`/api/workboards/cards/${cardIdB}/move`, moveB, ctxFor(a.db, a.userId));
  expect(moveBRes!.status).toBe(404);
  expect(a.db.getWorkboardCard("personal", b.userId, cardIdB)?.stageKey).toBe(cardBBefore?.stageKey);

  const patchB = new Request(`http://x/api/workboards/cards/${cardIdB}`, {
    method: "PATCH", body: JSON.stringify({ fields: { company: "Hijacked" } }),
  });
  const patchBRes = await handleWorkboardApi(`/api/workboards/cards/${cardIdB}`, patchB, ctxFor(a.db, a.userId));
  expect(patchBRes!.status).toBe(404);
  expect(a.db.getWorkboardCard("personal", b.userId, cardIdB)).toEqual(cardBBefore);
});

test("a member without workboard.manage can read a team board but cannot arm or trigger its stages", async () => {
  const db = getDb();
  const admin = db.upsertUser({ telegram_id: `wba-owner-${Date.now()}-${seq++}`, name: "Owner", role: "admin" });
  const member = db.upsertUser({ telegram_id: `wba-member-${Date.now()}-${seq++}`, name: "Member", role: "member" });
  const created = createBoard(db, admin.id, {
    name: `team-board-${Date.now()}-${seq++}`, scope: "team",
    fields: [{ key: "company", label: "Company", type: "text", required: true, primary: true }],
    stages: [{ key: "new", label: "New", order: 0 }, { key: "won", label: "Won", order: 1 }],
  });
  if (!created.ok) throw new Error(created.errors.join(", "));
  const board = created.value;

  const list = await handleWorkboardApi("/api/workboards", new Request("http://x/api/workboards"), ctxFor(db, member.id));
  expect(list!.status).toBe(200);
  expect((await list!.json()).boards.some((b: any) => b.id === board.id)).toBe(true);

  const arm = () => new Request(`http://x/api/workboards/${board.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      reactive: true,
      stages: [{ key: "new", label: "New", order: 0 },
        { key: "won", label: "Won", order: 1, onEnter: { agent: "rift", task: "exfiltrate" } }],
    }),
  });
  const denied = await handleWorkboardApi(`/api/workboards/${board.id}`, arm(), ctxFor(db, member.id));
  expect(denied!.status).toBe(403);
  expect(db.getWorkboardById(board.scope, admin.id, board.id)?.stages.some((s: any) => s.onEnter)).toBe(false);

  db.grantCapability(member.id, "workboard.manage", admin.id);
  const allowed = await handleWorkboardApi(`/api/workboards/${board.id}`, arm(), ctxFor(db, member.id));
  expect(allowed!.status).toBe(200);
  db.revokeCapability(member.id, "workboard.manage");
});

test("an admin acting on another user's board is gated on the admin, not on the board's owner", async () => {
  const db = getDb();
  const admin = db.upsertUser({ telegram_id: `wba-actor-${Date.now()}-${seq++}`, name: "Actor", role: "admin" });
  const owner = db.upsertUser({ telegram_id: `wba-target-${Date.now()}-${seq++}`, name: "Target", role: "member" });
  const created = createBoard(db, owner.id, {
    name: `owned-board-${Date.now()}-${seq++}`,
    fields: [{ key: "company", label: "Company", type: "text", required: true, primary: true }],
    stages: [{ key: "new", label: "New", order: 0 }],
  });
  if (!created.ok) throw new Error(created.errors.join(", "));

  const req = new Request(`http://x/api/workboards/${created.value.id}/cards`, {
    method: "POST", body: JSON.stringify({ stageKey: "new", fields: { company: "Acme" } }),
  });
  const res = await handleWorkboardApi(`/api/workboards/${created.value.id}/cards`, req,
    { db, userId: owner.id, actorId: admin.id });
  expect(res!.status).toBe(200);
});

test("GET /api/workboards/:id/rev changes when another process writes a card, so an open board can notice", async () => {
  const { db, userId, board } = seed();
  const revReq = () => new Request(`http://x/api/workboards/${board.id}/rev`);
  const first = await (await handleWorkboardApi(`/api/workboards/${board.id}/rev`, revReq(), ctxFor(db, userId)))!.json();
  expect(typeof first.rev).toBe("string");

  const unchanged = await (await handleWorkboardApi(`/api/workboards/${board.id}/rev`, revReq(), ctxFor(db, userId)))!.json();
  expect(unchanged.rev).toBe(first.rev);

  // Written straight through the facade — what `nova workboard card add` does from its own process.
  db.insertWorkboardCards(board.scope, userId, [{
    boardId: board.id, stageKey: "new", title: "From the CLI", fields: { company: "CLI Co" }, origin: "agent" as const,
  }]);
  const after = await (await handleWorkboardApi(`/api/workboards/${board.id}/rev`, revReq(), ctxFor(db, userId)))!.json();
  expect(after.rev).not.toBe(first.rev);
});

test("GET /api/workboards/:id/rev for a board this user cannot see is a 404", async () => {
  const { a, b } = seedTwoUsers();
  const res = await handleWorkboardApi(`/api/workboards/${b.board.id}/rev`,
    new Request(`http://x/api/workboards/${b.board.id}/rev`), ctxFor(a.db, a.userId));
  expect(res!.status).toBe(404);
});

test("DELETE /api/workboards/cards/:id archives the card and returns success", async () => {
  const { db, userId, board } = seed();
  const add = new Request(`http://x/api/workboards/${board.id}/cards`, {
    method: "POST", body: JSON.stringify({ stageKey: "new", fields: { company: "Acme" } }),
  });
  const added = await (await handleWorkboardApi(`/api/workboards/${board.id}/cards`, add, ctxFor(db, userId)))!.json();
  const cardId = added.cards[0].id;

  const cardsBefore = db.listWorkboardCards("personal", userId, board.id);
  expect(cardsBefore.some((c: any) => c.id === cardId)).toBe(true);

  const del = new Request(`http://x/api/workboards/cards/${cardId}`, { method: "DELETE" });
  const res = await handleWorkboardApi(`/api/workboards/cards/${cardId}`, del, ctxFor(db, userId));
  expect(res!.status).toBe(200);
  const body = await res!.json();
  expect(body.ok).toBe(true);

  const cardsAfter = db.listWorkboardCards("personal", userId, board.id);
  expect(cardsAfter.some((c: any) => c.id === cardId)).toBe(false);
});

test("a move into an armed stage reports the action as queued, not as running", async () => {
  const db = getDb();
  const u = db.upsertUser({ telegram_id: `wba-armed-${Date.now()}-${seq++}`, name: "Armed User", role: "admin" });
  const created = createBoard(db, u.id, {
    name: `armed-board-${Date.now()}-${seq++}`,
    reactive: true,
    fields: [{ key: "company", label: "Company", type: "text", required: true, primary: true }],
    stages: [
      { key: "new", label: "New", order: 0 },
      { key: "nurture", label: "Nurture", order: 1, onEnter: { agent: "orion", task: "Email {{card.company}}" } },
    ],
  });
  if (!created.ok) throw new Error(created.errors.join(", "));
  const board = created.value;
  const [card] = db.insertWorkboardCards(board.scope, u.id, [{
    boardId: board.id, stageKey: "new", title: "Acme", fields: { company: "Acme" }, origin: "user" as const,
  }]);

  const move = new Request(`http://x/api/workboards/cards/${card.id}/move`, {
    method: "POST", body: JSON.stringify({ toStage: "nurture" }),
  });
  const res = await handleWorkboardApi(`/api/workboards/cards/${card.id}/move`, move, ctxFor(db, u.id));
  expect(res!.status).toBe(200);
  const body = await res!.json();
  expect(body.firing).toBe("queued");
  expect(body.fires).toBe(true);
  expect(db.listPendingWorkboardActions(1000).some((r: any) => r.cardId === card.id)).toBe(true);
});

test("moving a card on a connector-bound board returns a pending push and records it in history", async () => {
  const { db, userId, board, card } = seedBound();
  const move = new Request(`http://x/api/workboards/cards/${card.id}/move`, {
    method: "POST", body: JSON.stringify({ toStage: "won" }),
  });
  const res = await handleWorkboardApi(`/api/workboards/cards/${card.id}/move`, move, ctxFor(db, userId));
  expect(res!.status).toBe(200);
  const body = await res!.json();
  expect(body.pendingPush).toEqual({
    connector: "hubspot", action: "update_contact",
    input: { id: "42", properties: { lifecycle: "customer" } },
  });

  const events = db.listWorkboardEvents(board.scope, userId, board.id, 10);
  const pushEvent = events.find((e: any) => e.kind === "sync" && e.cardId === card.id);
  expect(pushEvent).toBeTruthy();
  expect(pushEvent?.detail?.pendingPush).toEqual(body.pendingPush);
});

test("moving a card on an unbound board returns no pending push and adds no such history record", async () => {
  const { db, userId, board } = seedUnbound();
  const add = new Request(`http://x/api/workboards/${board.id}/cards`, {
    method: "POST", body: JSON.stringify({ stageKey: "new", fields: { company: "Acme" } }),
  });
  const added = await (await handleWorkboardApi(`/api/workboards/${board.id}/cards`, add, ctxFor(db, userId)))!.json();
  const cardId = added.cards[0].id;

  const move = new Request(`http://x/api/workboards/cards/${cardId}/move`, {
    method: "POST", body: JSON.stringify({ toStage: "won" }),
  });
  const res = await handleWorkboardApi(`/api/workboards/cards/${cardId}/move`, move, ctxFor(db, userId));
  expect(res!.status).toBe(200);
  const body = await res!.json();
  expect(body.pendingPush).toBe(null);

  const events = db.listWorkboardEvents(board.scope, userId, board.id, 10);
  expect(events.some((e: any) => e.kind === "sync")).toBe(false);
});

test("a card move never performs a connector call, even on a bound board — the connector would fail loudly if invoked", async () => {
  const spy = spyOn(connectorRegistry, "runConnectorAction").mockImplementation(async () => {
    throw new Error("a card move must never call a connector directly");
  });
  try {
    const { db, userId, card } = seedBound();
    const move = new Request(`http://x/api/workboards/cards/${card.id}/move`, {
      method: "POST", body: JSON.stringify({ toStage: "won" }),
    });
    const res = await handleWorkboardApi(`/api/workboards/cards/${card.id}/move`, move, ctxFor(db, userId));
    expect(res!.status).toBe(200);
    const body = await res!.json();
    expect(body.pendingPush).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

test("PATCH board with an additive field change backfills the new field as null on existing cards and leaves other values untouched", async () => {
  const { db, userId, board, card } = seedForSchemaEdit();
  const newFields = [...board.fields, { key: "owner", label: "Owner", type: "text" as const }];
  const req = new Request(`http://x/api/workboards/${board.id}`, {
    method: "PATCH", body: JSON.stringify({ fields: newFields }),
  });
  const res = await handleWorkboardApi(`/api/workboards/${board.id}`, req, ctxFor(db, userId));
  expect(res!.status).toBe(200);
  const body = await res!.json();
  expect(body.board.fields.map((f: any) => f.key)).toEqual(["company", "amount", "owner"]);

  const updatedCard = db.getWorkboardCard(board.scope, userId, card.id);
  expect(updatedCard?.fields.owner).toBe(null);
  expect(updatedCard?.fields.company).toBe("Acme");
  expect(updatedCard?.fields.amount).toBe(100);
});

test("PATCH board with a destructive field change and no confirm writes nothing at all", async () => {
  const { db, userId, board, card } = seedForSchemaEdit();
  const destructiveFields = board.fields.filter((f) => f.key !== "amount");
  const req = new Request(`http://x/api/workboards/${board.id}`, {
    method: "PATCH", body: JSON.stringify({ fields: destructiveFields }),
  });
  const res = await handleWorkboardApi(`/api/workboards/${board.id}`, req, ctxFor(db, userId));
  expect(res!.status).toBe(200);
  const body = await res!.json();
  expect(body.needsConfirm).toBe(true);
  expect(body.diff.removed).toEqual(["amount"]);

  const boardAfter = db.getWorkboardById(board.scope, userId, board.id);
  expect(boardAfter?.fields).toEqual(board.fields);
  const cardAfter = db.getWorkboardCard(board.scope, userId, card.id);
  expect(cardAfter?.fields).toEqual(card.fields);
});

test("PATCH board with a destructive field change and confirm proceeds, and the previous values are recoverable from the event log", async () => {
  const { db, userId, board, card } = seedForSchemaEdit();
  const destructiveFields = board.fields.filter((f) => f.key !== "amount");
  const req = new Request(`http://x/api/workboards/${board.id}`, {
    method: "PATCH", body: JSON.stringify({ fields: destructiveFields, confirm: true }),
  });
  const res = await handleWorkboardApi(`/api/workboards/${board.id}`, req, ctxFor(db, userId));
  expect(res!.status).toBe(200);
  const body = await res!.json();
  expect(body.board.fields.map((f: any) => f.key)).toEqual(["company"]);

  const events = db.listWorkboardEvents(board.scope, userId, board.id, 10);
  const schemaEvent = events.find((e: any) => e.kind === "updated" && e.detail?.diff?.removed?.includes("amount"));
  expect(schemaEvent).toBeTruthy();
  const preserved = schemaEvent?.detail?.preserved.find((p: any) => p.id === card.id);
  expect(preserved?.fields.amount).toBe(100);
  expect(preserved?.fields.company).toBe("Acme");
});

test("after a confirmed destructive field removal the cards are rewritten, so a card is still editable", async () => {
  const { db, userId, board, card } = seedForSchemaEdit();
  const destructiveFields = board.fields.filter((f) => f.key !== "amount");
  const editReq = new Request(`http://x/api/workboards/${board.id}`, {
    method: "PATCH", body: JSON.stringify({ fields: destructiveFields, confirm: true }),
  });
  expect((await handleWorkboardApi(`/api/workboards/${board.id}`, editReq, ctxFor(db, userId)))!.status).toBe(200);

  const rewritten = db.getWorkboardCard(board.scope, userId, card.id);
  expect(Object.keys(rewritten!.fields)).toEqual(["company"]);

  const patch = new Request(`http://x/api/workboards/cards/${card.id}`, {
    method: "PATCH", body: JSON.stringify({ fields: { company: "Acme Two" } }),
  });
  const res = await handleWorkboardApi(`/api/workboards/cards/${card.id}`, patch, ctxFor(db, userId));
  expect(res!.status).toBe(200);
  expect(db.getWorkboardCard(board.scope, userId, card.id)?.fields.company).toBe("Acme Two");
});

test("a retyped field whose stored value cannot coerce is nulled, not left poisoning every later edit", async () => {
  const { db, userId, board } = seedForSchemaEdit();
  const [card] = db.insertWorkboardCards(board.scope, userId, [{
    boardId: board.id, stageKey: "new", title: "Globex",
    fields: { company: "Globex", amount: "N/A" }, origin: "user" as const,
  }]);
  const retyped = board.fields.map((f) => (f.key === "amount" ? { ...f, type: "money" as const } : f));
  const asText = board.fields.map((f) => (f.key === "amount" ? { ...f, type: "text" as const } : f));
  // amount starts as money; retype to text and back so the stored "N/A" meets a type it can't take.
  const toText = new Request(`http://x/api/workboards/${board.id}`, {
    method: "PATCH", body: JSON.stringify({ fields: asText, confirm: true }),
  });
  expect((await handleWorkboardApi(`/api/workboards/${board.id}`, toText, ctxFor(db, userId)))!.status).toBe(200);
  const toMoney = new Request(`http://x/api/workboards/${board.id}`, {
    method: "PATCH", body: JSON.stringify({ fields: retyped, confirm: true }),
  });
  expect((await handleWorkboardApi(`/api/workboards/${board.id}`, toMoney, ctxFor(db, userId)))!.status).toBe(200);

  expect(db.getWorkboardCard(board.scope, userId, card.id)?.fields.amount).toBe(null);
  const patch = new Request(`http://x/api/workboards/cards/${card.id}`, {
    method: "PATCH", body: JSON.stringify({ fields: { amount: 50 } }),
  });
  const res = await handleWorkboardApi(`/api/workboards/cards/${card.id}`, patch, ctxFor(db, userId));
  expect(res!.status).toBe(200);
  expect(db.getWorkboardCard(board.scope, userId, card.id)?.fields.amount).toBe(50);
});

test("PATCH board with an invalid definition (duplicate stage keys) is refused with 400 and leaves the board unchanged", async () => {
  const { db, userId, board } = seedForSchemaEdit();
  const req = new Request(`http://x/api/workboards/${board.id}`, {
    method: "PATCH",
    body: JSON.stringify({ stages: [{ key: "new", label: "New", order: 0 }, { key: "new", label: "Also New", order: 1 }] }),
  });
  const res = await handleWorkboardApi(`/api/workboards/${board.id}`, req, ctxFor(db, userId));
  expect(res!.status).toBe(400);
  const body = await res!.json();
  expect(body.errors.join(" ")).toContain("duplicate stage key");
  const boardAfter = db.getWorkboardById(board.scope, userId, board.id);
  expect(boardAfter?.stages).toEqual(board.stages);
});

test("PATCH board with an invalid definition (empty field set) is refused with 400 and leaves the board unchanged", async () => {
  const { db, userId, board } = seedForSchemaEdit();
  const req = new Request(`http://x/api/workboards/${board.id}`, {
    method: "PATCH", body: JSON.stringify({ fields: [] }),
  });
  const res = await handleWorkboardApi(`/api/workboards/${board.id}`, req, ctxFor(db, userId));
  expect(res!.status).toBe(400);
  const body = await res!.json();
  expect(body.errors.join(" ")).toContain("at least one field");
  const boardAfter = db.getWorkboardById(board.scope, userId, board.id);
  expect(boardAfter?.fields).toEqual(board.fields);
});

test("PATCH board schema edit reaches archived cards too: additive backfill and destructive snapshot both include them", async () => {
  const { db, userId, board, card } = seedForSchemaEdit();
  const archived = db.updateWorkboardCard(board.scope, userId, card.id, { archived: true });
  expect(archived?.archived).toBe(true);

  const newFields = [...board.fields, { key: "owner", label: "Owner", type: "text" as const }];
  const addReq = new Request(`http://x/api/workboards/${board.id}`, {
    method: "PATCH", body: JSON.stringify({ fields: newFields }),
  });
  const addRes = await handleWorkboardApi(`/api/workboards/${board.id}`, addReq, ctxFor(db, userId));
  expect(addRes!.status).toBe(200);
  const afterAdd = db.listWorkboardCards(board.scope, userId, board.id, { includeArchived: true })
    .find((c) => c.id === card.id);
  expect(afterAdd?.archived).toBe(true);
  expect(afterAdd?.fields.owner).toBe(null);
  expect(afterAdd?.fields.amount).toBe(100);

  const destructiveFields = newFields.filter((f) => f.key !== "amount");
  const delReq = new Request(`http://x/api/workboards/${board.id}`, {
    method: "PATCH", body: JSON.stringify({ fields: destructiveFields, confirm: true }),
  });
  const delRes = await handleWorkboardApi(`/api/workboards/${board.id}`, delReq, ctxFor(db, userId));
  expect(delRes!.status).toBe(200);

  const events = db.listWorkboardEvents(board.scope, userId, board.id, 10);
  const schemaEvent = events.find((e: any) => e.kind === "updated" && e.detail?.diff?.removed?.includes("amount"));
  expect(schemaEvent).toBeTruthy();
  const preserved = schemaEvent?.detail?.preserved.find((p: any) => p.id === card.id);
  expect(preserved?.fields.amount).toBe(100);
  expect(preserved?.fields.company).toBe("Acme");
});

test("PATCH board schema edit pages through a board with more cards than a single page: every card is backfilled and every card is preserved", async () => {
  const { db, userId, board, card } = seedForSchemaEdit();
  const extraCount = SCHEMA_EDIT_PAGE_SIZE + 5;
  const inputs = Array.from({ length: extraCount }, (_, i) => ({
    boardId: board.id, stageKey: "new", title: `Card ${i}`,
    fields: { company: `Co ${i}`, amount: i }, origin: "user" as const,
  }));
  db.insertWorkboardCards(board.scope, userId, inputs);
  const totalCount = extraCount + 1; // +1 for seedForSchemaEdit's own card

  const newFields = [...board.fields, { key: "owner", label: "Owner", type: "text" as const }];
  const addReq = new Request(`http://x/api/workboards/${board.id}`, {
    method: "PATCH", body: JSON.stringify({ fields: newFields }),
  });
  const addRes = await handleWorkboardApi(`/api/workboards/${board.id}`, addReq, ctxFor(db, userId));
  expect(addRes!.status).toBe(200);
  const allCards = db.listWorkboardCards(board.scope, userId, board.id, { limit: totalCount + 10 });
  expect(allCards.length).toBe(totalCount);
  expect(allCards.every((c) => c.fields.owner === null)).toBe(true);

  const destructiveFields = newFields.filter((f) => f.key !== "amount");
  const delReq = new Request(`http://x/api/workboards/${board.id}`, {
    method: "PATCH", body: JSON.stringify({ fields: destructiveFields, confirm: true }),
  });
  const delRes = await handleWorkboardApi(`/api/workboards/${board.id}`, delReq, ctxFor(db, userId));
  expect(delRes!.status).toBe(200);

  const events = db.listWorkboardEvents(board.scope, userId, board.id, 10);
  const schemaEvent = events.find((e: any) => e.kind === "updated" && e.detail?.diff?.removed?.includes("amount"));
  expect(schemaEvent).toBeTruthy();
  expect(schemaEvent?.detail?.preserved.length).toBe(totalCount);
  const originalCardPreserved = schemaEvent?.detail?.preserved.find((p: any) => p.id === card.id);
  expect(originalCardPreserved?.fields.amount).toBe(100);
});
