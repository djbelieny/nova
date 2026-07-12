/**
 * Executive Message Handler
 *
 * Handles messages to an executive node:
 * - Direct DMs: Load exec prompt + context, call AI, parse intent tags
 * - Board contributions: Generate independent analysis for board meetings
 *
 * Intent tags parsed from AI responses:
 *   [DELEGATE: agent | task]                          — delegate work to an agent
 *   [DELEGATE: agent | task | PROVIDER: provider]     — with provider override
 *   [BRIEF: role | content]                           — brief another exec (or "all")
 *   [DECISION: question | chosen | rationale]         — record a decision
 *   [DECISION: question | chosen | rationale | CONFIDENCE: n] — with confidence
 *   [REMEMBER: ...] and other memory tags             — passed through unchanged
 */

import type { ExecComms } from "./exec-comms.ts";

// ============================================================
// Types
// ============================================================

interface ExecDef {
  name: string;
  description: string;
  prompt: string;
  role: string;
}

interface ParsedIntents {
  clean: string;
  delegations: Array<{ agent: string; task: string; provider?: string }>;
  briefs: Array<{ toRole: string | null; content: string }>;
  decisions: Array<{
    question: string;
    chosen: string;
    rationale: string;
    confidence: number;
  }>;
}

// ============================================================
// Injected dependencies
// ============================================================

let _callAI: (prompt: string, tier?: string, hint?: string) => Promise<string>;
let _comms: ExecComms;
let _execDef: ExecDef;
let _sendMessage: (chatId: string | number, text: string) => Promise<void>;

/**
 * Initialize the executive handler with runtime dependencies.
 * Must be called before handleExecMessage or generateBoardContribution.
 */
export function initExecHandler(deps: {
  callAI: (prompt: string, tier?: string, hint?: string) => Promise<string>;
  comms: ExecComms;
  execDef: ExecDef;
  sendMessage: (chatId: string | number, text: string) => Promise<void>;
}): void {
  _callAI = deps.callAI;
  _comms = deps.comms;
  _execDef = deps.execDef;
  _sendMessage = deps.sendMessage;
}

// ============================================================
// Direct DM handler
// ============================================================

/**
 * Handle a direct message to this executive node.
 *
 * 1. Load exec prompt + recent decisions for context
 * 2. Poll briefs from other executives
 * 3. Build full prompt and call AI
 * 4. Parse intent tags, dispatch side-effects, return cleaned response
 */
export async function handleExecMessage(
  text: string,
  user: { id: string; name?: string },
  chatId: string | number,
): Promise<string> {
  // Gather context in parallel
  const [recentDecisions, incomingBriefs] = await Promise.all([
    _comms.getRecentDecisions(user.id, 10),
    _comms.pollMessages(new Date(Date.now() - 24 * 60 * 60 * 1000)),
  ]);

  // Mark incoming briefs as read
  for (const msg of incomingBriefs) {
    await _comms.markRead(msg.id);
  }

  // Format context strings
  const decisionContext = recentDecisions.length
    ? recentDecisions
        .map(
          (d) =>
            `• ${d.question} → ${d.chosen_option} (confidence: ${d.confidence ?? "N/A"})`,
        )
        .join("\n")
    : "";

  const briefContext = incomingBriefs.length
    ? incomingBriefs
        .map((m) => `[${m.from_role}] ${m.subject ?? ""}: ${m.content}`)
        .join("\n")
    : "";

  // Build prompt and call AI
  const prompt = buildExecPrompt(_execDef, text, decisionContext, briefContext);
  const raw = await _callAI(prompt, "sonnet", _execDef.role);

  // Parse and dispatch intent tags
  const parsed = parseExecIntents(raw);
  await dispatchIntents(parsed, user.id);

  return parsed.clean;
}

// ============================================================
// Board contribution generator
// ============================================================

/**
 * Generate an independent board contribution for a meeting session.
 *
 * Standard roles: analyze the question from their unique perspective.
 * Critic role: waits for other contributions, then generates a structured
 * pre-mortem analysis. The critic never produces [DELEGATE:] tags.
 */
export async function generateBoardContribution(
  sessionId: string,
  question: string,
  role: string,
): Promise<void> {
  const isCritic = role === "critic";

  if (isCritic) {
    await generateCriticContribution(sessionId, question);
  } else {
    await generateStandardContribution(sessionId, question);
  }
}

/**
 * Standard (non-critic) board contribution.
 * Takes a clear position on the question from the exec's perspective.
 */
async function generateStandardContribution(
  sessionId: string,
  question: string,
): Promise<void> {
  const recentDecisions = await _comms.getRecentDecisions("", 5);

  const decisionContext = recentDecisions.length
    ? recentDecisions
        .map((d) => `• ${d.question} → ${d.chosen_option}`)
        .join("\n")
    : "";

  const prompt = [
    _execDef.prompt,
    "",
    `You are ${_execDef.role}. Analyze this question from YOUR perspective independently.`,
    `Do not hedge — take a clear position.`,
    "",
    decisionContext ? `RECENT DECISIONS FOR CONTEXT:\n${decisionContext}\n` : "",
    `Question: ${question}`,
  ]
    .filter(Boolean)
    .join("\n");

  const contribution = await _callAI(prompt, "sonnet", _execDef.role);
  await _comms.submitContribution(sessionId, contribution, false);
}

/**
 * Critic board contribution.
 * Waits for all other contributions, then generates a structured pre-mortem
 * that challenges assumptions and identifies risks.
 */
async function generateCriticContribution(
  sessionId: string,
  question: string,
): Promise<void> {
  // Wait for other contributions to arrive (poll with backoff)
  const session = await _comms.getSession(sessionId);
  const expectedCount = (session?.board_members?.length ?? 1) - 1; // minus the critic
  let contributions = await _comms.getContributions(sessionId);
  let nonCriticContributions = contributions.filter((c) => c.role !== "critic");

  // Poll up to 60s for other contributions to arrive
  const deadline = Date.now() + 60_000;
  while (nonCriticContributions.length < expectedCount && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    contributions = await _comms.getContributions(sessionId);
    nonCriticContributions = contributions.filter((c) => c.role !== "critic");
  }

  const othersText = nonCriticContributions
    .map((c) => `=== ${c.role.toUpperCase()} ===\n${c.contribution}`)
    .join("\n\n");

  const prompt = [
    _execDef.prompt,
    "",
    `You are the Critic. Your job is structured pre-mortem analysis.`,
    `Review the other executives' contributions and identify:`,
    `1. Unstated assumptions each position relies on`,
    `2. Risks and failure modes not yet discussed`,
    `3. Contradictions between positions`,
    `4. What would need to be true for the worst outcome to occur`,
    ``,
    `Do NOT produce any [DELEGATE:] tags — you analyze only.`,
    ``,
    `QUESTION: ${question}`,
    ``,
    `OTHER CONTRIBUTIONS:`,
    othersText,
  ].join("\n");

  const critique = await _callAI(prompt, "sonnet", "critic");
  await _comms.submitContribution(sessionId, critique, true);
}

// ============================================================
// Intent tag parsing
// ============================================================

/** Tag patterns — order matters (more specific patterns first) */
const TAG_DELEGATE =
  /\[DELEGATE:\s*([^|\]]+?)\s*\|\s*([^|\]]+?)(?:\s*\|\s*PROVIDER:\s*([^|\]]+?))?\s*\]/g;
const TAG_BRIEF =
  /\[BRIEF:\s*([^|\]]+?)\s*\|\s*([^\]]+?)\s*\]/g;
const TAG_DECISION =
  /\[DECISION:\s*([^|\]]+?)\s*\|\s*([^|\]]+?)\s*\|\s*([^|\]]+?)(?:\s*\|\s*CONFIDENCE:\s*([\d.]+))?\s*\]/g;

/**
 * Parse executive intent tags from an AI response.
 * Returns structured data plus the cleaned (tag-free) response text.
 */
function parseExecIntents(response: string): ParsedIntents {
  const delegations: ParsedIntents["delegations"] = [];
  const briefs: ParsedIntents["briefs"] = [];
  const decisions: ParsedIntents["decisions"] = [];

  let clean = response;

  // Extract delegations
  for (const m of response.matchAll(TAG_DELEGATE)) {
    delegations.push({
      agent: m[1].trim(),
      task: m[2].trim(),
      ...(m[3] ? { provider: m[3].trim() } : {}),
    });
  }

  // Extract briefs
  for (const m of response.matchAll(TAG_BRIEF)) {
    const toRole = m[1].trim().toLowerCase();
    briefs.push({
      toRole: toRole === "all" ? null : toRole,
      content: m[2].trim(),
    });
  }

  // Extract decisions
  for (const m of response.matchAll(TAG_DECISION)) {
    decisions.push({
      question: m[1].trim(),
      chosen: m[2].trim(),
      rationale: m[3].trim(),
      confidence: m[4] ? parseFloat(m[4]) : 0.7,
    });
  }

  // Remove all exec-specific tags from the response
  clean = clean
    .replace(TAG_DELEGATE, "")
    .replace(TAG_BRIEF, "")
    .replace(TAG_DECISION, "");

  // Collapse leftover blank lines
  clean = clean.replace(/\n{3,}/g, "\n\n").trim();

  return { clean, delegations, briefs, decisions };
}

// ============================================================
// Intent dispatch
// ============================================================

/**
 * Execute side-effects for all parsed intent tags.
 */
async function dispatchIntents(
  parsed: ParsedIntents,
  userId: string,
): Promise<void> {
  // Dispatch delegations
  for (const d of parsed.delegations) {
    const metadata = d.provider ? { provider: d.provider } : {};
    await _comms.requestDelegation(d.task, userId, d.agent);
    if (d.provider) {
      // Store provider hint in the delegation metadata via a brief
      // so the executing node knows which provider to use
      await _comms.sendBrief(
        null,
        `delegation-provider-hint`,
        `Agent ${d.agent} task should use provider: ${d.provider}`,
      );
    }
  }

  // Dispatch briefs
  for (const b of parsed.briefs) {
    await _comms.sendBrief(b.toRole, `Brief from ${_execDef.role}`, b.content);
  }

  // Record decisions
  for (const d of parsed.decisions) {
    await _comms.recordDecision({
      user_id: userId,
      question: d.question,
      chosen_option: d.chosen,
      rationale: d.rationale,
      confidence: d.confidence,
      contributing_roles: [_execDef.role],
    });
  }
}

// ============================================================
// Prompt builder
// ============================================================

/**
 * Build the full prompt for an executive AI call.
 * Includes: persona prompt, current time, decision history,
 * briefs from other execs, available intent tags, and the user message.
 */
function buildExecPrompt(
  execDef: ExecDef,
  userMessage: string,
  decisionContext: string,
  briefContext: string,
): string {
  const now = new Date().toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return [
    execDef.prompt,
    "",
    `Current time: ${now}`,
    "",
    decisionContext ? `PAST DECISIONS:\n${decisionContext}` : "",
    briefContext
      ? `RECENT BRIEFS FROM OTHER EXECUTIVES:\n${briefContext}`
      : "",
    "",
    `AVAILABLE INTENT TAGS:`,
    `- [DELEGATE: agent_slug | task description] — spawn an agent subagent to execute a task autonomously`,
    `- [DELEGATE: agent_slug | task description | PROVIDER: provider] — spawn agent with provider override`,
    `- [BRIEF: role_or_all | summary] — brief another executive or all executives`,
    `- [DECISION: question | chosen_option | rationale | CONFIDENCE: 0.0-1.0] — record a decision`,
    ``,
    `IMPORTANT: The 24 specialist agents (Pixel, Kai, Architect, etc.) are subagents — they don't have`,
    `their own Telegram presence. You cannot @mention or message them. Use [DELEGATE:] to spawn them`,
    `and they will execute tasks autonomously and report results back.`,
    "",
    `User message: ${userMessage}`,
  ]
    .filter(Boolean)
    .join("\n");
}
