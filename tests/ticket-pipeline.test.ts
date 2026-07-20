// tests/ticket-pipeline.test.ts
import { test, expect } from "bun:test";
import { advanceTicket } from "../src/ticket-pipeline.ts";
import { getDb } from "../src/db.ts";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gitc } from "../src/ticket-fixer.ts";

const U = "44444444-4444-4444-8444-444444444444";
const deps = {
  runLLM: async () => '{"classification":"bug","severity":"normal"}',
  runAgent: async (cwd: string) => { writeFileSync(join(cwd, "value.txt"), "ok"); },
};

test("new ticket triaged then escalates with no matching project", async () => {
  const db = getDb();
  const id = db.insertSupportTicket({ user_id: U, source: "resend", client_email: "x@nomatch.com", subject: "s", body_raw: "b" });
  expect(await advanceTicket(db, U, id, deps)).toBe("triaged");
  expect(await advanceTicket(db, U, id, deps)).toBe("escalated");
});

test("matched ticket runs fix and reaches awaiting_approval", async () => {
  const db = getDb();
  const repo = mkdtempSync(join(tmpdir(), "pipe-"));
  await gitc(repo, ["init","-b","main"]); await gitc(repo,["config","user.email","t@t.com"]); await gitc(repo,["config","user.name","t"]);
  writeFileSync(join(repo,"value.txt"),"broken");
  writeFileSync(join(repo,"check.test.ts"),`import {test,expect} from "bun:test";import {readFileSync} from "fs";import {join} from "path";test("v",()=>{expect(readFileSync(join(import.meta.dir,"value.txt"),"utf8")).toBe("ok")});`);
  await gitc(repo,["add","."]); await gitc(repo,["commit","-m","init"]);
  db.upsertUserProjectForTest(U, { name: "matched", client_match: "@acme.com", local_path: repo, test_command: "bun test check.test.ts" });
  const id = db.insertSupportTicket({ user_id: U, source: "resend", client_email: "jane@acme.com", subject: "fix value", body_raw: "value should be ok" });
  await advanceTicket(db, U, id, deps); // triaged
  await advanceTicket(db, U, id, deps); // resolving → project set
  expect(await advanceTicket(db, U, id, deps)).toBe("awaiting_approval");
  expect(db.getSupportTicket(U, id)?.branch_name).toBe(`fix/ticket-${id}`);
});

test("matched ticket escalates when the fix leaves tests red", async () => {
  const db = getDb();
  const repo = mkdtempSync(join(tmpdir(), "pipe-red-"));
  await gitc(repo, ["init","-b","main"]); await gitc(repo,["config","user.email","t@t.com"]); await gitc(repo,["config","user.name","t"]);
  writeFileSync(join(repo,"value.txt"),"broken");
  writeFileSync(join(repo,"check.test.ts"),`import {test,expect} from "bun:test";import {readFileSync} from "fs";import {join} from "path";test("v",()=>{expect(readFileSync(join(import.meta.dir,"value.txt"),"utf8")).toBe("ok")});`);
  await gitc(repo,["add","."]); await gitc(repo,["commit","-m","init"]);
  db.upsertUserProjectForTest(U, { name: "matched-red", client_match: "@redco.com", local_path: repo, test_command: "bun test check.test.ts" });
  const id = db.insertSupportTicket({ user_id: U, source: "resend", client_email: "jane@redco.com", subject: "fix value", body_raw: "value should be ok" });
  const badDeps = {
    runLLM: async () => '{"classification":"bug","severity":"normal"}',
    runAgent: async () => { /* does not fix the bug — value.txt stays "broken" */ },
  };
  await advanceTicket(db, U, id, badDeps); // triaged
  await advanceTicket(db, U, id, badDeps); // resolving → project set
  expect(await advanceTicket(db, U, id, badDeps)).toBe("escalated");
  expect(db.getSupportTicket(U, id)?.status).toBe("escalated");
});
