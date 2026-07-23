import { test, expect } from "bun:test";
import { getDb } from "../src/db.ts";
import { createBoard, addCards, moveCard, updateCard, archiveCard, toDef } from "../src/workboard-service.ts";
import { addListener, removeListener, type NovaEvent } from "../src/events.ts";

let seq = 0;
function newUser() {
  const db = getDb();
  const u = db.upsertUser({ telegram_id: `wbs-${Date.now()}-${seq++}`, name: "WBS User", role: "member" });
  return { db, userId: u.id };
}

const INPUT = {
  name: "leads",
  purpose: "Inbound leads",
  fields: [
    { key: "company", label: "Company", type: "text" as const, required: true, primary: true },
    { key: "score", label: "Score", type: "number" as const },
  ],
  stages: [
    { key: "new", label: "New", order: 0 },
    { key: "nurture", label: "Nurture", order: 1, onEnter: { playbook: "lead-follow-up" } },
  ],
  reactive: true,
};

function seed() {
  const { db, userId } = newUser();
  const created = createBoard(db, userId, INPUT);
  if (!created.ok) throw new Error(created.errors.join(", "));
  return { db, userId, board: created.value };
}

test("createBoard rejects a board whose stages are empty", () => {
  const { db, userId } = newUser();
  const r = createBoard(db, userId, { ...INPUT, stages: [] });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.join(" ")).toContain("stage");
});

test("createBoard rejects duplicate field keys", () => {
  const { db, userId } = newUser();
  const dup = [INPUT.fields[0], { ...INPUT.fields[0] }];
  const r = createBoard(db, userId, { ...INPUT, fields: dup });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.join(" ")).toContain("company");
});

test("addCards validates every record and writes none when one fails", () => {
  const { db, userId, board } = seed();
  const r = addCards(db, userId, board, "new", [
    { fields: { company: "Acme", score: 80 } },
    { fields: { score: 10 } },
  ], "agent");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.join(" ")).toContain("company");
  expect(db.listWorkboardCards("personal", userId, board.id).length).toBe(0);
});

test("addCards derives a title from the first primary field when none is given", () => {
  const { db, userId, board } = seed();
  const r = addCards(db, userId, board, "new", [{ fields: { company: "Acme", score: 80 } }], "agent");
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value[0].title).toBe("Acme");
});

test("addCards writes a created event per card", () => {
  const { db, userId, board } = seed();
  addCards(db, userId, board, "new", [{ fields: { company: "Acme" } }], "agent");
  const events = db.listWorkboardEvents("personal", userId, board.id);
  expect(events.some((e) => e.kind === "created")).toBe(true);
});

test("moveCard persists the stage, logs a moved event, and reports the onEnter action", () => {
  const { db, userId, board } = seed();
  const added = addCards(db, userId, board, "new", [{ fields: { company: "Acme" } }], "agent");
  if (!added.ok) throw new Error("setup failed");
  const r = moveCard(db, userId, board, added.value[0].id, "nurture", userId);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.value.card.stageKey).toBe("nurture");
    expect(r.value.fires).toEqual({ playbook: "lead-follow-up" });
  }
  const events = db.listWorkboardEvents("personal", userId, board.id);
  expect(events[0].kind).toBe("moved");
});

test("moveCard to an unknown stage fails and leaves the card where it was", () => {
  const { db, userId, board } = seed();
  const added = addCards(db, userId, board, "new", [{ fields: { company: "Acme" } }], "agent");
  if (!added.ok) throw new Error("setup failed");
  const r = moveCard(db, userId, board, added.value[0].id, "ghost", userId);
  expect(r.ok).toBe(false);
  expect(db.getWorkboardCard("personal", userId, added.value[0].id)?.stageKey).toBe("new");
});

test("toDef maps a stored board onto the pure-logic shape", () => {
  const { board } = seed();
  const def = toDef(board);
  expect(def.reactive).toBe(true);
  expect(def.stages.length).toBe(2);
});

test("moveCard with no beforeId/afterId appends the card to the end of its new stage", () => {
  const { db, userId, board } = seed();
  const existing = addCards(db, userId, board, "nurture", [
    { fields: { company: "Existing A" } },
    { fields: { company: "Existing B" } },
  ], "agent");
  if (!existing.ok) throw new Error("setup failed");

  const moving = addCards(db, userId, board, "new", [{ fields: { company: "Moving In" } }], "agent");
  if (!moving.ok) throw new Error("setup failed");

  const r = moveCard(db, userId, board, moving.value[0].id, "nurture", userId);
  expect(r.ok).toBe(true);

  const cards = db.listWorkboardCards("personal", userId, board.id, { stageKey: "nurture" });
  expect(cards.length).toBe(3);
  expect(cards[cards.length - 1].id).toBe(moving.value[0].id);
});

test("moveCard with an explicit beforeId/afterId hint still slots between those neighbours", () => {
  const { db, userId, board } = seed();
  const existing = addCards(db, userId, board, "nurture", [
    { fields: { company: "Existing A" } },
    { fields: { company: "Existing B" } },
  ], "agent");
  if (!existing.ok) throw new Error("setup failed");
  const [cardA, cardB] = existing.value;

  const moving = addCards(db, userId, board, "new", [{ fields: { company: "Moving In" } }], "agent");
  if (!moving.ok) throw new Error("setup failed");

  const r = moveCard(db, userId, board, moving.value[0].id, "nurture", userId, {
    beforeId: cardA.id, afterId: cardB.id,
  });
  expect(r.ok).toBe(true);

  const cards = db.listWorkboardCards("personal", userId, board.id, { stageKey: "nurture" });
  const ids = cards.map((c) => c.id);
  const idxA = ids.indexOf(cardA.id);
  const idxB = ids.indexOf(cardB.id);
  const idxMoved = ids.indexOf(moving.value[0].id);
  expect(idxMoved).toBeGreaterThan(idxA);
  expect(idxMoved).toBeLessThan(idxB);
});

test("addCards emits one workboard.cards.created event per batch, not one per card", () => {
  const { db, userId, board } = seed();
  const events: NovaEvent[] = [];
  const listener = (e: NovaEvent) => events.push(e);
  addListener(listener);
  try {
    const r = addCards(db, userId, board, "new", [
      { fields: { company: "Acme" } },
      { fields: { company: "Globex" } },
      { fields: { company: "Initech" } },
    ], "agent");
    expect(r.ok).toBe(true);
    const created = events.filter((e) => e.type === "workboard.cards.created");
    expect(created.length).toBe(1);
    expect(created[0].data.boardId).toBe(board.id);
    expect(created[0].data.count).toBe(3);
    expect(created[0].level).toBe("info");
    expect(created[0].userId).toBe(userId);
  } finally {
    removeListener(listener);
  }
});

test("moveCard emits a workboard.card.moved event with boardId and cardId", () => {
  const { db, userId, board } = seed();
  const added = addCards(db, userId, board, "new", [{ fields: { company: "Acme" } }], "agent");
  if (!added.ok) throw new Error("setup failed");

  const events: NovaEvent[] = [];
  const listener = (e: NovaEvent) => events.push(e);
  addListener(listener);
  try {
    const r = moveCard(db, userId, board, added.value[0].id, "nurture", userId);
    expect(r.ok).toBe(true);
    const moved = events.filter((e) => e.type === "workboard.card.moved");
    expect(moved.length).toBe(1);
    expect(moved[0].data.boardId).toBe(board.id);
    expect(moved[0].data.cardId).toBe(added.value[0].id);
    expect(moved[0].level).toBe("info");
    expect(moved[0].userId).toBe(userId);
  } finally {
    removeListener(listener);
  }
});

test("updateCard persists the fields, logs an updated event, and emits workboard.card.updated", () => {
  const { db, userId, board } = seed();
  const added = addCards(db, userId, board, "new", [{ fields: { company: "Acme", score: 10 } }], "agent");
  if (!added.ok) throw new Error("setup failed");
  const card = added.value[0];

  const events: NovaEvent[] = [];
  const listener = (e: NovaEvent) => events.push(e);
  addListener(listener);
  try {
    const r = updateCard(db, userId, board, card, { fields: { score: 90 } }, userId);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.fields.score).toBe(90);

    const dbEvents = db.listWorkboardEvents("personal", userId, board.id);
    expect(dbEvents.some((e) => e.kind === "updated")).toBe(true);

    const updated = events.filter((e) => e.type === "workboard.card.updated");
    expect(updated.length).toBe(1);
    expect(updated[0].data.boardId).toBe(board.id);
    expect(updated[0].data.cardId).toBe(card.id);
    expect(updated[0].level).toBe("info");
    expect(updated[0].userId).toBe(userId);
  } finally {
    removeListener(listener);
  }
});

test("archiveCard fails when the card does not exist and writes no event", () => {
  const { db, userId, board } = seed();
  const fakeCardId = "nonexistent-card-id";

  const events: NovaEvent[] = [];
  const listener = (e: NovaEvent) => events.push(e);
  addListener(listener);
  try {
    const r = archiveCard(db, userId, board, fakeCardId, userId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain("failed to archive card");

    const dbEvents = db.listWorkboardEvents("personal", userId, board.id);
    expect(dbEvents.some((e) => e.kind === "archived")).toBe(false);

    const archived = events.filter((e) => e.type === "workboard.card.updated" && e.data.archived);
    expect(archived.length).toBe(0);
  } finally {
    removeListener(listener);
  }
});
