/**
 * Smart Check-in (Multi-User)
 *
 * A proactive assistant pattern where Claude decides:
 * - IF to check in (based on real context from Supabase + MCPs)
 * - WHAT to say (based on goals, recent activity, calendar, etc.)
 *
 * Iterates over all active users with proactive_checkin enabled.
 *
 * Run periodically (e.g., every 30 minutes) and Claude
 * intelligently decides whether to message each user.
 *
 * Run: bun run services/smart-checkin.ts
 */

import { dirname, join } from "path";
import { getDb, type Database } from "../src/db.ts";
import { registerProvider, getDefaultProvider } from "../src/ai-provider.ts";
import { ClaudeProvider } from "../src/providers/claude.ts";
import { GeminiProvider } from "../src/providers/gemini.ts";
import { CodexProvider } from "../src/providers/codex.ts";

// Register AI providers (smart-checkin runs standalone)
registerProvider(new ClaudeProvider());
registerProvider(new GeminiProvider());
registerProvider(new CodexProvider());

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const PROJECT_ROOT = join(dirname(import.meta.path), "..");

interface ProactiveUser {
  id: string;
  telegram_id: string;
  name: string;
  timezone: string;
  preferences: Record<string, any>;
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
// FETCH PROACTIVE USERS
// ============================================================

function getAllProactiveUsers(db: Database): ProactiveUser[] {
  const users = db.getAllActiveUsers();

  return users.filter(
    (u: any) => u.preferences?.proactive_checkin !== false
  );
}

// ============================================================
// REAL CONTEXT FROM SUPABASE (per-user)
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
  // Query DB directly for the actual last user message — state file is unreliable
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

  // Fallback to state only if DB query fails
  const state = loadState(userId);
  const lastMsg = new Date(state.lastMessageTime);
  const now = new Date();
  const hoursSince = (now.getTime() - lastMsg.getTime()) / (1000 * 60 * 60);
  return `Last message: ~${hoursSince.toFixed(1)} hours ago (estimated)`;
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
// CLAUDE DECISION (per-user, with real context + MCP access)
// ============================================================

async function askClaudeToDecide(
  db: Database,
  user: ProactiveUser
): Promise<{ shouldCheckin: boolean; message: string }> {
  const state = loadState(user.id);
  const goals = getGoals(db, user.id);
  const recentActivity = getRecentActivity(db, user.id);
  const activity = await getLastActivity(db, user.id);

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

  const prompt = `Decide if you should check in with ${user.name} right now.

Time: ${timeStr} (${timeContext})
${activity}
Last check-in: ${state.lastCheckinTime || "Never"}
Goals: ${goals.length > 0 ? goals.join("; ") : "None"}
Pending: ${state.pendingItems.join("; ") || "None"}

Recent messages:
${recentActivity}

Check Gmail, Calendar, and Notion for urgent items if helpful.

Rules: Must check in at least once/day. After that, only for concrete reasons (deadlines, events, urgent emails, 4h+ silence). Max 3/day. Be brief, reference real context.

RESPOND:
DECISION: YES or NO
MESSAGE: [message if YES, "none" if NO]
REASON: [why]`;

  try {
    const result = await getDefaultProvider().call({
      prompt,
      model: "haiku",
      maxTurns: 5,
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
    console.error(`Claude error for ${user.name}:`, error);
    return { shouldCheckin: false, message: "" };
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
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

    const { shouldCheckin, message } = await askClaudeToDecide(db, user);

    if (shouldCheckin && message && message !== "none") {
      console.log(`Sending check-in to ${user.name}...`);
      const success = await sendTelegram(user.telegram_id, message);

      if (success) {
        const state = loadState(user.id);
        state.lastCheckinTime = new Date().toISOString();
        saveState(user.id, state);
        console.log(`Check-in sent to ${user.name}!`);
      } else {
        console.error(`Failed to send check-in to ${user.name}`);
      }
    } else {
      console.log(`No check-in needed for ${user.name}`);
    }
  }
}

main();

// ============================================================
// SCHEDULING
// ============================================================
//
// Run every 30 minutes:
//
// CRON (Linux):
//   0,30 * * * * cd /path/to/nova && bun run services/smart-checkin.ts
//
// LAUNCHD (macOS):
//   See ~/Library/LaunchAgents/com.nova.smart-checkin.plist
//
// WINDOWS Task Scheduler:
//   Create task with "Daily" trigger, set to repeat every 30 minutes
//
