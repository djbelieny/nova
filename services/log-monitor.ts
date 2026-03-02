/**
 * Log Monitor
 *
 * Nova self-monitoring: reads her own log files, uses Claude to analyze
 * new entries, auto-fixes what it can, and escalates complex issues to
 * a Notion page + Telegram notification.
 *
 * Runs ~3x/day via scheduler (every 8 hours).
 *
 * Run: bun run services/log-monitor.ts
 */

import { readFile, writeFile, stat } from "fs/promises";
import { dirname, join, basename } from "path";
import { registerProvider, getDefaultProvider } from "../src/ai-provider.ts";
import { ClaudeProvider } from "../src/providers/claude.ts";
import { GeminiProvider } from "../src/providers/gemini.ts";
import { CodexProvider } from "../src/providers/codex.ts";

// Register AI providers (log-monitor runs standalone)
registerProvider(new ClaudeProvider());
registerProvider(new GeminiProvider());
registerProvider(new CodexProvider());

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const USER_NAME = process.env.USER_NAME || "";
const STATE_FILE =
  process.env.LOG_MONITOR_STATE_FILE || "/tmp/log-monitor-state.json";
const PROJECT_ROOT = join(dirname(import.meta.path), "..");
const LOGS_DIR = join(PROJECT_ROOT, "logs");

// Log files to monitor, ordered by priority
const MONITORED_LOGS: Array<{ file: string; priority: "critical" | "high" | "medium" }> = [
  { file: "com.nova.core.error.log", priority: "critical" },
  { file: "com.nova.core.log", priority: "high" },
  { file: "cloudflare-tunnel.error.log", priority: "high" },
  { file: "com.nova.dashboard.error.log", priority: "medium" },
  { file: "com.nova.smart-checkin.error.log", priority: "medium" },
  { file: "com.nova.voice-server.error.log", priority: "medium" },
];

// Exclude our own logs to avoid infinite loops
const SELF_LOG_PREFIX = "com.nova.task.log-monitor";

const MAX_CHARS_PER_FILE = 50_000;
const MAX_CHARS_TOTAL = 100_000;

// ============================================================
// STATE MANAGEMENT
// ============================================================

interface MonitorState {
  lastRunTime: string;
  fileOffsets: Record<string, number>;
  recentIssues: string[];
}

async function loadState(): Promise<MonitorState> {
  try {
    const content = await readFile(STATE_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return {
      lastRunTime: "",
      fileOffsets: {},
      recentIssues: [],
    };
  }
}

async function saveState(state: MonitorState): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================
// LOG COLLECTION
// ============================================================

interface LogEntry {
  file: string;
  priority: "critical" | "high" | "medium";
  content: string;
}

async function collectLogs(state: MonitorState): Promise<{
  entries: LogEntry[];
  newOffsets: Record<string, number>;
  isFirstRun: boolean;
}> {
  const isFirstRun = state.lastRunTime === "";
  const entries: LogEntry[] = [];
  const newOffsets: Record<string, number> = { ...state.fileOffsets };
  let totalChars = 0;

  for (const { file, priority } of MONITORED_LOGS) {
    if (totalChars >= MAX_CHARS_TOTAL) break;

    const filePath = join(LOGS_DIR, file);

    try {
      const fileStat = await stat(filePath);
      const fileSize = fileStat.size;
      const storedOffset = state.fileOffsets[file] ?? 0;

      // On first run, initialize offsets to current size (skip historical noise)
      if (isFirstRun) {
        newOffsets[file] = fileSize;
        continue;
      }

      // File rotated/truncated — reset offset
      const readFrom = fileSize < storedOffset ? 0 : storedOffset;

      if (fileSize <= readFrom) {
        // No new content
        newOffsets[file] = fileSize;
        continue;
      }

      // Read new content using Bun's file API
      const fileHandle = Bun.file(filePath);
      const bytesToRead = Math.min(fileSize - readFrom, MAX_CHARS_PER_FILE);
      const slice = fileHandle.slice(readFrom, readFrom + bytesToRead);
      const content = await slice.text();

      newOffsets[file] = readFrom + bytesToRead;

      if (content.trim()) {
        const cappedContent = content.substring(0, MAX_CHARS_PER_FILE - totalChars);
        entries.push({ file, priority, content: cappedContent });
        totalChars += cappedContent.length;
      }
    } catch {
      // File doesn't exist — skip silently
      newOffsets[file] = 0;
    }
  }

  return { entries, newOffsets, isFirstRun };
}

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(message: string): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: message,
        }),
      }
    );
    return response.ok;
  } catch {
    return false;
  }
}

// ============================================================
// CLAUDE ANALYSIS
// ============================================================

async function analyzeWithClaude(
  entries: LogEntry[],
  recentIssues: string[]
): Promise<{
  autoFixes: string[];
  escalations: string[];
  notify: boolean;
}> {
  const logSections = entries
    .map(
      (e) =>
        `--- ${e.file} [${e.priority}] ---\n${e.content}\n`
    )
    .join("\n");

  const prompt = `You are Nova's self-monitoring system. Analyze these new log entries from Nova's background services and take action.

LOG ENTRIES:
${logSections}

RECENTLY REPORTED ISSUES (avoid duplicates):
${recentIssues.length > 0 ? recentIssues.join("\n") : "None"}

CLASSIFICATION RULES:

AUTO-FIX (act immediately using your tools):
- Missing directories → create them
- Stale lock files → remove them
- Service crashed → restart via: launchctl unload then load the plist
- Config issues you can fix without code changes

ESCALATE (create a Notion page with full context):
- Source code bugs or persistent failures
- Authentication/API key issues
- External service outages
- Anything you're uncertain about
- Use your Notion tools to create a page titled "Nova Issue: [brief description]" with:
  - The relevant log excerpts
  - Your analysis of root cause
  - A suggested fix plan

IGNORE (no action needed):
- Normal startup/shutdown messages
- Routine operational logs (connections established, messages processed)
- Semantic search returning "no results" — that's normal
- Tunnel reconnection messages (transient)
- Claude CLI startup banners

RESPOND IN THIS EXACT FORMAT:
STATUS: CLEAN | ISSUES_FOUND
SUMMARY: [One sentence overview]
ACTIONS_TAKEN: [List of auto-fixes applied, or "none"]
ESCALATED: [List of Notion page titles created, or "none"]
NOTIFY: YES | NO
`;

  try {
    const result = await getDefaultProvider().call({
      prompt,
      outputFormat: "text",
      cwd: PROJECT_ROOT,
    });

    const output = result.text;

    // Parse structured response
    const statusMatch = output.match(/STATUS:\s*(CLEAN|ISSUES_FOUND)/i);
    const summaryMatch = output.match(/SUMMARY:\s*(.+?)(?=\nACTIONS_TAKEN:|$)/is);
    const actionsMatch = output.match(/ACTIONS_TAKEN:\s*(.+?)(?=\nESCALATED:|$)/is);
    const escalatedMatch = output.match(/ESCALATED:\s*(.+?)(?=\nNOTIFY:|$)/is);
    const notifyMatch = output.match(/NOTIFY:\s*(YES|NO)/i);

    const status = statusMatch?.[1]?.toUpperCase() || "CLEAN";
    const summary = summaryMatch?.[1]?.trim() || "";
    const actionsRaw = actionsMatch?.[1]?.trim() || "none";
    const escalatedRaw = escalatedMatch?.[1]?.trim() || "none";
    const notify = notifyMatch?.[1]?.toUpperCase() === "YES";

    console.log(`Status: ${status}`);
    console.log(`Summary: ${summary}`);

    const autoFixes =
      actionsRaw.toLowerCase() === "none"
        ? []
        : actionsRaw.split("\n").map((l) => l.replace(/^[-*]\s*/, "").trim()).filter(Boolean);

    const escalations =
      escalatedRaw.toLowerCase() === "none"
        ? []
        : escalatedRaw.split("\n").map((l) => l.replace(/^[-*]\s*/, "").trim()).filter(Boolean);

    return { autoFixes, escalations, notify };
  } catch (error) {
    console.error("Claude error:", error);
    return { autoFixes: [], escalations: [], notify: false };
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("Running log monitor...");

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID");
    process.exit(1);
  }

  const state = await loadState();
  const { entries, newOffsets, isFirstRun } = await collectLogs(state);

  if (isFirstRun) {
    console.log("First run — initialized file offsets, skipping historical logs.");
    await saveState({
      lastRunTime: new Date().toISOString(),
      fileOffsets: newOffsets,
      recentIssues: [],
    });
    return;
  }

  if (entries.length === 0) {
    console.log("No new log entries since last check.");
    state.lastRunTime = new Date().toISOString();
    state.fileOffsets = newOffsets;
    await saveState(state);
    return;
  }

  console.log(
    `Found new entries in ${entries.length} file(s): ${entries.map((e) => e.file).join(", ")}`
  );

  const { autoFixes, escalations, notify } = await analyzeWithClaude(
    entries,
    state.recentIssues
  );

  // Build Telegram notification
  if (notify && (autoFixes.length > 0 || escalations.length > 0)) {
    const lines: string[] = ["Nova Log Monitor Report:"];

    if (autoFixes.length > 0) {
      lines.push("");
      lines.push("Auto-fixed:");
      for (const fix of autoFixes) {
        lines.push(`  - ${fix}`);
      }
    }

    if (escalations.length > 0) {
      lines.push("");
      lines.push("Escalated to Notion:");
      for (const esc of escalations) {
        lines.push(`  - ${esc}`);
      }
    }

    const message = lines.join("\n");
    console.log("Sending notification...");
    const sent = await sendTelegram(message);
    if (sent) {
      console.log("Notification sent!");
    } else {
      console.error("Failed to send notification");
    }
  } else {
    console.log("Logs analyzed — no notification needed.");
  }

  // Update state
  const allNewIssues = [...autoFixes, ...escalations];
  const updatedRecentIssues = [...allNewIssues, ...state.recentIssues].slice(0, 10);

  await saveState({
    lastRunTime: new Date().toISOString(),
    fileOffsets: newOffsets,
    recentIssues: updatedRecentIssues,
  });
}

main();

// ============================================================
// SCHEDULING
// ============================================================
//
// Run every 8 hours (~3x/day):
//
//   bun run src/scheduler.ts create "log-monitor" "interval:28800" "bun run services/log-monitor.ts"
//
// Verify:
//   bun run src/scheduler.ts list
//
