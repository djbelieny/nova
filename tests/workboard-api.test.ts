import { test, expect, spyOn } from "bun:test";
import { getDb } from "../src/db.ts";
import { createBoard } from "../src/workboard-service.ts";
import { handleWorkboardApi } from "../src/dashboard-workboards.ts";
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
