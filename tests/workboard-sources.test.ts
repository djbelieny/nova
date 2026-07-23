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
  boardCardCount,
  ADAPTER_CARD_LIMIT,
} from "../src/workboard-sources.ts";
import { ensureSystemBoards } from "../src/workboard-service.ts";
import { boardPayload, handleWorkboardApi, renderWorkboard } from "../src/dashboard-workboards.ts";

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

test("tickets adapter applyMove returns false and writes nothing for a ticket that does not exist", () => {
  const { db, userId } = newUser();
  const source = getCardSource("tickets")!;
  expect(source.applyMove(db, userId, "nonexistent-ticket-id", "done")).toBe(false);
});

test("tickets adapter applyMove returns false and writes nothing for a ticket owned by another user", () => {
  const { db, userId } = newUser();
  const { userId: otherUserId } = newUser();
  const id = db.insertSupportTicket({
    user_id: userId, source: "resend", client_email: "a@client.com", subject: "Mine only", body_raw: "private",
  });
  const source = getCardSource("tickets")!;
  expect(source.applyMove(db, otherUserId, id, "done")).toBe(false);
  const ticket = db.getSupportTicket(userId, id)!;
  expect(ticket.status).toBe("new");
});

test("tickets adapter keeps a non-canonical in-progress status when moved into the stage it already occupies", () => {
  const { db, userId } = newUser();
  const id = db.insertSupportTicket({
    user_id: userId, source: "resend", client_email: "a@client.com", subject: "Broken again", body_raw: "still broken",
  });
  db.updateSupportTicket(userId, id, { status: "fixing" });
  const source = getCardSource("tickets")!;
  const ok = source.applyMove(db, userId, id, "in_progress");
  expect(ok).toBe(true);
  const ticket = db.getSupportTicket(userId, id)!;
  expect(ticket.status).toBe("fixing");
});

test("tickets adapter keeps a non-canonical needs_attention status when reordered within the same stage", () => {
  const { db, userId } = newUser();
  const id = db.insertSupportTicket({
    user_id: userId, source: "resend", client_email: "a@client.com", subject: "On fire", body_raw: "urgent",
  });
  db.updateSupportTicket(userId, id, { status: "failed" });
  const source = getCardSource("tickets")!;
  const ok = source.applyMove(db, userId, id, "needs_attention");
  expect(ok).toBe(true);
  const ticket = db.getSupportTicket(userId, id)!;
  expect(ticket.status).toBe("failed");
});

test("tickets adapter overwrites status with the column's canonical value on a genuine stage change", () => {
  const { db, userId } = newUser();
  const id = db.insertSupportTicket({
    user_id: userId, source: "resend", client_email: "a@client.com", subject: "Broken again", body_raw: "still broken",
  });
  db.updateSupportTicket(userId, id, { status: "fixing" });
  const source = getCardSource("tickets")!;
  const ok = source.applyMove(db, userId, id, "done");
  expect(ok).toBe(true);
  const ticket = db.getSupportTicket(userId, id)!;
  expect(ticket.status).toBe("deployed");
});

test("tickets adapter applyMove falls back to the first column's status for an unrecognized target stage (pinned behavior)", () => {
  const { db, userId } = newUser();
  const id = db.insertSupportTicket({
    user_id: userId, source: "resend", client_email: "a@client.com", subject: "Help me", body_raw: "It is broken",
  });
  db.updateSupportTicket(userId, id, { status: "resolving" });
  const source = getCardSource("tickets")!;
  const ok = source.applyMove(db, userId, id, "not-a-real-stage");
  expect(ok).toBe(true);
  const ticket = db.getSupportTicket(userId, id)!;
  expect(ticket.status).toBe("new");
});

test("agent_tasks adapter keeps a non-canonical blocked status when reordered within the same stage", () => {
  const { db, userId } = newUser();
  const taskId = db.insertTask({ agent: "kai", description: "Retry the deploy", status: "cancelled", user_id: userId });
  const source = getCardSource("agent_tasks")!;
  const ok = source.applyMove(db, userId, taskId, "blocked");
  expect(ok).toBe(true);
  const task = db.getTaskById(taskId, userId)!;
  expect(task.status).toBe("cancelled");
});

test("agent_tasks adapter overwrites status with the column's canonical value on a genuine stage change", () => {
  const { db, userId } = newUser();
  const taskId = db.insertTask({ agent: "kai", description: "Retry the deploy", status: "cancelled", user_id: userId });
  const source = getCardSource("agent_tasks")!;
  const ok = source.applyMove(db, userId, taskId, "completed");
  expect(ok).toBe(true);
  const task = db.getTaskById(taskId, userId)!;
  expect(task.status).toBe("done");
});

test("agent_tasks adapter applyMove falls back to pending status for an unrecognized target stage (pinned behavior)", () => {
  const { db, userId } = newUser();
  const taskId = db.insertTask({ agent: "kai", description: "Ship it", status: "in_progress", user_id: userId });
  const source = getCardSource("agent_tasks")!;
  const ok = source.applyMove(db, userId, taskId, "not-a-real-stage");
  expect(ok).toBe(true);
  const task = db.getTaskById(taskId, userId)!;
  expect(task.status).toBe("pending");
});

function newAdmin() {
  const db = getDb();
  const u = db.upsertUser({ telegram_id: `wbp-${Date.now()}-${seq++}`, name: "P User", role: "admin" });
  return { db, userId: u.id };
}

test("ensureSystemBoards creates both boards and is idempotent", () => {
  const { db, userId } = newAdmin();
  const first = ensureSystemBoards(db, userId);
  const second = ensureSystemBoards(db, userId);
  expect(second.tasks.id).toBe(first.tasks.id);
  expect(second.tickets.id).toBe(first.tickets.id);
  expect(first.tasks.system).toBe(true);
  expect(first.tickets.system).toBe(true);
});

test("a ported board's payload uses the adapter's stages", () => {
  const { db, userId } = newAdmin();
  const { tasks } = ensureSystemBoards(db, userId);
  const payload = boardPayload(db, userId, tasks);
  expect(payload.stages.map((s: any) => s.key)).toEqual(["pending", "in_progress", "completed", "blocked"]);
});

test("an adapter counts its own table per stage, so a stage past the read cap can say what it is hiding", () => {
  const { db, userId } = newAdmin();
  const { tasks } = ensureSystemBoards(db, userId);
  const total = ADAPTER_CARD_LIMIT + 3;
  for (let i = 0; i < total; i++) {
    db.insertTask({ agent: "kai", description: `Task ${i}`, status: "pending", user_id: userId });
  }

  const payload = boardPayload(db, userId, tasks);
  const pending = payload.stages.find((s: any) => s.key === "pending")!;
  expect(pending.count).toBe(total);
  expect(pending.shown).toBe(ADAPTER_CARD_LIMIT);
  expect(boardCardCount(db, userId, tasks)).toBe(total);

  const html = renderWorkboard(db, userId, tasks.id);
  expect(html).toContain(`Showing ${ADAPTER_CARD_LIMIT} of ${total}`);
  // `nova workboard query` reads workboard_cards, so it cannot show the rest of this board.
  expect(html).not.toContain("nova workboard query");
});

test("a ticket adapter's stage counts fold raw statuses the same way its cards do", () => {
  const { db, userId } = newAdmin();
  const { tickets } = ensureSystemBoards(db, userId);
  for (const status of ["new", "triaged", "resolving", "deployed"]) {
    const id = db.insertSupportTicket({
      user_id: userId, source: "resend", client_email: "a@client.com", subject: `S ${status}`, body_raw: "x",
    });
    db.updateSupportTicket(userId, id, { status });
  }
  const counts = getCardSource("tickets")!.countByStage(db, userId);
  expect(counts.intake).toBe(2); // new + triaged both fold into intake
  expect(counts.in_progress).toBe(1);
  expect(counts.done).toBe(1);
  expect(boardCardCount(db, userId, tickets)).toBe(4);
});

test("moving a system board card through the API writes to the task's status column, not a workboard card", async () => {
  const { db, userId } = newAdmin();
  const { tasks } = ensureSystemBoards(db, userId);
  const taskId = db.insertTask({ agent: "kai", description: "Ship it", status: "pending", user_id: userId });

  const req = new Request(`http://x/api/workboards/cards/${taskId}/move`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ toStage: "completed" }),
  });
  const res = await handleWorkboardApi(`/api/workboards/cards/${taskId}/move`, req, { db, userId, actorId: userId });
  expect(res!.status).toBe(200);
  const body = await res!.json();
  expect(body.card.stageKey).toBe("completed");

  const task = db.getTaskById(taskId, userId)!;
  expect(task.status).toBe("done");
  expect(db.listWorkboardCards(tasks.scope, userId, tasks.id).length).toBe(0);
});

test("moving a system board card through the API writes to the ticket's status column, not a workboard card", async () => {
  const { db, userId } = newAdmin();
  const { tickets } = ensureSystemBoards(db, userId);
  const ticketId = db.insertSupportTicket({
    user_id: userId, source: "resend", client_email: "a@client.com", subject: "Help me", body_raw: "It is broken",
  });

  const req = new Request(`http://x/api/workboards/cards/${ticketId}/move`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ toStage: "done" }),
  });
  const res = await handleWorkboardApi(`/api/workboards/cards/${ticketId}/move`, req, { db, userId, actorId: userId });
  expect(res!.status).toBe(200);
  const body = await res!.json();
  expect(body.card.stageKey).toBe("done");

  const ticket = db.getSupportTicket(userId, ticketId)!;
  expect(ticket.status).toBe("deployed");
  expect(db.listWorkboardCards(tickets.scope, userId, tickets.id).length).toBe(0);
});

test("moving a system board card to a stage the board does not have is refused, leaving the ticket alone", async () => {
  const { db, userId } = newAdmin();
  ensureSystemBoards(db, userId);
  const ticketId = db.insertSupportTicket({
    user_id: userId, source: "resend", client_email: "a@client.com", subject: "Closed one", body_raw: "Fixed",
  });
  db.updateSupportTicket(userId, ticketId, { status: "deployed" });

  const req = new Request(`http://x/api/workboards/cards/${ticketId}/move`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ toStage: "resolved" }),
  });
  const res = await handleWorkboardApi(`/api/workboards/cards/${ticketId}/move`, req, { db, userId, actorId: userId });
  expect(res!.status).toBe(400);
  const body = await res!.json();
  expect(body.errors.join(" ")).toContain('unknown stage "resolved"');
  expect(db.getSupportTicket(userId, ticketId)!.status).toBe("deployed");
});

test("moving an agent-task card to a stage the board does not have is refused, leaving the task alone", async () => {
  const { db, userId } = newAdmin();
  ensureSystemBoards(db, userId);
  const taskId = db.insertTask({ agent: "kai", description: "Ship it", status: "done", user_id: userId });

  const req = new Request(`http://x/api/workboards/cards/${taskId}/move`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ toStage: "archived" }),
  });
  const res = await handleWorkboardApi(`/api/workboards/cards/${taskId}/move`, req, { db, userId, actorId: userId });
  expect(res!.status).toBe(400);
  expect(db.getTaskById(taskId, userId)!.status).toBe("done");
});

test("a schema-edit attempt against a system board is refused", async () => {
  const { db, userId } = newAdmin();
  const { tasks } = ensureSystemBoards(db, userId);

  const req = new Request(`http://x/api/workboards/${tasks.id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "renamed-board" }),
  });
  const res = await handleWorkboardApi(`/api/workboards/${tasks.id}`, req, { db, userId, actorId: userId });
  expect(res!.status).toBe(400);
  const body = await res!.json();
  expect(body.errors.join(" ")).toMatch(/locked/);
});

test("adding a card directly to a system board is refused and writes no workboard_cards row", async () => {
  const { db, userId } = newAdmin();
  const { tasks } = ensureSystemBoards(db, userId);

  const req = new Request(`http://x/api/workboards/${tasks.id}/cards`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stageKey: "pending", fields: { agent: "kai", description: "Sneak in" } }),
  });
  const res = await handleWorkboardApi(`/api/workboards/${tasks.id}/cards`, req, { db, userId, actorId: userId });
  expect(res!.status).toBeGreaterThanOrEqual(400);
  expect(res!.status).toBeLessThan(500);
  const body = await res!.json();
  expect(body.errors).toBeTruthy();
  expect(db.listWorkboardCards(tasks.scope, userId, tasks.id).length).toBe(0);
});
