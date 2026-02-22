#!/usr/bin/env bun
/**
 * Task Scheduler — Create, list, and manage recurring tasks via launchd
 *
 * Nova can call this to schedule her own recurring tasks dynamically.
 *
 * Usage:
 *   bun run src/scheduler.ts create <name> <schedule> <command>
 *   bun run src/scheduler.ts list
 *   bun run src/scheduler.ts delete <name>
 *   bun run src/scheduler.ts run-once <name>
 *
 * Schedule formats:
 *   "daily:HH:MM"          — every day at HH:MM
 *   "weekdays:HH:MM"       — Mon-Fri at HH:MM
 *   "weekly:DAY:HH:MM"     — specific day (0=Sun, 1=Mon, ..., 6=Sat)
 *   "interval:SECONDS"     — every N seconds
 *   "hourly:MM"            — every hour at :MM
 *
 * Examples:
 *   bun run src/scheduler.ts create "weekly-metrics" "weekly:1:09:00" "bun run services/smart-checkin.ts"
 *   bun run src/scheduler.ts create "check-email" "interval:3600" "bun run src/check-email.ts"
 *   bun run src/scheduler.ts list
 *   bun run src/scheduler.ts delete "weekly-metrics"
 */

import { writeFile, readFile, unlink } from "fs/promises";
import { join } from "path";
import { spawn } from "bun";

const PLIST_DIR = join(process.env.HOME || "~", "Library", "LaunchAgents");
const PROJECT_ROOT = "/Users/djbelieny/Projects/nova";
const LOGS_DIR = join(PROJECT_ROOT, "logs");
const BUN_PATH = "/Users/djbelieny/.bun/bin/bun";
const NODE_PATH = "/Users/djbelieny/.nvm/versions/node/v23.11.1/bin";
const PREFIX = "com.nova.task";

interface ScheduleConfig {
  type: "calendar" | "interval";
  interval?: number;
  calendarIntervals?: Array<{
    Hour?: number;
    Minute?: number;
    Weekday?: number;
  }>;
}

function parseSchedule(schedule: string): ScheduleConfig {
  const parts = schedule.split(":");

  switch (parts[0]) {
    case "daily": {
      const hour = parseInt(parts[1]);
      const minute = parseInt(parts[2] || "0");
      return {
        type: "calendar",
        calendarIntervals: [{ Hour: hour, Minute: minute }],
      };
    }
    case "weekdays": {
      const hour = parseInt(parts[1]);
      const minute = parseInt(parts[2] || "0");
      return {
        type: "calendar",
        calendarIntervals: [1, 2, 3, 4, 5].map((day) => ({
          Weekday: day,
          Hour: hour,
          Minute: minute,
        })),
      };
    }
    case "weekly": {
      const day = parseInt(parts[1]);
      const hour = parseInt(parts[2]);
      const minute = parseInt(parts[3] || "0");
      return {
        type: "calendar",
        calendarIntervals: [{ Weekday: day, Hour: hour, Minute: minute }],
      };
    }
    case "interval": {
      const seconds = parseInt(parts[1]);
      return { type: "interval", interval: seconds };
    }
    case "hourly": {
      const minute = parseInt(parts[1] || "0");
      return {
        type: "calendar",
        calendarIntervals: Array.from({ length: 24 }, (_, h) => ({
          Hour: h,
          Minute: minute,
        })),
      };
    }
    default:
      throw new Error(
        `Unknown schedule format: ${parts[0]}. Use daily, weekdays, weekly, interval, or hourly.`
      );
  }
}

function buildPlist(
  label: string,
  command: string,
  schedule: ScheduleConfig
): string {
  // Split command into args — supports "bun run script.ts arg1 arg2"
  const cmdParts = command.split(/\s+/);

  const argsXml = cmdParts
    .map((arg) => `        <string>${escapeXml(arg)}</string>`)
    .join("\n");

  let scheduleXml: string;
  if (schedule.type === "interval") {
    scheduleXml = `    <key>StartInterval</key>
    <integer>${schedule.interval}</integer>`;
  } else {
    const intervals = schedule.calendarIntervals!
      .map((ci) => {
        const entries: string[] = [];
        if (ci.Weekday !== undefined) {
          entries.push(`            <key>Weekday</key>\n            <integer>${ci.Weekday}</integer>`);
        }
        if (ci.Hour !== undefined) {
          entries.push(`            <key>Hour</key>\n            <integer>${ci.Hour}</integer>`);
        }
        if (ci.Minute !== undefined) {
          entries.push(`            <key>Minute</key>\n            <integer>${ci.Minute}</integer>`);
        }
        return `        <dict>\n${entries.join("\n")}\n        </dict>`;
      })
      .join("\n");

    scheduleXml = `    <key>StartCalendarInterval</key>
    <array>
${intervals}
    </array>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>

    <key>ProgramArguments</key>
    <array>
${argsXml}
    </array>

    <key>WorkingDirectory</key>
    <string>${PROJECT_ROOT}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${NODE_PATH}:/Users/djbelieny/.bun/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>${process.env.HOME}</string>
    </dict>

${scheduleXml}

    <key>StandardOutPath</key>
    <string>${LOGS_DIR}/${label}.log</string>

    <key>StandardErrorPath</key>
    <string>${LOGS_DIR}/${label}.error.log</string>
</dict>
</plist>`;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ============================================================
// COMMANDS
// ============================================================

async function createTask(name: string, schedule: string, command: string) {
  const label = `${PREFIX}.${name}`;
  const plistPath = join(PLIST_DIR, `${label}.plist`);

  const scheduleConfig = parseSchedule(schedule);
  const plist = buildPlist(label, command, scheduleConfig);

  // Unload if already exists
  try {
    const proc = spawn(["launchctl", "unload", plistPath], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
  } catch {}

  await writeFile(plistPath, plist);

  // Load into launchd
  const proc = spawn(["launchctl", "load", plistPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.error(`Failed to load task: ${stderr}`);
    process.exit(1);
  }

  console.log(`Task "${name}" created and loaded.`);
  console.log(`  Schedule: ${schedule}`);
  console.log(`  Command: ${command}`);
  console.log(`  Plist: ${plistPath}`);
}

async function listTasks() {
  const proc = spawn(["launchctl", "list"], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(proc.stdout).text();

  const novaLines = output.split("\n").filter((l) => l.includes(PREFIX) || l.includes("com.nova."));

  if (novaLines.length === 0) {
    console.log("No scheduled tasks found.");
    return;
  }

  console.log("Scheduled tasks:\n");
  for (const line of novaLines) {
    const parts = line.split("\t");
    const pid = parts[0]?.trim();
    const exitCode = parts[1]?.trim();
    const label = parts[2]?.trim();

    if (!label) continue;

    const status = pid === "-" ? `idle (last exit: ${exitCode})` : `running (PID: ${pid})`;

    // Try to read the plist to get schedule info
    const plistPath = join(PLIST_DIR, `${label}.plist`);
    let scheduleInfo = "";
    try {
      const content = await readFile(plistPath, "utf-8");
      if (content.includes("StartInterval")) {
        const match = content.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/);
        if (match) scheduleInfo = ` | every ${parseInt(match[1]) / 60} min`;
      } else if (content.includes("StartCalendarInterval")) {
        const hourMatch = content.match(/<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/);
        const minMatch = content.match(/<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/);
        if (hourMatch) {
          const h = parseInt(hourMatch[1]);
          const m = minMatch ? parseInt(minMatch[1]) : 0;
          const ampm = h >= 12 ? "PM" : "AM";
          const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
          scheduleInfo = ` | ${h12}:${m.toString().padStart(2, "0")} ${ampm}`;
        }
      }
    } catch {}

    console.log(`  ${label} — ${status}${scheduleInfo}`);
  }
}

async function deleteTask(name: string) {
  const label = name.startsWith(PREFIX) ? name : `${PREFIX}.${name}`;
  const plistPath = join(PLIST_DIR, `${label}.plist`);

  // Unload
  try {
    const proc = spawn(["launchctl", "unload", plistPath], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
  } catch {}

  // Delete plist
  try {
    await unlink(plistPath);
    console.log(`Task "${name}" deleted.`);
  } catch {
    console.error(`Task "${name}" not found at ${plistPath}`);
    process.exit(1);
  }
}

async function runOnce(name: string) {
  const label = name.startsWith(PREFIX) ? name : `${PREFIX}.${name}`;

  const proc = spawn(["launchctl", "start", label], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.error(`Failed to start task: ${stderr}`);
    process.exit(1);
  }

  console.log(`Task "${name}" triggered.`);
}

// ============================================================
// CLI
// ============================================================

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "create": {
    const [name, schedule, ...cmdParts] = args;
    if (!name || !schedule || cmdParts.length === 0) {
      console.error('Usage: scheduler.ts create <name> <schedule> <command>');
      console.error('');
      console.error('Schedule formats:');
      console.error('  daily:HH:MM        — every day at HH:MM');
      console.error('  weekdays:HH:MM     — Mon-Fri at HH:MM');
      console.error('  weekly:DAY:HH:MM   — specific day (0=Sun..6=Sat)');
      console.error('  interval:SECONDS   — every N seconds');
      console.error('  hourly:MM          — every hour at :MM');
      process.exit(1);
    }
    await createTask(name, schedule, cmdParts.join(" "));
    break;
  }
  case "list":
    await listTasks();
    break;
  case "delete": {
    if (!args[0]) {
      console.error("Usage: scheduler.ts delete <name>");
      process.exit(1);
    }
    await deleteTask(args[0]);
    break;
  }
  case "run-once": {
    if (!args[0]) {
      console.error("Usage: scheduler.ts run-once <name>");
      process.exit(1);
    }
    await runOnce(args[0]);
    break;
  }
  default:
    console.error("Usage: scheduler.ts <create|list|delete|run-once> [args]");
    process.exit(1);
}
