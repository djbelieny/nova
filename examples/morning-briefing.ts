/**
 * Morning Briefing
 *
 * Sends a daily summary via Telegram at a scheduled time.
 * Fetches real data from Supabase (goals/facts) and uses Claude CLI
 * with MCPs (Gmail, Calendar, Notion) for live context.
 *
 * Schedule this with:
 * - macOS: launchd (see daemon/morning-briefing.plist)
 * - Linux: cron or systemd timer
 * - Windows: Task Scheduler
 *
 * Run manually: bun run examples/morning-briefing.ts
 */

import { spawn } from "bun";
import { createClient } from "@supabase/supabase-js";
import { dirname, join } from "path";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const USER_NAME = process.env.USER_NAME || "";
const USER_TIMEZONE =
  process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
const PROJECT_ROOT = join(dirname(import.meta.path), "..");

// ============================================================
// TELEGRAM HELPER
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
// SUPABASE DATA (goals & facts — fast, direct queries)
// ============================================================

async function getSupabaseContext(): Promise<string> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return "";
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );

    const [goalsResult, factsResult] = await Promise.all([
      supabase.rpc("get_active_goals"),
      supabase.rpc("get_facts"),
    ]);

    const parts: string[] = [];

    if (goalsResult.data?.length) {
      const goals = goalsResult.data
        .map((g: any) => {
          const deadline = g.deadline
            ? ` (by ${new Date(g.deadline).toLocaleDateString()})`
            : "";
          return `- ${g.content}${deadline}`;
        })
        .join("\n");
      parts.push(`ACTIVE GOALS:\n${goals}`);
    }

    if (factsResult.data?.length) {
      // Only include recent/relevant facts (last 20)
      const facts = factsResult.data
        .slice(0, 20)
        .map((f: any) => `- ${f.content}`)
        .join("\n");
      parts.push(`KEY FACTS:\n${facts}`);
    }

    return parts.join("\n\n");
  } catch (error) {
    console.error("Supabase error:", error);
    return "";
  }
}

// ============================================================
// CLAUDE CLI WITH MCPs (Gmail, Calendar, Notion — live data)
// ============================================================

async function getMCPBriefing(supabaseContext: string): Promise<string> {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    timeZone: USER_TIMEZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const prompt = `You are ${USER_NAME}'s AI assistant preparing a morning briefing for ${dateStr}.

${supabaseContext ? supabaseContext + "\n\n" : ""}Your task: Create a concise morning briefing by checking available tools:

1. **Email**: Check Gmail for unread or important emails from today/yesterday. Summarize the top items.
2. **Calendar**: Check Google Calendar for today's events and tomorrow's early events. List times and titles.
3. **Tasks**: Check Notion for any open tasks or upcoming deadlines.

FORMAT your response as a Telegram message (Markdown) with these sections:
- A greeting with the date
- 📅 **Schedule** — today's calendar events with times
- 📧 **Inbox** — unread/important email summary (count + highlights)
- 📋 **Tasks** — open tasks from Notion and active goals
- 💡 **Focus** — 1-2 sentence suggestion for the day's priority based on all context

RULES:
- If a tool is unavailable or returns nothing, skip that section silently — do NOT mention errors or missing tools.
- Keep it scannable — bullet points, not paragraphs.
- Be brief. This is a daily briefing, not a report.
- End with a short encouraging note.`;

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
      return "";
    }

    return output.trim();
  } catch (error) {
    console.error("Claude CLI error:", error);
    return "";
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("Building morning briefing...");

  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID");
    process.exit(1);
  }

  // Fetch Supabase data (fast) in parallel with starting Claude
  const supabaseContext = await getSupabaseContext();

  // Claude CLI checks MCPs and assembles the briefing
  const briefing = await getMCPBriefing(supabaseContext);

  if (!briefing) {
    console.error("Failed to generate briefing");
    process.exit(1);
  }

  console.log("Sending briefing...");
  const success = await sendTelegram(briefing);

  if (success) {
    console.log("Briefing sent successfully!");
  } else {
    console.error("Failed to send briefing");
    process.exit(1);
  }
}

main();

// ============================================================
// LAUNCHD PLIST FOR SCHEDULING (macOS)
// ============================================================
/*
Save this as ~/Library/LaunchAgents/com.claude.morning-briefing.plist:

<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude.morning-briefing</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/YOUR_USERNAME/.bun/bin/bun</string>
        <string>run</string>
        <string>examples/morning-briefing.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/claude-telegram-relay</string>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>9</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>/tmp/morning-briefing.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/morning-briefing.error.log</string>
</dict>
</plist>

Load with: launchctl load ~/Library/LaunchAgents/com.claude.morning-briefing.plist
*/

// ============================================================
// CRON FOR SCHEDULING (Linux)
// ============================================================
/*
Add to crontab with: crontab -e

# Run at 9:00 AM every day
0 9 * * * cd /path/to/claude-telegram-relay && /home/USER/.bun/bin/bun run examples/morning-briefing.ts >> /tmp/morning-briefing.log 2>&1
*/
