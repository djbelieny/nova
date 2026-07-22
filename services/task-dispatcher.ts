/**
 * Scheduled Task Dispatcher
 *
 * Polls the scheduled_tasks table for due tasks and executes them via Claude CLI.
 * Each task gets its own Claude subprocess with the stored instructions + user context.
 * Results are sent to the user via Telegram Bot API.
 *
 * Run: bun run services/task-dispatcher.ts
 * Schedule: every 60 seconds via launchd (StartInterval)
 */

import { getDb, type Database } from "../src/db.ts";
import { registerProvider, getDefaultProvider, getProvider } from "../src/ai-provider.ts";
import { ClaudeProvider } from "../src/providers/claude.ts";
import { GeminiProvider } from "../src/providers/gemini.ts";
import { CodexProvider } from "../src/providers/codex.ts";

// Register AI providers (task-dispatcher runs standalone)
registerProvider(new ClaudeProvider());
registerProvider(new GeminiProvider());
registerProvider(new CodexProvider());
import { computeNextTrigger } from "../src/memory.ts";
import { resumeDueTimers, type RunStepFn } from "../src/process-engine.ts";
import { sweepOverdueTasks } from "../src/task-routing.ts";
import { withLock, PROCESS_ID } from "../src/locks.ts";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

const MAX_CONCURRENT = 3;

// ============================================================
// DATABASE
// ============================================================

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(chatId: string, message: string): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
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
// CLAUDE EXECUTION
// ============================================================

interface DueTask {
  id: string;
  user_id: string;
  created_by: string;
  title: string;
  instructions: string;
  trigger_at: string;
  recurrence: string | null;
  timezone: string;
  condition: string | null;
  max_runs: number | null;
  run_count: number;
  metadata: Record<string, any>;
}

interface UserInfo {
  id: string;
  telegram_id: string;
  name: string;
  timezone: string;
  profile_text: string;
}

function getUserInfo(db: Database, userId: string): UserInfo | null {
  const user = db.getUserById(userId);
  if (!user) return null;
  return user;
}

async function executeTask(
  task: DueTask,
  userInfo: UserInfo
): Promise<{ success: boolean; result: string }> {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: userInfo.timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  let prompt = `Task for ${userInfo.name}. Time: ${timeStr}\nTask: ${task.title}\n`;

  if (task.condition) {
    prompt += `\nCONDITION: ${task.condition}\nIf NOT met, respond exactly: CONDITION_NOT_MET\nIf met, proceed.\n`;
  }

  prompt += `\nINSTRUCTIONS:\n${task.instructions}\n\nBe concise. This goes directly to Telegram. No [SCHEDULE:] or [REMEMBER:] tags.`;

  // Determine which MCPs this task might need
  const instructionsLower = task.instructions.toLowerCase();
  const mcpServers: string[] = [];
  // Google Workspace is handled via gws CLI (not MCP), injected into agent prompts by buildGwsInstructions()
  if (instructionsLower.match(/notion|task|page|database/)) mcpServers.push("notion");
  if (instructionsLower.match(/search|web|find.*online|look.*up/)) mcpServers.push("tavily");
  // Dedupe
  const uniqueMcps = [...new Set(mcpServers)];

  try {
    const claude = getProvider("claude") ?? getDefaultProvider();
    const result = await claude.call({
      prompt,
      model: claude.mapModelTier("fast"),
      maxTurns: 5,
      outputFormat: "text",
    });

    if (result.text === "CONDITION_NOT_MET") {
      console.log(`Task "${task.title}": condition not met, skipping`);
      return { success: true, result: "Condition not met — skipped" };
    }

    return { success: true, result: result.text };
  } catch (error) {
    console.error(`Execution error for task "${task.title}":`, error);
    return { success: false, result: String(error) };
  }
}

// ============================================================
// TASK ADVANCEMENT (recurring vs one-time)
// ============================================================

function advanceTask(
  db: Database,
  task: DueTask,
  result: string,
  success: boolean
): void {
  const newRunCount = task.run_count + 1;
  const isMaxed = task.max_runs !== null && newRunCount >= task.max_runs;

  if (!success) {
    // Failed. For a recurring task, advance trigger_at to the next scheduled occurrence
    // so a persistently failing task doesn't get re-fetched every dispatch cycle (60s)
    // and hammer the AI provider forever. One-time tasks just go to "failed".
    let nextTriggerAt: string | undefined;
    if (task.recurrence && !isMaxed) {
      const next = computeNextTrigger(task.recurrence, task.timezone, new Date(task.trigger_at));
      if (next) nextTriggerAt = next.toISOString();
    }
    db.updateScheduledTask(task.id, {
      last_run_at: new Date().toISOString(),
      last_result: result.substring(0, 2000),
      run_count: newRunCount,
      // If we couldn't advance a recurring task (no next trigger), retire it instead of looping.
      status: isMaxed || (task.recurrence && !nextTriggerAt) ? "failed" : "active",
      ...(nextTriggerAt ? { trigger_at: nextTriggerAt } : {}),
      updated_at: new Date().toISOString(),
    });
    return;
  }

  if (task.recurrence && !isMaxed) {
    // Recurring — compute next trigger
    const nextTrigger = computeNextTrigger(
      task.recurrence,
      task.timezone,
      new Date(task.trigger_at)
    );

    if (nextTrigger) {
      db.updateScheduledTask(task.id, {
        trigger_at: nextTrigger.toISOString(),
        last_run_at: new Date().toISOString(),
        last_result: result.substring(0, 2000),
        run_count: newRunCount,
        updated_at: new Date().toISOString(),
      });
    } else {
      // Can't compute next trigger — mark completed
      db.updateScheduledTask(task.id, {
        status: "completed",
        last_run_at: new Date().toISOString(),
        last_result: result.substring(0, 2000),
        run_count: newRunCount,
        updated_at: new Date().toISOString(),
      });
    }
  } else {
    // One-time or max runs reached — mark completed
    db.updateScheduledTask(task.id, {
      status: "completed",
      last_run_at: new Date().toISOString(),
      last_result: result.substring(0, 2000),
      run_count: newRunCount,
      updated_at: new Date().toISOString(),
    });
  }
}

// ============================================================
// MAIN
// ============================================================

/** Run a single durable-process action step via the fast provider (pre-authorized, like scheduled tasks). */
const runProcessStep: RunStepFn = async (userId, description, agent) => {
  try {
    const claude = getProvider("claude") ?? getDefaultProvider();
    const who = getUserInfo(getDb(), userId)?.name || "the user";
    const prompt = `${agent ? `Acting as the ${agent} specialist. ` : ""}This is one step of a longer automated process for ${who}.\n\nTASK:\n${description}\n\nBe concise; complete the step.`;
    const result = await claude.call({ prompt, model: claude.mapModelTier("fast"), maxTurns: 5, outputFormat: "text" });
    return { success: true, result: result.text };
  } catch (error) {
    return { success: false, result: String(error) };
  }
};

async function main() {
  console.log("Running task dispatcher...");

  if (!BOT_TOKEN) {
    console.error("Missing TELEGRAM_BOT_TOKEN");
    process.exit(1);
  }

  const db = getDb();

  // Advisory lock so two overlapping dispatcher runs don't double-process the same work.
  if (!db.acquireLock("task-dispatcher", PROCESS_ID, 300)) {
    console.log("Another dispatcher run holds the lock; skipping this tick.");
    process.exit(0);
  }

  // Resume durable processes whose timers are now due (runs regardless of scheduled tasks)
  try {
    const resumed = await resumeDueTimers(db, runProcessStep);
    if (resumed) console.log(`Resumed ${resumed} durable process(es)`);
  } catch (err) {
    console.error("Process resume error:", err);
  }

  // Escalate assigned tasks past their SLA (DM assignee + owner, once each)
  try {
    const escalated = await sweepOverdueTasks(db, async (recipientUserId, message) => {
      const info = getUserInfo(db, recipientUserId);
      if (info?.telegram_id) await sendTelegram(info.telegram_id, message);
    });
    if (escalated) console.log(`Escalated ${escalated} overdue task(s)`);
  } catch (err) {
    console.error("Task escalation error:", err);
  }

  // Fetch due tasks
  const dueTasks = db.getDueTasks();

  if (!dueTasks?.length) {
    console.log("No due tasks");
    db.releaseLock("task-dispatcher", PROCESS_ID);
    process.exit(0);
  }

  console.log(`Found ${dueTasks.length} due task(s)`);

  // Process tasks with concurrency limit
  const batches: DueTask[][] = [];
  for (let i = 0; i < dueTasks.length; i += MAX_CONCURRENT) {
    batches.push(dueTasks.slice(i, i + MAX_CONCURRENT));
  }

  for (const batch of batches) {
    await Promise.all(
      batch.map(async (task: DueTask) => {
        console.log(`\nExecuting: "${task.title}" (${task.id})`);

        // Get user info
        const userInfo = getUserInfo(db, task.user_id);
        if (!userInfo) {
          console.error(`No user found for ${task.user_id}, skipping`);
          return;
        }

        // Execute the task
        const { success, result } = await executeTask(task, userInfo);

        // Send result to user (skip if condition not met or task failed silently)
        if (success && result !== "Condition not met — skipped") {
          const sent = await sendTelegram(userInfo.telegram_id, result);
          if (sent) {
            console.log(`Sent result to ${userInfo.name}`);

            // Save as assistant message for conversation continuity
            db.saveMessage({
              role: "assistant",
              content: result,
              channel: "telegram",
              user_id: task.user_id,
              metadata: {
                source: "scheduled_task",
                task_id: task.id,
                task_title: task.title,
              },
            });
          } else {
            console.error(`Failed to send to ${userInfo.name}`);
          }
        }

        // Advance the task (recurring → next trigger, one-time → completed)
        advanceTask(db, task, result, success);
        console.log(`Task "${task.title}" processed`);
      })
    );
  }

  db.releaseLock("task-dispatcher", PROCESS_ID);
  console.log("\nDispatcher complete");
}

main().catch((err) => {
  console.error("Dispatcher error:", err);
  process.exit(1);
});
