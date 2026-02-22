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

import { spawn } from "bun";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { dirname, join } from "path";
import { computeNextTrigger } from "../src/memory.ts";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_ROOT = join(dirname(import.meta.path), "..");

const MAX_CONCURRENT = 3;

// ============================================================
// SUPABASE
// ============================================================

function initSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
    process.exit(1);
  }
  return createClient(url, key);
}

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

async function getUserInfo(supabase: SupabaseClient, userId: string): Promise<UserInfo | null> {
  const { data, error } = await supabase.rpc("get_user_for_dispatch", { p_user_id: userId });
  if (error || !data?.length) return null;
  return data[0];
}

async function executeTask(
  supabase: SupabaseClient,
  task: DueTask,
  userInfo: UserInfo
): Promise<{ success: boolean; result: string }> {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: userInfo.timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  // Build the prompt
  let prompt = `You are ${userInfo.name}'s personal AI assistant. A scheduled task has triggered.

Current time: ${timeStr}
Task: ${task.title}
`;

  if (task.condition) {
    prompt += `
CONDITION TO EVALUATE FIRST:
${task.condition}

Check this condition using your available tools. If the condition is NOT met, respond with exactly:
CONDITION_NOT_MET
and nothing else. If the condition IS met, proceed with the instructions below.

`;
  }

  prompt += `
INSTRUCTIONS:
${task.instructions}

${userInfo.profile_text ? `Profile:\n${userInfo.profile_text}\n` : ""}
Keep your response concise and conversational — this will be sent directly to ${userInfo.name} via Telegram.
Do NOT include any [SCHEDULE:] or [REMEMBER:] tags in your response.`;

  try {
    const proc = spawn(
      [
        CLAUDE_PATH,
        "-p",
        prompt,
        "--output-format",
        "text",
        "--permission-mode",
        "bypassPermissions",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          CLAUDECODE: undefined,
        },
      }
    );

    const [output, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error(`Claude error for task "${task.title}":`, stderr);
      return { success: false, result: stderr || "Claude CLI error" };
    }

    const result = output.trim();

    // Check if condition was not met
    if (result === "CONDITION_NOT_MET") {
      console.log(`Task "${task.title}": condition not met, skipping`);
      return { success: true, result: "Condition not met — skipped" };
    }

    return { success: true, result };
  } catch (error) {
    console.error(`Execution error for task "${task.title}":`, error);
    return { success: false, result: String(error) };
  }
}

// ============================================================
// TASK ADVANCEMENT (recurring vs one-time)
// ============================================================

async function advanceTask(
  supabase: SupabaseClient,
  task: DueTask,
  result: string,
  success: boolean
): Promise<void> {
  const newRunCount = task.run_count + 1;
  const isMaxed = task.max_runs !== null && newRunCount >= task.max_runs;

  if (!success) {
    // Failed — increment run count but keep active (unless maxed)
    await supabase
      .from("scheduled_tasks")
      .update({
        last_run_at: new Date().toISOString(),
        last_result: result.substring(0, 2000),
        run_count: newRunCount,
        status: isMaxed ? "failed" : "active",
        updated_at: new Date().toISOString(),
      })
      .eq("id", task.id);
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
      await supabase
        .from("scheduled_tasks")
        .update({
          trigger_at: nextTrigger.toISOString(),
          last_run_at: new Date().toISOString(),
          last_result: result.substring(0, 2000),
          run_count: newRunCount,
          updated_at: new Date().toISOString(),
        })
        .eq("id", task.id);
    } else {
      // Can't compute next trigger — mark completed
      await supabase
        .from("scheduled_tasks")
        .update({
          status: "completed",
          last_run_at: new Date().toISOString(),
          last_result: result.substring(0, 2000),
          run_count: newRunCount,
          updated_at: new Date().toISOString(),
        })
        .eq("id", task.id);
    }
  } else {
    // One-time or max runs reached — mark completed
    await supabase
      .from("scheduled_tasks")
      .update({
        status: "completed",
        last_run_at: new Date().toISOString(),
        last_result: result.substring(0, 2000),
        run_count: newRunCount,
        updated_at: new Date().toISOString(),
      })
      .eq("id", task.id);
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

  const supabase = initSupabase();

  // Fetch due tasks
  const { data: dueTasks, error } = await supabase.rpc("get_due_tasks");

  if (error) {
    console.error("Error fetching due tasks:", error.message);
    process.exit(1);
  }

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
        const userInfo = await getUserInfo(supabase, task.user_id);
        if (!userInfo) {
          console.error(`No user found for ${task.user_id}, skipping`);
          return;
        }

        // Execute the task
        const { success, result } = await executeTask(supabase, task, userInfo);

        // Send result to user (skip if condition not met or task failed silently)
        if (success && result !== "Condition not met — skipped") {
          const sent = await sendTelegram(userInfo.telegram_id, result);
          if (sent) {
            console.log(`Sent result to ${userInfo.name}`);

            // Save as assistant message for conversation continuity
            await supabase.from("messages").insert({
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
        await advanceTask(supabase, task, result, success);
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
