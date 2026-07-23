import { test, expect } from "bun:test";
import { getDb } from "../src/db.ts";
import {
  TASK_STAGES,
  TICKET_STAGES,
  stageForTaskStatus,
  statusForTaskStage,
  stageForTicketStatus,
  statusForTicketStage,
  taskToCard,
  ticketToCard,
  getCardSource,
} from "../src/workboard-sources.ts";

let seq = 0;
function newUser() {
  const db = getDb();
  const u = db.upsertUser({ telegram_id: `wbsrc-${Date.now()}-${seq++}`, name: "WB Source User", role: "member" });
  return { db, userId: u.id };
}

test("task statuses map onto the four canonical stages", () => {
  expect(stageForTaskStatus("pending")).toBe("pending");
  expect(stageForTaskStatus("done")).toBe("completed");
  expect(stageForTaskStatus("failed")).toBe("blocked");
  expect(stageForTaskStatus("cancelled")).toBe("blocked");
  expect(stageForTaskStatus("nonsense")).toBe("pending");
});

test("stages map back onto storable task statuses", () => {
  expect(statusForTaskStage("completed")).toBe("done");
  expect(statusForTaskStage("blocked")).toBe("blocked");
  expect(statusForTaskStage("in_progress")).toBe("in_progress");
});

test("mapping a status to a stage and back is stable for the round trip", () => {
  for (const s of TASK_STAGES) {
    expect(stageForTaskStatus(statusForTaskStage(s.key))).toBe(s.key);
  }
});

test("taskToCard exposes the agent and description as card fields", () => {
  const card = taskToCard(
    { id: "t1", agent: "kai", description: "Write the brief", status: "in_progress", created_at: "2026-01-01", updated_at: "2026-01-02" },
    "board-1"
  );
  expect(card.id).toBe("t1");
  expect(card.stageKey).toBe("in_progress");
  expect(card.fields.agent).toBe("kai");
  expect(card.title).toBe("Write the brief");
});

test("getCardSource returns null for the local cards kind", () => {
  expect(getCardSource("cards")).toBe(null);
  expect(getCardSource("agent_tasks")).not.toBe(null);
});

test("ticket statuses map onto the real ticket-board columns, not a guessed set", () => {
  const keys = TICKET_STAGES.map((s) => s.key).sort();
  expect(keys).toEqual(["awaiting_approval", "done", "in_progress", "intake", "needs_attention"].sort());
  expect(stageForTicketStatus("new")).toBe("intake");
  expect(stageForTicketStatus("triaged")).toBe("intake");
  expect(stageForTicketStatus("resolving")).toBe("in_progress");
  expect(stageForTicketStatus("deployed")).toBe("done");
  expect(stageForTicketStatus("closed")).toBe("done");
  expect(stageForTicketStatus("escalated")).toBe("needs_attention");
  expect(stageForTicketStatus("something-unrecognized")).toBe("needs_attention");
});

test("ticket stages map back onto storable statuses and round-trip", () => {
  for (const s of TICKET_STAGES) {
    expect(stageForTicketStatus(statusForTicketStage(s.key))).toBe(s.key);
  }
});

test("ticketToCard exposes requester and subject as card fields", () => {
  const card = ticketToCard(
    { id: "tk1", subject: "Login broken", client_name: "Jane", client_email: "jane@acme.com", status: "resolving", created_at: "2026-01-01", updated_at: "2026-01-02" },
    "board-2"
  );
  expect(card.id).toBe("tk1");
  expect(card.stageKey).toBe("in_progress");
  expect(card.title).toBe("Login broken");
  expect(card.fields.requester).toBe("Jane");
});

test("agent_tasks adapter reads a real seeded task and maps status to stage", () => {
  const { db, userId } = newUser();
  const taskId = db.insertTask({ agent: "kai", description: "Ship the report", status: "in_progress", user_id: userId });
  const source = getCardSource("agent_tasks")!;
  const cards = source.readCards(db, userId, "board-x");
  const card = cards.find((c) => c.id === taskId);
  expect(card).toBeDefined();
  expect(card!.stageKey).toBe("in_progress");
  expect(card!.fields.agent).toBe("kai");
  expect(card!.title).toBe("Ship the report");
});

test("agent_tasks adapter applyMove writes through to the status column and round-trips on re-read", () => {
  const { db, userId } = newUser();
  const taskId = db.insertTask({ agent: "kai", description: "Ship it", status: "pending", user_id: userId });
  const source = getCardSource("agent_tasks")!;
  const ok = source.applyMove(db, userId, taskId, "completed");
  expect(ok).toBe(true);
  const card = source.readCards(db, userId, "board-x").find((c) => c.id === taskId)!;
  expect(card.stageKey).toBe("completed");
});

test("agent_tasks adapter applyMove returns false for a card that does not belong to the user", () => {
  const { db, userId } = newUser();
  const { userId: otherUserId } = newUser();
  const taskId = db.insertTask({ agent: "kai", description: "Ship it", status: "pending", user_id: userId });
  const source = getCardSource("agent_tasks")!;
  expect(source.applyMove(db, otherUserId, taskId, "completed")).toBe(false);
});

test("tickets adapter reads a real seeded ticket and maps status to stage", () => {
  const { db, userId } = newUser();
  const id = db.insertSupportTicket({
    user_id: userId, source: "resend", client_email: "a@client.com", client_name: "A Client",
    subject: "Help me", body_raw: "It is broken",
  });
  const source = getCardSource("tickets")!;
  const cards = source.readCards(db, userId, "board-y");
  const card = cards.find((c) => c.id === id)!;
  expect(card.stageKey).toBe("intake");
  expect(card.title).toBe("Help me");
  expect(card.fields.requester).toBe("A Client");
});

test("tickets adapter applyMove writes through to the status column and round-trips on re-read", () => {
  const { db, userId } = newUser();
  const id = db.insertSupportTicket({
    user_id: userId, source: "resend", client_email: "a@client.com", subject: "Help me", body_raw: "It is broken",
  });
  const source = getCardSource("tickets")!;
  const ok = source.applyMove(db, userId, id, "done");
  expect(ok).toBe(true);
  const card = source.readCards(db, userId, "board-y").find((c) => c.id === id)!;
  expect(card.stageKey).toBe("done");
});
