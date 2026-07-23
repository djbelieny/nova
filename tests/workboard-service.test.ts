import { test, expect } from "bun:test";
import { getDb } from "../src/db.ts";
import { createBoard, addCards, moveCard, updateCard, archiveCard, toDef } from "../src/workboard-service.ts";
import { addListener, removeListener, type NovaEvent } from "../src/events.ts";
import { processMemoryIntents } from "../src/memory.ts";

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

// ── [WORKBOARD: …] intent tag → processMemoryIntents ──
// Integration coverage for the chat-authored board tag lives here (next to createBoard) since
// there's no dedicated intent-tag test file for src/memory.ts.

test("[WORKBOARD: …] creates the board, strips the tag, and confirms name/fields/stages/path", async () => {
  const { db, userId } = newUser();
  db.grantCapability(userId, "workboard.manage");
  const tag =
    "[WORKBOARD: wbtag-purchasing | Track purchase orders | " +
    "FIELDS: vendor:text*, po_number:text, amount:money, due_date:date, status:select(draft|sent|paid) | " +
    "STAGES: draft > sent > paid]";
  const response = `Setting that up now. ${tag} All done.`;

  const clean = await processMemoryIntents(db, response, userId);

  expect(clean).not.toContain("[WORKBOARD:");
  expect(clean).toContain("Setting that up now.");
  expect(clean).toContain("All done.");

  const board = db.findWorkboard(userId, "wbtag-purchasing");
  expect(board).not.toBeNull();
  if (!board) throw new Error("board not created");
  expect(board.fields.length).toBe(5);
  expect(board.stages.map((s) => s.key)).toEqual(["draft", "sent", "paid"]);
  expect(board.purpose).toBe("Track purchase orders");

  expect(clean).toContain("wbtag-purchasing");
  expect(clean).toContain("5 fields");
  expect(clean).toContain("Draft → Sent → Paid");
  expect(clean).toContain(`/workboards/${board.id}`);
});

test("[WORKBOARD: …] with a select field whose options contain pipes still creates a clean board", async () => {
  const { db, userId } = newUser();
  db.grantCapability(userId, "workboard.manage");
  const tag = "[WORKBOARD: wbtag-orders | Order tracker | FIELDS: name:text*, status:select(a|b|c|d) | STAGES: new > done]";

  const clean = await processMemoryIntents(db, tag, userId);

  const board = db.findWorkboard(userId, "wbtag-orders");
  expect(board).not.toBeNull();
  if (!board) throw new Error("board not created");
  expect(board.fields[1].options).toEqual(["a", "b", "c", "d"]);
  expect(clean).not.toContain("[WORKBOARD:");
});

test("[WORKBOARD: …] with an unknown field type still creates the board from the good fields, and reports the bad one", async () => {
  const { db, userId } = newUser();
  db.grantCapability(userId, "workboard.manage");
  const tag = "[WORKBOARD: wbtag-unknowntype | desc | FIELDS: name:text*, weird:frobnicate | STAGES: a > b]";

  const clean = await processMemoryIntents(db, tag, userId);

  const board = db.findWorkboard(userId, "wbtag-unknowntype");
  expect(board).not.toBeNull();
  if (!board) throw new Error("board not created");
  expect(board.fields.map((f) => f.key)).toEqual(["name"]);
  expect(clean).toContain("frobnicate");
});

test("[WORKBOARD: …] with a malformed field spec still creates the board from the surviving fields", async () => {
  const { db, userId } = newUser();
  db.grantCapability(userId, "workboard.manage");
  const tag = "[WORKBOARD: wbtag-malformed | desc | FIELDS: name:text*, ///not-a-field///, amount:money | STAGES: a > b]";

  const clean = await processMemoryIntents(db, tag, userId);

  const board = db.findWorkboard(userId, "wbtag-malformed");
  expect(board).not.toBeNull();
  if (!board) throw new Error("board not created");
  expect(board.fields.map((f) => f.key)).toEqual(["name", "amount"]);
  expect(clean).toContain("malformed field spec");
});

test("[WORKBOARD: …] for a name that already exists surfaces the createBoard rejection to the user", async () => {
  const { db, userId } = newUser();
  db.grantCapability(userId, "workboard.manage");
  const tag = "[WORKBOARD: wbtag-dup | desc | FIELDS: name:text* | STAGES: a > b]";

  const first = await processMemoryIntents(db, tag, userId);
  expect(first).toContain("wbtag-dup");
  expect(first).not.toContain("Couldn't create");

  const second = await processMemoryIntents(db, tag, userId);
  expect(second).toContain("Couldn't create");
  expect(second).toContain("already exists");
});

// ── [WORKBOARD: …] capability gate ──

test("[WORKBOARD: …] from a member without workboard.manage creates no board and tells them why", async () => {
  const { db, userId } = newUser();
  const tag = "[WORKBOARD: wbtag-nocap | desc | FIELDS: name:text* | STAGES: a > b]";

  const clean = await processMemoryIntents(db, tag, userId);

  expect(clean).not.toContain("[WORKBOARD:");
  expect(clean).toContain("Couldn't create");
  expect(clean).toContain("workboard.manage");
  expect(db.findWorkboard(userId, "wbtag-nocap")).toBeNull();
});

test("[WORKBOARD: …] from a member granted workboard.manage still succeeds", async () => {
  const { db, userId } = newUser();
  db.grantCapability(userId, "workboard.manage");
  const tag = "[WORKBOARD: wbtag-withcap | desc | FIELDS: name:text* | STAGES: a > b]";

  const clean = await processMemoryIntents(db, tag, userId);

  expect(clean).toContain("wbtag-withcap");
  expect(clean).not.toContain("Couldn't create");
  expect(db.findWorkboard(userId, "wbtag-withcap")).not.toBeNull();
});

test("[WORKBOARD: …] from an admin succeeds with no explicit grant — hasCapability passes admins implicitly", async () => {
  const db = getDb();
  const admin = db.upsertUser({ telegram_id: `wbs-admin-${Date.now()}-${seq++}`, name: "WBS Admin", role: "admin" });
  const tag = "[WORKBOARD: wbtag-admincap | desc | FIELDS: name:text* | STAGES: a > b]";

  const clean = await processMemoryIntents(db, tag, admin.id);

  expect(clean).toContain("wbtag-admincap");
  expect(clean).not.toContain("Couldn't create");
  expect(db.findWorkboard(admin.id, "wbtag-admincap")).not.toBeNull();
});

// ── [WORKBOARD: …] name/purpose extraction ──

test("[WORKBOARD: …] with purpose omitted parses name and fields/stages instead of swallowing them into purpose", async () => {
  const { db, userId } = newUser();
  db.grantCapability(userId, "workboard.manage");
  const tag = "[WORKBOARD: purchasing | FIELDS: vendor:text*, amount:money | STAGES: draft > sent > paid]";

  const clean = await processMemoryIntents(db, tag, userId);

  const board = db.findWorkboard(userId, "purchasing");
  expect(board).not.toBeNull();
  if (!board) throw new Error("board not created");
  expect(board.purpose).toBe(null);
  expect(board.fields.map((f) => f.key)).toEqual(["vendor", "amount"]);
  expect(board.stages.map((s) => s.key)).toEqual(["draft", "sent", "paid"]);
  expect(clean).not.toContain("Couldn't create");
});

test("[WORKBOARD: …] opening directly with FIELDS: is a reported error and creates no board", async () => {
  const { db, userId } = newUser();
  db.grantCapability(userId, "workboard.manage");
  const tag = "[WORKBOARD: FIELDS: vendor:text*, amount:money | STAGES: draft > sent > paid]";

  const clean = await processMemoryIntents(db, tag, userId);

  expect(clean).toContain("Couldn't create");
  expect(clean).toContain("board name is required");
  expect(clean).not.toContain("Created the");
});

test("[WORKBOARD: …] with an unrecognised section prefix reports it instead of silently dropping it", async () => {
  const { db, userId } = newUser();
  db.grantCapability(userId, "workboard.manage");
  const tag = "[WORKBOARD: wbtag-badsection | desc | FIELDS: name:text* | STAGES: a > b | COLUMNS: extra > stuff]";

  const clean = await processMemoryIntents(db, tag, userId);

  const board = db.findWorkboard(userId, "wbtag-badsection");
  expect(board).not.toBeNull();
  if (!board) throw new Error("board not created");
  expect(board.stages.map((s) => s.key)).toEqual(["a", "b"]);
  expect(clean).toContain("unrecognised section");
  expect(clean).toContain("COLUMNS");
});
