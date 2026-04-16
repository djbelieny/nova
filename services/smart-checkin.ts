/**
 * Smart Check-in (Multi-User)
 *
 * A proactive assistant pattern where the LLM decides:
 * - IF to check in (based on real context from DB + integrations)
 * - WHAT to say (based on goals, recent activity, tasks, etc.)
 *
 * Uses Groq (direct API) for reliable background execution.
 * Fetches real data from ClickUp and Notion via REST APIs.
 *
 * Run: bun run services/smart-checkin.ts
 */

import { dirname, join } from "path";
import { getDb, type Database } from "../src/db.ts";
import { registerProvider, getDefaultProvider, getProvider } from "../src/ai-provider.ts";
import { ClaudeProvider } from "../src/providers/claude.ts";
import { GeminiProvider } from "../src/providers/gemini.ts";
import { CodexProvider } from "../src/providers/codex.ts";
import { GroqProvider } from "../src/providers/groq.ts";
import { getIntegrationContext } from "../src/service-integrations.ts";

registerProvider(new GroqProvider());
registerProvider(new ClaudeProvider());
registerProvider(new GeminiProvider());
registerProvider(new CodexProvider());

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const PROJECT_ROOT = join(dirname(import.meta.path), "..");

// Max non-urgent check-ins per day. 0 = unlimited. Default: 3.
const MAX_DAILY_CHECKINS = parseInt(process.env.CHECKIN_MAX_DAILY || "3");

interface ProactiveUser {
  id: string;
  telegram_id: string;
  name: string;
  timezone: string;
  preferences: Record<string, any>;
  job_role?: string;
}

// ============================================================
// STATE MANAGEMENT (per-user, stored in shared SQLite)
// ============================================================

interface CheckinState {
  lastMessageTime: string;
  lastCheckinTime: string;
  pendingItems: string[];
}

let _db: Database | null = null;
function getStateDb(): Database {
  if (!_db) _db = getDb();
  return _db;
}

function loadState(userId: string): CheckinState {
  const db = getStateDb();
  const raw = db.getServiceState("smart-checkin", userId);
  if (raw) {
    try { return JSON.parse(raw); } catch {}
  }
  return {
    lastMessageTime: new Date().toISOString(),
    lastCheckinTime: "",
    pendingItems: [],
  };
}

function saveState(userId: string, state: CheckinState): void {
  const db = getStateDb();
  db.setServiceState("smart-checkin", userId, JSON.stringify(state));
}

// ============================================================
// DAILY LIMIT GATE
// ============================================================

function getCheckinsToday(db: Database, userId: string): number {
  try {
    return db.countTodayMessages(userId, {
      role: "assistant",
      metadataFilter: { source: "smart-checkin" },
    });
  } catch {
    return 0;
  }
}

// ============================================================
// FETCH PROACTIVE USERS
// ============================================================

function getAllProactiveUsers(db: Database): ProactiveUser[] {
  const users = db.getAllActiveUsers();

  return users
    .filter((u: any) => u.preferences?.proactive_checkin !== false)
    .map((u: any) => ({
      id: u.id,
      telegram_id: u.telegram_id,
      name: u.name,
      timezone: u.timezone,
      preferences: u.preferences,
      job_role: u.job_role || "general",
    }));
}

// ============================================================
// REAL CONTEXT FROM DB (per-user)
// ============================================================

function getGoals(db: Database, userId: string): string[] {
  try {
    const data = db.getActiveGoals(userId);
    if (!data?.length) return [];

    return data.map((g: any) => {
      const deadline = g.deadline
        ? ` (by ${new Date(g.deadline).toLocaleDateString()})`
        : "";
      return `${g.content}${deadline}`;
    });
  } catch (error) {
    console.error("Goals fetch error:", error);
    return [];
  }
}

function getRecentActivity(db: Database, userId: string): string {
  try {
    const data = db.getRecentMessages(userId, 6);

    if (!data?.length) return "No recent messages";

    const messages = [...data].reverse();
    return messages
      .map((m: any) => {
        const time = new Date(m.created_at).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });
        return `[${time} ${m.role}]: ${m.content.substring(0, 100)}`;
      })
      .join("\n");
  } catch (error) {
    console.error("Recent activity error:", error);
    return "Could not fetch recent activity";
  }
}

async function getLastActivity(db: Database, userId: string): Promise<string> {
  try {
    const data = db.getRecentMessages(userId, 1);

    if (data?.length) {
      const lastMsg = new Date(data[0].created_at);
      const now = new Date();
      const hoursSince = (now.getTime() - lastMsg.getTime()) / (1000 * 60 * 60);
      const timeStr = lastMsg.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
      return `Last message: ${timeStr} (${hoursSince.toFixed(1)} hours ago)`;
    }
  } catch (error) {
    console.error("Last activity query error:", error);
  }

  const state = loadState(userId);
  const lastMsg = new Date(state.lastMessageTime);
  const now = new Date();
  const hoursSince = (now.getTime() - lastMsg.getTime()) / (1000 * 60 * 60);
  return `Last message: ~${hoursSince.toFixed(1)} hours ago (estimated)`;
}

function getRestOfDaySchedule(db: Database, userId: string, timezone: string): string {
  try {
    const now = new Date();
    const midnight = new Date(
      now.toLocaleString("en-US", { timeZone: timezone })
    );
    midnight.setHours(23, 59, 59, 999);

    const tasks = db.getUpcomingScheduledTasks(
      userId,
      now.toISOString(),
      midnight.toISOString(),
      8
    );

    if (!tasks?.length) return "None";

    return tasks
      .map((t: any) => {
        const at = new Date(t.next_run_at).toLocaleTimeString("en-US", {
          timeZone: timezone,
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });
        return `${t.title} at ${at}`;
      })
      .join("; ");
  } catch (error) {
    console.error("Rest-of-day schedule error:", error);
    return "Could not fetch schedule";
  }
}

function getChangesSinceLastCheckin(
  db: Database,
  userId: string,
  lastCheckinTime: string,
  timezone: string
): string {
  if (!lastCheckinTime) return "No previous check-in";

  try {
    const since = new Date(lastCheckinTime);
    const allRecent = db.getRecentMessages(userId, 20);
    if (!allRecent?.length) return "No new messages";

    const newMsgs = allRecent.filter(
      (m: any) => new Date(m.created_at) > since
    );

    if (!newMsgs.length) return "No new messages since last check-in";

    const msgs = [...newMsgs].reverse();
    return msgs
      .map((m: any) => {
        const ts = new Date(m.created_at).toLocaleTimeString("en-US", {
          timeZone: timezone,
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });
        return `[${ts} ${m.role}]: ${m.content.substring(0, 100)}`;
      })
      .join("\n");
  } catch (error) {
    console.error("Changes since last check-in error:", error);
    return "Could not fetch recent changes";
  }
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
// LLM DECISION (per-user, with real context)
// ============================================================

async function askToDecide(
  db: Database,
  user: ProactiveUser
): Promise<{ shouldCheckin: boolean; message: string }> {
  const state = loadState(user.id);
  const goals = getGoals(db, user.id);
  const recentActivity = getRecentActivity(db, user.id);
  const activity = await getLastActivity(db, user.id);
  const restOfDay = getRestOfDaySchedule(db, user.id, user.timezone);
  const changesSince = getChangesSinceLastCheckin(
    db,
    user.id,
    state.lastCheckinTime,
    user.timezone
  );
  const checkinsToday = getCheckinsToday(db, user.id);
  const dailyLimit = MAX_DAILY_CHECKINS > 0 ? MAX_DAILY_CHECKINS : "unlimited";

  // Fetch real integration data
  const integrationContext = await getIntegrationContext();

  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: user.timezone,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
  const hour = parseInt(
    now.toLocaleString("en-US", { timeZone: user.timezone, hour: "numeric", hour12: false })
  );
  const timeContext =
    hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";

  const roleCheckinHints: Record<string, string> = {
    developer: "Ask about: build failures, blocked PRs, deployment status, or tech debt piling up.",
    account_manager: "Ask about: client at risk, follow-up overdue, or pipeline opportunity.",
    designer: "Ask about: feedback needed, handoff ready, or review scheduled.",
    marketer: "Ask about: campaign going live, content deadline, or performance anomaly.",
    founder: "Ask about: revenue impact, team blocker, or strategic decision needed.",
    general: "Ask about: approaching deadlines, blocked tasks, or key decisions needed.",
  };
  const role = user.job_role || "general";
  const roleHint = roleCheckinHints[role] || roleCheckinHints.general;

  const prompt = `Decide if you should check in with ${user.name} (${role}) right now.

Time: ${timeStr} (${timeContext})
${activity}
Last check-in: ${state.lastCheckinTime || "Never"}
Check-ins today: ${checkinsToday}/${dailyLimit}
Goals: ${goals.length > 0 ? goals.join("; ") : "None"}
Pending: ${state.pendingItems.join("; ") || "None"}

Scheduled for the rest of today:
${restOfDay}

New since last check-in:
${changesSince}

Recent messages:
${recentActivity}
${integrationContext ? `\nExternal tasks & projects:\n${integrationContext}` : ""}

Rules: Only check in for concrete reasons (deadlines, urgent tasks, upcoming events, or silence 4h+ during work hours). Urgent/security issues override the daily limit. For non-urgent items, keep check-ins spaced at least 2 hours apart. Be brief, reference real context. Include relevant upcoming schedule items or recent changes when they add value. ${roleHint}

RESPOND:
DECISION: YES or NO
MESSAGE: [message if YES, "none" if NO]
REASON: [why]`;

  try {
    const claude = getProvider("claude") ?? getDefaultProvider();
    const result = await claude.call({
      prompt,
      model: claude.mapModelTier("fast"),
      outputFormat: "text",
    });

    const output = result.text;
    const decisionMatch = output.match(/DECISION:\s*(YES|NO)/i);
    const messageMatch = output.match(/MESSAGE:\s*(.+?)(?=\nREASON:|$)/is);
    const reasonMatch = output.match(/REASON:\s*(.+)/is);

    const shouldCheckin = decisionMatch?.[1]?.toUpperCase() === "YES";
    const message = messageMatch?.[1]?.trim() || "";
    const reason = reasonMatch?.[1]?.trim() || "";

    console.log(`${user.name}: Decision: ${shouldCheckin ? "YES" : "NO"} — ${reason}`);

    return { shouldCheckin, message };
  } catch (error) {
    console.error(`Check-in error for ${user.name}:`, error);
    return { shouldCheckin: false, message: "" };
  }
}

// ============================================================
// MAIN
// ============================================================

export async function main() {
  console.log("Running smart check-in (multi-user)...");

  if (!BOT_TOKEN) {
    console.error("Missing TELEGRAM_BOT_TOKEN");
    process.exit(1);
  }

  const db = getDb();

  const users = getAllProactiveUsers(db);
  console.log(`Found ${users.length} proactive user(s)`);

  for (const user of users) {
    console.log(`\nChecking ${user.name}...`);

    // Hard daily gate (skips LLM call entirely when limit hit)
    if (MAX_DAILY_CHECKINS > 0) {
      const todayCount = getCheckinsToday(db, user.id);
      if (todayCount >= MAX_DAILY_CHECKINS) {
        console.log(`${user.name}: daily limit (${MAX_DAILY_CHECKINS}) reached — skipped`);
        continue;
      }
    }

    const { shouldCheckin, message } = await askToDecide(db, user);

    if (shouldCheckin && message && message !== "none") {
      console.log(`Sending check-in to ${user.name}...`);
      const success = await sendTelegram(user.telegram_id, message);

      if (success) {
        const state = loadState(user.id);
        state.lastCheckinTime = new Date().toISOString();
        saveState(user.id, state);
        db.saveMessage({
          role: "assistant",
          content: message,
          user_id: user.id,
          metadata: { source: "smart-checkin" },
        });
        console.log(`Check-in sent to ${user.name}!`);
      } else {
        console.error(`Failed to send check-in to ${user.name}`);
      }
    } else {
      console.log(`No check-in needed for ${user.name}`);
    }
  }
}

if (import.meta.main) { main(); }
