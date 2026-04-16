/**
 * Health Monitor — Nova self-healing service
 *
 * Runs every 30 minutes via launchd/systemd. Checks service health,
 * TypeScript compilation, git state, dependencies, resources, logs,
 * and integrations. Auto-fixes critical issues, sends Telegram
 * notifications with Fix/Ignore/Detail buttons for warnings.
 *
 * Run: bun run services/health-monitor.ts
 */

import { readFile, writeFile, stat, readdir } from "fs/promises";
import { existsSync } from "fs";
import { dirname, join } from "path";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const PROJECT_ROOT = join(dirname(import.meta.path), "..");
const DATA_DIR = join(PROJECT_ROOT, "data");
const STATE_FILE = join(DATA_DIR, "health-monitor-state.json");
const PENDING_FILE = join(DATA_DIR, "health-pending.json");
const LOGS_DIR = join(PROJECT_ROOT, "logs");

// Core files that matter most for compilation checks
const CORE_FILES = [
  "src/relay.ts",
  "src/orchestrator.ts",
  "src/planner.ts",
  "src/voice-server.ts",
  "src/agent-router.ts",
];

// Services to monitor
const SERVICES_MAC: Record<string, string> = {
  "com.nova.core": "Main bot relay",
  "com.nova.voice-server": "Voice server",
  "com.nova.miniapp": "Mini App server",
  "com.nova.health-monitor": "Health monitor",
};

const SERVICES_LINUX: Record<string, string> = {
  "nova-relay": "Main bot relay",
  "nova-voice": "Voice server",
  "nova-dashboard": "Dashboard",
  "nova-miniapp": "Mini App server",
};

// ============================================================
// TYPES
// ============================================================

type Severity = "critical" | "warning" | "info";

interface HealthCheckResult {
  status: "ok" | "warn" | "critical";
  checkName: string;
  detail: string;
  fixAction?: string;
  fixTarget?: string;
}

interface HealthIssue {
  id: string;
  timestamp: string;
  check: string;
  severity: Severity;
  title: string;
  detail: string;
  fixAction: string;
  fixTarget: string;
  status: "pending" | "resolved" | "suppressed";
  suppressedUntil?: string;
  telegramMessageId?: number;
}

interface PendingIssues {
  issues: HealthIssue[];
}

interface MonitorState {
  lastRun: string;
  knownIssues: string[];
  suppressedUntil: Record<string, string>;
}

// ============================================================
// STATE MANAGEMENT
// ============================================================

async function loadState(): Promise<MonitorState> {
  try {
    const content = await readFile(STATE_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return { lastRun: "", knownIssues: [], suppressedUntil: {} };
  }
}

async function saveState(state: MonitorState): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

async function loadPending(): Promise<PendingIssues> {
  try {
    const content = await readFile(PENDING_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return { issues: [] };
  }
}

async function savePending(pending: PendingIssues): Promise<void> {
  await writeFile(PENDING_FILE, JSON.stringify(pending, null, 2));
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(
  message: string,
  buttons?: { text: string; callback_data: string }[][],
): Promise<number | null> {
  try {
    const body: any = {
      chat_id: CHAT_ID,
      text: message,
      parse_mode: "HTML",
    };
    if (buttons) {
      body.reply_markup = JSON.stringify({ inline_keyboard: buttons });
    }
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (response.ok) {
      const data = await response.json() as any;
      return data.result?.message_id || null;
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================
// HEALTH CHECKS
// ============================================================

async function checkServices(): Promise<HealthCheckResult[]> {
  const results: HealthCheckResult[] = [];
  const isMac = process.platform === "darwin";

  if (isMac) {
    for (const [label, desc] of Object.entries(SERVICES_MAC)) {
      try {
        const proc = Bun.spawn(["launchctl", "list", label], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const stdout = await new Response(proc.stdout).text();
        const code = await proc.exited;

        if (code !== 0) {
          results.push({
            status: "critical",
            checkName: "checkServices",
            detail: `${desc} (${label}) is not loaded in launchd`,
            fixAction: "restart_service",
            fixTarget: label,
          });
        } else {
          // Check PID — if no PID for keepAlive services, it's crashed
          const pidLine = stdout.match(/"PID"\s*=\s*(\d+)/);
          const isKeepAlive = label === "com.nova.core" || label === "com.nova.miniapp";
          if (isKeepAlive && !pidLine) {
            results.push({
              status: "critical",
              checkName: "checkServices",
              detail: `${desc} (${label}) is loaded but not running (no PID)`,
              fixAction: "restart_service",
              fixTarget: label,
            });
          } else {
            results.push({
              status: "ok",
              checkName: "checkServices",
              detail: `${desc} (${label}) is running`,
            });
          }
        }
      } catch (e: any) {
        results.push({
          status: "critical",
          checkName: "checkServices",
          detail: `Failed to check ${label}: ${e.message}`,
          fixAction: "restart_service",
          fixTarget: label,
        });
      }
    }
  } else {
    for (const [svc, desc] of Object.entries(SERVICES_LINUX)) {
      try {
        const proc = Bun.spawn(["systemctl", "is-active", svc], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const stdout = (await new Response(proc.stdout).text()).trim();
        await proc.exited;

        if (stdout !== "active") {
          results.push({
            status: "critical",
            checkName: "checkServices",
            detail: `${desc} (${svc}) status: ${stdout}`,
            fixAction: "restart_service",
            fixTarget: svc,
          });
        } else {
          results.push({
            status: "ok",
            checkName: "checkServices",
            detail: `${desc} (${svc}) is active`,
          });
        }
      } catch (e: any) {
        results.push({
          status: "warn",
          checkName: "checkServices",
          detail: `Failed to check ${svc}: ${e.message}`,
        });
      }
    }
  }

  return results;
}

async function checkTypescript(): Promise<HealthCheckResult[]> {
  const results: HealthCheckResult[] = [];

  for (const file of CORE_FILES) {
    const fullPath = join(PROJECT_ROOT, file);
    if (!existsSync(fullPath)) continue;

    try {
      const proc = Bun.spawn(
        ["bun", "build", "--no-bundle", fullPath],
        { stdout: "pipe", stderr: "pipe", cwd: PROJECT_ROOT },
      );
      const stderr = await new Response(proc.stderr).text();
      const code = await proc.exited;

      if (code !== 0) {
        results.push({
          status: "warn",
          checkName: "checkTypescript",
          detail: `${file} has compilation errors:\n${stderr.substring(0, 500)}`,
        });
      } else {
        results.push({
          status: "ok",
          checkName: "checkTypescript",
          detail: `${file} compiles cleanly`,
        });
      }
    } catch (e: any) {
      results.push({
        status: "warn",
        checkName: "checkTypescript",
        detail: `Failed to check ${file}: ${e.message}`,
      });
    }
  }

  return results;
}

async function checkGitState(): Promise<HealthCheckResult[]> {
  const results: HealthCheckResult[] = [];
  const git = (args: string[]) =>
    Bun.spawn(["git", "-C", PROJECT_ROOT, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

  // Check dirty working tree
  try {
    const proc = git(["status", "--porcelain"]);
    const stdout = (await new Response(proc.stdout).text()).trim();
    await proc.exited;

    if (stdout) {
      const fileCount = stdout.split("\n").length;
      results.push({
        status: "warn",
        checkName: "checkGitState",
        detail: `Working tree has ${fileCount} uncommitted change(s)`,
        fixAction: "git_stash",
        fixTarget: "",
      });
    } else {
      results.push({
        status: "ok",
        checkName: "checkGitState",
        detail: "Working tree is clean",
      });
    }
  } catch {}

  // Check for stale self-edit branches (>1hr old)
  try {
    const proc = git(["branch", "--list", "self-edit/*"]);
    const stdout = (await new Response(proc.stdout).text()).trim();
    await proc.exited;

    if (stdout) {
      const branches = stdout
        .split("\n")
        .map((b) => b.trim().replace("* ", ""))
        .filter(Boolean);

      for (const branch of branches) {
        // Check age of the branch tip
        const dateProc = git(["log", "-1", "--format=%ct", branch]);
        const dateStr = (await new Response(dateProc.stdout).text()).trim();
        await dateProc.exited;

        const branchAge = Date.now() / 1000 - parseInt(dateStr || "0");
        if (branchAge > 3600) {
          // >1 hour old
          results.push({
            status: "info" as any,
            checkName: "checkGitState",
            detail: `Stale self-edit branch: ${branch} (${Math.round(branchAge / 60)}min old)`,
            fixAction: "delete_branch",
            fixTarget: branch,
          });
        }
      }
    }
  } catch {}

  // Check if production is behind main
  try {
    const proc = git(["rev-list", "--count", "production..main"]);
    const count = parseInt(
      (await new Response(proc.stdout).text()).trim() || "0",
    );
    await proc.exited;

    if (count > 0) {
      results.push({
        status: "warn",
        checkName: "checkGitState",
        detail: `production is ${count} commit(s) behind main`,
      });
    }
  } catch {}

  return results;
}

async function checkDependencies(): Promise<HealthCheckResult[]> {
  const results: HealthCheckResult[] = [];

  try {
    const pkgPath = join(PROJECT_ROOT, "package.json");
    const lockPath = join(PROJECT_ROOT, "bun.lockb");

    if (existsSync(pkgPath) && existsSync(lockPath)) {
      const pkgStat = await stat(pkgPath);
      const lockStat = await stat(lockPath);

      if (pkgStat.mtimeMs > lockStat.mtimeMs) {
        results.push({
          status: "warn",
          checkName: "checkDependencies",
          detail:
            "package.json is newer than bun.lockb — dependencies may be out of sync",
          fixAction: "bun_install",
          fixTarget: "",
        });
      } else {
        results.push({
          status: "ok",
          checkName: "checkDependencies",
          detail: "Dependencies are in sync",
        });
      }
    }
  } catch (e: any) {
    results.push({
      status: "warn",
      checkName: "checkDependencies",
      detail: `Failed to check dependencies: ${e.message}`,
    });
  }

  return results;
}

async function checkResources(): Promise<HealthCheckResult[]> {
  const results: HealthCheckResult[] = [];

  // Disk space
  try {
    const proc = Bun.spawn(["df", "-h", PROJECT_ROOT], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    const lines = stdout.trim().split("\n");
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      const usePct = parseInt(parts[4]?.replace("%", "") || "0");

      if (usePct >= 95) {
        results.push({
          status: "critical",
          checkName: "checkResources",
          detail: `Disk usage at ${usePct}% — critically low space`,
        });
      } else if (usePct >= 85) {
        results.push({
          status: "warn",
          checkName: "checkResources",
          detail: `Disk usage at ${usePct}% — getting low`,
        });
      } else {
        results.push({
          status: "ok",
          checkName: "checkResources",
          detail: `Disk usage at ${usePct}%`,
        });
      }
    }
  } catch {}

  // Memory (macOS vm_stat / Linux free)
  try {
    if (process.platform === "darwin") {
      const proc = Bun.spawn(["vm_stat"], { stdout: "pipe", stderr: "pipe" });
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;

      const freeMatch = stdout.match(/Pages free:\s+(\d+)/);
      const inactiveMatch = stdout.match(/Pages inactive:\s+(\d+)/);
      if (freeMatch && inactiveMatch) {
        const pageSize = 16384; // Apple Silicon
        const freeMB =
          ((parseInt(freeMatch[1]) + parseInt(inactiveMatch[1])) * pageSize) /
          1024 /
          1024;
        if (freeMB < 500) {
          results.push({
            status: "warn",
            checkName: "checkResources",
            detail: `Available memory low: ~${Math.round(freeMB)}MB free`,
          });
        }
      }
    } else {
      const proc = Bun.spawn(["free", "-m"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;

      const memLine = stdout.split("\n").find((l) => l.startsWith("Mem:"));
      if (memLine) {
        const parts = memLine.split(/\s+/);
        const available = parseInt(parts[6] || "0");
        if (available < 500) {
          results.push({
            status: "warn",
            checkName: "checkResources",
            detail: `Available memory low: ${available}MB`,
          });
        }
      }
    }
  } catch {}

  return results;
}

async function checkLogs(): Promise<HealthCheckResult[]> {
  const results: HealthCheckResult[] = [];
  const errorPatterns = [
    /SIGKILL/,
    /ENOMEM/,
    /unhandled\s+rejection/i,
    /heap\s+out\s+of\s+memory/i,
    /FATAL\s+ERROR/,
  ];

  const errorLogs = [
    "com.nova.core.error.log",
    "com.nova.voice-server.error.log",
    "com.nova.miniapp.error.log",
  ];

  for (const logFile of errorLogs) {
    const logPath = join(LOGS_DIR, logFile);
    if (!existsSync(logPath)) continue;

    try {
      const fileStat = await stat(logPath);
      // Only check logs modified in the last hour
      if (Date.now() - fileStat.mtimeMs > 60 * 60 * 1000) continue;

      // Read last 10KB of the error log
      const file = Bun.file(logPath);
      const size = file.size;
      const readFrom = Math.max(0, size - 10_000);
      const content = await file.slice(readFrom, size).text();

      for (const pattern of errorPatterns) {
        const match = content.match(pattern);
        if (match) {
          results.push({
            status: "warn",
            checkName: "checkLogs",
            detail: `${logFile}: found "${match[0]}" in recent log entries`,
          });
          break; // One match per file is enough
        }
      }
    } catch {}
  }

  return results;
}

async function checkIntegrations(): Promise<HealthCheckResult[]> {
  const results: HealthCheckResult[] = [];

  // Telegram bot token validation
  if (BOT_TOKEN) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/getMe`,
      );
      if (response.ok) {
        results.push({
          status: "ok",
          checkName: "checkIntegrations",
          detail: "Telegram bot token is valid",
        });
      } else {
        results.push({
          status: "critical",
          checkName: "checkIntegrations",
          detail: `Telegram bot token invalid (HTTP ${response.status})`,
        });
      }
    } catch (e: any) {
      results.push({
        status: "warn",
        checkName: "checkIntegrations",
        detail: `Telegram API unreachable: ${e.message}`,
      });
    }
  }

  return results;
}

// ============================================================
// CLASSIFY & ACT
// ============================================================

function classifySeverity(result: HealthCheckResult): Severity {
  if (result.status === "critical") return "critical";
  if (result.status === "warn") return "warning";
  return "info";
}

async function autoFix(issue: HealthIssue): Promise<string> {
  const isMac = process.platform === "darwin";

  if (issue.fixAction === "restart_service") {
    if (isMac) {
      const plistPath = join(
        process.env.HOME || "",
        "Library",
        "LaunchAgents",
        `${issue.fixTarget}.plist`,
      );
      if (!existsSync(plistPath)) return `Plist not found: ${plistPath}`;

      const unload = Bun.spawn(["launchctl", "unload", plistPath], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await unload.exited;
      const load = Bun.spawn(["launchctl", "load", plistPath], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const loadErr = await new Response(load.stderr).text();
      const code = await load.exited;
      return code === 0
        ? `Restarted ${issue.fixTarget}`
        : `Restart failed: ${loadErr}`;
    } else {
      const proc = Bun.spawn(
        ["sudo", "systemctl", "restart", issue.fixTarget],
        { stdout: "pipe", stderr: "pipe" },
      );
      const stderr = await new Response(proc.stderr).text();
      const code = await proc.exited;
      return code === 0
        ? `Restarted ${issue.fixTarget}`
        : `Restart failed: ${stderr}`;
    }
  }

  if (issue.fixAction === "delete_branch") {
    const proc = Bun.spawn(
      ["git", "-C", PROJECT_ROOT, "branch", "-d", issue.fixTarget],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return code === 0
      ? `Deleted stale branch ${issue.fixTarget}`
      : `Delete failed: ${stderr}`;
  }

  if (issue.fixAction === "git_stash") {
    const proc = Bun.spawn(
      ["git", "-C", PROJECT_ROOT, "stash", "--include-untracked"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return code === 0 ? "Stashed dirty working tree" : `Stash failed: ${stderr}`;
  }

  return `No auto-fix available for action: ${issue.fixAction}`;
}

// ============================================================
// MAIN
// ============================================================

export async function main() {
  console.log("[health-monitor] Starting health checks...");

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID");
    process.exit(1);
  }

  const state = await loadState();
  const pending = await loadPending();

  // Clean up expired suppressions
  const now = new Date().toISOString();
  for (const [key, until] of Object.entries(state.suppressedUntil)) {
    if (until < now) delete state.suppressedUntil[key];
  }

  // Clean up old resolved/suppressed issues (keep last 50)
  pending.issues = pending.issues
    .filter(
      (i) =>
        i.status === "pending" ||
        (i.status === "suppressed" &&
          i.suppressedUntil &&
          i.suppressedUntil > now),
    )
    .slice(0, 50);

  // Run all health checks
  const allResults: HealthCheckResult[] = [];

  const checks = await Promise.allSettled([
    checkServices(),
    checkTypescript(),
    checkDependencies(),
    checkResources(),
    checkLogs(),
    checkIntegrations(),
  ]);

  for (const check of checks) {
    if (check.status === "fulfilled") {
      allResults.push(...check.value);
    }
  }

  // Classify results
  const issues: HealthCheckResult[] = allResults.filter(
    (r) => r.status !== "ok",
  );
  const okCount = allResults.filter((r) => r.status === "ok").length;

  console.log(
    `[health-monitor] ${okCount} OK, ${issues.length} issue(s) found`,
  );

  if (issues.length === 0) {
    state.lastRun = now;
    state.knownIssues = [];
    await saveState(state);
    await savePending(pending);
    console.log("[health-monitor] All checks passed.");
    return;
  }

  // Process issues
  const criticals: HealthIssue[] = [];
  const warnings: HealthIssue[] = [];
  const infos: string[] = [];

  for (const result of issues) {
    const severity = classifySeverity(result);
    const issueKey = `${result.checkName}:${result.detail.substring(0, 80)}`;

    // Skip suppressed issues
    if (state.suppressedUntil[issueKey]) continue;

    if (severity === "info") {
      infos.push(result.detail);
      continue;
    }

    const issue: HealthIssue = {
      id: generateId(),
      timestamp: now,
      check: result.checkName,
      severity,
      title: result.detail.split("\n")[0],
      detail: result.detail,
      fixAction: result.fixAction || "",
      fixTarget: result.fixTarget || "",
      status: "pending",
    };

    if (severity === "critical") {
      criticals.push(issue);
    } else {
      warnings.push(issue);
    }
  }

  // Auto-fix critical issues
  const autoFixResults: string[] = [];
  for (const issue of criticals) {
    if (issue.fixAction) {
      console.log(
        `[health-monitor] Auto-fixing critical: ${issue.title}`,
      );
      const result = await autoFix(issue);
      autoFixResults.push(`${issue.title} → ${result}`);
      issue.status = "resolved";
    }
    pending.issues.push(issue);
  }

  // Send notifications for warnings with buttons
  for (const issue of warnings) {
    const buttons = [];
    if (issue.fixAction) {
      buttons.push({ text: "Fix", callback_data: `hm:fix:${issue.id}` });
    }
    buttons.push(
      { text: "Ignore 24h", callback_data: `hm:ignore:${issue.id}` },
      { text: "Details", callback_data: `hm:detail:${issue.id}` },
    );

    const msgId = await sendTelegram(
      `<b>Nova Health Warning</b>\n\n<b>${issue.check}</b>: ${issue.title}`,
      [buttons],
    );
    if (msgId) issue.telegramMessageId = msgId;
    pending.issues.push(issue);
  }

  // Send auto-fix summary for criticals
  if (autoFixResults.length > 0) {
    const msg =
      "<b>Nova Health Monitor — Auto-fixes applied:</b>\n\n" +
      autoFixResults.map((r) => `• ${r}`).join("\n");
    await sendTelegram(msg);
  }

  // Log info items (don't send individually)
  if (infos.length > 0) {
    console.log(
      `[health-monitor] Info items: ${infos.join("; ")}`,
    );
  }

  // Update state
  state.lastRun = now;
  state.knownIssues = issues.map(
    (i) => `${i.checkName}:${i.detail.substring(0, 80)}`,
  );
  await saveState(state);
  await savePending(pending);

  console.log("[health-monitor] Done.");
}

if (import.meta.main) main().catch((err) => {
  console.error("[health-monitor] Fatal:", err);
  process.exit(1);
});
