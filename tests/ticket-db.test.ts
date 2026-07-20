// tests/ticket-db.test.ts
import { test, expect } from "bun:test";
import { getDb } from "../src/db.ts";

const U = "11111111-1111-4111-8111-111111111111";

test("insert + fetch a support ticket, default status is new", () => {
  const db = getDb();
  const id = db.insertSupportTicket({
    user_id: U, source: "resend", client_email: "a@client.com",
    client_name: "A", resend_message_id: "msg-1",
    subject: "Login broken", body_raw: "I can't log in",
  });
  const t = db.getSupportTicket(U, id);
  expect(t?.status).toBe("new");
  expect(t?.client_email).toBe("a@client.com");
});

test("dedupe by resend message id", () => {
  const db = getDb();
  db.insertSupportTicket({ user_id: U, source: "resend", client_email: "b@client.com", subject: "x", body_raw: "y", resend_message_id: "dup-1" });
  expect(db.findTicketByMessageId(U, "dup-1")).not.toBeNull();
  expect(db.findTicketByMessageId(U, "nope")).toBeNull();
});

test("status transitions and status query", () => {
  const db = getDb();
  const id = db.insertSupportTicket({ user_id: U, source: "resend", client_email: "c@client.com", subject: "x", body_raw: "y" });
  db.updateSupportTicket(U, id, { status: "fixing", branch_name: "fix/abc" });
  const fixing = db.getTicketsByStatus(U, ["fixing"]);
  expect(fixing.some(t => t.id === id)).toBe(true);
});

test("resolve project by client_match domain", () => {
  const db = getDb();
  const PU = "22222222-2222-4222-8222-222222222222";
  const pid = db.upsertUserProjectForTest(PU, { name: "acme", repo_url: "git@github.com:me/acme.git", client_match: "@acme.com", test_command: "bun test", deploy_command: "echo deploy", rollback_command: "echo rollback" });
  const proj = db.getProjectByClientMatch(PU, "jane@acme.com");
  expect(proj?.id).toBe(pid);
  expect(db.getProjectByClientMatch(PU, "jane@other.com")).toBeNull();
});

test("domain-boundary allowlist: subdomain matches, attacker bypass does not", () => {
  const db = getDb();
  const PU = "33333333-3333-4333-8333-333333333333";
  db.upsertUserProjectForTest(PU, { name: "acme-sec", client_match: "@acme.com", test_command: "exit 0", deploy_command: "exit 0", rollback_command: "exit 0" });
  // exact domain match
  expect(db.getProjectByClientMatch(PU, "jane@acme.com")).not.toBeNull();
  // subdomain of acme.com — should match
  expect(db.getProjectByClientMatch(PU, "bob@mail.acme.com")).not.toBeNull();
  // attacker domain: acme.com.attacker.com — must NOT match
  expect(db.getProjectByClientMatch(PU, "evil@acme.com.attacker.com")).toBeNull();
});
