import { test, expect } from "bun:test";
import { getDb } from "../src/db.ts";
import { addCards, createBoard, moveCard } from "../src/workboard-service.ts";
import { buildOnEnterDispatch, cardScope, fireOnEnter, onEnterKey } from "../src/workboard-reactive.ts";

let seq = 0;
function seed(reactive = true) {
  const db = getDb();
  const u = db.upsertUser({ telegram_id: `wbf-${Date.now()}-${seq++}`, name: "F User", role: "admin" });
  const created = createBoard(db, u.id, {
    name: "leads-reactive",
    fields: [
      { key: "company", label: "Company", type: "text", required: true, primary: true },
      { key: "email", label: "Email", type: "email" },
    ],
    stages: [
      { key: "new", label: "New", order: 0 },
      { key: "nurture", label: "Nurture", order: 1, onEnter: { agent: "orion", task: "Email {{card.company}} at {{card.email}}" } },
    ],
    reactive,
  });
  if (!created.ok) throw new Error(created.errors.join(", "));
  const added = addCards(db, u.id, created.value, "new", [{ fields: { company: "Acme", email: "a@acme.com" } }], "agent");
  if (!added.ok) throw new Error(added.errors.join(", "));
  return { db, userId: u.id, board: created.value, card: added.value[0] };
}

test("cardScope exposes fields, title, and id under card.*", () => {
  const { card } = seed();
  const scope = cardScope(card);
  expect(scope.card.company).toBe("Acme");
  expect(scope.card.title).toBe("Acme");
  expect(scope.card.id).toBe(card.id);
});

test("buildOnEnterDispatch renders an agent task from card fields", () => {
  const { card } = seed();
  const d = buildOnEnterDispatch({ agent: "orion", task: "Email {{card.company}} at {{card.email}}" }, card, () => null);
  expect("skip" in d).toBe(false);
  if (!("skip" in d)) {
    expect(d.agentSlug).toBe("orion");
    expect(d.taskDescription).toBe("Email Acme at a@acme.com");
  }
});

test("buildOnEnterDispatch skips when a named playbook does not exist", () => {
  const { card } = seed();
  const d = buildOnEnterDispatch({ playbook: "ghost" }, card, () => null);
  expect("skip" in d).toBe(true);
});

test("onEnterKey changes when the card is edited", () => {
  const { db, userId, card } = seed();
  const before = onEnterKey(card, "nurture");
  const edited = db.updateWorkboardCard("personal", userId, card.id, { title: "Acme Corp" })!;
  expect(onEnterKey(edited, "nurture")).not.toBe(before);
});

test("fireOnEnter dispatches once and records a fired event", async () => {
  const { db, userId, board, card } = seed();
  const calls: any[] = [];
  const dispatch = async (uid: string, agent: string, task: string) => { calls.push({ uid, agent, task }); return "task-1"; };
  const r = await fireOnEnter(db, userId, board, card, { agent: "orion", task: "Email {{card.company}}" }, dispatch);
  expect(r.fired).toBe(true);
  expect(calls[0].agent).toBe("orion");
  expect(calls[0].task).toBe("Email Acme");
  expect(db.listWorkboardEvents("personal", userId, board.id).some((e) => e.kind === "fired")).toBe(true);
});

test("fireOnEnter is idempotent for the same card, stage, and revision", async () => {
  const { db, userId, board, card } = seed();
  let n = 0;
  const dispatch = async () => { n++; return "task-1"; };
  const action = { agent: "orion", task: "Email {{card.company}}" };
  await fireOnEnter(db, userId, board, card, action, dispatch);
  const second = await fireOnEnter(db, userId, board, card, action, dispatch);
  expect(n).toBe(1);
  expect(second.fired).toBe(false);
  expect(second.reason).toBe("deduped");
});

test("a failed dispatch dead-letters and leaves the card in its new stage", async () => {
  const { db, userId, board, card } = seed();
  const dispatch = async () => { throw new Error("provider down"); };
  const r = await fireOnEnter(db, userId, board, card, { agent: "orion", task: "x" }, dispatch);
  expect(r.fired).toBe(false);
  expect(db.listDeadLetters(userId).some((d: any) => d.kind === "workboard")).toBe(true);
});

test("loop guard end to end: an onEnter-originated move does not fire again", () => {
  const { db, userId, board, card } = seed();
  const r = moveCard(db, userId, board, card.id, "nurture", "automation", { actorIsOnEnter: true });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.fires).toBe(null);
});
