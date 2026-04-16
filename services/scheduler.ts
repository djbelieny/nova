/**
 * Docker Scheduler — replaces config/nova.cron for Docker deployments.
 *
 * Spawns each service as a child process (same as cron does) so services
 * can use process.exit() freely without affecting the scheduler itself.
 *
 * All UTC times match config/nova.cron exactly.
 *
 * Run: bun run services/scheduler.ts
 */

import "dotenv/config";
import { spawn } from "bun";
import { join, dirname } from "path";

const SERVICES_DIR = join(dirname(import.meta.path));

async function runService(name: string, script: string): Promise<void> {
  console.log(`[scheduler] Running ${name}...`);
  try {
    const proc = spawn(["bun", "run", join(SERVICES_DIR, script)], {
      stdout: "inherit",
      stderr: "inherit",
      env: process.env,
    });
    await proc.exited;
    if (proc.exitCode !== 0) {
      console.error(`[scheduler] ${name} exited with code ${proc.exitCode}`);
    }
  } catch (err) {
    console.error(`[scheduler] ${name} failed to spawn:`, err);
  }
}

console.log("[scheduler] Starting Nova Docker Scheduler");
console.log("[scheduler] All times are UTC, matching config/nova.cron");

// Task dispatcher — every 60 seconds
setInterval(() => runService("task-dispatcher", "task-dispatcher.ts"), 60_000);

// Health monitor — every 30 minutes
setInterval(() => runService("health-monitor", "health-monitor.ts"), 30 * 60_000);

// All other services — checked every minute via tick
let lastTickMinute = -1;
setInterval(async () => {
  const now = new Date();
  const currentMinute = now.getUTCMinutes() + now.getUTCHours() * 60;
  if (currentMinute === lastTickMinute) return; // deduplicate
  lastTickMinute = currentMinute;

  const h = now.getUTCHours();
  const m = now.getUTCMinutes();

  // morning-briefing: 14:00
  if (h === 14 && m === 0) runService("morning-briefing", "morning-briefing.ts");

  // smart-checkin: 14:00, 15:30, 17:00, 19:00, 21:00, 23:00
  if (
    (h === 14 && m === 0) ||
    (h === 15 && m === 30) ||
    (h === 17 && m === 0) ||
    (h === 19 && m === 0) ||
    (h === 21 && m === 0) ||
    (h === 23 && m === 0)
  ) {
    runService("smart-checkin", "smart-checkin.ts");
  }

  // ai-news-monitor: 13:00, 18:00, 23:00
  if ((h === 13 || h === 18 || h === 23) && m === 0) runService("ai-news-monitor", "ai-news-monitor.ts");

  // social-post-suggester: 14:30
  if (h === 14 && m === 30) runService("social-post-suggester", "social-post-suggester.ts");

  // lead-suggester: 15:00
  if (h === 15 && m === 0) runService("lead-suggester", "lead-suggester.ts");

  // meta-ads-report: 13:30
  if (h === 13 && m === 30) runService("meta-ads-report", "meta-ads-report.ts");

  // memory-review: 8:00
  if (h === 8 && m === 0) runService("memory-review", "memory-review.ts");

  // dream: 7:00, 9:00
  if ((h === 7 || h === 9) && m === 0) runService("dream", "dream.ts");

  // log-monitor: 0:00, 8:00, 16:00
  if ((h === 0 || h === 8 || h === 16) && m === 0) runService("log-monitor", "log-monitor.ts");
}, 60_000);

// Run task-dispatcher once on startup
runService("task-dispatcher", "task-dispatcher.ts");

console.log("[scheduler] All jobs scheduled. Waiting...");
