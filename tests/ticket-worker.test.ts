// tests/ticket-worker.test.ts
import { test, expect } from "bun:test";
import { recoverStaleTickets, handleTicketApproval } from "../services/ticket-worker.ts";
import { getDb } from "../src/db.ts";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gitc } from "../src/ticket-fixer.ts";

const U = "55555555-5555-4555-8555-555555555555";

test("recoverStaleTickets resets fixing → resolving AND deploying → awaiting_approval", () => {
  const db = getDb();
  const id1 = db.insertSupportTicket({ user_id: U, source: "resend", client_email: "a@a.com", subject: "s-fix", body_raw: "b" });
  db.updateSupportTicket(U, id1, { status: "fixing" });
  const id2 = db.insertSupportTicket({ user_id: U, source: "resend", client_email: "a@a.com", subject: "s-deploy", body_raw: "b" });
  db.updateSupportTicket(U, id2, { status: "deploying" });
  expect(recoverStaleTickets(db, U)).toBeGreaterThanOrEqual(2);
  expect(db.getSupportTicket(U, id1)?.status).toBe("resolving");
  expect(db.getSupportTicket(U, id2)?.status).toBe("awaiting_approval");
});

test("approve triggers dry-run deploy and marks deployed", async () => {
  const db = getDb();
  const repo = mkdtempSync(join(tmpdir(), "wk-"));
  await gitc(repo,["init","-b","main"]); await gitc(repo,["config","user.email","t@t.com"]); await gitc(repo,["config","user.name","t"]);
  writeFileSync(join(repo,"f.txt"),"a"); await gitc(repo,["add","."]); await gitc(repo,["commit","-m","init"]);
  await gitc(repo,["checkout","-B","fix/ticket-wk1"]); writeFileSync(join(repo,"f.txt"),"b"); await gitc(repo,["add","."]); await gitc(repo,["commit","-m","fix"]);
  const pid = db.upsertUserProjectForTest(U, { name: "wk", client_match: "@a.com", local_path: repo, test_command: "exit 0", deploy_command: "exit 0", rollback_command: "exit 0" });
  const id = db.insertSupportTicket({ user_id: U, source: "resend", client_email: "x@a.com", subject: "s", body_raw: "b" });
  db.updateSupportTicket(U, id, { status: "awaiting_approval", project_id: pid, branch_name: "fix/ticket-wk1" });
  const sent: string[] = [];
  await handleTicketApproval(db, U, id, "approve", { sendEmail: async (_to,_s,body) => { sent.push(body); }, dryRun: true });
  expect(db.getSupportTicket(U, id)?.status).toBe("deployed");
  expect(sent.length).toBe(1);
});

test("reject marks escalated and emails the client", async () => {
  const db = getDb();
  const pid = db.upsertUserProjectForTest(U, { name: "wk-reject", client_match: "@a.com", local_path: "/tmp/wk-reject", test_command: "exit 0", deploy_command: "exit 0", rollback_command: "exit 0" });
  const id = db.insertSupportTicket({ user_id: U, source: "resend", client_email: "y@a.com", subject: "s", body_raw: "b" });
  db.updateSupportTicket(U, id, { status: "awaiting_approval", project_id: pid, branch_name: "fix/ticket-wk2" });
  const sent: string[] = [];
  await handleTicketApproval(db, U, id, "reject", { sendEmail: async (_to,_s,body) => { sent.push(body); }, dryRun: true });
  expect(db.getSupportTicket(U, id)?.status).toBe("escalated");
  expect(sent.length).toBe(1);
});
