/**
 * Group Chat — Executive Board Room
 *
 * Turns a Telegram group into a live executive board room where
 * executives have natural conversations. Key behaviors:
 *
 * - Relevance check: each exec only responds when the message is in their domain
 * - @mention activation: always respond when directly mentioned
 * - Turn-taking: staggered delays prevent simultaneous responses
 * - Reply threading: execs reply to each other's messages
 * - Nova as moderator: can call on specific execs
 *
 * Usage: add all exec bots + Nova to a Telegram group.
 */

import type { ExecComms, ExecRosterEntry } from "./exec-comms.ts";

// ============================================================
// Types
// ============================================================

interface GroupMessage {
  messageId: number;
  chatId: number;
  fromUserId: string;
  fromName: string;
  text: string;
  replyToMessageId?: number;
  replyToText?: string;
  replyToFrom?: string;
}

interface GroupChatConfig {
  role: string;
  execName: string;
  botUsername: string; // e.g., "Nova07CEO_bot"
  userTelegramUsername?: string; // e.g., "djbelieny" — so execs can @mention the user
}

// ============================================================
// Domain mappings — which topics each exec cares about
// ============================================================

const DOMAIN_KEYWORDS: Record<string, string[]> = {
  ceo: [
    "strategy", "vision", "direction", "mission", "pivot", "fundraise",
    "board", "decision", "priority", "roadmap", "expansion", "acquisition",
    "partnership", "leadership", "culture", "long-term", "competitive advantage",
    "moat", "flywheel", "day one", "big picture", "overall",
    "goals", "okr", "target", "milestone", "customer", "product",
    "hiring", "quarterly", "annual", "company",
  ],
  cfo: [
    "budget", "revenue", "cost", "profit", "margin", "pricing", "finance",
    "cash flow", "roi", "cac", "ltv", "unit economics", "forecast",
    "financial", "spend", "expense", "invoice", "payment", "subscription",
    "arr", "mrr", "burn rate", "runway", "investment", "tax",
    "target", "goal", "growth", "sales",
  ],
  cmo: [
    "marketing", "brand", "campaign", "social media", "content", "growth",
    "audience", "engagement", "conversion", "funnel", "ads", "advertising",
    "seo", "email marketing", "newsletter", "launch", "positioning",
    "messaging", "creative", "viral", "influencer", "pr launch", "rebrand",
    "customer", "feedback", "user", "community",
  ],
  cto: [
    "technology", "architecture", "infrastructure", "code", "api", "database",
    "security", "performance", "scalability", "tech stack", "deploy",
    "server", "cloud", "bug", "technical debt", "integration", "build",
    "system", "devops", "microservice", "latency", "uptime",
    "product", "feature", "platform", "app",
  ],
  coo: [
    "operations", "process", "workflow", "efficiency", "bottleneck",
    "execution", "timeline", "deadline", "project management", "status",
    "progress", "blocked", "resource", "capacity", "hiring", "team",
    "kpi", "metrics", "dashboard", "daily standup", "sprint",
    "goal", "okr", "target", "milestone", "quality",
  ],
  research: [
    "research", "trend", "market", "competitor", "analysis", "data",
    "industry", "report", "study", "insight", "forecast", "signal",
    "opportunity", "disruption", "emerging", "benchmark", "landscape",
    "customer", "user", "product", "ai", "technology",
  ],
  critic: [
    "risk", "concern", "problem", "issue", "fail", "mistake", "wrong",
    "assumption", "bias", "blind spot", "downside", "worst case",
    "devil's advocate", "challenge", "question", "red flag", "warning",
    "goal", "target", "quality", "incomplete",
  ],
};

// Turn-taking priority order — CEO first, then by domain relevance
const ROLE_PRIORITY: Record<string, number> = {
  ceo: 1,
  cfo: 2,
  cmo: 3,
  cto: 4,
  coo: 5,
  research: 6,
  critic: 7,
};

// Base delay per priority slot (ms) — staggers responses
const STAGGER_DELAY_MS = 3000;

// Cooldown: don't respond to same chat within N seconds (prevents spam)
// Tracked per exec per chat — each exec has its own cooldown
const RESPONSE_COOLDOWN_MS = 30_000;

// ============================================================
// State
// ============================================================

let _callAI: (prompt: string, tier?: string, hint?: string) => Promise<string>;
let _comms: ExecComms;
let _config: GroupChatConfig;
let _execPrompt: string;

// Track recent messages for context window
const recentGroupMessages: GroupMessage[] = [];
const MAX_CONTEXT_MESSAGES = 20;

// Cooldown tracking per exec per chat (key: "chatId:role")
const lastResponseTime = new Map<string, number>();

// Track which message IDs this bot sent (to avoid responding to self)
const ownMessageIds = new Set<number>();

// Roster of all execs — refreshed periodically by the node
let _roster: ExecRosterEntry[] = [];

export function initGroupChat(deps: {
  callAI: (prompt: string, tier?: string, hint?: string) => Promise<string>;
  comms: ExecComms;
  config: GroupChatConfig;
  execPrompt: string;
}): void {
  _callAI = deps.callAI;
  _comms = deps.comms;
  _config = deps.config;
  _execPrompt = deps.execPrompt;
}

/**
 * Update the exec roster so the AI knows how to @mention other execs.
 * Called periodically from executive-node.ts.
 */
export function updateGroupRoster(roster: ExecRosterEntry[]): void {
  _roster = roster;
}

// ============================================================
// Main handler — called for every group message
// ============================================================

/**
 * Handle a message in the executive group chat.
 * Returns null if this exec should stay silent, or a response string.
 */
export async function handleGroupMessage(
  msg: GroupMessage,
): Promise<{ response: string; replyToMessageId: number; delay: number } | null> {
  // Don't respond to own messages
  if (ownMessageIds.has(msg.messageId)) return null;

  // Check cooldown (per exec per chat)
  const cooldownKey = `${msg.chatId}:${_config.role}`;
  const lastResponse = lastResponseTime.get(cooldownKey) || 0;
  if (Date.now() - lastResponse < RESPONSE_COOLDOWN_MS) {
    // Still in cooldown — only break it for direct mentions
    if (!isDirectlyMentioned(msg.text)) return null;
  }

  // Track message for context
  recentGroupMessages.push(msg);
  if (recentGroupMessages.length > MAX_CONTEXT_MESSAGES) {
    recentGroupMessages.shift();
  }

  // Determine if we should respond
  const shouldRespond = await checkRelevance(msg);
  if (!shouldRespond) {
    console.log(`[group-chat:${_config.role}] SILENT for: "${msg.text.slice(0, 60)}..."`);
    return null;
  }

  // Calculate stagger delay based on role priority
  const priority = ROLE_PRIORITY[_config.role] || 5;
  const delay = priority * STAGGER_DELAY_MS;

  // Generate response
  console.log(`[group-chat:${_config.role}] RESPONDING to: "${msg.text.slice(0, 60)}..." (delay: ${delay}ms)`);
  const response = await generateGroupResponse(msg);
  if (!response || response.trim().length === 0) return null;

  // Update cooldown
  lastResponseTime.set(cooldownKey, Date.now() + delay);

  return {
    response,
    replyToMessageId: msg.messageId,
    delay,
  };
}

/**
 * Register a message ID as sent by this bot (for self-detection).
 */
export function registerOwnMessage(messageId: number): void {
  ownMessageIds.add(messageId);
  // Keep set bounded
  if (ownMessageIds.size > 200) {
    const oldest = ownMessageIds.values().next().value;
    if (oldest !== undefined) ownMessageIds.delete(oldest);
  }
}

// ============================================================
// Relevance check
// ============================================================

/**
 * Determine if this executive should respond to a group message.
 *
 * Always respond: direct @mention, reply to our message, broad "everyone" address
 * Maybe respond: message matches our domain keywords
 * Never respond: single-word acks, off-domain
 */
async function checkRelevance(msg: GroupMessage): Promise<boolean> {
  const text = msg.text.toLowerCase();

  // Always respond to direct mentions
  if (isDirectlyMentioned(msg.text)) return true;

  // Always respond if someone replied to our message
  if (msg.replyToFrom && msg.replyToFrom.toLowerCase().includes(_config.botUsername.toLowerCase())) {
    return true;
  }

  // Skip single-word messages only
  if (text.split(/\s+/).length < 2) return false;

  // Skip messages that are ONLY acknowledgments (entire message is just an ack)
  const skipPatterns = /^(ok|okay|thanks|thank you|got it|sure|yes|no|agreed|lol|haha|nice|great|cool|👍)$/i;
  if (skipPatterns.test(text.trim())) return false;

  // Broad address — message is directed at the whole team → all execs respond
  const broadPatterns = /\b(everyone|team|folks|anybody|anyone|all of you|y'all|people|what do you all|should we|can we|let's discuss|what are your|give me your|thoughts\??|opinions\??|ideas\??)\b/i;
  if (broadPatterns.test(text)) return true;

  // Check domain keyword match
  const keywords = DOMAIN_KEYWORDS[_config.role] || [];
  const matchCount = keywords.filter((kw) => text.includes(kw)).length;

  // Strong keyword match — respond
  if (matchCount >= 2) return true;

  // Single keyword match — use AI to decide (fast call)
  if (matchCount === 1) {
    return await aiRelevanceCheck(msg);
  }

  // No keyword match but message is substantive (5+ words) — let AI decide
  if (text.split(/\s+/).length >= 8) {
    return await aiRelevanceCheck(msg);
  }

  return false;
}

function isDirectlyMentioned(text: string): boolean {
  const username = _config.botUsername.toLowerCase();
  const textLower = text.toLowerCase();
  // Check for @username mention
  if (textLower.includes(`@${username}`)) return true;
  // Check for role mention (e.g., "CEO", "CFO")
  const roleName = _config.role.toUpperCase();
  if (textLower.includes(roleName.toLowerCase())) return true;
  // Check for exec name mention
  if (textLower.includes(_config.execName.toLowerCase())) return true;
  return false;
}

/**
 * Fast AI check: "Should I respond to this?"
 * Uses the cheapest model tier for speed.
 */
async function aiRelevanceCheck(msg: GroupMessage): Promise<boolean> {
  try {
    const prompt = [
      `You are ${_config.execName} (${_config.role.toUpperCase()}).`,
      `Your domain: ${DOMAIN_KEYWORDS[_config.role]?.slice(0, 10).join(", ")}`,
      "",
      `A message was sent in the executive group chat:`,
      `"${msg.text.slice(0, 300)}"`,
      "",
      `Should you respond to this? Consider:`,
      `- Is this in your domain or expertise?`,
      `- Would your perspective add value?`,
      `- Is someone asking for input from your area?`,
      `- Is this a general business question where your role's perspective matters?`,
      "",
      `Reply with exactly YES or NO. Nothing else.`,
    ].join("\n");

    const result = await _callAI(prompt, "fast");
    const answer = result.trim().toUpperCase();
    const should = !answer.startsWith("NO");
    console.log(`[group-chat:${_config.role}] AI relevance check: ${should ? "YES" : "NO"} for "${msg.text.slice(0, 40)}..."`);
    return should;
  } catch (err) {
    console.error(`[group-chat:${_config.role}] AI relevance check failed:`, err);
    return false;
  }
}

// ============================================================
// Response generation
// ============================================================

/**
 * Build a reference block so the AI knows who's in the group and how to tag them.
 */
function buildRosterReference(): string {
  const lines: string[] = ["EXECUTIVE ROSTER (use @username to tag):"];

  // Other execs from roster
  for (const entry of _roster) {
    if (entry.role === _config.role) continue; // skip self
    if (!entry.bot_username) continue;
    const status = entry.status === "online" ? "" : " [offline]";
    lines.push(`  - ${entry.exec_name} (${entry.role.toUpperCase()}): @${entry.bot_username}${status}`);
  }

  // The user
  if (_config.userTelegramUsername) {
    lines.push(`  - User (boss/founder): @${_config.userTelegramUsername}`);
  }

  // Self reminder
  lines.push(`  - You are: ${_config.execName} (${_config.role.toUpperCase()}) @${_config.botUsername}`);

  if (lines.length <= 2) {
    // No roster loaded yet — provide role-only hints
    lines.push("  (roster not yet loaded — use role names like CEO, CFO, CTO to address others)");
  }

  return lines.join("\n");
}

async function generateGroupResponse(msg: GroupMessage): Promise<string> {
  // Build conversation context from recent messages
  const contextLines = recentGroupMessages
    .slice(-10)
    .map((m) => `[${m.fromName}]: ${m.text.slice(0, 300)}`)
    .join("\n");

  const isDirect = isDirectlyMentioned(msg.text);
  const isReplyToUs = msg.replyToFrom?.toLowerCase().includes(_config.botUsername.toLowerCase());

  // Build roster reference so the AI knows how to @mention others
  const rosterLines = buildRosterReference();

  const prompt = [
    _execPrompt,
    "",
    "=== GROUP CHAT CONTEXT ===",
    "You are in an executive group chat with the user and other executives.",
    "Keep responses CONCISE (2-4 sentences). This is a chat, not a memo.",
    "Be conversational but substantive. Show your expertise without being verbose.",
    isDirect ? "You were directly addressed — give a focused answer." : "",
    isReplyToUs ? "Someone is replying to your previous message — continue the thread." : "",
    "",
    rosterLines,
    "",
    "TAGGING GUIDELINES:",
    "- When you need input from another executive, tag them with @username (e.g., @Nova07CFO_bot).",
    "- When you want the user's attention or decision, tag them directly.",
    "- Tag naturally — don't force it. Only tag when another exec's expertise is genuinely needed.",
    "- You can tag multiple execs in one message if the topic spans domains.",
    "- Common patterns: ask CFO about costs, CTO about feasibility, Research for data, Critic for risks.",
    "",
    "AGENT TASKS:",
    "- The 24 specialist agents (Pixel, Kai, Architect, etc.) are NOT in this chat — you cannot @mention them.",
    "- To assign work to an agent, use [DELEGATE: agent_slug | task description] — this spawns them as a subagent.",
    "- Example: [DELEGATE: pixel | Create 3 social media post variations for our new product launch]",
    "- The agent will execute the task autonomously and report results back.",
    "",
    "Do NOT use [BRIEF:] or [DECISION:] tags in group chat — those are for DM sessions.",
    "Do NOT repeat what others have said. Add YOUR unique perspective.",
    "If you have nothing meaningful to add, say nothing (respond with empty string).",
    "",
    "RECENT CONVERSATION:",
    contextLines,
    "",
    msg.replyToText
      ? `REPLYING TO: [${msg.replyToFrom}]: ${msg.replyToText.slice(0, 200)}`
      : "",
    "",
    `NEW MESSAGE from ${msg.fromName}: ${msg.text}`,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const response = await _callAI(prompt, "fast");

    // Parse and dispatch delegation tags from group chat responses
    const delegations = parseDelegationsFromResponse(response);
    if (delegations.length > 0 && _comms) {
      for (const d of delegations) {
        console.log(`[group-chat:${_config.role}] Spawning agent task: ${d.agent} — ${d.task.slice(0, 80)}`);
        await _comms.requestDelegation(d.task, "", d.agent);
      }
    }

    // Clean tags that shouldn't appear in chat (keep text around delegations)
    let clean = response
      .replace(/\[DELEGATE:[^\]]*\]/g, "")
      .replace(/\[BRIEF:[^\]]*\]/g, "")
      .replace(/\[DECISION:[^\]]*\]/g, "")
      .replace(/\[REMEMBER:[^\]]*\]/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    // If response is too long for a group chat, truncate
    if (clean.length > 1000) {
      clean = clean.slice(0, 997) + "...";
    }

    return clean;
  } catch (err) {
    console.error(`[group-chat:${_config.role}] Error generating response:`, err);
    return "";
  }
}

// ============================================================
// Supabase-based cross-exec coordination
// ============================================================

/**
 * Record a group chat response in exec_messages so other execs
 * can see what was said (even if they're polling, not in the group).
 */
export async function recordGroupResponse(
  chatId: number,
  text: string,
  replyToRole?: string,
): Promise<void> {
  try {
    await _comms.sendBrief(
      null,
      `group-chat`,
      `[${_config.role.toUpperCase()} in group]: ${text.slice(0, 500)}`,
    );
  } catch {
    // Non-critical — don't break the flow
  }
}

// ============================================================
// Delegation parsing for group chat
// ============================================================

/**
 * Parse [DELEGATE: agent | task] tags from an AI response.
 * Used to let execs spawn agent subagents directly from group chat.
 */
function parseDelegationsFromResponse(
  response: string,
): Array<{ agent: string; task: string }> {
  const delegations: Array<{ agent: string; task: string }> = [];
  const regex = /\[DELEGATE:\s*([^|\]]+?)\s*\|\s*([^|\]]+?)(?:\s*\|\s*PROVIDER:\s*[^|\]]+?)?\s*\]/g;
  for (const m of response.matchAll(regex)) {
    delegations.push({
      agent: m[1].trim(),
      task: m[2].trim(),
    });
  }
  return delegations;
}
