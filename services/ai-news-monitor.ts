/**
 * AI News Monitor
 *
 * Runs 3x/day, fetches top AI/tech headlines via Tavily,
 * summarizes them with Groq, and sends a digest to Telegram.
 *
 * Schedule: 13:00, 18:00, 23:00 UTC (8am, 1pm, 6pm ET)
 * Run manually: bun run services/ai-news-monitor.ts
 */

import { getDb, type Database } from "../src/db.ts";
import { registerProvider, getDefaultProvider, getProvider } from "../src/ai-provider.ts";
import { GroqProvider } from "../src/providers/groq.ts";
import { ClaudeProvider } from "../src/providers/claude.ts";
import { searchTavily } from "../src/service-integrations.ts";

registerProvider(new GroqProvider());
registerProvider(new ClaudeProvider());

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

// ============================================================
// STATE — prevent duplicate digests
// ============================================================

function alreadyRanThisWindow(db: Database, userId: string, timezone: string): boolean {
  const raw = db.getServiceState("ai-news-monitor", userId) || "";
  const now = new Date();
  const userHour = parseInt(
    now.toLocaleString("en-US", { timeZone: timezone, hour: "numeric", hour12: false })
  );
  // Windows: morning (7-11), afternoon (12-16), evening (17-21)
  const window = userHour < 12 ? "morning" : userHour < 17 ? "afternoon" : "evening";
  const today = now.toLocaleDateString("en-CA", { timeZone: timezone });
  const key = `${today}:${window}`;
  return raw === key;
}

function markRanThisWindow(db: Database, userId: string, timezone: string): void {
  const now = new Date();
  const userHour = parseInt(
    now.toLocaleString("en-US", { timeZone: timezone, hour: "numeric", hour12: false })
  );
  const window = userHour < 12 ? "morning" : userHour < 17 ? "afternoon" : "evening";
  const today = now.toLocaleDateString("en-CA", { timeZone: timezone });
  db.setServiceState("ai-news-monitor", userId, `${today}:${window}`);
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
// FETCH & SUMMARIZE NEWS
// ============================================================

async function fetchAndSummarizeNews(timeLabel: string, dateLabel: string): Promise<string> {
  const queries = [
    `latest AI news breakthroughs ${dateLabel}`,
    `AI startups funding announcements ${dateLabel}`,
    `AI tools and products launched this week`,
  ];

  // Fetch from multiple angles
  const allResults = await Promise.all(
    queries.map((q) => searchTavily(q, { maxResults: 5, topic: "news" }))
  );

  // Deduplicate by URL
  const seen = new Set<string>();
  const articles: { title: string; url: string; content: string }[] = [];
  for (const results of allResults) {
    for (const r of results) {
      if (!seen.has(r.url)) {
        seen.add(r.url);
        articles.push(r);
      }
    }
  }

  if (!articles.length) return "";

  // Build context for LLM
  const articlesText = articles
    .slice(0, 12)
    .map((a, i) => `${i + 1}. ${a.title}\n   ${a.url}\n   ${a.content}`)
    .join("\n\n");

  const prompt = `You are an AI news curator for a tech entrepreneur who runs an AI mentorship business and builds AI-powered tools.

Here are today's top AI/tech articles (fetched live on ${dateLabel}, ${timeLabel}):

${articlesText}

Create a concise Telegram digest:
- Use a headline like "📰 AI News Digest — ${timeLabel}, ${dateLabel}"
- Pick the 5-7 most important/relevant stories
- For each: one-line summary + the URL
- End with a "Key Takeaway" — one sentence on the biggest trend or opportunity
- Use Markdown formatting (bold headlines, bullet points)
- Keep it scannable — busy entrepreneur should get the gist in 30 seconds
- IMPORTANT: Only include stories from these actual articles. Do NOT repeat stories from previous digests.`;

  try {
    const claude = getProvider("claude") ?? getDefaultProvider();
    const result = await claude.call({
      prompt,
      model: claude.mapModelTier("fast"),
      outputFormat: "text",
    });
    return result.text;
  } catch (error) {
    console.error("News summary error:", error);
    return "";
  }
}

// ============================================================
// MAIN
// ============================================================

export async function main() {
  console.log("Running AI news monitor...");

  if (!BOT_TOKEN) {
    console.error("Missing TELEGRAM_BOT_TOKEN");
    process.exit(1);
  }

  if (!process.env.TAVILY_API_KEY) {
    console.error("Missing TAVILY_API_KEY — cannot fetch news");
    process.exit(1);
  }

  const db = getDb();
  const users = db.getAllActiveUsers();

  for (const user of users) {
    if (user.preferences?.ai_news === false) {
      console.log(`${user.name}: ai_news disabled — skipping`);
      continue;
    }

    if (alreadyRanThisWindow(db, user.id, user.timezone)) {
      console.log(`${user.name}: already sent this window — skipping`);
      continue;
    }

    const now = new Date();
    const userHour = parseInt(
      now.toLocaleString("en-US", { timeZone: user.timezone, hour: "numeric", hour12: false })
    );
    const windowLabel = userHour < 12 ? "Morning" : userHour < 17 ? "Afternoon" : "Evening";
    const dateLabel = now.toLocaleDateString("en-US", {
      timeZone: user.timezone,
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });

    console.log(`Fetching news for ${user.name}...`);
    const digest = await fetchAndSummarizeNews(windowLabel, dateLabel);

    if (!digest) {
      console.error(`Failed to generate news digest for ${user.name}`);
      continue;
    }

    const success = await sendTelegram(user.telegram_id, digest);
    if (success) {
      markRanThisWindow(db, user.id, user.timezone);
      console.log(`News digest sent to ${user.name}!`);
    } else {
      console.error(`Failed to send news digest to ${user.name}`);
    }
  }
}

if (import.meta.main) { main(); }
