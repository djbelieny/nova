/**
 * Card sources — a board's cards may come from workboard_cards (the default) or be adapted from
 * an existing table. Adapted boards are system boards: draggable, not redesignable. The write
 * path is deliberately narrow — a stage change maps to that table's status column, nothing else.
 */

import type { StageDef } from "./workboards.ts";
import type { CardSourceKind, DatabaseType, WorkboardCard } from "./db.ts";
import { TICKET_COLUMNS, columnForStatus } from "./ticket-board.ts";

export interface CardSource {
  readCards(db: DatabaseType, userId: string, boardId: string): WorkboardCard[];
  applyMove(db: DatabaseType, userId: string, cardId: string, toStage: string): boolean;
  stages(): StageDef[];
}

export const TASK_STAGES: StageDef[] = [
  { key: "pending", label: "Pending", order: 0 },
  { key: "in_progress", label: "In Progress", order: 1 },
  { key: "completed", label: "Completed", order: 2 },
  { key: "blocked", label: "Blocked", order: 3 },
];

/** Mirrors the mapping the old getKanbanData used (src/dashboard.ts, getKanbanData). */
export function stageForTaskStatus(status: string): string {
  if (status === "done" || status === "completed") return "completed";
  if (status === "failed" || status === "cancelled" || status === "blocked") return "blocked";
  if (status === "in_progress") return "in_progress";
  return "pending";
}

export function statusForTaskStage(stage: string): string {
  if (stage === "completed") return "done";
  if (stage === "blocked") return "blocked";
  if (stage === "in_progress") return "in_progress";
  return "pending";
}

export function taskToCard(task: any, boardId: string): WorkboardCard {
  return {
    id: task.id,
    boardId,
    stageKey: stageForTaskStatus(task.status ?? "pending"),
    position: 0,
    title: task.description || "(no description)",
    fields: { agent: task.agent || "general", description: task.description || "", result: task.result ?? null },
    origin: "agent",
    originRef: task.id,
    externalId: null,
    archived: false,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
  };
}

const AGENT_TASK_SOURCE: CardSource = {
  stages: () => TASK_STAGES,
  readCards(db, userId, boardId) {
    // Deliberately wider than the old /kanban page's default of 30 — a four-column board
    // showing only 30 tasks would look empty. Not an accident.
    return db.getAgentTasksRecent({ userId, limit: 200 }).map((t: any) => taskToCard(t, boardId));
  },
  applyMove(db, userId, cardId, toStage) {
    const task = db.getTaskById(cardId, userId);
    if (!task) return false;
    if (stageForTaskStatus(task.status ?? "pending") === toStage) return true;
    return db.updateAgentTaskStatus(userId, cardId, statusForTaskStage(toStage));
  },
};

/**
 * Ticket stages mirror the real operator columns from ticket-board.ts (used by the existing
 * /tickets page) rather than a guessed set — several raw ticket statuses fold into one stage.
 */
export const TICKET_STAGES: StageDef[] = TICKET_COLUMNS.map((col, order) => ({
  key: col.key,
  label: col.label,
  order,
}));

const TICKET_STAGE_TO_STATUS: Record<string, string> = Object.fromEntries(
  TICKET_COLUMNS.map((col) => [col.key, col.statuses[0]])
);

export function stageForTicketStatus(status: string): string {
  return columnForStatus(status);
}

export function statusForTicketStage(stage: string): string {
  return TICKET_STAGE_TO_STATUS[stage] ?? TICKET_COLUMNS[0].statuses[0];
}

export function ticketToCard(ticket: any, boardId: string): WorkboardCard {
  return {
    id: ticket.id,
    boardId,
    stageKey: stageForTicketStatus(ticket.status ?? "new"),
    position: 0,
    title: ticket.subject || "(no subject)",
    fields: {
      requester: ticket.client_name || ticket.client_email || "",
      email: ticket.client_email ?? "",
      classification: ticket.classification ?? null,
      severity: ticket.severity ?? null,
    },
    origin: "agent",
    originRef: ticket.id,
    externalId: null,
    archived: false,
    createdAt: ticket.created_at,
    updatedAt: ticket.updated_at,
  };
}

const TICKET_SOURCE: CardSource = {
  stages: () => TICKET_STAGES,
  readCards(db, userId, boardId) {
    return db.getRecentSupportTickets(userId, 200).map((t: any) => ticketToCard(t, boardId));
  },
  applyMove(db, userId, cardId, toStage) {
    const ticket = db.getSupportTicket(userId, cardId);
    if (!ticket) return false;
    if (columnForStatus(ticket.status) === toStage) return true;
    db.updateSupportTicket(userId, cardId, { status: statusForTicketStage(toStage) });
    return true;
  },
};

export function getCardSource(kind: CardSourceKind): CardSource | null {
  if (kind === "agent_tasks") return AGENT_TASK_SOURCE;
  if (kind === "tickets") return TICKET_SOURCE;
  return null;
}
