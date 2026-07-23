import { test, expect } from "bun:test";
import { getDb } from "../src/db.ts";

let seq = 0;
function newUser() {
  const db = getDb();
  const u = db.upsertUser({ telegram_id: `wb-${Date.now()}-${seq++}`, name: "WB User", role: "member" });
  return { db, userId: u.id };
}

const FIELDS = [
  { key: "company", label: "Company", type: "text" as const, required: true, primary: true },
  { key: "score", label: "Score", type: "number" as const },
];
const STAGES = [
  { key: "new", label: "New", order: 0 },
  { key: "qualified", label: "Qualified", order: 1 },
];

function seedBoard() {
  const { db, userId } = newUser();
  const board = db.insertWorkboard({
    scope: "personal", userId, name: "leads", purpose: "Inbound leads",
    source: "cards", fields: FIELDS, stages: STAGES, reactive: false,
  });
  return { db, userId, board };
}

test("insertWorkboard round-trips fields and stages as parsed JSON", () => {
  const { db, userId, board } = seedBoard();
  const got = db.getWorkboardById("personal", userId, board.id);
  expect(got?.name).toBe("leads");
  expect(got?.fields[0].key).toBe("company");
  expect(got?.stages[1].label).toBe("Qualified");
  expect(got?.reactive).toBe(false);
});

test("findWorkboard resolves by name for the owning user", () => {
  const { db, userId } = seedBoard();
  expect(db.findWorkboard(userId, "leads")?.name).toBe("leads");
  expect(db.findWorkboard(userId, "missing")).toBe(null);
});

test("insertWorkboardCards writes many cards and listWorkboardCards filters by stage", () => {
  const { db, userId, board } = seedBoard();
  db.insertWorkboardCards("personal", userId, [
    { boardId: board.id, stageKey: "new", title: "Acme", fields: { company: "Acme", score: 80 }, origin: "agent" },
    { boardId: board.id, stageKey: "new", title: "Globex", fields: { company: "Globex", score: 40 }, origin: "agent" },
    { boardId: board.id, stageKey: "qualified", title: "Initech", fields: { company: "Initech", score: 95 }, origin: "agent" },
  ]);
  expect(db.listWorkboardCards("personal", userId, board.id).length).toBe(3);
  expect(db.listWorkboardCards("personal", userId, board.id, { stageKey: "new" }).length).toBe(2);
});

test("updateWorkboardCard moves a card and bumps updated_at", () => {
  const { db, userId, board } = seedBoard();
  const card = db.insertWorkboardCard("personal", userId, {
    boardId: board.id, stageKey: "new", title: "Acme", fields: { company: "Acme", score: 1 }, origin: "user",
  });
  const moved = db.updateWorkboardCard("personal", userId, card.id, { stageKey: "qualified" });
  expect(moved?.stageKey).toBe("qualified");
  expect(db.listWorkboardCards("personal", userId, board.id, { stageKey: "new" }).length).toBe(0);
});

test("archived cards are excluded from listWorkboardCards", () => {
  const { db, userId, board } = seedBoard();
  const card = db.insertWorkboardCard("personal", userId, {
    boardId: board.id, stageKey: "new", title: "Acme", fields: { company: "Acme" }, origin: "user",
  });
  db.updateWorkboardCard("personal", userId, card.id, { archived: true });
  expect(db.listWorkboardCards("personal", userId, board.id).length).toBe(0);
});

test("workboard events append and read back newest first", () => {
  const { db, userId, board } = seedBoard();
  db.insertWorkboardEvent("personal", userId, {
    boardId: board.id, cardId: "c1", kind: "moved", fromStage: "new", toStage: "qualified", actor: userId,
  });
  const events = db.listWorkboardEvents("personal", userId, board.id);
  expect(events.length).toBe(1);
  expect(events[0].kind).toBe("moved");
  expect(events[0].toStage).toBe("qualified");
});

test("two different users can each create a personal board named 'leads'", () => {
  const { db, userId: userA } = newUser();
  const { userId: userB } = newUser();
  const boardA = db.insertWorkboard({
    scope: "personal", userId: userA, name: "leads", purpose: "Inbound leads",
    source: "cards", fields: FIELDS, stages: STAGES, reactive: false,
  });
  const boardB = db.insertWorkboard({
    scope: "personal", userId: userB, name: "leads", purpose: "Inbound leads",
    source: "cards", fields: FIELDS, stages: STAGES, reactive: false,
  });
  expect(boardA.name).toBe("leads");
  expect(boardB.name).toBe("leads");
  expect(boardA.id).not.toBe(boardB.id);
});

// A team board lives in shared.db and findWorkboard matches it by name alone, for every user —
// so a fixed name left behind here would shadow that name for every later test and every real
// user of a reused data directory. Unique per run, and removed once the assertion is made.
test("two different users cannot both create a team board of the same name", () => {
  const { db, userId: userA } = newUser();
  const { userId: userB } = newUser();
  const name = `team-dupe-${Date.now()}-${seq++}`;
  const board = db.insertWorkboard({
    scope: "team", userId: userA, name, purpose: "Inbound leads",
    source: "cards", fields: FIELDS, stages: STAGES, reactive: false,
  });
  try {
    expect(() => db.insertWorkboard({
      scope: "team", userId: userB, name, purpose: "Inbound leads",
      source: "cards", fields: FIELDS, stages: STAGES, reactive: false,
    })).toThrow();
  } finally {
    db.deleteWorkboard("team", userA, board.id);
  }
  expect(db.findWorkboard(userB, name)).toBe(null);
});
