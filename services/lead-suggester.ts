/**
 * Lead Generation Suggester
 *
 * Analyzes DJ's business context, recent industry trends, and
 * competitor activity to surface new lead opportunities proactively.
 *
 * Schedule: 15:00 UTC (10am ET) — daily
 * Run manually: bun run services/lead-suggester.ts
 */

import { getDb, type Database } from "../src/db.ts";
import { registerProvider, getDefaultProvider, setDefaultProvider } from "../src/ai-provider.ts";
import { GroqProvider } from "../src/providers/groq.ts";
import { ClaudeProvider } from "../src/providers/claude.ts";
import { searchTavily, getClickUpTasks, getNotionTasks } from "../src/service-integrations.ts";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { dirname, join } from "path";

registerProvider(new GroqProvider());
registerProvider(new ClaudeProvider());
if (process.env.GROQ_API_KEY) setDefaultProvider("groq");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const PROJECT_ROOT = join(dirname(import.meta.path), "..");

// ============================================================
// STATE
// ============================================================

function alreadyRanToday(db: Database, userId: string, timezone: string): boolean {
  const lastDate = db.getServiceState("lead-suggester", userId) || "";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: timezone });
  return lastDate === today;
}

function markRanToday(db: Database, userId: string, timezone: string): void {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: timezone });
  db.setServiceState("lead-suggester", userId, today);
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
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        }),
      }
    );
    if (response.ok) return true;

    // Fallback: send without Markdown parsing
    const fallback = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          disable_web_page_preview: true,
        }),
      }
    );
    return fallback.ok;
  } catch {
    return false;
  }
}

// ============================================================
// LOAD PROFILE + GOALS
// ============================================================

async function loadProfile(): Promise<string> {
  const profilePath = join(PROJECT_ROOT, "config", "profile.md");
  if (!existsSync(profilePath)) return "";
  try {
    return await readFile(profilePath, "utf-8");
  } catch {
    return "";
  }
}

function getGoals(db: Database, userId: string): string {
  try {
    const data = db.getActiveGoals(userId);
    if (!data?.length) return "";
    return data.map((g: any) => `- ${g.content}`).join("\n");
  } catch {
    return "";
  }
}

function getFacts(db: Database, userId: string): string {
  try {
    const data = db.getFacts(userId);
    if (!data?.length) return "";
    return data
      .slice(0, 15)
      .map((f: any) => `- ${f.content}`)
      .join("\n");
  } catch {
    return "";
  }
}

// ============================================================
// RESEARCH & GENERATE LEADS
// ============================================================

async function generateLeadSuggestions(
  userName: string,
  db: Database,
  userId: string
): Promise<string> {
  const profile = await loadProfile();
  const goals = getGoals(db, userId);
  const facts = getFacts(db, userId);

  // Research current market signals
  const [marketTrends, aiAdoption, competitorMoves] = await Promise.all([
    searchTavily("businesses adopting AI automation 2025 2026", { maxResults: 5 }),
    searchTavily("small business AI tools demand growing", { maxResults: 5 }),
    searchTavily("AI consulting mentorship coaching business trends", { maxResults: 5 }),
  ]);

  // Fetch current projects for context
  const [clickup, notion] = await Promise.all([
    getClickUpTasks(),
    getNotionTasks(),
  ]);

  const trendsText = [...marketTrends, ...aiAdoption, ...competitorMoves]
    .slice(0, 10)
    .map((a) => `- ${a.title}: ${a.content}`)
    .join("\n");

  const prompt = `You are a lead generation strategist for ${userName}.

${profile ? `About ${userName}:\n${profile}\n` : ""}
${goals ? `Current goals:\n${goals}\n` : ""}
${facts ? `Key facts about the business:\n${facts}\n` : ""}
${clickup ? `Current projects:\n${clickup}\n` : ""}
${notion ? `Notion items:\n${notion}\n` : ""}

Market intelligence:
${trendsText || "No market data available today."}

Based on ${userName}'s business (AI mentorship, software development, digital products), generate 3-5 concrete lead opportunities:

For each opportunity:
1. *Target* — who specifically (industry, company size, role)
2. *Pain point* — what problem they have that ${userName} can solve
3. *Approach* — specific outreach strategy (LinkedIn message, cold email angle, content piece, partnership)
4. *Signal* — what market signal or trend makes this timely RIGHT NOW
5. *Next step* — one specific action ${userName} can take today

Focus on:
- Industries actively adopting AI but struggling with implementation
- Businesses that could benefit from AI automation/mentorship
- Partnership or referral opportunities
- Content-driven lead magnets (webinars, workshops, free tools)

Be specific — not "target small businesses" but "target e-commerce brands with $1-10M revenue looking to automate customer support with AI."

Format as Markdown with clear headers for each opportunity.`;

  try {
    const result = await getDefaultProvider().call({
      prompt,
      outputFormat: "text",
    });
    return result.text;
  } catch (error) {
    console.error("Lead suggestion error:", error);
    return "";
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("Running lead suggester...");

  if (!BOT_TOKEN) {
    console.error("Missing TELEGRAM_BOT_TOKEN");
    process.exit(1);
  }

  const db = getDb();
  const users = db.getAllActiveUsers();

  for (const user of users) {
    if (user.preferences?.lead_suggestions === false) {
      console.log(`${user.name}: lead_suggestions disabled — skipping`);
      continue;
    }

    if (alreadyRanToday(db, user.id, user.timezone)) {
      console.log(`${user.name}: already sent today — skipping`);
      continue;
    }

    console.log(`Generating lead suggestions for ${user.name}...`);
    const suggestions = await generateLeadSuggestions(user.name, db, user.id);

    if (!suggestions) {
      console.error(`Failed to generate lead suggestions for ${user.name}`);
      continue;
    }

    const header = `*Lead Opportunities — Today*\n\n`;
    const success = await sendTelegram(user.telegram_id, header + suggestions);

    if (success) {
      markRanToday(db, user.id, user.timezone);
      console.log(`Lead suggestions sent to ${user.name}!`);
    } else {
      console.error(`Failed to send lead suggestions to ${user.name}`);
    }
  }
}

main();
