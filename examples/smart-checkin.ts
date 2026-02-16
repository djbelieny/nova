/**
 * Smart Check-in
 *
 * A proactive assistant pattern where Claude decides:
 * - IF to check in (based on real context from Supabase + MCPs)
 * - WHAT to say (based on goals, recent activity, calendar, etc.)
 *
 * Run periodically (e.g., every 30 minutes) and Claude
 * intelligently decides whether to message you.
 *
 * Run: bun run examples/smart-checkin.ts
 */

import { spawn } from "bun";
import { readFile, writeFile } from "fs/promises";
import { createClient } from "@supabase/supabase-js";
import { dirname, join } from "path";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const USER_NAME = process.env.USER_NAME || "";
const USER_TIMEZONE =
  process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
const STATE_FILE =
  process.env.CHECKIN_STATE_FILE || "/tmp/checkin-state.json";
const PROJECT_ROOT = join(dirname(import.meta.path), "..");

// ============================================================
// STATE MANAGEMENT
// ============================================================

interface CheckinState {
  lastMessageTime: string; // Last time user messaged
  lastCheckinTime: string; // Last time we checked in
  pendingItems: string[]; // Things to follow up on
}

async function loadState(): Promise<CheckinState> {
  try {
    const content = await readFile(STATE_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return {
      lastMessageTime: new Date().toISOString(),
      lastCheckinTime: "",
      pendingItems: [],
    };
  }
}

async function saveState(state: CheckinState): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================
// REAL CONTEXT FROM SUPABASE
// ============================================================

async function getGoals(): Promise<string[]> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return [];
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );

    const { data, error } = await supabase.rpc("get_active_goals");

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

async function getRecentActivity(): Promise<string> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return "No recent activity data available";
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );

    const { data, error } = await supabase.rpc("get_recent_messages", {
      limit_count: 6,
    });

    if (error || !data?.length) return "No recent messages";

    // Reverse to chronological
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

async function getLastActivity(): Promise<string> {
  const state = await loadState();
  const lastMsg = new Date(state.lastMessageTime);
  const now = new Date();
  const hoursSince = (now.getTime() - lastMsg.getTime()) / (1000 * 60 * 60);

  return `Last message: ${hoursSince.toFixed(1)} hours ago`;
}

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(message: string): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
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
// CLAUDE DECISION (with real context + MCP access)
// ============================================================

async function askClaudeToDecide(): Promise<{
  shouldCheckin: boolean;
  message: string;
}> {
  const state = await loadState();
  const [goals, recentActivity, activity] = await Promise.all([
    getGoals(),
    getRecentActivity(),
    getLastActivity(),
  ]);

  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: USER_TIMEZONE,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
  const hour = now.getHours();
  const timeContext =
    hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";

  const prompt = `You are ${USER_NAME}'s proactive AI assistant. Decide if you should check in with ${USER_NAME} right now.

CONTEXT:
- Current time: ${timeStr} (${timeContext})
- ${activity}
- Last check-in: ${state.lastCheckinTime || "Never"}
- Active goals: ${goals.length > 0 ? goals.join(", ") : "None tracked"}
- Pending follow-ups: ${state.pendingItems.join(", ") || "None"}

RECENT CONVERSATION:
${recentActivity}

You also have access to Gmail, Google Calendar, and Notion via your tools. Check them if it would help you decide:
- Is there an upcoming calendar event ${USER_NAME} should prepare for?
- Are there urgent unread emails?
- Are there Notion tasks with approaching deadlines?

RULES:
1. Don't be annoying — max 2-3 check-ins per day
2. Only check in if there's a REASON (goal deadline, long silence, important event coming up, urgent email)
3. Be brief and helpful, not intrusive
4. Consider time of day (don't interrupt deep work hours 10am-12pm, 2pm-4pm unless urgent)
5. If nothing important, respond with NO_CHECKIN
6. When you DO check in, reference specific real context (not generic "how's it going")

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
      console.error("Claude error:", stderr);
      return { shouldCheckin: false, message: "" };
    }

    // Parse Claude's response
    const decisionMatch = output.match(/DECISION:\s*(YES|NO)/i);
    const messageMatch = output.match(/MESSAGE:\s*(.+?)(?=\nREASON:|$)/is);
    const reasonMatch = output.match(/REASON:\s*(.+)/is);

    const shouldCheckin = decisionMatch?.[1]?.toUpperCase() === "YES";
    const message = messageMatch?.[1]?.trim() || "";
    const reason = reasonMatch?.[1]?.trim() || "";

    console.log(`Decision: ${shouldCheckin ? "YES" : "NO"}`);
    console.log(`Reason: ${reason}`);

    return { shouldCheckin, message };
  } catch (error) {
    console.error("Claude error:", error);
    return { shouldCheckin: false, message: "" };
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("Running smart check-in...");

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID");
    process.exit(1);
  }

  const { shouldCheckin, message } = await askClaudeToDecide();

  if (shouldCheckin && message && message !== "none") {
    console.log("Sending check-in...");
    const success = await sendTelegram(message);

    if (success) {
      // Update state
      const state = await loadState();
      state.lastCheckinTime = new Date().toISOString();
      await saveState(state);
      console.log("Check-in sent!");
    } else {
      console.error("Failed to send check-in");
    }
  } else {
    console.log("No check-in needed");
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
//   See ~/Library/LaunchAgents/com.claude.smart-checkin.plist
//
// WINDOWS Task Scheduler:
//   Create task with "Daily" trigger, set to repeat every 30 minutes
//
