/**
 * Dream Mode — Nightly Memory Consolidation Service
 *
 * Like sleep consolidates memories in humans, this service runs during idle
 * periods to extract lasting insights from recent conversations and write them
 * to long-term memory via Memwright.
 *
 * Run: bun run services/dream.ts
 *      bun run services/dream.ts --idle        (only idle users)
 *      bun run services/dream.ts --user <id>   (specific user)
 */

import "dotenv/config";
import { getDb, type Database } from "../src/db.ts";
import { registerProvider, getDefaultProvider, getProvider } from "../src/ai-provider.ts";
import { ClaudeProvider } from "../src/providers/claude.ts";
import { GeminiProvider } from "../src/providers/gemini.ts";
import { CodexProvider } from "../src/providers/codex.ts";
import { GroqProvider } from "../src/providers/groq.ts";
import { memwright } from "../src/memwright-client.ts";
import { getMemoryContext } from "../src/memory.ts";
import { NOVA_NAME } from "../src/identity.ts";

registerProvider(new GroqProvider());
registerProvider(new ClaudeProvider());
registerProvider(new GeminiProvider());
registerProvider(new CodexProvider());

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

// ============================================================
// TYPES
// ============================================================

interface ProactiveUser {
  id: string;
  telegram_id: string;
  name: string;
  timezone: string;
  preferences: Record<string, any>;
  job_role?: string;
}

interface DreamState {
  lastDreamAt: string;
  lastInsightCount: number;
}

// ============================================================
// DB SINGLETON
// ============================================================

let _db: Database | null = null;
function getStateDb(): Database {
  if (!_db) _db = getDb();
  return _db;
}

// ============================================================
// STATE MANAGEMENT (per-user, stored in shared SQLite)
// ============================================================

function loadDreamState(userId: string): DreamState {
  const db = getStateDb();
  const raw = db.getServiceState("dream", userId);
  if (raw) {
    try { return JSON.parse(raw); } catch {}
  }
  return { lastDreamAt: "", lastInsightCount: 0 };
}

function saveDreamState(userId: string, state: DreamState): void {
  const db = getStateDb();
  db.setServiceState("dream", userId, JSON.stringify(state));
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
// IDLE DETECTION (timezone-aware)
// ============================================================

function isUserIdle(db: Database, user: ProactiveUser): boolean {
  const recent = db.getRecentMessages(user.id, 1);
  if (!recent.length) return false;
  const hoursSince = (Date.now() - new Date(recent[0].created_at).getTime()) / 3_600_000;
  const localHour = new Date().toLocaleString("en-US", {
    timeZone: user.timezone || "UTC",
    hour: "numeric",
    hour12: false,
  });
  const isDaytime = parseInt(localHour) >= 8 && parseInt(localHour) < 22;
  return hoursSince >= (isDaytime ? 6 : 10);
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
        body: JSON.stringify({ chat_id: chatId, text: message }),
      }
    );
    return response.ok;
  } catch {
    return false;
  }
}

// ============================================================
// DREAM CYCLE (per-user)
// ============================================================

async function runDreamCycle(db: Database, user: ProactiveUser): Promise<number> {
  // 1. Rate gate — skip if last dream was less than 6 hours ago
  const state = loadDreamState(user.id);
  if (state.lastDreamAt) {
    const hoursSince = (Date.now() - new Date(state.lastDreamAt).getTime()) / 3_600_000;
    if (hoursSince < 6) {
      console.log(`[dream] ${user.name}: skipping — last dream ${hoursSince.toFixed(1)}h ago`);
      return 0;
    }
  }

  // 2. Fetch recent conversation messages chronologically
  const recentMessages = db.getRecentMessages(user.id, 50);
  const sorted = [...recentMessages].reverse(); // getRecentMessages returns newest-first, reverse to get oldest-first

  // 3. Format as User/Nova exchanges, capped at 20,000 chars
  let exchanges = "";
  for (const msg of sorted) {
    const prefix = msg.role === "user" ? "User" : NOVA_NAME;
    const line = `${prefix}: ${msg.content}\n`;
    if ((exchanges + line).length > 20_000) break;
    exchanges += line;
  }
  const formattedExchanges = exchanges.trim() || "(no recent conversation history)";

  // 4. Get existing memory context so Claude knows what NOT to re-record
  let existingContext = "";
  try {
    existingContext = await getMemoryContext(db, user.id, 2000);
  } catch (err) {
    console.warn(`[dream] ${user.name}: getMemoryContext failed — ${err}`);
  }

  // 5. Build dream prompt
  const dreamPrompt = `You are running ${user.name}'s nightly memory consolidation. Like sleep, extract lasting insights from recent experiences — patterns, not events.

EXISTING LONG-TERM MEMORY (do NOT repeat anything already here):
${existingContext || "(none yet)"}

RECENT CONVERSATIONS (last 48 hours):
${formattedExchanges}

Find things NOT already in long-term memory:
(a) Communication/work patterns
(b) Implicit goals or concerns
(c) Preferences revealed through behavior
(d) Durable facts worth remembering long-term

Rules: skip one-off events, keep insights self-contained, max 8 per cycle.

Format: [INSIGHT: text]
Nothing new: output only NO_INSIGHTS`;

  // 6. Call Claude Haiku
  let response = "";
  try {
    const claude = getProvider("claude") ?? getDefaultProvider();
    const result = await claude.call({
      prompt: dreamPrompt,
      model: claude.mapModelTier("fast"),
      outputFormat: "text",
      sandboxed: true,
    });
    response = result.text;
  } catch (err) {
    console.error(`[dream] ${user.name}: LLM call failed — ${err}`);
    return 0;
  }

  // 7. Parse [INSIGHT: text] tags
  const insightMatches = [...response.matchAll(/\[INSIGHT:\s*(.+?)\]/gi)];
  const insights = insightMatches.map(m => m[1].trim()).filter(Boolean);

  if (insights.length === 0) {
    console.log(`[dream] ${user.name}: no new insights this cycle`);
    saveDreamState(user.id, { lastDreamAt: new Date().toISOString(), lastInsightCount: 0 });
    return 0;
  }

  // 8. Write insights to Memwright
  let savedCount = 0;
  try {
    await memwright.batchAdd(
      insights.map(text => ({
        content: text,
        namespace: `user:${user.id}`,
        category: "insight",
        tags: ["dream", new Date().toISOString().slice(0, 10)],
        metadata: {
          source: "dream-mode",
          cycle_date: new Date().toISOString().slice(0, 10),
        },
      }))
    );
    savedCount = insights.length;
  } catch (err) {
    console.warn(`[dream] ${user.name}: batchAdd failed — ${err}. Will retry next cycle.`);
  }

  // 9. Update state
  saveDreamState(user.id, { lastDreamAt: new Date().toISOString(), lastInsightCount: savedCount });

  // 10. Optional Telegram notification
  if (user.preferences?.dream_notify === true && insights.length >= 3 && BOT_TOKEN) {
    await sendTelegram(
      user.telegram_id,
      `Dream mode ran — extracted ${insights.length} new insights from your recent conversations.`
    );
  }

  return insights.length;
}

// ============================================================
// MAIN
// ============================================================

export async function main() {
  const db = getDb();
  const users = getAllProactiveUsers(db);
  const idleOnly = process.argv.includes("--idle");
  const targetUser = process.argv.includes("--user")
    ? process.argv[process.argv.indexOf("--user") + 1]
    : null;

  for (const user of users) {
    if (targetUser && user.id !== targetUser) continue;
    if (idleOnly && !isUserIdle(db, user)) {
      console.log(`[dream] Skipping ${user.name} — not idle`);
      continue;
    }
    const count = await runDreamCycle(db, user);
    console.log(`[dream] ${user.name}: ${count} insights extracted`);
  }
}

if (import.meta.main) { main().catch(console.error); }
