/**
 * Heartbeat — In-Process Proactive Agent Loop
 *
 * A lightweight periodic loop that runs inside the main relay process.
 * Reads a HEARTBEAT.md checklist, pre-filters with cheap local checks,
 * and only escalates to a Claude haiku call when something needs attention.
 *
 * Most ticks are silent — no LLM cost at all.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import type { SupabaseClient } from "@supabase/supabase-js";

const PROJECT_ROOT = dirname(dirname(import.meta.path));
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".nova");

// Config
const MAX_DAILY_CHECKINS = parseInt(process.env.HEARTBEAT_MAX_DAILY || "3");
const ACTIVE_HOURS_RAW = process.env.HEARTBEAT_ACTIVE_HOURS || "8-22";
const [ACTIVE_START, ACTIVE_END] = ACTIVE_HOURS_RAW.split("-").map(Number);

// ============================================================
// Types
// ============================================================

interface HeartbeatUser {
  id: string;
  telegram_id: string;
  name: string;
  timezone: string;
  preferences: Record<string, any>;
  profile_text: string;
}

interface HeartbeatContext {
  checklist: string;
  currentTime: string;
  timezone: string;
  hoursSinceLastInteraction: number;
  lastInteractionAt: string;  // human-readable timestamp of last user message
  recentSnippets: string;     // last few messages for grounding
  activeGoals: string;
  upcomingTasks: string;
  checkinsToday: number;
}

/** Signature for the Claude caller injected from relay.ts */
type ClaudeCaller = (prompt: string, model?: "haiku" | "sonnet" | "opus", userId?: string, hint?: string) => Promise<string>;

/** Signature for sending a message to a user via their channel */
type MessageSender = (user: HeartbeatUser, message: string) => Promise<void>;

// ============================================================
// HEARTBEAT FILE I/O
// ============================================================

const CONFIG_PATH = join(PROJECT_ROOT, "config", "heartbeat.md");
const RUNTIME_PATH = join(RELAY_DIR, "heartbeat.md");

/**
 * Read the heartbeat checklist. Prefers the runtime copy (~/.nova/heartbeat.md)
 * so Nova can self-schedule follow-ups. Falls back to config/heartbeat.md.
 */
async function readHeartbeatFile(): Promise<string> {
  try {
    return await readFile(RUNTIME_PATH, "utf-8");
  } catch {
    try {
      return await readFile(CONFIG_PATH, "utf-8");
    } catch {
      return "";
    }
  }
}

/**
 * Append a follow-up item to the runtime heartbeat file.
 * Creates the file if it doesn't exist (copies from config/ first).
 */
export async function appendToHeartbeat(item: string): Promise<void> {
  await mkdir(dirname(RUNTIME_PATH), { recursive: true });

  let content: string;
  try {
    content = await readFile(RUNTIME_PATH, "utf-8");
  } catch {
    // Bootstrap from config/
    try {
      content = await readFile(CONFIG_PATH, "utf-8");
    } catch {
      content = "# Heartbeat Checklist\n";
    }
  }

  // Append the new item
  const trimmed = content.trimEnd();
  const newContent = trimmed + `\n- [ ] ${item}\n`;
  await writeFile(RUNTIME_PATH, newContent);
  console.log(`[heartbeat] Appended follow-up: ${item}`);
}

// ============================================================
// LOCAL PRE-FILTERS (zero LLM cost)
// ============================================================

/**
 * Check if the current time is within the user's active hours window.
 */
function isWithinActiveHours(user: HeartbeatUser): boolean {
  try {
    const now = new Date();
    const hour = parseInt(
      now.toLocaleString("en-US", {
        timeZone: user.timezone,
        hour: "numeric",
        hour12: false,
      })
    );
    return hour >= ACTIVE_START && hour < ACTIVE_END;
  } catch {
    // Invalid timezone — default to allowing
    return true;
  }
}

/**
 * Check if we've already sent the max number of heartbeat check-ins today.
 */
async function exceededDailyCheckins(
  supabase: SupabaseClient,
  userId: string
): Promise<boolean> {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { count } = await supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("role", "assistant")
      .gte("created_at", todayStart.toISOString())
      .contains("metadata", { source: "heartbeat" });

    return (count || 0) >= MAX_DAILY_CHECKINS;
  } catch {
    return false;
  }
}

/**
 * Check if the user has been active recently (sent a message within N minutes).
 */
async function recentActivity(
  supabase: SupabaseClient,
  userId: string,
  withinMinutes: number
): Promise<boolean> {
  try {
    const cutoff = new Date(Date.now() - withinMinutes * 60 * 1000);

    const { data } = await supabase
      .from("messages")
      .select("id")
      .eq("user_id", userId)
      .eq("role", "user")
      .gte("created_at", cutoff.toISOString())
      .limit(1);

    return (data?.length || 0) > 0;
  } catch {
    return false;
  }
}

// ============================================================
// CONTEXT GATHERING (lightweight DB queries)
// ============================================================

async function gatherHeartbeatContext(
  supabase: SupabaseClient,
  user: HeartbeatUser,
  checklist: string
): Promise<HeartbeatContext> {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: user.timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  // Parallel queries for context
  const [goalsResult, lastMsgResult, recentMsgsResult, checkinsResult, tasksResult] = await Promise.allSettled([
    // Active goals
    supabase.rpc("get_active_goals", { p_user_id: user.id }),
    // Last user message timestamp
    supabase
      .from("messages")
      .select("created_at")
      .eq("user_id", user.id)
      .eq("role", "user")
      .order("created_at", { ascending: false })
      .limit(1),
    // Recent messages (both roles) for grounding context
    supabase.rpc("get_recent_messages", { p_user_id: user.id, limit_count: 6 }),
    // Today's heartbeat count
    (async () => {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      return supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id)
        .eq("role", "assistant")
        .gte("created_at", todayStart.toISOString())
        .contains("metadata", { source: "heartbeat" });
    })(),
    // Upcoming scheduled tasks
    supabase
      .from("scheduled_tasks")
      .select("title, next_run_at")
      .eq("user_id", user.id)
      .eq("status", "active")
      .gte("next_run_at", now.toISOString())
      .lte("next_run_at", new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString())
      .order("next_run_at", { ascending: true })
      .limit(5),
  ]);

  // Parse goals
  let activeGoals = "None";
  if (goalsResult.status === "fulfilled" && goalsResult.value.data?.length) {
    activeGoals = goalsResult.value.data
      .map((g: any) => {
        const deadline = g.deadline
          ? ` (by ${new Date(g.deadline).toLocaleDateString()})`
          : "";
        return `${g.content}${deadline}`;
      })
      .join("; ");
  }

  // Parse hours since last interaction + readable timestamp
  let hoursSince = 0;
  let lastInteractionAt = "unknown";
  if (lastMsgResult.status === "fulfilled" && lastMsgResult.value.data?.length) {
    const lastAt = new Date(lastMsgResult.value.data[0].created_at);
    hoursSince = Math.round((now.getTime() - lastAt.getTime()) / (1000 * 60 * 60) * 10) / 10;
    lastInteractionAt = lastAt.toLocaleString("en-US", {
      timeZone: user.timezone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  }

  // Parse recent message snippets for grounding
  let recentSnippets = "No recent messages";
  if (recentMsgsResult.status === "fulfilled" && recentMsgsResult.value.data?.length) {
    const msgs = [...recentMsgsResult.value.data].reverse();
    recentSnippets = msgs
      .map((m: any) => {
        const ts = new Date(m.created_at).toLocaleString("en-US", {
          timeZone: user.timezone,
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });
        return `[${ts} ${m.role}]: ${(m.content || "").substring(0, 80)}`;
      })
      .join("\n");
  }

  // Parse checkins today
  let checkinsToday = 0;
  if (checkinsResult.status === "fulfilled") {
    checkinsToday = (checkinsResult.value as any).count || 0;
  }

  // Parse upcoming tasks
  let upcomingTasks = "None";
  if (tasksResult.status === "fulfilled" && (tasksResult.value as any).data?.length) {
    upcomingTasks = (tasksResult.value as any).data
      .map((t: any) => `${t.title} (at ${new Date(t.next_run_at).toLocaleTimeString("en-US", { timeZone: user.timezone, hour: "numeric", minute: "2-digit" })})`)
      .join("; ");
  }

  return {
    checklist,
    currentTime: timeStr,
    timezone: user.timezone,
    hoursSinceLastInteraction: hoursSince,
    lastInteractionAt,
    recentSnippets,
    activeGoals,
    upcomingTasks,
    checkinsToday,
  };
}

// ============================================================
// HEARTBEAT PROMPT (minimal for cost)
// ============================================================

function buildHeartbeatPrompt(user: HeartbeatUser, ctx: HeartbeatContext): string {
  return `You are ${user.name}'s AI assistant. A periodic heartbeat just fired.

CHECKLIST (from HEARTBEAT.md):
${ctx.checklist}

CONTEXT:
- Current time: ${ctx.currentTime} (${ctx.timezone})
- Last user message: ${ctx.lastInteractionAt} (${ctx.hoursSinceLastInteraction}h ago)
- Active goals: ${ctx.activeGoals}
- Due soon: ${ctx.upcomingTasks}
- Check-ins today: ${ctx.checkinsToday}/${MAX_DAILY_CHECKINS}

RECENT CONVERSATION (use these timestamps as ground truth):
${ctx.recentSnippets}

RULES:
1. If nothing in the checklist needs attention right now, reply exactly: HEARTBEAT_OK
2. If something does need attention, reply with a brief, helpful message (2-3 sentences max).
3. Do NOT use tools. This is a quick triage — no email/calendar checks.
4. Be genuinely useful, not annoying. Only alert for real reasons.
5. IMPORTANT: Use the RECENT CONVERSATION timestamps above to determine when you last interacted — do NOT rely solely on the "Last user message" field.

RESPOND:`;
}

/**
 * Check if the Claude response indicates nothing to report.
 */
function isHeartbeatOk(response: string): boolean {
  const trimmed = response.trim();
  return trimmed === "HEARTBEAT_OK" || trimmed.startsWith("HEARTBEAT_OK");
}

// ============================================================
// MAIN HEARTBEAT LOOP
// ============================================================

/**
 * Initialize and start the heartbeat loop.
 * Called from relay.ts with injected dependencies.
 */
export function startHeartbeat(deps: {
  supabase: SupabaseClient;
  callClaude: ClaudeCaller;
  sendAlert: MessageSender;
  saveMessage: (role: string, content: string, userId: string, metadata?: Record<string, unknown>, channel?: string) => Promise<void>;
}): void {
  const intervalMin = parseInt(process.env.HEARTBEAT_INTERVAL_MIN || "30");
  const intervalMs = intervalMin * 60 * 1000;

  if (process.env.HEARTBEAT_ENABLED === "false") {
    console.log("[heartbeat] Disabled via HEARTBEAT_ENABLED=false");
    return;
  }

  // Run the heartbeat loop
  const run = () => runHeartbeat(deps).catch((err) =>
    console.error("[heartbeat] Error:", (err as Error).message)
  );

  setInterval(run, intervalMs);
  console.log(`[heartbeat] Enabled — every ${intervalMin} min`);
}

async function runHeartbeat(deps: {
  supabase: SupabaseClient;
  callClaude: ClaudeCaller;
  sendAlert: MessageSender;
  saveMessage: (role: string, content: string, userId: string, metadata?: Record<string, unknown>, channel?: string) => Promise<void>;
}): Promise<void> {
  const { supabase, callClaude, sendAlert, saveMessage } = deps;

  // 1. Read HEARTBEAT.md
  const heartbeatContent = await readHeartbeatFile();

  // Strip HTML comments and blank lines to check if there's actual content
  const stripped = heartbeatContent
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^#.*$/gm, "")
    .trim();

  if (!stripped) {
    // Empty checklist — skip entirely (zero cost)
    return;
  }

  // 2. Get all proactive users
  const users = await getProactiveUsers(supabase);

  if (!users.length) return;

  for (const user of users) {
    try {
      // 3. Local pre-filters (zero LLM cost)
      if (!isWithinActiveHours(user)) {
        console.log(`[heartbeat] ${user.name}: outside active hours — skipped`);
        continue;
      }

      if (await exceededDailyCheckins(supabase, user.id)) {
        console.log(`[heartbeat] ${user.name}: max daily check-ins reached — skipped`);
        continue;
      }

      if (await recentActivity(supabase, user.id, 60)) {
        console.log(`[heartbeat] ${user.name}: active recently — skipped`);
        continue;
      }

      // 4. Gather lightweight context
      const context = await gatherHeartbeatContext(supabase, user, stripped);

      // 5. Call Claude (haiku) with small prompt
      const prompt = buildHeartbeatPrompt(user, context);
      const result = await callClaude(prompt, "haiku", user.id, "heartbeat");

      // 6. Evaluate response
      if (isHeartbeatOk(result)) {
        console.log(`[heartbeat] ${user.name}: nothing to report`);
        continue;
      }

      // 7. Send alert to user
      console.log(`[heartbeat] ${user.name}: sending alert`);
      await sendAlert(user, result);

      // 8. Record the heartbeat message
      await saveMessage("assistant", result, user.id, { source: "heartbeat" });
    } catch (err) {
      console.error(`[heartbeat] Error for ${user.name}:`, (err as Error).message);
    }
  }
}

// ============================================================
// USER FETCHING
// ============================================================

async function getProactiveUsers(supabase: SupabaseClient): Promise<HeartbeatUser[]> {
  try {
    const { data, error } = await supabase
      .from("users")
      .select("id, telegram_id, name, timezone, preferences, profile_text")
      .eq("active", true);

    if (error || !data) return [];

    // Only include users who haven't explicitly disabled proactive check-ins
    return data.filter(
      (u: any) => u.preferences?.proactive_checkin !== false
    ) as HeartbeatUser[];
  } catch {
    return [];
  }
}
