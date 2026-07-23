import { test, expect } from "bun:test";
import { getDb } from "../src/db.ts";
import { createBoard, addCards } from "../src/workboard-service.ts";
import { renderWorkboard, renderWorkboardIndex } from "../src/dashboard-workboards.ts";

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
