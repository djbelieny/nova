/**
 * Memory Module
 *
 * Persistent facts, goals, and preferences stored in Supabase.
 * Claude manages memory automatically via intent tags in its responses:
 *   [REMEMBER: fact]
 *   [GOAL: text | DEADLINE: date]
 *   [DONE: search text]
 *
 * Nova parses these tags, saves to the database, and strips them
 * from the response before sending to the user.
 */

import type { Database } from "./db.ts";
import { memwright } from "./memwright-client.ts";
import type { RecallResult } from "./memwright-client.ts";

/** Escape SQL LIKE/ILIKE wildcards to prevent wildcard injection. */
function escapeIlike(text: string): string {
  return text.replace(/[%_\\]/g, (c) => `\\${c}`);
}

// ── AI summarizer (optional — injected from relay.ts at startup) ──
// When available, long facts/goals are summarized with haiku before storage.
// Falls back to rule-based compression when not available.
type SummarizeAI = (prompt: string) => Promise<string>;
let _summarizeAI: SummarizeAI | null = null;

/**
 * Wire in an AI caller for write-time summarization.
 * Call once from relay.ts after providers are registered.
 */
export function initMemorySummarizer(callAI: SummarizeAI): void {
  _summarizeAI = callAI;
}

// ── Session summarizer (optional — injected from relay.ts at startup) ──
// Maintains a compact working memory summary for each active session.
let _sessionSummarizer: ((prompt: string, model: string) => Promise<string>) | null = null;

/** Wire in an AI caller for session summary generation.
 *  The callAI function receives (prompt, modelTier) where modelTier is e.g. "haiku".
 *  Call once at startup, alongside initMemorySummarizer. */
export function initSessionSummarizer(
  callAI: (prompt: string, model: string) => Promise<string>
): void {
  _sessionSummarizer = callAI;
}

/**
 * Read the current session summary and format it for prompt injection.
 */
export async function getSessionSummaryContext(
  db: Database | null,
  userId: string,
  sessionKey: string
): Promise<string> {
  // Sync DB call — async for API uniformity with other memory context functions
  if (!db) return "";
  const row = db.getSessionSummary(userId, sessionKey);
  if (!row) return "";
  const summary = row.summary.slice(0, 600); // safety cap
  return `CURRENT SESSION:\n${summary}`;
}

/**
 * Fire-and-forget session summary update after each exchange.
 * Keeps a rolling working memory of what happened this session.
 */
export function updateSessionSummaryAsync(
  db: Database | null,
  userId: string,
  sessionKey: string,
  userMessage: string,
  assistantResponse: string
): void {
  if (!db || !_sessionSummarizer) return;

  const existing = db.getSessionSummary(userId, sessionKey);

  const prompt = `You are maintaining a compact working memory summary for an AI assistant session.

Existing summary (may be empty for new sessions):
${existing?.summary || "(none yet)"}

Latest exchange:
User: ${userMessage.slice(0, 500)}
Assistant: ${assistantResponse.slice(0, 800)}

Update the working memory summary. Keep it under 200 words. Format exactly:
Current session: [topic in 5 words]. Key context: [2-3 key facts established this session]. User is working on: [current goal or task]. Last exchange: [one sentence summary of what just happened].

Output ONLY the updated summary text, nothing else.`;

  _sessionSummarizer(prompt, "haiku")
    .then(summary => {
      db.upsertSessionSummary(userId, sessionKey, summary.trim());
    })
    .catch(err => console.warn("[session-summary] Update failed:", err));
}

/**
 * Compress content before storing in memory.
 * Rule-based (zero AI cost, zero latency) — strips filler, normalises to terse
 * declarative form, and cuts at a sentence boundary instead of mid-word.
 *
 * This runs at WRITE TIME so everything in the DB is already compact.
 * The model then receives clean, dense context rather than verbose verbatim text.
 */
export function compressForStorage(text: string, type: "fact" | "goal"): string {
  let s = text
    .trim()
    .replace(/\s+/g, " ") // collapse whitespace

    // ── strip leading filler phrases ──
    .replace(/^(please\s+)?(remember(\s+that)?|note(\s+that)?|keep\s+in\s+mind(\s+that)?|fyi[,:]?\s*|just\s+so\s+you\s+know[,:]?\s*)/i, "")
    .replace(/^(btw|by\s+the\s+way)[,:]?\s*/i, "")
    .replace(/^(also[,:]?\s*)/i, "")
    .trim() // remove any leading space left by filler strip

    // ── "my <field> is [called] <value>" → "<Field>: <value>" ──
    .replace(
      /^my (name|company|business|brand|job|role|title|email|phone|website|product|service|industry|location|city|country|timezone|language) (is|are)(\s+called|\s+known\s+as)?\s+/i,
      (_, noun) => `${noun.charAt(0).toUpperCase() + noun.slice(1)}: `
    )
    // ── "the <field> is" → "<Field>:" ──
    .replace(
      /^the (client|contact|customer|user|company|business)\s+(name\s+)?(is|are)\s+/i,
      (_, noun) => `${noun.charAt(0).toUpperCase() + noun.slice(1)}: `
    )

    // ── goal-specific: strip intent opener ──
    .replace(/^(goal:|objective:|my\s+goal\s+is\s+(to\s+)?|i\s+(want|need|aim|plan|hope)\s+to\s+|i'?m\s+(trying|working|planning)\s+to\s+|i\s+would\s+like\s+to\s+)/i, "")

    // ── fact-specific: strip "I am/I'm <verb>-ing" starters ──
    .replace(/^i\s+(am|was|have\s+been)\s+/i, "")
    .trim();

  // ── smart sentence-boundary cap — never cut mid-sentence ──
  const MAX = type === "goal" ? 100 : 150;
  if (s.length > MAX) {
    // Look for a sentence end (.!?) within a small window past MAX
    const window = s.slice(0, MAX + 30);
    const ends = [window.lastIndexOf(".", MAX), window.lastIndexOf("!", MAX), window.lastIndexOf("?", MAX)];
    const sentenceEnd = Math.max(...ends);

    if (sentenceEnd > MAX / 2) {
      s = s.slice(0, sentenceEnd + 1).trim();
    } else {
      // No sentence boundary — cut at last comma or space within MAX
      const breakAt = Math.max(window.lastIndexOf(",", MAX), window.lastIndexOf(" ", MAX));
      s = s.slice(0, breakAt > MAX / 2 ? breakAt : MAX).trim();
    }
  }

  // Capitalise first letter
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Detect a loose category from a fact string.
 * Used to group facts in context rather than dumping a flat list.
 */
export function detectFactCategory(fact: string): string {
  const f = fact.toLowerCase();
  if (/\b(name|call(ed)?|known as|nickname)\b/.test(f)) return "identity";
  if (/\b(company|business|brand|startup|agency|firm|org|organisation|organization|industry|sector)\b/.test(f)) return "business";
  if (/\b(email|phone|address|location|city|country|timezone|website|url|domain)\b/.test(f)) return "contact";
  if (/\b(prefer|like|love|hate|dislike|avoid|always|never|style|tone|format|language)\b/.test(f)) return "preferences";
  if (/\b(client|customer|partner|vendor|supplier|contact|team|colleague|employee|staff)\b/.test(f)) return "people";
  if (/\b(product|service|offer|price|pricing|plan|tier|feature|tool|software|platform)\b/.test(f)) return "product";
  if (/\b(revenue|mrr|arr|profit|budget|spend|cost|sales|deal|pipeline)\b/.test(f)) return "finance";
  return "general";
}

/**
 * Summarize content for storage using haiku when content is long enough
 * to benefit from AI compression. Falls back to compressForStorage (rule-based)
 * if the AI caller is not available or the content is already short.
 *
 * AI is invoked only when content exceeds the threshold after rule-based
 * compression — so short facts never incur an AI call.
 */
async function summarizeForStorage(raw: string, type: "fact" | "goal"): Promise<string> {
  // Always run rule-based pass first — it's free and often sufficient
  const ruleCompressed = compressForStorage(raw, type);

  const THRESHOLD = type === "goal" ? 80 : 120;

  // If already short, done — no AI needed
  if (ruleCompressed.length <= THRESHOLD) return ruleCompressed;

  // No AI available — return rule-based result
  if (!_summarizeAI) return ruleCompressed;

  try {
    const instruction = type === "goal"
      ? `Summarize this goal into one concise sentence under 80 characters. Preserve: core objective, any numbers/metrics, any deadline. Remove filler words. Output ONLY the summary, nothing else:\n${raw}`
      : `Summarize this fact into one concise sentence under 120 characters. Preserve: all names, numbers, dates, relationships, and key details. Remove filler words. Output ONLY the summary, nothing else:\n${raw}`;

    const result = (await _summarizeAI(instruction)).trim();

    // Sanity checks — reject AI output that looks wrong
    if (result.length < 5 || result.length > 300) return ruleCompressed;
    if (result.includes("\n")) return ruleCompressed; // should be single line
    // Strip any accidental quotes the model may wrap around output
    const clean = result.replace(/^["']|["']$/g, "").trim();
    return clean || ruleCompressed;
  } catch {
    return ruleCompressed;
  }
}

/**
 * Collapse a list of older messages into a compact digest line.
 * Extracts the first meaningful clause from each message, deduplicates,
 * and joins with " | ". No AI involved — read-time must stay fast.
 */
function digestMessages(messages: any[], timezone: string): string {
  const phrases: string[] = [];
  for (const m of messages) {
    const content = (m.content || "").trim();
    if (!content) continue;
    // Take first sentence or first 60 chars, whichever is shorter
    const firstSentence = content.split(/[.!?\n]/)[0].trim();
    const snippet = firstSentence.slice(0, 60);
    if (snippet.length > 8) phrases.push(snippet);
  }
  // Deduplicate near-identical phrases
  const unique = phrases.filter((p, i) => !phrases.slice(0, i).some(q => q.slice(0, 20) === p.slice(0, 20)));
  return unique.slice(0, 6).join(" | ");
}

/**
 * Parse Claude's response for memory intent tags.
 * Saves facts/goals to Supabase and returns the cleaned response.
 */
export async function processMemoryIntents(
  db: Database | null,
  response: string,
  userId: string,
  userTimezone?: string,
  agentContext?: { agentSlug?: string; sessionId?: string }
): Promise<string> {
  if (!db) return response;

  let clean = response;

  // [REMEMBER: fact to store] — summarize before storing
  for (const match of response.matchAll(/\[REMEMBER:\s*(.+?)\]/gi)) {
    const fact = await summarizeForStorage(match[1], "fact");
    await memwright.add({
      content: fact,
      namespace: `user:${userId}`,
      category: detectFactCategory(fact),
      metadata: { agentSlug: agentContext?.agentSlug, sessionId: agentContext?.sessionId },
    });
    clean = clean.replace(match[0], "");
  }

  // [SHARE: fact to share with team]
  for (const match of response.matchAll(/\[SHARE:\s*(.+?)\]/gi)) {
    const summarized = await summarizeForStorage(match[1], "fact");
    await memwright.add({
      content: summarized,
      namespace: "nova:shared",
      category: detectFactCategory(summarized),
      metadata: { agentSlug: agentContext?.agentSlug, sessionId: agentContext?.sessionId },
    });
    clean = clean.replace(match[0], "");
  }

  // [GOAL: text] or [GOAL: text | DEADLINE: date]
  for (const match of response.matchAll(/\[GOAL:\s*(.+?)(?:\s*\|\s*DEADLINE:\s*(.+?))?\]/gi)) {
    const summarized = await summarizeForStorage(match[1], "goal");
    await memwright.add({
      content: summarized,
      namespace: `user:${userId}`,
      category: "goal",
      tags: ["goal"],
      metadata: { deadline: match[2] || null, agentSlug: agentContext?.agentSlug },
    });
    clean = clean.replace(match[0], "");
  }

  // [DONE: search text for completed goal]
  for (const match of response.matchAll(/\[DONE:\s*(.+?)\]/gi)) {
    const results = await memwright.search({
      namespace: `user:${userId}`,
      category: "goal",
      entity: match[1],
      limit: 1,
    });
    const first = results[0];
    if (first?.id) await memwright.forget(first.id);
    clean = clean.replace(match[0], "");
  }

  // [TASK: agent | description] — create a new task
  for (const match of response.matchAll(/\[TASK:\s*(.+?)\s*\|\s*(.+?)\]/gi)) {
    db.insertTask({
      agent: match[1],
      description: match[2],
      status: "pending",
      user_id: userId,
    });
    clean = clean.replace(match[0], "");
  }

  // [TASK_START: search text] — mark matching pending task as in_progress
  for (const match of response.matchAll(/\[TASK_START:\s*(.+?)\]/gi)) {
    const task = db.findTaskByDescription(userId, ["pending"], match[1]);

    if (task) {
      db.updateTask(task.id, { status: "in_progress" });
    }
    clean = clean.replace(match[0], "");
  }

  // [TASK_DONE: search text | result] — mark matching active task as done
  for (const match of response.matchAll(/\[TASK_DONE:\s*(.+?)\s*\|\s*(.+?)\]/gi)) {
    const task = db.findTaskByDescription(userId, ["pending", "in_progress"], match[1]);

    if (task) {
      db.updateTask(task.id, { status: "completed", result: match[2] });
    }
    clean = clean.replace(match[0], "");
  }

  // [TASK_BLOCKED: search text | reason] — mark matching active task as blocked
  for (const match of response.matchAll(/\[TASK_BLOCKED:\s*(.+?)\s*\|\s*(.+?)\]/gi)) {
    const task = db.findTaskByDescription(userId, ["pending", "in_progress"], match[1]);

    if (task) {
      db.updateTask(task.id, { status: "blocked", result: match[2] });
    }
    clean = clean.replace(match[0], "");
  }

  // [TASK_CANCEL: search text] — cancel a matching task
  for (const match of response.matchAll(/\[TASK_CANCEL:\s*(.+?)\]/gi)) {
    const task = db.findTaskByDescription(userId, ["pending", "in_progress", "blocked"], match[1]);

    if (task) {
      db.updateTask(task.id, { status: "cancelled" });
    }
    clean = clean.replace(match[0], "");
  }

  // [SCHEDULE: title | datetime | instructions]
  // [SCHEDULE: title | datetime | instructions | RECUR: rule]
  // [SCHEDULE: title | datetime | instructions | RECUR: rule | IF: condition]
  for (const match of response.matchAll(
    /\[SCHEDULE:\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)(?:\s*\|\s*RECUR:\s*(.+?))?(?:\s*\|\s*IF:\s*(.+?))?\]/gi
  )) {
    const title = match[1].trim();
    const rawTrigger = match[2].trim();
    const instructions = match[3].trim();
    const recurrence = match[4]?.trim() || null;
    const condition = match[5]?.trim() || null;
    const tz = userTimezone || "UTC";

    const triggerAt = parseScheduleTrigger(rawTrigger, tz);
    if (triggerAt) {
      const isOneTime = !recurrence;
      db.insertScheduledTask({
        user_id: userId,
        created_by: "user",
        title,
        instructions,
        trigger_at: triggerAt.toISOString(),
        recurrence,
        timezone: tz,
        condition,
        max_runs: isOneTime ? 1 : null,
      });
    }
    clean = clean.replace(match[0], "");
  }

  // [SCHEDULE_CANCEL: search text]
  for (const match of response.matchAll(/\[SCHEDULE_CANCEL:\s*(.+?)\]/gi)) {
    const task = db.findScheduledTaskByTitle(userId, match[1]);

    if (task) {
      db.updateScheduledTask(task.id, { status: "cancelled" });
    }
    clean = clean.replace(match[0], "");
  }

  // [MESSAGE: @username | content] — inter-user messaging
  const messageTagRegex = /\[MESSAGE:\s*@([^\s|]+)\s*\|\s*([^\]]+)\]/g;
  for (const msgMatch of response.matchAll(messageTagRegex)) {
    const targetUsername = msgMatch[1].trim();
    const messageContent = msgMatch[2].trim();

    try {
      const allUsers = db.getAllActiveUsers();
      const target = allUsers.find((u: any) =>
        u.name?.toLowerCase() === targetUsername.toLowerCase() ||
        u.telegram_id === targetUsername
      );

      if (target) {
        db.saveInterUserMessage({
          from_user_id: userId,
          to_user_id: target.id,
          content: messageContent,
        });
      } else {
        console.warn(`[memory] Inter-user message: user "@${targetUsername}" not found`);
      }
    } catch (err) {
      console.error("[memory] Inter-user message failed:", err);
    }
    clean = clean.replace(msgMatch[0], "");
  }

  return clean.trim();
}

/**
 * Get all facts and active goals for prompt context.
 */
export async function getMemoryContext(
  db: Database | null,
  userId: string,
  budget: number = 3000
): Promise<string> {
  try {
    const [userResults, sharedResults] = await Promise.all([
      memwright.recall("user facts preferences goals context", {
        namespace: `user:${userId}`,
        budget: Math.floor(budget * 0.8),
      }),
      memwright.recall("shared facts context", {
        namespace: "nova:shared",
        budget: Math.floor(budget * 0.2),
      }),
    ]);

    const allResults = [...userResults, ...sharedResults];
    if (!allResults.length) return "";

    // Separate goals from facts for display
    const goals = allResults.filter(r => r.memory?.category === "goal");
    const facts = allResults.filter(r => r.memory?.category !== "goal");

    const parts: string[] = [];

    if (facts.length) {
      parts.push("FACTS:\n" + facts.map(r => `- ${r.content}`).join("\n"));
    }
    if (goals.length) {
      parts.push("GOALS:\n" + goals.map(r => `- ${r.content}`).join("\n"));
    }

    return parts.join("\n\n");
  } catch (error) {
    console.error("Memory context error:", error);
    return "";
  }
}

/**
 * Get active agent tasks for prompt context.
 */
export async function getTaskContext(
  db: Database | null,
  userId: string
): Promise<string> {
  if (!db) return "";

  try {
    const data = db.getActiveTasks(userId);

    if (!data?.length) return "";

    // Cap at 15 tasks, 100 chars per description
    const tasks = data.slice(0, 15);
    const lines = tasks.map(
      (t: any) => `- [${t.agent}] ${(t.description || "").slice(0, 100)} (${t.status})`
    );
    if (data.length > 15) {
      lines.push(`[...${data.length - 15} more tasks]`);
    }

    return "ACTIVE TASKS:\n" + lines.join("\n");
  } catch (error) {
    console.warn("Task context error:", error);
    return "";
  }
}

/**
 * Get recent conversation history (chronological, last N messages).
 * Provides immediate conversational context — "what were we just talking about?"
 */
export async function getRecentHistory(
  db: Database | null,
  userId: string,
  count: number = 12
): Promise<string> {
  if (!db) return "";

  try {
    const data = db.getRecentMessages(userId, count);
    if (!data?.length) return "";

    // Data comes DESC from DB, reverse to chronological
    const messages = [...data].reverse();

    // ── Strategy: keep the last 4 turns verbatim (immediate context) ──
    // Older turns are collapsed into a single digest line.
    // This gives the model what it needs for the current exchange without
    // flooding the prompt with history it doesn't need word-for-word.

    const VERBATIM_COUNT = 4;
    const older = messages.slice(0, -VERBATIM_COUNT);
    const recent = messages.slice(-VERBATIM_COUNT);

    const lines: string[] = [];

    // Digest line for older messages
    if (older.length > 0) {
      const digest = digestMessages(older, "America/New_York");
      if (digest) lines.push(`Earlier: ${digest}`);
    }

    // Verbatim recent messages — cap each at 400 chars at a sentence boundary
    const MAX_VERBATIM_CHARS = 400;
    for (const m of recent) {
      const ts = new Date(m.created_at).toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
      let content = (m.content || "").trim();
      if (content.length > MAX_VERBATIM_CHARS) {
        // Cut at last sentence boundary within the window
        const window = content.slice(0, MAX_VERBATIM_CHARS + 20);
        const ends = [window.lastIndexOf(".", MAX_VERBATIM_CHARS), window.lastIndexOf("!", MAX_VERBATIM_CHARS), window.lastIndexOf("?", MAX_VERBATIM_CHARS)];
        const sentEnd = Math.max(...ends);
        content = sentEnd > MAX_VERBATIM_CHARS / 2
          ? content.slice(0, sentEnd + 1).trim()
          : content.slice(0, MAX_VERBATIM_CHARS).trim();
      }
      lines.push(`[${ts} ${m.role}]: ${content}`);
    }

    return "RECENT CONVERSATION:\n" + lines.join("\n");
  } catch (error) {
    console.warn("Recent history error:", error);
    return "";
  }
}

/**
 * Semantic search for relevant past memories via Memwright ranked recall.
 */
export async function getRelevantContext(
  db: Database | null,
  query: string,
  userId: string
): Promise<string> {
  try {
    const results = await memwright.recall(query, {
      namespace: `user:${userId}`,
      budget: 1000,
    });

    if (!results.length) return "";

    // Promote short-term memories that get recalled — atomically via SQLite lock
    for (const r of results) {
      const meta = r.memory?.metadata;
      if (meta?.short_term === true && meta?.promoted !== true) {
        const locked = db?.markShortTermMemoryPromoted(r.id);
        if (locked) {
          promoteToLongTerm(r, userId); // fire-and-forget
        }
      }
    }

    return (
      "RELEVANT PAST:\n" +
      results
        .map(r => `- ${r.content}`)
        .join("\n")
    );
  } catch (error) {
    console.warn("Relevant context error:", error);
    return "";
  }
}

/**
 * Parse a trigger time string into a Date.
 * Supports: ISO datetime (2026-02-19T15:00:00), relative (+30m, +2h, +1d).
 */
export function parseScheduleTrigger(raw: string, timezone: string): Date | null {
  // Relative: +30m, +2h, +1d
  const relMatch = raw.match(/^\+(\d+)([mhd])$/i);
  if (relMatch) {
    const amount = parseInt(relMatch[1]);
    const unit = relMatch[2].toLowerCase();
    const now = new Date();
    if (unit === "m") now.setMinutes(now.getMinutes() + amount);
    else if (unit === "h") now.setHours(now.getHours() + amount);
    else if (unit === "d") now.setDate(now.getDate() + amount);
    return now;
  }

  // ISO datetime — parse directly
  const parsed = new Date(raw);
  if (!isNaN(parsed.getTime())) return parsed;

  return null;
}

/**
 * Compute the next trigger_at for a recurring task.
 * Recurrence DSL: daily:HH:MM, weekly:DAY:HH:MM, weekdays:HH:MM, interval:SECONDS
 */
export function computeNextTrigger(recurrence: string, timezone: string, lastTrigger: Date): Date | null {
  const parts = recurrence.split(":");

  if (parts[0] === "interval" && parts[1]) {
    const seconds = parseInt(parts[1]);
    if (isNaN(seconds)) return null;
    return new Date(lastTrigger.getTime() + seconds * 1000);
  }

  if (parts[0] === "daily" && parts[1] && parts[2]) {
    const hour = parseInt(parts[1]);
    const minute = parseInt(parts[2]);
    const next = new Date(lastTrigger);
    next.setDate(next.getDate() + 1);
    // Set time in UTC approximation (timezone handling is simplified)
    next.setUTCHours(hour, minute, 0, 0);
    return next;
  }

  if (parts[0] === "weekly" && parts[1] && parts[2] && parts[3]) {
    const targetDay = parseInt(parts[1]); // 0=Sunday, 1=Monday, etc.
    const hour = parseInt(parts[2]);
    const minute = parseInt(parts[3]);
    const next = new Date(lastTrigger);
    const currentDay = next.getUTCDay();
    let daysAhead = targetDay - currentDay;
    if (daysAhead <= 0) daysAhead += 7;
    next.setDate(next.getDate() + daysAhead);
    next.setUTCHours(hour, minute, 0, 0);
    return next;
  }

  if (parts[0] === "weekdays" && parts[1] && parts[2]) {
    const hour = parseInt(parts[1]);
    const minute = parseInt(parts[2]);
    const next = new Date(lastTrigger);
    do {
      next.setDate(next.getDate() + 1);
    } while (next.getUTCDay() === 0 || next.getUTCDay() === 6); // skip weekends
    next.setUTCHours(hour, minute, 0, 0);
    return next;
  }

  return null;
}

/**
 * Get recent board decisions for prompt context injection.
 * Queries the shared Supabase decisions table via ExecComms.
 * Falls back gracefully if ExecComms is not initialized.
 */
export async function getDecisionContext(
  userId: string,
  comms?: any // ExecComms instance (optional)
): Promise<string> {
  if (!comms) return "";

  try {
    const decisions = await comms.getRecentDecisions(userId, 20);
    if (!decisions?.length) return "";

    const lines = decisions.map((d: any) => {
      const date = new Date(d.created_at).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });
      const confidence = d.confidence ? ` (confidence: ${(d.confidence * 100).toFixed(0)}%)` : "";
      const outcome = d.outcome && d.outcome !== "pending" ? ` [${d.outcome}]` : "";
      return `- [${date}] ${d.question} → ${d.chosen_option}${confidence}${outcome}`;
    });

    return "PAST DECISIONS:\n" + lines.join("\n");
  } catch (error) {
    console.warn("Decision context error:", error);
    return "";
  }
}

/**
 * Promote a short-term memory to long-term by re-adding it without the short_term flag.
 * The original short-term entry expires naturally via the pruning sweep in memory-review.ts.
 * Not exported — called only from getRelevantContext promotion loop.
 */
function promoteToLongTerm(result: RecallResult, userId: string): void {
  const meta = result.memory?.metadata;
  memwright.add({
    content: result.content,
    namespace: `user:${userId}`,
    category: (result.memory?.category as string) || "conversation",
    tags: ["promoted"],
    metadata: {
      ...meta,
      short_term: false,
      promoted: true,
      promoted_at: new Date().toISOString(),
    },
  }).catch(err => console.warn("[memory] Short-term promotion failed:", err));
}

/**
 * Get active scheduled tasks for prompt context injection.
 */
export async function getScheduleContext(
  db: Database | null,
  userId: string,
  userTimezone?: string
): Promise<string> {
  if (!db) return "";

  try {
    const data = db.getScheduledTasks(userId);

    if (!data?.length) return "";

    // Cap at 20 scheduled tasks
    const tasks = data.slice(0, 20);
    const lines = tasks.map((t: any) => {
      const triggerStr = t.trigger_at
        ? new Date(t.trigger_at).toLocaleString("en-US", {
            timeZone: userTimezone || t.timezone || "UTC",
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          })
        : "no trigger time";
      const recur = t.recurrence ? ` (${t.recurrence})` : "";
      const creator = t.created_by === "nova" ? " [self-scheduled]" : "";
      return `- ${t.title} — ${triggerStr}${recur}${creator}`;
    });
    if (data.length > 20) {
      lines.push(`[...${data.length - 20} more scheduled tasks truncated...]`);
    }

    return "SCHEDULED TASKS:\n" + lines.join("\n");
  } catch (error) {
    console.warn("Schedule context error:", error);
    return "";
  }
}
