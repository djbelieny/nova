/**
 * Dev Task Dispatcher
 *
 * Background service that polls for pending dev tasks (task_type='dev') and
 * runs them via Claude Code CLI in the project's workspace directory.
 *
 * Each task:
 *   1. Resolves/clones the project workspace
 *   2. Creates a dedicated branch (nova/task-<id>)
 *   3. Installs deps (idempotent, runtime-aware)
 *   4. Calls Claude with bypassPermissions (sandboxed=false default)
 *   5. Runs tests, sends summary to user
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { getDb } from "../src/db.ts";
import type { AgentTaskRow, UserProject } from "../src/db.ts";
import { logError } from "../src/error-handler.ts";
import { ClaudeProvider } from "../src/providers/claude.ts";

function sanitizeShellArg(s: string): string {
  return s.replace(/[^a-zA-Z0-9._\-/:@]/g, '');
}

type SendFn = (userId: string, text: string) => Promise<void>;

const claude = new ClaudeProvider();
const DEV_WORKSPACE = join(homedir(), ".nova", "workspace", "dev");

export function startDevTaskDispatcher(sendMessage: SendFn): void {
  setInterval(
    () => pollDevTasks(sendMessage).catch(e => logError(e, "dev-task-dispatcher")),
    30_000
  );
}

async function pollDevTasks(sendMessage: SendFn): Promise<void> {
  const db = getDb();
  const pending = db.getPendingDevTasks();

  for (const { userId, task } of pending) {
    if (!task.project_id) {
      logError(new Error(`Dev task ${task.id} has no project_id — skipping`), "dev-task-dispatcher", userId);
      continue;
    }
    if (db.hasInProgressDevTask(userId, task.project_id)) continue;

    db.updateDevTaskStatus(userId, task.id, "in_progress");

    runDevTask(userId, task, sendMessage).catch(e => {
      logError(e, "dev-task-run", userId);
      try {
        db.updateDevTaskStatus(userId, task.id, "failed", e.message);
      } catch (dbErr) {
        logError(dbErr, "dev-task-db-update", userId);
      }
      sendMessage(userId, `❌ Dev task failed: ${e.message}`).catch(err => {
        logError(err, "dev-task-notification", userId);
      });
    });
  }
}

async function runDevTask(
  userId: string,
  task: AgentTaskRow,
  sendMessage: SendFn
): Promise<void> {
  const db = getDb();
  const project = db.getProject(userId, task.project_id!);
  if (!project) throw new Error(`Project ${task.project_id} not found`);

  await sendMessage(userId, `Starting dev task: *${task.description}*`);

  const workspacePath = resolveWorkspace(project);

  // Create or checkout task branch
  const branchName = sanitizeShellArg(`nova/task-${task.id.slice(0, 8)}`);
  try {
    execSync(`git checkout -b ${branchName}`, { cwd: workspacePath, stdio: "pipe" });
  } catch {
    execSync(`git checkout ${branchName}`, { cwd: workspacePath, stdio: "pipe" });
  }

  installDeps(workspacePath, project.runtime);

  // Progress ticker every 3 minutes
  const ticker = setInterval(
    () => sendMessage(userId, `Still working on: *${task.description}*...`).catch(() => {}),
    180_000
  );

  let claudeOutput = "";
  try {
    const result = await claude.call({
      prompt: task.description,
      cwd: workspacePath,
      maxTurns: 50,
      outputFormat: "text",
      sandboxed: false,
    });
    claudeOutput = result.text;
  } finally {
    clearInterval(ticker);
  }

  // Diff stat
  let diff = "";
  try {
    diff = execSync(`git diff HEAD --stat`, { cwd: workspacePath }).toString().trim();
  } catch {}

  const testSummary = runTests(workspacePath, project.runtime);

  const outputSummary = claudeOutput.trim().slice(0, 500);
  const completion = [
    `Dev task complete: *${task.description}*`,
    ``,
    outputSummary ? `Summary:\n${outputSummary}` : '',
    ``,
    `Branch: \`${branchName}\``,
    diff ? `Changes:\n\`\`\`\n${diff}\n\`\`\`` : `Changes: none`,
    `Tests: ${testSummary}`,
    ``,
    `Review with: \`git diff ${project.defaultBranch}...${branchName}\``,
  ].filter(s => s !== '').join("\n");

  await sendMessage(userId, completion);
  db.updateDevTaskStatus(userId, task.id, "completed", claudeOutput || diff || "no changes");
}

function resolveWorkspace(project: UserProject): string {
  if (project.localPath) {
    try {
      execSync(`git pull origin ${sanitizeShellArg(project.defaultBranch)} --ff-only`, {
        cwd: project.localPath,
        stdio: "pipe",
      });
    } catch {}
    return project.localPath;
  }

  if (project.repoUrl) {
    const projectDir = join(DEV_WORKSPACE, project.name);
    mkdirSync(DEV_WORKSPACE, { recursive: true });
    if (!existsSync(join(projectDir, ".git"))) {
      execSync(`git clone ${sanitizeShellArg(project.repoUrl)} ${projectDir}`, { stdio: "pipe" });
    } else {
      try {
        execSync(`git pull origin ${sanitizeShellArg(project.defaultBranch)} --ff-only`, {
          cwd: projectDir,
          stdio: "pipe",
        });
      } catch {}
    }
    return projectDir;
  }

  throw new Error(`Project ${project.name} has no repoUrl or localPath`);
}

function installDeps(cwd: string, runtime?: string | null): void {
  try {
    if (
      existsSync(join(cwd, "bun.lockb")) ||
      (runtime === "bun" && existsSync(join(cwd, "package.json")))
    ) {
      execSync("bun install", { cwd, stdio: "pipe" });
    } else if (existsSync(join(cwd, "package-lock.json"))) {
      execSync("npm ci", { cwd, stdio: "pipe" });
    } else if (existsSync(join(cwd, "package.json"))) {
      execSync("bun install", { cwd, stdio: "pipe" });
    } else if (existsSync(join(cwd, "requirements.txt"))) {
      execSync("pip install -r requirements.txt", { cwd, stdio: "pipe" });
    } else if (existsSync(join(cwd, "Cargo.toml"))) {
      execSync("cargo fetch", { cwd, stdio: "pipe" });
    }
  } catch (e: any) {
    logError(e, "dev-task-install-deps");
    // Continue — Claude may still work with existing cached modules
  }
}

function runTests(cwd: string, runtime?: string | null): string {
  try {
    let cmd = "";
    if (existsSync(join(cwd, "package.json"))) {
      const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
      if (pkg.scripts?.test) {
        cmd = runtime === "bun" ? "bun test" : "npm test";
      }
    } else if (existsSync(join(cwd, "Cargo.toml"))) {
      cmd = "cargo test 2>&1 | tail -5";
    } else if (existsSync(join(cwd, "requirements.txt"))) {
      cmd = "python -m pytest --tb=no -q 2>&1 | tail -5";
    }

    if (!cmd) return "no test runner detected";

    const out = execSync(cmd, { cwd, stdio: "pipe", timeout: 120_000 })
      .toString()
      .trim();
    return out.split("\n").slice(-3).join(" | ");
  } catch (e: any) {
    return `tests failed: ${e.message?.split("\n")[0] ?? "unknown"}`;
  }
}
