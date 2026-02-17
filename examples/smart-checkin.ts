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
 * Run: bun run examples/smart-checkin.ts
 */

import { spawn } from "bun";
import { readFile, writeFile } from "fs/promises";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { dirname, join } from "path";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_ROOT = join(dirname(import.meta.path), "..");

interface ProactiveUser {
  id: string;
  telegram_id: string;
  name: string;
  timezone: string;
  preferences: Record<string, any>;
}

// ============================================================
// STATE MANAGEMENT (per-user)
// ============================================================

interface CheckinState {
  lastMessageTime: string;
  lastCheckinTime: string;
  pendingItems: string[];
}

const STATE_DIR = "/tmp";

function stateFile(userId: string): string {
  return join(STATE_DIR, `checkin-state-${userId}.json`);
}

async function loadState(userId: string): Promise<CheckinState> {
  try {
    const content = await readFile(stateFile(userId), "utf-8");
    return JSON.parse(content);
  } catch {
    return {
      lastMessageTime: new Date().toISOString(),
      lastCheckinTime: "",
      pendingItems: [],
    };
  }
}

async function saveState(userId: string, state: CheckinState): Promise<void> {
  await writeFile(stateFile(userId), JSON.stringify(state, null, 2));
}

// ============================================================
// FETCH PROACTIVE USERS
// ============================================================

async function getAllProactiveUsers(supabase: SupabaseClient): Promise<ProactiveUser[]> {
  const { data, error } = await supabase
    .from("users")
    .select("id, telegram_id, name, timezone, preferences")
    .eq("active", true);

  if (error || !data) return [];

  return data.filter(
    (u: any) => u.preferences?.proactive_checkin !== false
  );
}

// ============================================================
// REAL CONTEXT FROM SUPABASE (per-user)
// ============================================================

async function getGoals(supabase: SupabaseClient, userId: string): Promise<string[]> {
  try {
    const { data, error } = await supabase.rpc("get_active_goals", { p_user_id: userId });
    if (error || !data?.length) return [];

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

async function getRecentActivity(supabase: SupabaseClient, userId: string): Promise<string> {
  try {
    const { data, error } = await supabase.rpc("get_recent_messages", {
      p_user_id: userId,
      limit_count: 6,
    });

    if (error || !data?.length) return "No recent messages";

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

async function getLastActivity(userId: string): Promise<string> {
  const state = await loadState(userId);
  const lastMsg = new Date(state.lastMessageTime);
  const now = new Date();
  const hoursSince = (now.getTime() - lastMsg.getTime()) / (1000 * 60 * 60);

  return `Last message: ${hoursSince.toFixed(1)} hours ago`;
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
  supabase: SupabaseClient,
  user: ProactiveUser
): Promise<{ shouldCheckin: boolean; message: string }> {
  const state = await loadState(user.id);
  const [goals, recentActivity, activity] = await Promise.all([
    getGoals(supabase, user.id),
    getRecentActivity(supabase, user.id),
    getLastActivity(user.id),
  ]);

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

  const prompt = `You are ${user.name}'s proactive AI assistant. Decide if you should check in with ${user.name} right now.

CONTEXT:
- Current time: ${timeStr} (${timeContext})
- ${activity}
- Last check-in: ${state.lastCheckinTime || "Never"}
- Active goals: ${goals.length > 0 ? goals.join(", ") : "None tracked"}
- Pending follow-ups: ${state.pendingItems.join(", ") || "None"}

RECENT CONVERSATION:
${recentActivity}

You also have access to Gmail, Google Calendar, and Notion via your tools. Check them if it would help you decide:
- Is there an upcoming calendar event ${user.name} should prepare for?
- Are there urgent unread emails?
- Are there Notion tasks with approaching deadlines?

RULES:
1. You MUST check in at least once per day. If there has been no check-in today, default to YES.
2. After the first daily check-in, additional check-ins need a concrete reason (goal deadline, important event, urgent email, long silence of 4+ hours).
3. Max 3 check-ins per day total.
4. Be brief and helpful, not intrusive.
5. If nothing important AND you already checked in today, respond with NO_CHECKIN.
6. When you DO check in, reference specific real context (not generic "how's it going").
7. Even a simple "good morning" or status update counts — don't overthink whether to reach out.

RESPOND IN THIS EXACT FORMAT:
DECISION: YES or NO
MESSAGE: [Your message if YES, or "none" if NO]
REASON: [Why you decided this]
`;

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
      console.error(`Claude error for ${user.name}:`, stderr);
      return { shouldCheckin: false, message: "" };
    }

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

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
    process.exit(1);
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );

  const users = await getAllProactiveUsers(supabase);
  console.log(`Found ${users.length} proactive user(s)`);

  for (const user of users) {
    console.log(`\nChecking ${user.name}...`);

    const { shouldCheckin, message } = await askClaudeToDecide(supabase, user);

    if (shouldCheckin && message && message !== "none") {
      console.log(`Sending check-in to ${user.name}...`);
      const success = await sendTelegram(user.telegram_id, message);

      if (success) {
        const state = await loadState(user.id);
        state.lastCheckinTime = new Date().toISOString();
        await saveState(user.id, state);
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
//   0,30 * * * * cd /path/to/relay && bun run examples/smart-checkin.ts
//
// LAUNCHD (macOS):
//   See ~/Library/LaunchAgents/com.nova.smart-checkin.plist
//
// WINDOWS Task Scheduler:
//   Create task with "Daily" trigger, set to repeat every 30 minutes
//
