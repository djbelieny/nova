import { test, expect } from "bun:test";
import { getDb } from "../src/db.ts";
import { createBoard } from "../src/workboard-service.ts";
import { handleWorkboardApi } from "../src/dashboard-workboards.ts";

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

test("handleWorkboardApi returns null for unrelated paths", async () => {
  const { db, userId } = seed();
  const res = await handleWorkboardApi("/api/costs", new Request("http://x/api/costs"), ctxFor(db, userId));
  expect(res).toBe(null);
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
