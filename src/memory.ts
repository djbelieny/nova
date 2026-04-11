/**
 * Memory Module
 *
 * Persistent facts, goals, and preferences stored in Supabase.
 * Claude manages memory automatically via intent tags in its responses:
 *   [REMEMBER: fact]
 *   [GOAL: text | DEADLINE: date]
 *   [DONE: search text]
 *
 * Nova parses these tags, saves to the database, and strips them
 * from the response before sending to the user.
 */

import type { Database } from "./db.ts";
import { generateEmbedding } from "./embeddings.ts";
import { embeddingToBlob } from "./db.ts";

/** Escape SQL LIKE/ILIKE wildcards to prevent wildcard injection. */
function escapeIlike(text: string): string {
  return text.replace(/[%_\\]/g, (c) => `\\${c}`);
}

/**
 * Parse Claude's response for memory intent tags.
 * Saves facts/goals to Supabase and returns the cleaned response.
 */
export async function processMemoryIntents(
  db: Database | null,
  response: string,
  userId: string,
  userTimezone?: string
): Promise<string> {
  if (!db) return response;

  let clean = response;

  // [REMEMBER: fact to store] — with duplicate detection
  for (const match of response.matchAll(/\[REMEMBER:\s*(.+?)\]/gi)) {
    const fact = match[1];
    // Check for existing similar fact
    const existing = db.findMemoryByContent(userId, "fact", fact.substring(0, 100));

    if (!existing) {
      const emb = await generateEmbedding(fact);
      db.insertMemory({
        type: "fact",
        content: fact,
        user_id: userId,
        scope: "private",
        embedding: emb || undefined,
      });
    }
    clean = clean.replace(match[0], "");
  }

  // [SHARE: fact to share with team]
  for (const match of response.matchAll(/\[SHARE:\s*(.+?)\]/gi)) {
    const emb = await generateEmbedding(match[1]);
    db.insertMemory({
      type: "fact",
      content: match[1],
      user_id: userId,
      scope: "shared",
      embedding: emb || undefined,
    });
    clean = clean.replace(match[0], "");
  }

  // [GOAL: text] or [GOAL: text | DEADLINE: date]
  for (const match of response.matchAll(
    /\[GOAL:\s*(.+?)(?:\s*\|\s*DEADLINE:\s*(.+?))?\]/gi
  )) {
    const emb = await generateEmbedding(match[1]);
    db.insertMemory({
      type: "goal",
      content: match[1],
      deadline: match[2] || undefined,
      user_id: userId,
      embedding: emb || undefined,
    });
    clean = clean.replace(match[0], "");
  }

  // [DONE: search text for completed goal]
  for (const match of response.matchAll(/\[DONE:\s*(.+?)\]/gi)) {
    const goal = db.findMemoryByContent(userId, "goal", match[1]);

    if (goal) {
      db.updateMemory(goal.id, {
        type: "completed_goal",
        completed_at: new Date().toISOString(),
      });
    }
    clean = clean.replace(match[0], "");
  }

  // [TASK: agent | description] — create a new task
  for (const match of response.matchAll(/\[TASK:\s*(.+?)\s*\|\s*(.+?)\]/gi)) {
    db.insertTask({
      agent: match[1],
      description: match[2],
      status: "pending",
      user_id: userId,
    });
    clean = clean.replace(match[0], "");
  }

  // [TASK_START: search text] — mark matching pending task as in_progress
  for (const match of response.matchAll(/\[TASK_START:\s*(.+?)\]/gi)) {
    const task = db.findTaskByDescription(userId, ["pending"], match[1]);

    if (task) {
      db.updateTask(task.id, { status: "in_progress" });
    }
    clean = clean.replace(match[0], "");
  }

  // [TASK_DONE: search text | result] — mark matching active task as done
  for (const match of response.matchAll(/\[TASK_DONE:\s*(.+?)\s*\|\s*(.+?)\]/gi)) {
    const task = db.findTaskByDescription(userId, ["pending", "in_progress"], match[1]);

    if (task) {
      db.updateTask(task.id, { status: "completed", result: match[2] });
    }
    clean = clean.replace(match[0], "");
  }

  // [TASK_BLOCKED: search text | reason] — mark matching active task as blocked
  for (const match of response.matchAll(/\[TASK_BLOCKED:\s*(.+?)\s*\|\s*(.+?)\]/gi)) {
    const task = db.findTaskByDescription(userId, ["pending", "in_progress"], match[1]);

    if (task) {
      db.updateTask(task.id, { status: "blocked", result: match[2] });
    }
    clean = clean.replace(match[0], "");
  }

  // [TASK_CANCEL: search text] — cancel a matching task
  for (const match of response.matchAll(/\[TASK_CANCEL:\s*(.+?)\]/gi)) {
    const task = db.findTaskByDescription(userId, ["pending", "in_progress", "blocked"], match[1]);

    if (task) {
      db.updateTask(task.id, { status: "cancelled" });
    }
    clean = clean.replace(match[0], "");
  }

  // [SCHEDULE: title | datetime | instructions]
  // [SCHEDULE: title | datetime | instructions | RECUR: rule]
  // [SCHEDULE: title | datetime | instructions | RECUR: rule | IF: condition]
  for (const match of response.matchAll(
    /\[SCHEDULE:\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)(?:\s*\|\s*RECUR:\s*(.+?))?(?:\s*\|\s*IF:\s*(.+?))?\]/gi
  )) {
    const title = match[1].trim();
    const rawTrigger = match[2].trim();
    const instructions = match[3].trim();
    const recurrence = match[4]?.trim() || null;
    const condition = match[5]?.trim() || null;
    const tz = userTimezone || "UTC";

    const triggerAt = parseScheduleTrigger(rawTrigger, tz);
    if (triggerAt) {
      const isOneTime = !recurrence;
      db.insertScheduledTask({
        user_id: userId,
        created_by: "user",
        title,
        instructions,
        trigger_at: triggerAt.toISOString(),
        recurrence,
        timezone: tz,
        condition,
        max_runs: isOneTime ? 1 : null,
      });
    }
    clean = clean.replace(match[0], "");
  }

  // [SCHEDULE_CANCEL: search text]
  for (const match of response.matchAll(/\[SCHEDULE_CANCEL:\s*(.+?)\]/gi)) {
    const task = db.findScheduledTaskByTitle(userId, match[1]);

    if (task) {
      db.updateScheduledTask(task.id, { status: "cancelled" });
    }
    clean = clean.replace(match[0], "");
  }

  // [MESSAGE: @username | content] — inter-user messaging
  const messageTagRegex = /\[MESSAGE:\s*@([^\s|]+)\s*\|\s*([^\]]+)\]/g;
  let msgMatch: RegExpExecArray | null;
  while ((msgMatch = messageTagRegex.exec(response)) !== null) {
    const targetUsername = msgMatch[1].trim();
    const messageContent = msgMatch[2].trim();

    try {
      const allUsers = db.getAllActiveUsers();
      const target = allUsers.find((u: any) =>
        u.name?.toLowerCase() === targetUsername.toLowerCase() ||
        u.telegram_id === targetUsername
      );

      if (target) {
        db.saveInterUserMessage({
          from_user_id: userId,
          to_user_id: target.id,
          content: messageContent,
        });
      } else {
        console.warn(`[memory] Inter-user message: user "@${targetUsername}" not found`);
      }
    } catch (err) {
      console.error("[memory] Inter-user message failed:", err);
    }
    clean = clean.replace(msgMatch[0], "");
  }

  return clean.trim();
}

/**
 * Get all facts and active goals for prompt context.
 */
export async function getMemoryContext(
  db: Database | null,
  userId: string
): Promise<string> {
  if (!db) return "";

  try {
    const facts = db.getFacts(userId);
    const goals = db.getActiveGoals(userId);

    const parts: string[] = [];
    const idsToUpdate: string[] = [];

    if (facts?.length) {
      // Cap at 50 facts to prevent unbounded growth
      const capped = facts.slice(0, 50);
      capped.forEach((f: any) => idsToUpdate.push(f.id));
      const suffix = facts.length > 50
        ? `\n[...${facts.length - 50} more facts truncated...]`
        : "";
      parts.push(
        "FACTS:\n" +
          capped.map((f: any) => `- ${f.content}`).join("\n") + suffix
      );
    }

    if (goals?.length) {
      goals.forEach((g: any) => idsToUpdate.push(g.id));
      parts.push(
        "GOALS:\n" +
          goals
            .map((g: any) => {
              const deadline = g.deadline
                ? ` (by ${new Date(g.deadline).toLocaleDateString()})`
                : "";
              return `- ${g.content}${deadline}`;
            })
            .join("\n")
      );
    }

    if (idsToUpdate.length > 0) {
      db.updateMultipleMemoryAccessTimes(idsToUpdate);
    }

    return parts.join("\n\n");
  } catch (error) {
    console.error("Memory context error:", error);
    return "";
  }
}

/**
 * Get active agent tasks for prompt context.
 */
export async function getTaskContext(
  db: Database | null,
  userId: string
): Promise<string> {
  if (!db) return "";

  try {
    const data = db.getActiveTasks(userId);

    if (!data?.length) return "";

    // Cap at 20 tasks to prevent unbounded growth
    const tasks = data.slice(0, 20);
    const lines = tasks.map(
      (t: any) => `- [${t.agent}] ${t.description} (${t.status})`
    );
    if (data.length > 20) {
      lines.push(`[...${data.length - 20} more tasks truncated...]`);
    }

    return "ACTIVE TASKS:\n" + lines.join("\n");
  } catch (error) {
    console.warn("Task context error:", error);
    return "";
  }
}

/**
 * Get recent conversation history (chronological, last N messages).
 * Provides immediate conversational context — "what were we just talking about?"
 */
export async function getRecentHistory(
  db: Database | null,
  userId: string,
  count: number = 12
): Promise<string> {
  if (!db) return "";

  try {
    const data = db.getRecentMessages(userId, count);

    if (!data?.length) return "";

    // Data comes DESC from DB, reverse to chronological
    const messages = [...data].reverse();

    const lines = messages.map((m: any) => {
      const ts = new Date(m.created_at).toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
      return `[${ts} ${m.role}]: ${m.content}`;
    });

    // Secondary char limit — drop oldest messages if total exceeds 8,000 chars
    const MAX_HISTORY_CHARS = 8_000;
    while (lines.length > 1 && lines.join("\n").length > MAX_HISTORY_CHARS) {
      lines.shift();
    }

    return "RECENT CONVERSATION:\n" + lines.join("\n");
  } catch (error) {
    console.warn("Recent history error:", error);
    return "";
  }
}

/**
 * Semantic search for relevant past messages.
 * Generates embedding locally and calls pgvector match functions via Supabase RPC.
 */
export async function getRelevantContext(
  db: Database | null,
  query: string,
  userId: string
): Promise<string> {
  if (!db) return "";

  try {
    const { semanticSearch } = await import("./embeddings.ts");
    const data = await semanticSearch(query, {
      table: "messages",
      matchCount: 5,
      userId,
    });

    if (!data?.length) {
      return "";
    }

    // Cap each result to 500 chars to prevent a single long message from dominating
    const MAX_RESULT_CHARS = 500;
    return (
      "RELEVANT PAST MESSAGES:\n" +
      data
        .map((m: any) => {
          const content = m.content.length > MAX_RESULT_CHARS
            ? m.content.slice(0, MAX_RESULT_CHARS) + "..."
            : m.content;
          return `[${m.role}]: ${content}`;
        })
        .join("\n")
    );
  } catch (error) {
    console.warn("Semantic search unavailable:", error);
    return "";
  }
}

/**
 * Parse a trigger time string into a Date.
 * Supports: ISO datetime (2026-02-19T15:00:00), relative (+30m, +2h, +1d).
 */
export function parseScheduleTrigger(raw: string, timezone: string): Date | null {
  // Relative: +30m, +2h, +1d
  const relMatch = raw.match(/^\+(\d+)([mhd])$/i);
  if (relMatch) {
    const amount = parseInt(relMatch[1]);
    const unit = relMatch[2].toLowerCase();
    const now = new Date();
    if (unit === "m") now.setMinutes(now.getMinutes() + amount);
    else if (unit === "h") now.setHours(now.getHours() + amount);
    else if (unit === "d") now.setDate(now.getDate() + amount);
    return now;
  }

  // ISO datetime — parse directly
  const parsed = new Date(raw);
  if (!isNaN(parsed.getTime())) return parsed;

  return null;
}

/**
 * Compute the next trigger_at for a recurring task.
 * Recurrence DSL: daily:HH:MM, weekly:DAY:HH:MM, weekdays:HH:MM, interval:SECONDS
 */
export function computeNextTrigger(recurrence: string, timezone: string, lastTrigger: Date): Date | null {
  const parts = recurrence.split(":");

  if (parts[0] === "interval" && parts[1]) {
    const seconds = parseInt(parts[1]);
    if (isNaN(seconds)) return null;
    return new Date(lastTrigger.getTime() + seconds * 1000);
  }

  if (parts[0] === "daily" && parts[1] && parts[2]) {
    const hour = parseInt(parts[1]);
    const minute = parseInt(parts[2]);
    const next = new Date(lastTrigger);
    next.setDate(next.getDate() + 1);
    // Set time in UTC approximation (timezone handling is simplified)
    next.setUTCHours(hour, minute, 0, 0);
    return next;
  }

  if (parts[0] === "weekly" && parts[1] && parts[2] && parts[3]) {
    const targetDay = parseInt(parts[1]); // 0=Sunday, 1=Monday, etc.
    const hour = parseInt(parts[2]);
    const minute = parseInt(parts[3]);
    const next = new Date(lastTrigger);
    const currentDay = next.getUTCDay();
    let daysAhead = targetDay - currentDay;
    if (daysAhead <= 0) daysAhead += 7;
    next.setDate(next.getDate() + daysAhead);
    next.setUTCHours(hour, minute, 0, 0);
    return next;
  }

  if (parts[0] === "weekdays" && parts[1] && parts[2]) {
    const hour = parseInt(parts[1]);
    const minute = parseInt(parts[2]);
    const next = new Date(lastTrigger);
    do {
      next.setDate(next.getDate() + 1);
    } while (next.getUTCDay() === 0 || next.getUTCDay() === 6); // skip weekends
    next.setUTCHours(hour, minute, 0, 0);
    return next;
  }

  return null;
}

/**
 * Get recent board decisions for prompt context injection.
 * Queries the shared Supabase decisions table via ExecComms.
 * Falls back gracefully if ExecComms is not initialized.
 */
export async function getDecisionContext(
  userId: string,
  comms?: any // ExecComms instance (optional)
): Promise<string> {
  if (!comms) return "";

  try {
    const decisions = await comms.getRecentDecisions(userId, 20);
    if (!decisions?.length) return "";

    const lines = decisions.map((d: any) => {
      const date = new Date(d.created_at).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });
      const confidence = d.confidence ? ` (confidence: ${(d.confidence * 100).toFixed(0)}%)` : "";
      const outcome = d.outcome && d.outcome !== "pending" ? ` [${d.outcome}]` : "";
      return `- [${date}] ${d.question} → ${d.chosen_option}${confidence}${outcome}`;
    });

    return "PAST DECISIONS:\n" + lines.join("\n");
  } catch (error) {
    console.warn("Decision context error:", error);
    return "";
  }
}

/**
 * Get active scheduled tasks for prompt context injection.
 */
export async function getScheduleContext(
  db: Database | null,
  userId: string,
  userTimezone?: string
): Promise<string> {
  if (!db) return "";

  try {
    const data = db.getScheduledTasks(userId);

    if (!data?.length) return "";

    // Cap at 20 scheduled tasks
    const tasks = data.slice(0, 20);
    const lines = tasks.map((t: any) => {
      const triggerStr = t.trigger_at
        ? new Date(t.trigger_at).toLocaleString("en-US", {
            timeZone: userTimezone || t.timezone || "UTC",
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          })
        : "no trigger time";
      const recur = t.recurrence ? ` (${t.recurrence})` : "";
      const creator = t.created_by === "nova" ? " [self-scheduled]" : "";
      return `- ${t.title} — ${triggerStr}${recur}${creator}`;
    });
    if (data.length > 20) {
      lines.push(`[...${data.length - 20} more scheduled tasks truncated...]`);
    }

    return "SCHEDULED TASKS:\n" + lines.join("\n");
  } catch (error) {
    console.warn("Schedule context error:", error);
    return "";
  }
}
