// tests/ticket-fixer.test.ts
import { test, expect } from "bun:test";
import { runFix, gitc } from "../src/ticket-fixer.ts";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

async function makeFixtureRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "fixrepo-"));
  await gitc(dir, ["init", "-b", "main"]);
  await gitc(dir, ["config", "user.email", "t@t.com"]);
  await gitc(dir, ["config", "user.name", "t"]);
  // A test that fails until value.txt contains "ok"
  writeFileSync(join(dir, "value.txt"), "broken");
  writeFileSync(join(dir, "check.test.ts"), `import {test,expect} from "bun:test";import {readFileSync} from "fs";import {join} from "path";test("v",()=>{expect(readFileSync(join(import.meta.dir,"value.txt"),"utf8")).toBe("ok")});`);
  await gitc(dir, ["add", "."]);
  await gitc(dir, ["commit", "-m", "init"]);
  return dir;
}

test("runFix produces a green branch when the agent fixes the bug", async () => {
  const repo = await makeFixtureRepo();
  const runAgent = async (cwd: string) => { writeFileSync(join(cwd, "value.txt"), "ok"); };
  const r = await runFix({
    project: { local_path: repo, default_branch: "main", test_command: "bun test check.test.ts" },
    ticket: { id: "t1", subject: "fix", body_raw: "value should be ok" },
    runAgent,
  });
  expect(r.success).toBe(true);
  expect(r.branchName).toBe("fix/ticket-t1");
  expect(r.diffSummary).toContain("value.txt");
});

test("runFix surfaces newly created files in the diff summary", async () => {
  const repo = await makeFixtureRepo();
  const runAgent = async (cwd: string) => {
    writeFileSync(join(cwd, "value.txt"), "ok");
    writeFileSync(join(cwd, "fixed.txt"), "new file from agent");
  };
  const r = await runFix({
    project: { local_path: repo, default_branch: "main", test_command: "bun test check.test.ts" },
    ticket: { id: "t3", subject: "fix", body_raw: "create fixed.txt and set value ok" },
    runAgent,
  });
  expect(r.success).toBe(true);
  expect(r.diffSummary).toContain("fixed.txt");
});

test("runFix fails (no push) when tests stay red", async () => {
  const repo = await makeFixtureRepo();
  const runAgent = async () => { /* agent does nothing */ };
  const r = await runFix({
    project: { local_path: repo, default_branch: "main", test_command: "bun test check.test.ts" },
    ticket: { id: "t2", subject: "fix", body_raw: "x" },
    runAgent,
  });
  expect(r.success).toBe(false);
});
