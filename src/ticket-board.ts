// Pure presentation logic for the support-ticket Kanban board.
// Maps the ticket state machine's statuses onto operator-facing columns.
// Kept separate from dashboard.ts so it can be unit-tested in isolation.

export interface TicketColumn {
  key: string;
  label: string;
  statuses: string[];
}

export const TICKET_COLUMNS: TicketColumn[] = [
  { key: "intake", label: "Intake", statuses: ["new", "triaged"] },
  { key: "in_progress", label: "In Progress", statuses: ["resolving", "fixing", "deploying"] },
  { key: "awaiting_approval", label: "Awaiting Approval", statuses: ["awaiting_approval"] },
  { key: "done", label: "Done", statuses: ["deployed", "closed"] },
  { key: "needs_attention", label: "Needs Attention", statuses: ["escalated", "failed"] },
];

const STATUS_TO_COLUMN: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const col of TICKET_COLUMNS) for (const s of col.statuses) m[s] = col.key;
  return m;
})();

// Any status we don't recognize lands in "needs_attention" so it surfaces to the
// operator rather than silently disappearing from the board.
const FALLBACK_COLUMN = "needs_attention";

export function columnForStatus(status: string): string {
  return STATUS_TO_COLUMN[status] || FALLBACK_COLUMN;
}

export function groupTicketsByColumn<T extends { status: string }>(
  tickets: T[]
): { columns: Record<string, T[]> } {
  const columns: Record<string, T[]> = {};
  for (const col of TICKET_COLUMNS) columns[col.key] = [];
  for (const t of tickets) columns[columnForStatus(t.status)].push(t);
  return { columns };
}
