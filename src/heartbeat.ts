/**
 * Heartbeat — In-Process Proactive Agent Loop
 *
 * A lightweight periodic loop that runs inside the main Nova process.
 * Reads a HEARTBEAT.md checklist, pre-filters with cheap local checks,
 * and only escalates to a Claude haiku call when something needs attention.
 *
 * Most ticks are silent — no LLM cost at all.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import type { Database } from "./db.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));
const NOVA_DIR = process.env.NOVA_DIR || process.env.RELAY_DIR || join(process.env.HOME || "~", ".nova");

// Config
const MAX_DAILY_CHECKINS = parseInt(process.env.HEARTBEAT_MAX_DAILY || "1");
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
const RUNTIME_PATH = join(NOVA_DIR, "heartbeat.md");

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
  db: Database,
  userId: string
): Promise<boolean> {
  try {
    const count = db.countTodayMessages(userId, { role: "assistant", metadataFilter: { source: "heartbeat" } });
    return count >= MAX_DAILY_CHECKINS;
  } catch {
    return false;
  }
}

/**
 * Check if the user has been active recently (sent a message within N minutes).
 */
async function recentActivity(
  db: Database,
  userId: string,
  withinMinutes: number
): Promise<boolean> {
  try {
    return db.hasRecentActivity(userId, withinMinutes);
  } catch {
    return false;
  }
}

// ============================================================
// CONTEXT GATHERING (lightweight DB queries)
// ============================================================

async function gatherHeartbeatContext(
  db: Database,
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

  // All queries are synchronous with SQLite — no need for Promise.allSettled
  const goals = db.getActiveGoals(user.id);
  const lastMsgData = db.getRecentMessages(user.id, 1);
  const recentMsgsData = db.getRecentMessages(user.id, 6);
  const checkinsCount = db.countTodayMessages(user.id, { role: "assistant", metadataFilter: { source: "heartbeat" } });
  const upcomingTasksData = db.getUpcomingScheduledTasks(user.id, now.toISOString(), new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString(), 5);

  // Parse goals
  let activeGoals = "None";
  if (goals?.length) {
    activeGoals = goals
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
  if (lastMsgData?.length) {
    const lastAt = new Date(lastMsgData[0].created_at);
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
  if (recentMsgsData?.length) {
    const msgs = [...recentMsgsData].reverse();
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
  const checkinsToday = checkinsCount || 0;

  // Parse upcoming tasks
  let upcomingTasks = "None";
  if (upcomingTasksData?.length) {
    upcomingTasks = upcomingTasksData
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

// Max chars for the checklist section — prevents large HEARTBEAT.md from blowing up tokens
const CHECKLIST_MAX_CHARS = 2500;

function buildHeartbeatPrompt(user: HeartbeatUser, ctx: HeartbeatContext): string {
  // Cap checklist to prevent runaway token cost when HEARTBEAT.md grows large
  const checklist = ctx.checklist.length > CHECKLIST_MAX_CHARS
    ? ctx.checklist.slice(0, CHECKLIST_MAX_CHARS) + `\n[...truncated at ${CHECKLIST_MAX_CHARS} chars]`
    : ctx.checklist;

  // Cap goals to 300 chars to keep context tight
  const goals = ctx.activeGoals.length > 300
    ? ctx.activeGoals.slice(0, 300) + "..."
    : ctx.activeGoals;

  return `You are ${user.name}'s AI assistant. A periodic heartbeat fired.

CHECKLIST:
${checklist}

CONTEXT: time=${ctx.currentTime} (${ctx.timezone}) | last_msg=${ctx.lastInteractionAt} (${ctx.hoursSinceLastInteraction}h ago) | goals=${goals} | due=${ctx.upcomingTasks} | checkins_today=${ctx.checkinsToday}/${MAX_DAILY_CHECKINS}

RECENT (ground truth for timing):
${ctx.recentSnippets}

RULES: 1) Nothing needs action → reply HEARTBEAT_OK exactly. 2) Something needs action → 2-3 sentence message only. 3) No tools, no API calls. 4) Only alert for real, specific reasons. 5) Use RECENT timestamps for recency, not the last_msg field.

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
  db: Database;
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
  db: Database;
  callClaude: ClaudeCaller;
  sendAlert: MessageSender;
  saveMessage: (role: string, content: string, userId: string, metadata?: Record<string, unknown>, channel?: string) => Promise<void>;
}): Promise<void> {
  const { db, callClaude, sendAlert, saveMessage } = deps;

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
  const users = getProactiveUsers(db);

  if (!users.length) return;

  for (const user of users) {
    try {
      // 3. Local pre-filters (zero LLM cost)
      if (!isWithinActiveHours(user)) {
        console.log(`[heartbeat] ${user.name}: outside active hours — skipped`);
        continue;
      }

      if (await exceededDailyCheckins(db, user.id)) {
        console.log(`[heartbeat] ${user.name}: max daily check-ins reached — skipped`);
        continue;
      }

      if (await recentActivity(db, user.id, 60)) {
        console.log(`[heartbeat] ${user.name}: active recently — skipped`);
        continue;
      }

      // 4. Gather lightweight context
      const context = await gatherHeartbeatContext(db, user, stripped);

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

function getProactiveUsers(db: Database): HeartbeatUser[] {
  try {
    const data = db.getAllActiveUsers();

    if (!data) return [];

    // Only include users who haven't explicitly disabled proactive check-ins
    return data.filter(
      (u: any) => {
        const prefs = typeof u.preferences === "string" ? JSON.parse(u.preferences) : (u.preferences || {});
        return prefs.proactive_checkin !== false;
      }
    ) as HeartbeatUser[];
  } catch {
    return [];
  }
}
