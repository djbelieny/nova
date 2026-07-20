/**
 * Morning Briefing (Multi-User)
 *
 * Sends a daily summary via Telegram at each user's preferred briefing hour.
 * Fetches real data from SQLite (goals/facts), ClickUp, and Notion.
 * Uses Groq (direct API) for reliable background generation.
 *
 * Run manually: bun run services/morning-briefing.ts
 */

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

interface BriefingUser {
  id: string;
  telegram_id: string;
  name: string;
  timezone: string;
  preferences: Record<string, any>;
  job_role?: string;
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

  return users
    .filter((u: any) => u.preferences?.morning_briefing !== false)
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
// PER-USER STATE (already-ran-today tracking, stored in shared SQLite)
// ============================================================

function alreadyRanToday(db: Database, userId: string, timezone: string): boolean {
  const lastDate = db.getServiceState("morning-briefing", userId) || "";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: timezone });
  return lastDate === today;
}

function markRanToday(db: Database, userId: string, timezone: string): void {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: timezone });
  db.setServiceState("morning-briefing", userId, today);
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
// GENERATE BRIEFING
// ============================================================

async function generateBriefing(user: BriefingUser, dbContext: string): Promise<string> {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    timeZone: user.timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  // Fetch real integration data
  const integrationContext = await getIntegrationContext();

  const roleGuidance: Record<string, string> = {
    developer: "Focus on: PRs to review, technical debt, deployments, build health, unblocked tasks.",
    account_manager: "Focus on: client status, pipeline follow-ups, CRM actions, renewals due soon.",
    designer: "Focus on: design feedback pending, assets needed, upcoming reviews, handoffs.",
    marketer: "Focus on: campaign performance, content deadlines, ad spend pacing, audience growth.",
    founder: "Focus on: revenue metrics, team blockers, investor follow-ups, strategic priorities.",
    general: "Focus on: most urgent goals, blocked tasks, key decisions needed.",
  };
  const role = user.job_role || "general";
  const roleHint = roleGuidance[role] || roleGuidance.general;

  const prompt = `Morning briefing for ${user.name} (${role}), ${dateStr}.

${dbContext ? dbContext + "\n" : ""}${integrationContext ? integrationContext + "\n" : ""}Build a concise Telegram Markdown briefing:
- Greeting + date
- Tasks: open tasks from ClickUp/Notion + active goals (use real data above)
- Focus: 1-2 sentence priority suggestion based on what's most urgent — ${roleHint}

${!integrationContext ? "Note: No external task data available today — focus on goals and general priorities." : ""}
Skip sections with no data silently. Bullet points, be brief. Keep it under 300 words.`;

  try {
    const claude = getProvider("claude") ?? getDefaultProvider();
    const result = await claude.call({
      prompt,
      model: claude.mapModelTier("fast"),
      outputFormat: "text",
    });

    return result.text;
  } catch (error) {
    console.error(`Briefing generation error for ${user.name}:`, error);
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

  for (const user of users) {
    // Skip if already ran today for this user
    if (alreadyRanToday(db, user.id, user.timezone)) {
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
    const briefing = await generateBriefing(user, dbContext);

    if (!briefing) {
      console.error(`Failed to generate briefing for ${user.name}`);
      continue;
    }

    console.log(`Sending briefing to ${user.name}...`);
    const success = await sendTelegram(user.telegram_id, briefing);

    if (success) {
      markRanToday(db, user.id, user.timezone);
      console.log(`Briefing sent to ${user.name}!`);
    } else {
      console.error(`Failed to send briefing to ${user.name}`);
    }
  }
}

main();
