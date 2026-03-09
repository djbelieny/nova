/**
 * Board Meeting Coordinator
 *
 * Convenes the executive board (CEO, CFO, CMO, CTO, COO, Research, Critic),
 * monitors contributions, synthesizes options, and presents decisions to the user.
 *
 * Flow: convene -> collect contributions -> critique -> synthesize -> present options -> decide
 */

import { InlineKeyboard } from "grammy";
import type { ExecComms, BoardSession, BoardContribution } from "./exec-comms.ts";

// ============================================================
// Constants
// ============================================================

const ALL_EXEC_ROLES = ["ceo", "cfo", "cmo", "cto", "coo", "research", "critic"];
const NON_CRITIC_ROLES = ["ceo", "cfo", "cmo", "cto", "coo", "research"];
const CRITIC_ROLE = "critic";
const POLL_INTERVAL = 3000;
const PHASE1_TIMEOUT = 5 * 60 * 1000;
const PHASE2_TIMEOUT = 2 * 60 * 1000;

// ============================================================
// Types
// ============================================================

interface BoardOption {
  title: string;
  description: string;
  supporters: string[];
  risks: string;
  confidence: number;
  effort: "low" | "medium" | "high";
}

// ============================================================
// Injected Dependencies
// ============================================================

let _callAI: (prompt: string, tier?: string, hint?: string) => Promise<string>;
let _comms: ExecComms;
let _sendMessage: (chatId: string | number, text: string, keyboard?: any) => Promise<void>;

export function initBoard(deps: {
  callAI: (prompt: string, tier?: string, hint?: string) => Promise<string>;
  comms: ExecComms;
  sendMessage: (chatId: string | number, text: string, keyboard?: any) => Promise<void>;
}): void {
  _callAI = deps.callAI;
  _comms = deps.comms;
  _sendMessage = deps.sendMessage;
}

// ============================================================
// Active session tracking
// ============================================================

const activeSessions = new Map<string, { userId: string; chatId: string | number }>();

// ============================================================
// Convene Board
// ============================================================

export async function conveneBoard(
  question: string,
  userId: string,
  chatId: string | number,
  followUpOf?: string,
): Promise<string> {
  const sessionId = await _comms.conveneBoard(question, ALL_EXEC_ROLES, userId);

  if (!sessionId) {
    await _sendMessage(chatId, "Failed to convene board session. Please try again.");
    return "";
  }

  // Link follow-up if provided
  if (followUpOf) {
    await _comms.updateSession(sessionId, { follow_up_of: followUpOf } as any);
  }

  await _sendMessage(chatId, "Board convened. Executives analyzing independently...");
  await _comms.updateSession(sessionId, { status: "analyzing" });

  // Track and monitor
  activeSessions.set(sessionId, { userId, chatId });
  monitorSession(sessionId, userId, chatId).catch((err) => {
    console.error(`[Board] Monitor error for session ${sessionId}:`, err);
    _sendMessage(chatId, "Board session encountered an error during analysis.").catch(() => {});
    activeSessions.delete(sessionId);
  });

  return sessionId;
}

// ============================================================
// Session Monitor
// ============================================================

async function monitorSession(
  sessionId: string,
  userId: string,
  chatId: string | number,
): Promise<void> {
  const startTime = Date.now();

  // Phase 1: Wait for all non-critic contributions
  while (Date.now() - startTime < PHASE1_TIMEOUT) {
    const contributions = await _comms.getContributions(sessionId);
    const nonCriticContributions = contributions.filter(
      (c) => c.role !== CRITIC_ROLE && !c.is_critique,
    );
    const contributingRoles = new Set(nonCriticContributions.map((c) => c.role));

    // Check if all non-critic roles contributed
    const allNonCriticDone = NON_CRITIC_ROLES.every((r) => contributingRoles.has(r));
    if (allNonCriticDone) break;

    // Fallback: only wait for online nodes
    const statuses = await _comms.getNodeStatuses();
    const onlineRoles = new Set(
      statuses.filter((s) => s.status === "online").map((s) => s.role),
    );
    const relevantRoles = NON_CRITIC_ROLES.filter((r) => onlineRoles.has(r));
    if (relevantRoles.length > 0 && relevantRoles.every((r) => contributingRoles.has(r))) break;

    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }

  // Transition to critique phase
  await _comms.updateSession(sessionId, { status: "critiquing" });

  // Phase 2: Wait for critic
  const criticStart = Date.now();
  while (Date.now() - criticStart < PHASE2_TIMEOUT) {
    const contributions = await _comms.getContributions(sessionId);
    const critique = contributions.find((c) => c.is_critique);
    if (critique) break;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }

  // Phase 3: Synthesize
  await _comms.updateSession(sessionId, { status: "synthesizing" });
  await synthesizeAndPresent(sessionId, userId, chatId);
}

// ============================================================
// Synthesis
// ============================================================

async function synthesizeAndPresent(
  sessionId: string,
  userId: string,
  chatId: string | number,
): Promise<void> {
  const session = await _comms.getSession(sessionId);
  if (!session) {
    await _sendMessage(chatId, "Board session not found.");
    return;
  }

  // Gather contributions
  const contributions = await _comms.getContributions(sessionId);
  const nonCriticContributions = contributions.filter((c) => !c.is_critique);
  const critique = contributions.find((c) => c.is_critique);

  // Get recent decisions for context
  const recentDecisions = await _comms.getRecentDecisions(userId, 5);

  // Build synthesis prompt
  const contributionsBlock = nonCriticContributions
    .map((c) => `[${c.role.toUpperCase()}]: ${c.contribution}`)
    .join("\n\n");

  const decisionsBlock = recentDecisions.length > 0
    ? recentDecisions
        .map((d) => `- Q: ${d.question} -> ${d.chosen_option} (${d.outcome ?? "pending"})`)
        .join("\n")
    : "None";

  const prompt = `You are Nova, synthesizing a board meeting.

QUESTION: ${session.question}

EXECUTIVE CONTRIBUTIONS:
${contributionsBlock}

CRITIC'S ANALYSIS:
${critique?.contribution ?? "No critique submitted (timed out)."}

PAST DECISIONS (for context):
${decisionsBlock}

Synthesize into 3-5 distinct options. For each option:
1. Title (1 line)
2. Description (2-3 sentences)
3. Supporting executives (who advocated this direction)
4. Key risks (from critic's analysis)
5. Confidence score (0-1, based on executive agreement + critic's assessment)
6. Estimated effort (low/medium/high)

Format as JSON array: [{ "title": "...", "description": "...", "supporters": ["ceo", "cmo"], "risks": "...", "confidence": 0.85, "effort": "medium" }]

Return ONLY the JSON array, no other text.`;

  const raw = await _callAI(prompt, "premium", "board-synthesis");
  const options = parseOptions(raw);

  if (options.length === 0) {
    await _sendMessage(chatId, "Board meeting completed but synthesis failed. Raw analysis available in session log.");
    await _comms.updateSession(sessionId, { status: "failed" });
    activeSessions.delete(sessionId);
    return;
  }

  // Store options in session
  await _comms.updateSession(sessionId, { options, status: "presented" });

  // Format and present to user
  const message = formatBoardResults(session.question, options);
  const keyboard = buildOptionKeyboard(sessionId, options);
  await _sendMessage(chatId, message, keyboard);

  activeSessions.delete(sessionId);
}

// ============================================================
// Option Parsing
// ============================================================

function parseOptions(raw: string): BoardOption[] {
  try {
    // Extract JSON array from response (handle markdown code blocks)
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((o: any) => o.title && o.description)
      .map((o: any) => ({
        title: String(o.title),
        description: String(o.description),
        supporters: Array.isArray(o.supporters) ? o.supporters.map(String) : [],
        risks: String(o.risks ?? "Unknown"),
        confidence: typeof o.confidence === "number" ? o.confidence : 0.5,
        effort: ["low", "medium", "high"].includes(o.effort) ? o.effort : "medium",
      }));
  } catch {
    console.error("[Board] Failed to parse synthesis options");
    return [];
  }
}

// ============================================================
// Presentation Formatting
// ============================================================

function formatBoardResults(question: string, options: BoardOption[]): string {
  const lines: string[] = [
    "Board Meeting Results\n",
    `Question: ${question}\n`,
  ];

  options.forEach((opt, i) => {
    const confidencePct = Math.round(opt.confidence * 100);
    const supporters = opt.supporters.map((s) => s.toUpperCase()).join(", ");
    lines.push(
      `Option ${i + 1}: ${opt.title} (Confidence: ${confidencePct}%)`,
      opt.description,
      `Supported by: ${supporters || "General consensus"}`,
      `Risks: ${opt.risks}`,
      `Effort: ${opt.effort}`,
      "",
    );
  });

  return lines.join("\n");
}

function buildOptionKeyboard(sessionId: string, options: BoardOption[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  options.forEach((_, i) => {
    keyboard.text(`Option ${i + 1}`, `board_option:${sessionId}:${i}`);
  });
  keyboard.text("Dismiss", `board_dismiss:${sessionId}`);

  return keyboard;
}

// ============================================================
// Handle Board Decision
// ============================================================

export async function handleBoardDecision(
  sessionId: string,
  chosenOption: string,
  userId: string,
): Promise<void> {
  const session = await _comms.getSession(sessionId);
  if (!session) {
    console.error(`[Board] Session ${sessionId} not found for decision`);
    return;
  }

  const chatId = activeSessions.get(sessionId)?.chatId;
  const options = session.options as BoardOption[];
  const optionIndex = parseInt(chosenOption, 10);
  const chosen = options[optionIndex];

  if (!chosen) {
    console.error(`[Board] Invalid option index ${optionIndex} for session ${sessionId}`);
    return;
  }

  // Update session with decision
  await _comms.updateSession(sessionId, {
    chosen_option: chosen.title,
    decision_rationale: chosen.description,
    status: "decided",
  });

  // Generate consensus summary
  const consensusPrompt = `Summarize this board decision in 2-3 sentences for executive briefing:
Question: ${session.question}
Chosen: ${chosen.title} - ${chosen.description}
Confidence: ${Math.round(chosen.confidence * 100)}%
Supporters: ${chosen.supporters.join(", ")}`;

  const consensus = await _callAI(consensusPrompt, "fast", "board-consensus");

  // Store consensus
  await _comms.updateSession(sessionId, { consensus });

  // Record in decisions table
  await _comms.recordDecision({
    user_id: userId,
    question: session.question,
    chosen_option: chosen.title,
    rationale: chosen.description,
    confidence: chosen.confidence,
    board_session_id: sessionId,
    contributing_roles: chosen.supporters,
  });

  // Brief all executives
  await _comms.sendBrief(
    null,
    "Board Decision",
    `Decision made on: "${session.question}"\n\nChosen: ${chosen.title}\n\n${consensus}`,
  );

  // Check for stalling
  const isStalling = await _comms.checkStalling(userId);

  // Send confirmation to user
  const targetChatId = chatId ?? userId;
  let confirmationMsg = `Decision recorded: ${chosen.title}\n\n${consensus}`;
  if (isStalling) {
    confirmationMsg +=
      "\n\nNote: Recent board sessions appear to cover similar ground. Consider moving to execution or reframing the question.";
  }

  await _sendMessage(targetChatId, confirmationMsg);
}

// ============================================================
// Board Poller
// ============================================================

const pollerSessions = new Set<string>();
let pollerRunning = false;

export function startBoardPoller(): void {
  if (pollerRunning) return;
  pollerRunning = true;

  const POLLER_INTERVAL = 10_000;

  const tick = async () => {
    if (!pollerRunning) return;

    try {
      // Check for sessions that might have been created externally
      // (e.g., from another node or the dashboard)
      const pending = await _comms.getPendingSessions();

      for (const session of pending) {
        if (pollerSessions.has(session.id)) continue;
        if (activeSessions.has(session.id)) continue;

        pollerSessions.add(session.id);
        console.log(`[Board] Poller picked up session ${session.id}: "${session.question}"`);

        // These sessions were convened but not monitored by this node.
        // If status is still 'convened' or 'analyzing', start monitoring.
        if (session.status === "convened" || session.status === "analyzing") {
          const chatId = session.metadata?.chatId ?? session.user_id;
          activeSessions.set(session.id, { userId: session.user_id, chatId });

          monitorSession(session.id, session.user_id, chatId).catch((err) => {
            console.error(`[Board] Poller monitor error for ${session.id}:`, err);
            activeSessions.delete(session.id);
          });
        }
      }
    } catch (err) {
      console.error("[Board] Poller tick error:", err);
    }

    setTimeout(tick, POLLER_INTERVAL);
  };

  setTimeout(tick, POLLER_INTERVAL);
  console.log("[Board] Poller started");
}
