import { test, expect } from "bun:test";
import { groupTicketsByColumn, TICKET_COLUMNS } from "../src/ticket-board.ts";

const mk = (id: string, status: string) => ({ id, status, subject: "s", client_email: "a@b.com" });

test("groups each status into the right column", () => {
  const tickets = [
    mk("1", "new"), mk("2", "triaged"),
    mk("3", "resolving"), mk("4", "fixing"), mk("5", "deploying"),
    mk("6", "awaiting_approval"),
    mk("7", "deployed"), mk("8", "closed"),
    mk("9", "escalated"), mk("10", "failed"),
  ];
  const { columns } = groupTicketsByColumn(tickets);
  expect(columns.intake.map(t => t.id)).toEqual(["1", "2"]);
  expect(columns.in_progress.map(t => t.id)).toEqual(["3", "4", "5"]);
  expect(columns.awaiting_approval.map(t => t.id)).toEqual(["6"]);
  expect(columns.done.map(t => t.id)).toEqual(["7", "8"]);
  expect(columns.needs_attention.map(t => t.id)).toEqual(["9", "10"]);
});

test("unknown status falls into needs_attention (never dropped)", () => {
  const { columns } = groupTicketsByColumn([mk("x", "weird_status")]);
  expect(columns.needs_attention.map(t => t.id)).toEqual(["x"]);
});

test("returns all five columns even when empty", () => {
  const { columns } = groupTicketsByColumn([]);
  expect(Object.keys(columns).sort()).toEqual(TICKET_COLUMNS.map(c => c.key).sort());
  for (const c of TICKET_COLUMNS) expect(columns[c.key]).toEqual([]);
});

// --- DB: getRecentSupportTickets ---
import { getDb } from "../src/db.ts";
const BU = "77777777-7777-4777-8777-777777777777";

test("getRecentSupportTickets returns operator tickets capped at the limit", () => {
  const db = getDb();
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    ids.push(db.insertSupportTicket({ user_id: BU, source: "resend", client_email: `c${i}@x.com`, subject: `t${i}`, body_raw: "b" }));
  }
  const all = db.getRecentSupportTickets(BU, 100);
  expect(all.length).toBeGreaterThanOrEqual(5);
  expect(all.every((t: any) => t.user_id === BU)).toBe(true);
  const limited = db.getRecentSupportTickets(BU, 3);
  expect(limited.length).toBe(3);
});
