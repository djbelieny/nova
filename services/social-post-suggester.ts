/**
 * Social Media Post Suggester
 *
 * Runs after the AI News Monitor, takes the latest AI headlines
 * and DJ's business context, and generates ready-to-post social
 * media ideas sent via Telegram.
 *
 * Schedule: 14:00 UTC (9am ET) — after morning news digest
 * Run manually: bun run services/social-post-suggester.ts
 */

import { getDb, type Database } from "../src/db.ts";
import { registerProvider, getDefaultProvider, getProvider } from "../src/ai-provider.ts";
import { GroqProvider } from "../src/providers/groq.ts";
import { ClaudeProvider } from "../src/providers/claude.ts";
import { searchTavily } from "../src/service-integrations.ts";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { dirname, join } from "path";

registerProvider(new GroqProvider());
registerProvider(new ClaudeProvider());

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const PROJECT_ROOT = join(dirname(import.meta.path), "..");

// ============================================================
// STATE
// ============================================================

function alreadyRanToday(db: Database, userId: string, timezone: string): boolean {
  const lastDate = db.getServiceState("social-post-suggester", userId) || "";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: timezone });
  return lastDate === today;
}

function markRanToday(db: Database, userId: string, timezone: string): void {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: timezone });
  db.setServiceState("social-post-suggester", userId, today);
}

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(chatId: string, message: string): Promise<boolean> {
  const MAX_LEN = 4000;
  const chunks: string[] = [];
  let remaining = message;
  while (remaining.length > MAX_LEN) {
    let splitAt = remaining.lastIndexOf("\n", MAX_LEN);
    if (splitAt < MAX_LEN / 2) splitAt = MAX_LEN;
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);

  for (const chunk of chunks) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: chunk,
            parse_mode: "Markdown",
            disable_web_page_preview: true,
          }),
        }
      );
      if (!response.ok) {
        const fallback = await fetch(
          `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: chunk,
              disable_web_page_preview: true,
            }),
          }
        );
        if (!fallback.ok) return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

// ============================================================
// LOAD PROFILE
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

// ============================================================
// GENERATE POST IDEAS
// ============================================================

async function generatePostIdeas(userName: string): Promise<string> {
  // Fetch fresh AI/tech headlines
  const articles = await searchTavily("AI news breakthroughs tools today", {
    maxResults: 8,
    topic: "news",
  });

  const profile = await loadProfile();

  const articlesText = articles
    .map((a) => `- ${a.title}: ${a.content}`)
    .join("\n");

  const prompt = `You are a social media strategist for ${userName}, a tech entrepreneur who runs an AI mentorship business, builds AI-powered tools, and teaches entrepreneurs how to use AI.

${profile ? `About ${userName}:\n${profile}\n` : ""}
Today's AI/tech headlines:
${articlesText || "No headlines available — generate evergreen post ideas instead."}

Generate 3 social media post ideas that ${userName} could post today. For each idea:

1. *Platform* — which platform it's best for (LinkedIn, X/Twitter, Instagram, or TikTok)
2. *Hook* — the first line that stops the scroll (bold, provocative, or curiosity-driven)
3. *Post body* — the full post copy, ready to paste and publish
4. *Hashtags* — 3-5 relevant hashtags
5. *Why now* — one line explaining the timeliness/relevance

Mix formats: one thought-leadership take, one practical tip/tutorial angle, one hot-take or contrarian view.

Keep posts authentic to a founder's voice — not corporate, not salesy. Conversational, opinionated, value-packed.

Format as Markdown with clear separation between the 3 posts.`;

  try {
    const claude = getProvider("claude") ?? getDefaultProvider();
    const result = await claude.call({
      prompt,
      model: claude.mapModelTier("fast"),
      outputFormat: "text",
    });
    return result.text;
  } catch (error) {
    console.error("Post generation error:", error);
    return "";
  }
}

// ============================================================
// MAIN
// ============================================================

export async function main() {
  console.log("Running social post suggester...");

  if (!BOT_TOKEN) {
    console.error("Missing TELEGRAM_BOT_TOKEN");
    process.exit(1);
  }

  const db = getDb();
  const users = db.getAllActiveUsers();

  for (const user of users) {
    if (user.preferences?.social_posts === false) {
      console.log(`${user.name}: social_posts disabled — skipping`);
      continue;
    }

    if (alreadyRanToday(db, user.id, user.timezone)) {
      console.log(`${user.name}: already sent today — skipping`);
      continue;
    }

    console.log(`Generating post ideas for ${user.name}...`);
    const ideas = await generatePostIdeas(user.name);

    if (!ideas) {
      console.error(`Failed to generate post ideas for ${user.name}`);
      continue;
    }

    const header = `*Social Post Ideas for Today*\n\n`;
    const success = await sendTelegram(user.telegram_id, header + ideas);

    if (success) {
      markRanToday(db, user.id, user.timezone);
      console.log(`Post ideas sent to ${user.name}!`);
    } else {
      console.error(`Failed to send post ideas to ${user.name}`);
    }
  }
}

main();
