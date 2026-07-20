// tests/ticket-intake.test.ts
import { test, expect, mock } from "bun:test";
import { intakeInboundEmail } from "../src/ticket-intake.ts";
import { getDb } from "../src/db.ts";

// Partial mock: keep the real parse/verify implementations so this mock
// doesn't poison resend-client.test.ts (mock.module leaks across test files).
import * as realResend from "../src/resend-client.ts";
mock.module("../src/resend-client.ts", () => ({
  ...realResend,
  sendTicketEmail: async () => {},
}));

const OP = "22222222-2222-4222-8222-222222222222";
const RUN = Date.now().toString(36);

test("creates a ticket from inbound email", async () => {
  const db = getDb();
  const payload = { type: "email.received", data: { email_id: `in-1-${RUN}`, from: "jane@acme.com", subject: "Bug", text: "broken" } };
  const r = await intakeInboundEmail(db, OP, payload);
  expect(r.ticketId).not.toBeNull();
  expect(r.deduped).toBe(false);
  expect(db.getSupportTicket(OP, r.ticketId!)?.subject).toBe("Bug");
});

test("dedupes repeated message id", async () => {
  const db = getDb();
  const payload = { type: "email.received", data: { email_id: `in-2-${RUN}`, from: "j@acme.com", subject: "B", text: "x" } };
  await intakeInboundEmail(db, OP, payload);
  const second = await intakeInboundEmail(db, OP, payload);
  expect(second.deduped).toBe(true);
});
