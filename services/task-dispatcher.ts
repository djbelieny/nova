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
import { spawnLeanClaude } from "../src/claude-spawn.ts";
import { computeNextTrigger } from "../src/memory.ts";

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
  if (instructionsLower.match(/email|gmail|inbox|send.*mail/)) mcpServers.push("google-workspace");
  if (instructionsLower.match(/calendar|event|schedule|meeting/)) mcpServers.push("google-workspace");
  if (instructionsLower.match(/notion|task|page|database/)) mcpServers.push("notion");
  if (instructionsLower.match(/search|web|find.*online|look.*up/)) mcpServers.push("tavily");
  // Dedupe
  const uniqueMcps = [...new Set(mcpServers)];

  try {
    const { output, exitCode, stderr } = await spawnLeanClaude({
      prompt,
      mcpServers: uniqueMcps,
      model: "haiku",
      maxTurns: 5,
    });

    if (exitCode !== 0) {
      console.error(`Claude error for task "${task.title}":`, stderr);
      return { success: false, result: stderr || "Claude CLI error" };
    }

    if (output === "CONDITION_NOT_MET") {
      console.log(`Task "${task.title}": condition not met, skipping`);
      return { success: true, result: "Condition not met — skipped" };
    }

    return { success: true, result: output };
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
    // Failed — increment run count but keep active (unless maxed)
    db.updateScheduledTask(task.id, {
      last_run_at: new Date().toISOString(),
      last_result: result.substring(0, 2000),
      run_count: newRunCount,
      status: isMaxed ? "failed" : "active",
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

async function main() {
  console.log("Running task dispatcher...");

  if (!BOT_TOKEN) {
    console.error("Missing TELEGRAM_BOT_TOKEN");
    process.exit(1);
  }

  const db = getDb();

  // Fetch due tasks
  const dueTasks = db.getDueTasks();

  if (!dueTasks?.length) {
    console.log("No due tasks");
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

  console.log("\nDispatcher complete");
}

main().catch((err) => {
  console.error("Dispatcher error:", err);
  process.exit(1);
});
