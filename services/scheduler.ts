/**
 * Docker Scheduler — replaces config/nova.cron for Docker deployments.
 *
 * Runs all Nova scheduled services at the same UTC times as the system cron.
 * Each service handles its own rate-gating and idempotency.
 *
 * Run: bun run services/scheduler.ts
 */

import "dotenv/config";

// Import all scheduled services
import { main as taskDispatcher } from "./task-dispatcher.ts";
import { main as morningBriefing } from "./morning-briefing.ts";
import { main as smartCheckin } from "./smart-checkin.ts";
import { main as aiNewsMonitor } from "./ai-news-monitor.ts";
import { main as socialPostSuggester } from "./social-post-suggester.ts";
import { main as leadSuggester } from "./lead-suggester.ts";
import { main as metaAdsReport } from "./meta-ads-report.ts";
import { main as memoryReview } from "./memory-review.ts";
import { main as dream } from "./dream.ts";
import { main as logMonitor } from "./log-monitor.ts";
import { main as healthMonitor } from "./health-monitor.ts";

async function runSafely(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[scheduler] ${name} failed:`, err);
  }
}

console.log("[scheduler] Starting Nova Docker Scheduler");
console.log("[scheduler] All times are UTC, matching config/nova.cron");

// Task dispatcher — every 60 seconds
setInterval(() => runSafely("task-dispatcher", taskDispatcher), 60_000);

// Health monitor — every 30 minutes
setInterval(() => runSafely("health-monitor", healthMonitor), 30 * 60_000);

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
  if (h === 14 && m === 0) runSafely("morning-briefing", morningBriefing);

  // smart-checkin: 14:00, 15:30, 17:00, 19:00, 21:00, 23:00
  if (
    (h === 14 && m === 0) ||
    (h === 15 && m === 30) ||
    (h === 17 && m === 0) ||
    (h === 19 && m === 0) ||
    (h === 21 && m === 0) ||
    (h === 23 && m === 0)
  ) {
    runSafely("smart-checkin", smartCheckin);
  }

  // ai-news-monitor: 13:00, 18:00, 23:00
  if ((h === 13 || h === 18 || h === 23) && m === 0) runSafely("ai-news-monitor", aiNewsMonitor);

  // social-post-suggester: 14:30
  if (h === 14 && m === 30) runSafely("social-post-suggester", socialPostSuggester);

  // lead-suggester: 15:00
  if (h === 15 && m === 0) runSafely("lead-suggester", leadSuggester);

  // meta-ads-report: 13:30
  if (h === 13 && m === 30) runSafely("meta-ads-report", metaAdsReport);

  // memory-review: 8:00
  if (h === 8 && m === 0) runSafely("memory-review", memoryReview);

  // dream: 7:00, 9:00 (--idle equivalent: rate gate + idle check inside runDreamCycle)
  if ((h === 7 || h === 9) && m === 0) runSafely("dream", dream);

  // log-monitor: 0:00, 8:00, 16:00
  if ((h === 0 || h === 8 || h === 16) && m === 0) runSafely("log-monitor", logMonitor);
}, 60_000);

// Run task-dispatcher immediately on start
runSafely("task-dispatcher", taskDispatcher);

console.log("[scheduler] All jobs scheduled. Waiting...");
