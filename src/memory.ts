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

/**
 * Parse Claude's response for memory intent tags.
 * Saves facts/goals to Supabase and returns the cleaned response.
 */
export async function processMemoryIntents(
  supabase: SupabaseClient | null,
  response: string,
  userId: string
): Promise<string> {
  if (!supabase) return response;

  let clean = response;

  // [REMEMBER: fact to store]
  for (const match of response.matchAll(/\[REMEMBER:\s*(.+?)\]/gi)) {
    await supabase.from("memory").insert({
      type: "fact",
      content: match[1],
      user_id: userId,
      scope: "private",
    });
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
      .ilike("content", `%${match[1]}%`)
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
      .ilike("description", `%${match[1]}%`)
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
      .ilike("description", `%${match[1]}%`)
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
      .ilike("description", `%${match[1]}%`)
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
      .ilike("description", `%${match[1]}%`)
      .limit(1);

    if (data?.[0]) {
      await supabase
        .from("agent_tasks")
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
      parts.push(
        "FACTS:\n" +
          factsResult.data.map((f: any) => `- ${f.content}`).join("\n")
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

    const lines = data.map(
      (t: any) => `- [${t.agent}] ${t.description} (${t.status})`
    );

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

    return (
      "RELEVANT PAST MESSAGES:\n" +
      data
        .map((m: any) => `[${m.role}]: ${m.content}`)
        .join("\n")
    );
  } catch (error) {
    console.warn("Semantic search unavailable:", error);
    return "";
  }
}
