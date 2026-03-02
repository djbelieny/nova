/**
 * Morning Briefing (Multi-User)
 *
 * Sends a daily summary via Telegram at each user's preferred briefing hour.
 * Fetches real data from Supabase (goals/facts) and uses Claude CLI
 * with MCPs (Gmail, Calendar, Notion) for live context.
 *
 * Iterates over all active users with morning_briefing enabled,
 * checks each user's local time against their briefing_hour preference.
 *
 * Schedule this with:
 * - macOS: launchd (see daemon/morning-briefing.plist)
 * - Linux: cron or systemd timer
 * - Windows: Task Scheduler
 *
 * Run manually: bun run services/morning-briefing.ts
 */

import { readFile, writeFile } from "fs/promises";
import { getDb, type Database } from "../src/db.ts";
import { registerProvider, getDefaultProvider } from "../src/ai-provider.ts";
import { ClaudeProvider } from "../src/providers/claude.ts";

// Register AI provider (morning-briefing runs standalone)
registerProvider(new ClaudeProvider());

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const STATE_FILE = "/tmp/morning-briefing-state.json";

interface BriefingUser {
  id: string;
  telegram_id: string;
  name: string;
  timezone: string;
  preferences: Record<string, any>;
}

// ============================================================
// TELEGRAM HELPER
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
          parse_mode: "Markdown",
        }),
      }
    );

    return response.ok;
  } catch (error) {
    console.error("Telegram error:", error);
    return false;
  }
}

// ============================================================
// FETCH BRIEFING USERS
// ============================================================

function getAllBriefingUsers(db: Database): BriefingUser[] {
  const users = db.getAllActiveUsers();

  return users.filter(
    (u: any) => u.preferences?.morning_briefing !== false
  );
}

// ============================================================
// PER-USER STATE (already-ran-today tracking)
// ============================================================

interface BriefingState {
  [userId: string]: string; // userId -> last run date (YYYY-MM-DD)
}

async function loadBriefingState(): Promise<BriefingState> {
  try {
    const content = await readFile(STATE_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function saveBriefingState(state: BriefingState): Promise<void> {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

function alreadyRanToday(state: BriefingState, userId: string, timezone: string): boolean {
  const lastDate = state[userId] || "";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: timezone });
  return lastDate === today;
}

function markRanToday(state: BriefingState, userId: string, timezone: string): void {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: timezone });
  state[userId] = today;
}

function isUserBriefingHour(user: BriefingUser): boolean {
  const now = new Date();
  const userHour = parseInt(
    now.toLocaleString("en-US", { timeZone: user.timezone, hour: "numeric", hour12: false })
  );
  const briefingHour = user.preferences?.briefing_hour ?? 9;
  return userHour === briefingHour;
}

// ============================================================
// DATABASE CONTEXT (goals & facts — per-user)
// ============================================================

function getDbContext(db: Database, userId: string): string {
  try {
    const goalsData = db.getActiveGoals(userId);
    const factsData = db.getFacts(userId);

    const parts: string[] = [];

    if (goalsData?.length) {
      const goals = goalsData
        .map((g: any) => {
          const deadline = g.deadline
            ? ` (by ${new Date(g.deadline).toLocaleDateString()})`
            : "";
          return `- ${g.content}${deadline}`;
        })
        .join("\n");
      parts.push(`ACTIVE GOALS:\n${goals}`);
    }

    if (factsData?.length) {
      const facts = factsData
        .slice(0, 20)
        .map((f: any) => `- ${f.content}`)
        .join("\n");
      parts.push(`KEY FACTS:\n${facts}`);
    }

    return parts.join("\n\n");
  } catch (error) {
    console.error("Database error:", error);
    return "";
  }
}

// ============================================================
// CLAUDE CLI WITH MCPs (per-user context)
// ============================================================

async function getMCPBriefing(user: BriefingUser, dbContext: string): Promise<string> {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    timeZone: user.timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const prompt = `Morning briefing for ${user.name}, ${dateStr}.

${dbContext ? dbContext + "\n" : ""}Check Gmail, Calendar, Notion. Build a Telegram Markdown briefing:
- Greeting + date
- Schedule: today's events with times
- Inbox: unread/important email count + highlights
- Tasks: open tasks + active goals
- Focus: 1-2 sentence priority suggestion

Skip sections with no data silently. Bullet points, be brief.`;

  try {
    const result = await getDefaultProvider().call({
      prompt,
      model: "haiku",
      maxTurns: 5,
      outputFormat: "text",
    });

    return result.text;
  } catch (error) {
    console.error(`Claude CLI error for ${user.name}:`, error);
    return "";
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("Building morning briefing (multi-user)...");

  if (!BOT_TOKEN) {
    console.error("Missing TELEGRAM_BOT_TOKEN");
    process.exit(1);
  }

  const db = getDb();

  const users = getAllBriefingUsers(db);
  console.log(`Found ${users.length} briefing user(s)`);

  const state = await loadBriefingState();
  let stateChanged = false;

  for (const user of users) {
    // Skip if already ran today for this user
    if (alreadyRanToday(state, user.id, user.timezone)) {
      console.log(`Already sent today's briefing to ${user.name} — skipping.`);
      continue;
    }

    // Skip if it's not the user's briefing hour
    if (!isUserBriefingHour(user)) {
      const briefingHour = user.preferences?.briefing_hour ?? 9;
      console.log(`Not ${user.name}'s briefing hour (${briefingHour}:00 in ${user.timezone}) — skipping.`);
      continue;
    }

    console.log(`\nBuilding briefing for ${user.name}...`);

    const dbContext = getDbContext(db, user.id);
    const briefing = await getMCPBriefing(user, dbContext);

    if (!briefing) {
      console.error(`Failed to generate briefing for ${user.name}`);
      continue;
    }

    console.log(`Sending briefing to ${user.name}...`);
    const success = await sendTelegram(user.telegram_id, briefing);

    if (success) {
      markRanToday(state, user.id, user.timezone);
      stateChanged = true;
      console.log(`Briefing sent to ${user.name}!`);
    } else {
      console.error(`Failed to send briefing to ${user.name}`);
    }
  }

  if (stateChanged) {
    await saveBriefingState(state);
  }
}

main();

// ============================================================
// LAUNCHD PLIST FOR SCHEDULING (macOS)
// ============================================================
/*
Save this as ~/Library/LaunchAgents/com.nova.morning-briefing.plist:
Runs hourly; the script itself checks each user's timezone and briefing_hour.

<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nova.morning-briefing</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/YOUR_USERNAME/.bun/bin/bun</string>
        <string>run</string>
        <string>services/morning-briefing.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/nova</string>
    <key>StartInterval</key>
    <integer>3600</integer>
    <key>StandardOutPath</key>
    <string>/tmp/morning-briefing.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/morning-briefing.error.log</string>
</dict>
</plist>

Load with: launchctl load ~/Library/LaunchAgents/com.nova.morning-briefing.plist
*/
