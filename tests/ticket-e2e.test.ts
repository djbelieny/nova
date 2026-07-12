// tests/ticket-e2e.test.ts
import { test, expect, mock } from "bun:test";
import { getDb } from "../src/db.ts";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gitc } from "../src/ticket-fixer.ts";

// Partial mock: keep the real parse/verify implementations so this mock
// doesn't poison resend-client.test.ts (mock.module leaks across test files).
import * as realResend from "../src/resend-client.ts";
mock.module("../src/resend-client.ts", () => ({
  ...realResend,
  sendTicketEmail: async () => {},
}));

const U = "66666666-6666-4666-8666-666666666666";

test("inbound email → fix → approve → deployed (dry-run)", async () => {
  const db = getDb();
  const { intakeInboundEmail } = await import("../src/ticket-intake.ts");
  const { processOnce, handleTicketApproval } = await import("../services/ticket-worker.ts");

  const repo = mkdtempSync(join(tmpdir(), "e2e-"));
  await gitc(repo,["init","-b","main"]); await gitc(repo,["config","user.email","t@t.com"]); await gitc(repo,["config","user.name","t"]);
  writeFileSync(join(repo,"value.txt"),"broken");
  writeFileSync(join(repo,"check.test.ts"),`import {test,expect} from "bun:test";import {readFileSync} from "fs";import {join} from "path";test("v",()=>{expect(readFileSync(join(import.meta.dir,"value.txt"),"utf8")).toBe("ok")});`);
  await gitc(repo,["add","."]); await gitc(repo,["commit","-m","init"]);
  db.upsertUserProjectForTest(U, { name: "e2e", client_match: "@acme.com", local_path: repo, test_command: "bun test check.test.ts", deploy_command: "exit 0", rollback_command: "exit 0" });

  const { ticketId } = await intakeInboundEmail(db, U, { type: "email.received", data: { email_id: `e2e-${crypto.randomUUID()}`, from: "jane@acme.com", subject: "fix value", text: "value should be ok" } });
  expect(ticketId).not.toBeNull();

  const deps = {
    runLLM: async () => '{"classification":"bug","severity":"normal"}',
    runAgent: async (cwd: string) => { writeFileSync(join(cwd, "value.txt"), "ok"); },
    onAwaitingApproval: async () => {},
  };
  await processOnce(db, U, deps);
  expect(db.getSupportTicket(U, ticketId!)?.status).toBe("awaiting_approval");

  await handleTicketApproval(db, U, ticketId!, "approve", { sendEmail: async () => {}, dryRun: true });
  expect(db.getSupportTicket(U, ticketId!)?.status).toBe("deployed");
});
