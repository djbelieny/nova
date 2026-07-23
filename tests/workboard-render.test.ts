import { test, expect } from "bun:test";
import { getDb } from "../src/db.ts";
import { createBoard, addCards } from "../src/workboard-service.ts";
import { boardPayload, renderWorkboard, renderWorkboardIndex, STAGE_CARD_LIMIT } from "../src/dashboard-workboards.ts";

let seq = 0;
function seed() {
  const db = getDb();
  const u = db.upsertUser({ telegram_id: `wbr-${Date.now()}-${seq++}`, name: "R User", role: "admin" });
  const created = createBoard(db, u.id, {
    name: "purchasing",
    fields: [
      { key: "vendor", label: "Vendor", type: "text", required: true, primary: true },
      { key: "amount", label: "Amount", type: "money" },
    ],
    stages: [{ key: "draft", label: "Draft", order: 0 }, { key: "sent", label: "Sent", order: 1 }],
  });
  if (!created.ok) throw new Error(created.errors.join(", "));
  addCards(db, u.id, created.value, "draft", [{ fields: { vendor: "Acme", amount: 1200 } }], "user");
  return { db, userId: u.id, board: created.value };
}

test("index page lists the board and its card count", () => {
  const { db, userId } = seed();
  const html = renderWorkboardIndex(db, userId);
  expect(html).toContain("purchasing");
  expect(html).toContain("Workboards");
});

test("board page renders a column per stage and the card title", () => {
  const { db, userId, board } = seed();
  const html = renderWorkboard(db, userId, board.id);
  expect(html).toContain("Draft");
  expect(html).toContain("Sent");
  expect(html).toContain("Acme");
});

test("board page shows a stage total for money fields", () => {
  const { db, userId, board } = seed();
  const html = renderWorkboard(db, userId, board.id);
  expect(html).toContain("1,200");
});

test("board page escapes card content", () => {
  const { db, userId, board } = seed();
  addCards(db, userId, board, "draft", [{ fields: { vendor: "<script>alert(1)</script>" } }], "user");
  const html = renderWorkboard(db, userId, board.id);
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(html).toContain("&lt;script&gt;");
});

test("a missing board renders a not-found page rather than throwing", () => {
  const { db, userId } = seed();
  expect(renderWorkboard(db, userId, "nope")).toContain("not found");
});

test("a stage whose cards sum to a genuine zero still renders a total", () => {
  const db = getDb();
  const u = db.upsertUser({ telegram_id: `wbr-zero-${Date.now()}-${seq++}`, name: "Zero User", role: "admin" });
  const created = createBoard(db, u.id, {
    name: "purchasing",
    fields: [
      { key: "vendor", label: "Vendor", type: "text", required: true, primary: true },
      { key: "amount", label: "Amount", type: "money" },
    ],
    stages: [{ key: "draft", label: "Draft", order: 0 }],
  });
  if (!created.ok) throw new Error(created.errors.join(", "));
  addCards(db, u.id, created.value, "draft", [{ fields: { vendor: "Acme", amount: 0 } }], "user");
  const html = renderWorkboard(db, u.id, created.value.id);
  // The stage header renders "<count><totalHtml>"; a real zero total must show as "0",
  // not silently disappear the way a falsy `total ? ... : ""` check would drop it.
  expect(html).toContain('<span class="total">0</span>');
});

test("a board with no numeric field renders no stage total", () => {
  const db = getDb();
  const u = db.upsertUser({ telegram_id: `wbr-nonum-${Date.now()}-${seq++}`, name: "NoNum User", role: "admin" });
  const created = createBoard(db, u.id, {
    name: "no-numeric-field",
    fields: [{ key: "vendor", label: "Vendor", type: "text", required: true, primary: true }],
    stages: [{ key: "draft", label: "Draft", order: 0 }],
  });
  if (!created.ok) throw new Error(created.errors.join(", "));
  addCards(db, u.id, created.value, "draft", [{ fields: { vendor: "Acme" } }], "user");
  const html = renderWorkboard(db, u.id, created.value.id);
  expect(html).not.toContain('<span class="total">');
});

test("a stage past the card cap still reports its true count and total, and a later stage is not starved of cards", () => {
  const { db, userId, board } = seed();
  const crowded = Array.from({ length: STAGE_CARD_LIMIT + 3 }, (_, i) => ({
    boardId: board.id, stageKey: "draft", title: `Draft ${i}`,
    fields: { vendor: `V${i}`, amount: 10 }, origin: "user" as const,
  }));
  db.insertWorkboardCards(board.scope, userId, crowded);
  db.insertWorkboardCards(board.scope, userId, [
    { boardId: board.id, stageKey: "sent", title: "Late One", fields: { vendor: "Late One", amount: 7 }, origin: "user" as const },
    { boardId: board.id, stageKey: "sent", title: "Late Two", fields: { vendor: "Late Two", amount: 3 }, origin: "user" as const },
  ]);

  const payload = boardPayload(db, userId, board);
  const draft = payload.stages.find((s) => s.key === "draft")!;
  const sent = payload.stages.find((s) => s.key === "sent")!;
  // seed() already added one 1,200 card to draft.
  expect(draft.count).toBe(STAGE_CARD_LIMIT + 4);
  expect(draft.shown).toBe(STAGE_CARD_LIMIT);
  expect(draft.total).toBe(1200 + (STAGE_CARD_LIMIT + 3) * 10);
  expect(sent.count).toBe(2);
  expect(payload.cards.sent.length).toBe(2);
  expect(sent.total).toBe(10);

  const html = renderWorkboard(db, userId, board.id);
  expect(html).toContain("Late One");
  expect(html).toContain("Late Two");
  expect(html).toContain(`Showing ${STAGE_CARD_LIMIT} of ${STAGE_CARD_LIMIT + 4}`);
});

test("index tiles count every card on a board, not just the first page", () => {
  const { db, userId, board } = seed();
  db.insertWorkboardCards(board.scope, userId, Array.from({ length: STAGE_CARD_LIMIT + 2 }, (_, i) => ({
    boardId: board.id, stageKey: "draft", title: `Draft ${i}`,
    fields: { vendor: `V${i}` }, origin: "user" as const,
  })));
  const html = renderWorkboardIndex(db, userId);
  expect(html).toContain(`${STAGE_CARD_LIMIT + 3} cards`);
});

test("client script guards a card against a second move while one is in flight", () => {
  const { db, userId, board } = seed();
  const html = renderWorkboard(db, userId, board.id);
  // NOTE: this only asserts the guard is present in the emitted string. The actual
  // dragstart/drop sequencing and rollback-on-rejection behavior are not exercised
  // here — the harness can't execute inline browser JS. Verified only by inspection.
  expect(html).toContain("dataset.moving");
  expect(html).toContain("card.setAttribute('draggable','false')");
  expect(html).toContain("classList.add('moving')");
  expect(html).toContain(".card.moving"); // CSS visual cue rule in SHELL_CSS
  // Guard is cleared on both the success and failure/catch paths of the move fetch.
  const inFlightClears = (html.match(/card\.removeAttribute\('data-moving'\)/g) || []).length;
  expect(inFlightClears).toBeGreaterThanOrEqual(2);
});

test("client script tells the truth about a queued stage action and a recorded connector write", () => {
  const { db, userId, board } = seed();
  const html = renderWorkboard(db, userId, board.id);
  expect(html).toContain("Stage action queued — the relay will run it shortly.");
  expect(html).toContain("recorded in board history");
  expect(html).not.toContain("needs approval in chat");
});

test("client script drop handler short-circuits a same-stage drop", () => {
  const { db, userId, board } = seed();
  const html = renderWorkboard(db, userId, board.id);
  expect(html).toContain("if(from===col)return;");
});

test("client script embeds this board's id and scopes SSE reloads to it", () => {
  const { db, userId, board } = seed();
  const html = renderWorkboard(db, userId, board.id);
  expect(html).toContain(`var BOARD_ID=${JSON.stringify(board.id)}`);
  expect(html).toContain("data.boardId!==BOARD_ID");
});

test("client script does not reload for the viewer's own just-applied move, and debounces bursts", () => {
  const { db, userId, board } = seed();
  const html = renderWorkboard(db, userId, board.id);
  expect(html).toContain("ownMoves[card.dataset.id]=Date.now()");
  expect(html).toContain("ownMoves[cardId]");
  expect(html).toContain("now-lastReload<3000");
});

test("a different board's id is not embedded in this board's script", () => {
  const { db, userId } = seed();
  const created2 = createBoard(db, userId, {
    name: "other-board",
    fields: [{ key: "vendor", label: "Vendor", type: "text", required: true, primary: true }],
    stages: [{ key: "draft", label: "Draft", order: 0 }],
  });
  if (!created2.ok) throw new Error(created2.errors.join(", "));
  const { board: board1 } = seed();
  const html = renderWorkboard(db, userId, created2.value.id);
  expect(html).not.toContain(board1.id);
});
