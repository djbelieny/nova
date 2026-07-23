import { test, expect } from "bun:test";
import { getDb } from "../src/db.ts";
import { createBoard, addCards, moveCard, toDef } from "../src/workboard-service.ts";

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
