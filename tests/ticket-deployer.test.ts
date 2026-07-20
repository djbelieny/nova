// tests/ticket-deployer.test.ts
import { test, expect } from "bun:test";
import { deployFix } from "../src/ticket-deployer.ts";
import { gitc } from "../src/ticket-fixer.ts";
import { mkdtempSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

async function repoWithBranch(deployCmd: string, rollbackCmd: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "deprepo-"));
  await gitc(dir, ["init", "-b", "main"]);
  await gitc(dir, ["config", "user.email", "t@t.com"]);
  await gitc(dir, ["config", "user.name", "t"]);
  writeFileSync(join(dir, "f.txt"), "a"); await gitc(dir, ["add","."]); await gitc(dir, ["commit","-m","init"]);
  await gitc(dir, ["checkout","-B","fix/ticket-t1"]);
  writeFileSync(join(dir, "f.txt"), "b"); await gitc(dir, ["add","."]); await gitc(dir, ["commit","-m","fix"]);
  return dir;
}

test("dry-run records commands without deploying", async () => {
  const repo = await repoWithBranch("exit 0", "exit 0");
  const deployCmd = `touch ${repo}/DEPLOYED`;
  const r = await deployFix({ project: { local_path: repo, default_branch: "main", deploy_command: deployCmd, rollback_command: "exit 0" }, branchName: "fix/ticket-t1", dryRun: true, pushRemote: false });
  expect(r.ok).toBe(true);
  expect(r.log.join("\n")).toContain(`DRY-RUN deploy: ${deployCmd}`);
  expect(existsSync(join(repo, "DEPLOYED"))).toBe(false);
});

test("deploy failure triggers rollback", async () => {
  const repo = await repoWithBranch("exit 1", "exit 0");
  const r = await deployFix({ project: { local_path: repo, default_branch: "main", deploy_command: "exit 1", rollback_command: "exit 0" }, branchName: "fix/ticket-t1", dryRun: false, pushRemote: false });
  expect(r.ok).toBe(false);
  expect(r.rolledBack).toBe(true);
});
