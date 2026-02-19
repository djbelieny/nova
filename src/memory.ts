/**
 * Memory Module
 *
 * Persistent facts, goals, and preferences stored in Supabase.
 * Claude manages memory automatically via intent tags in its responses:
 *   [REMEMBER: fact]
 *   [GOAL: text | DEADLINE: date]
 *   [DONE: search text]
 *
 * The relay parses these tags, saves to Supabase, and strips them
 * from the response before sending to the user.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** Escape SQL LIKE/ILIKE wildcards to prevent wildcard injection. */
function escapeIlike(text: string): string {
  return text.replace(/[%_\\]/g, (c) => `\\${c}`);
}

/**
 * Parse Claude's response for memory intent tags.
 * Saves facts/goals to Supabase and returns the cleaned response.
 */
export async function processMemoryIntents(
  supabase: SupabaseClient | null,
  response: string,
  userId: string,
  userTimezone?: string
): Promise<string> {
  if (!supabase) return response;

  let clean = response;

  // [REMEMBER: fact to store] — with duplicate detection
  for (const match of response.matchAll(/\[REMEMBER:\s*(.+?)\]/gi)) {
    const fact = match[1];
    // Check for existing similar fact (case-insensitive substring match)
    const { data: existing } = await supabase
      .from("memory")
      .select("id")
      .eq("type", "fact")
      .eq("user_id", userId)
      .ilike("content", `%${escapeIlike(fact.substring(0, 100))}%`)
      .limit(1);

    if (!existing?.length) {
      await supabase.from("memory").insert({
        type: "fact",
        content: fact,
        user_id: userId,
        scope: "private",
      });
    }
    clean = clean.replace(match[0], "");
  }

  // [SHARE: fact to share with team]
  for (const match of response.matchAll(/\[SHARE:\s*(.+?)\]/gi)) {
    await supabase.from("memory").insert({
      type: "fact",
      content: match[1],
      user_id: userId,
      scope: "shared",
    });
    clean = clean.replace(match[0], "");
  }

  // [GOAL: text] or [GOAL: text | DEADLINE: date]
  for (const match of response.matchAll(
    /\[GOAL:\s*(.+?)(?:\s*\|\s*DEADLINE:\s*(.+?))?\]/gi
  )) {
    await supabase.from("memory").insert({
      type: "goal",
      content: match[1],
      deadline: match[2] || null,
      user_id: userId,
    });
    clean = clean.replace(match[0], "");
  }

  // [DONE: search text for completed goal]
  for (const match of response.matchAll(/\[DONE:\s*(.+?)\]/gi)) {
    const { data } = await supabase
      .from("memory")
      .select("id")
      .eq("type", "goal")
      .eq("user_id", userId)
      .ilike("content", `%${escapeIlike(match[1])}%`)
      .limit(1);

    if (data?.[0]) {
      await supabase
        .from("memory")
        .update({
          type: "completed_goal",
          completed_at: new Date().toISOString(),
        })
        .eq("id", data[0].id);
    }
    clean = clean.replace(match[0], "");
  }

  // [TASK: agent | description] — create a new task
  for (const match of response.matchAll(/\[TASK:\s*(.+?)\s*\|\s*(.+?)\]/gi)) {
    await supabase.from("agent_tasks").insert({
      agent: match[1],
      description: match[2],
      status: "pending",
      user_id: userId,
    });
    clean = clean.replace(match[0], "");
  }

  // [TASK_START: search text] — mark matching pending task as in_progress
  for (const match of response.matchAll(/\[TASK_START:\s*(.+?)\]/gi)) {
    const { data } = await supabase
      .from("agent_tasks")
      .select("id")
      .eq("status", "pending")
      .eq("user_id", userId)
      .ilike("description", `%${escapeIlike(match[1])}%`)
      .limit(1);

    if (data?.[0]) {
      await supabase
        .from("agent_tasks")
        .update({ status: "in_progress", updated_at: new Date().toISOString() })
        .eq("id", data[0].id);
    }
    clean = clean.replace(match[0], "");
  }

  // [TASK_DONE: search text | result] — mark matching active task as done
  for (const match of response.matchAll(/\[TASK_DONE:\s*(.+?)\s*\|\s*(.+?)\]/gi)) {
    const { data } = await supabase
      .from("agent_tasks")
      .select("id")
      .in("status", ["pending", "in_progress"])
      .eq("user_id", userId)
      .ilike("description", `%${escapeIlike(match[1])}%`)
      .limit(1);

    if (data?.[0]) {
      await supabase
        .from("agent_tasks")
        .update({ status: "completed", result: match[2], updated_at: new Date().toISOString() })
        .eq("id", data[0].id);
    }
    clean = clean.replace(match[0], "");
  }

  // [TASK_BLOCKED: search text | reason] — mark matching active task as blocked
  for (const match of response.matchAll(/\[TASK_BLOCKED:\s*(.+?)\s*\|\s*(.+?)\]/gi)) {
    const { data } = await supabase
      .from("agent_tasks")
      .select("id")
      .in("status", ["pending", "in_progress"])
      .eq("user_id", userId)
      .ilike("description", `%${escapeIlike(match[1])}%`)
      .limit(1);

    if (data?.[0]) {
      await supabase
        .from("agent_tasks")
        .update({ status: "blocked", result: match[2], updated_at: new Date().toISOString() })
        .eq("id", data[0].id);
    }
    clean = clean.replace(match[0], "");
  }

  // [TASK_CANCEL: search text] — cancel a matching task
  for (const match of response.matchAll(/\[TASK_CANCEL:\s*(.+?)\]/gi)) {
    const { data } = await supabase
      .from("agent_tasks")
      .select("id")
      .in("status", ["pending", "in_progress", "blocked"])
      .eq("user_id", userId)
      .ilike("description", `%${escapeIlike(match[1])}%`)
      .limit(1);

    if (data?.[0]) {
      await supabase
        .from("agent_tasks")
        .update({ status: "cancelled", updated_at: new Date().toISOString() })
        .eq("id", data[0].id);
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
      await supabase.from("scheduled_tasks").insert({
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
    const { data } = await supabase
      .from("scheduled_tasks")
      .select("id")
      .eq("user_id", userId)
      .eq("status", "active")
      .ilike("title", `%${escapeIlike(match[1])}%`)
      .limit(1);

    if (data?.[0]) {
      await supabase
        .from("scheduled_tasks")
        .update({ status: "cancelled", updated_at: new Date().toISOString() })
        .eq("id", data[0].id);
    }
    clean = clean.replace(match[0], "");
  }

  return clean.trim();
}

/**
 * Get all facts and active goals for prompt context.
 */
export async function getMemoryContext(
  supabase: SupabaseClient | null,
  userId: string
): Promise<string> {
  if (!supabase) return "";

  try {
    const [factsResult, goalsResult] = await Promise.all([
      supabase.rpc("get_facts", { p_user_id: userId }),
      supabase.rpc("get_active_goals", { p_user_id: userId }),
    ]);

    const parts: string[] = [];

    if (factsResult.data?.length) {
      // Cap at 50 facts to prevent unbounded growth
      const facts = factsResult.data.slice(0, 50);
      const suffix = factsResult.data.length > 50
        ? `\n[...${factsResult.data.length - 50} more facts truncated...]`
        : "";
      parts.push(
        "FACTS:\n" +
          facts.map((f: any) => `- ${f.content}`).join("\n") + suffix
      );
    }

    if (goalsResult.data?.length) {
      parts.push(
        "GOALS:\n" +
          goalsResult.data
            .map((g: any) => {
              const deadline = g.deadline
                ? ` (by ${new Date(g.deadline).toLocaleDateString()})`
                : "";
              return `- ${g.content}${deadline}`;
            })
            .join("\n")
      );
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
  supabase: SupabaseClient | null,
  userId: string
): Promise<string> {
  if (!supabase) return "";

  try {
    const { data, error } = await supabase.rpc("get_active_tasks", { p_user_id: userId });

    if (error) {
      console.warn("Task context error:", error.message);
      return "";
    }

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
  supabase: SupabaseClient | null,
  userId: string,
  count: number = 12
): Promise<string> {
  if (!supabase) return "";

  try {
    const { data, error } = await supabase.rpc("get_recent_messages", {
      p_user_id: userId,
      limit_count: count,
    });

    if (error) {
      console.warn("Recent history fetch error:", error.message);
      return "";
    }

    if (!data?.length) return "";

    // Data comes DESC from DB, reverse to chronological
    const messages = [...data].reverse();

    const lines = messages.map((m: any) => {
      const time = new Date(m.created_at).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
      return `[${time} ${m.role}]: ${m.content}`;
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
 * Semantic search for relevant past messages via the search Edge Function.
 * The Edge Function handles embedding generation (OpenAI key stays in Supabase).
 */
export async function getRelevantContext(
  supabase: SupabaseClient | null,
  query: string,
  userId: string
): Promise<string> {
  if (!supabase) return "";

  try {
    const { data, error } = await supabase.functions.invoke("search", {
      body: { query, match_count: 5, table: "messages", user_id: userId },
    });

    if (error) {
      console.warn("Semantic search error:", error.message || error);
      return "";
    }

    if (!data?.length) {
      console.warn("Semantic search returned no results for:", query.substring(0, 50));
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
 * Get active scheduled tasks for prompt context injection.
 */
export async function getScheduleContext(
  supabase: SupabaseClient | null,
  userId: string,
  userTimezone?: string
): Promise<string> {
  if (!supabase) return "";

  try {
    const { data, error } = await supabase.rpc("get_scheduled_tasks", { p_user_id: userId });

    if (error) {
      console.warn("Schedule context error:", error.message);
      return "";
    }

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
