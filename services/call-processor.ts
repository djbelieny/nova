/**
 * Call Transcript Processor
 *
 * Receives a call transcript and runs a 5-step autonomous pipeline:
 *   1. AI extraction — summary, facts, goals, decisions, tasks (haiku)
 *   2. Memory storage — facts/goals via processMemoryIntents intent tags
 *   3. Notion page — full summary page via callAI with user MCP config
 *   4. Task execution — Nova-assigned tasks run via callAI; user tasks listed only
 *   5. Telegram notification — summary + task assignments sent to user
 *
 * Injected dependencies keep this module DB-only until init.
 */

import { getDb, type Database } from "../src/db.ts";
import { emit } from "../src/events.ts";
import { processMemoryIntents } from "../src/memory.ts";
import { NOVA_NAME } from "../src/identity.ts";

// ============================================================
// Types
// ============================================================

export interface CallMeta {
  title?: string;
  participants?: string[];
  duration_minutes?: number;
}

interface ExtractedCall {
  summary: string;
  facts: string[];
  goals: string[];
  decisions: string[];
  tasks: Array<{ description: string; assignee: string }>;
}

// ============================================================
// Module-level injected deps
// ============================================================

type CallAIFn = (prompt: string, tier: string, userId?: string, hint?: string) => Promise<string>;
type SendAlertFn = (userId: string, message: string) => Promise<void>;

let _callAI: CallAIFn | null = null;
let _sendAlert: SendAlertFn | null = null;

let _db: Database | null = null;
function db(): Database {
  if (!_db) _db = getDb();
  return _db;
}

export function initCallProcessor(deps: {
  callAI: CallAIFn;
  sendAlert: SendAlertFn;
}): void {
  _callAI = deps.callAI;
  _sendAlert = deps.sendAlert;
}

// ============================================================
// AI extraction
// ============================================================

const TRANSCRIPT_MAX_CHARS = 8000;

function buildExtractionPrompt(transcript: string, meta: CallMeta): string {
  const truncated = transcript.length > TRANSCRIPT_MAX_CHARS
    ? transcript.slice(0, TRANSCRIPT_MAX_CHARS) + `\n[truncated at ${TRANSCRIPT_MAX_CHARS} chars]`
    : transcript;

  const context = [
    meta.title && `Title: ${meta.title}`,
    meta.participants?.length && `Participants: ${meta.participants.join(", ")}`,
    meta.duration_minutes && `Duration: ${meta.duration_minutes} minutes`,
  ].filter(Boolean).join(" | ");

  return `Extract structured data from this call transcript. Respond with ONLY valid JSON, no markdown fences.

Schema: {"summary":"3-5 sentence overview","facts":["string"],"goals":["string"],"decisions":["string"],"tasks":[{"description":"string","assignee":"user|nova|unassigned|<person_name>"}]}

Rules:
- facts = persistent knowledge: names, companies, contact info, product details, pricing, agreements
- goals = objectives with deadlines or milestones mentioned
- decisions = concluded choices made during the call
- tasks = specific action items; assignee="user" if for the primary caller, "nova" if AI can handle it, else the person's name or "unassigned"
- summary must be complete (who, what, key outcomes)
${context ? `\nCall context: ${context}` : ""}

Transcript:
${truncated}`;
}

async function extractCallData(transcript: string, meta: CallMeta): Promise<ExtractedCall> {
  const prompt = buildExtractionPrompt(transcript, meta);
  let raw = "";
  try {
    raw = await _callAI!(prompt, "fast");
    // Strip markdown fences if AI added them despite instructions
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    const parsed = JSON.parse(cleaned);
    return {
      summary: String(parsed.summary || "").trim(),
      facts: Array.isArray(parsed.facts) ? parsed.facts.map(String) : [],
      goals: Array.isArray(parsed.goals) ? parsed.goals.map(String) : [],
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions.map(String) : [],
      tasks: Array.isArray(parsed.tasks)
        ? parsed.tasks.map((t: any) => ({ description: String(t.description || ""), assignee: String(t.assignee || "unassigned") }))
        : [],
    };
  } catch (err) {
    console.error("[call-processor] Extraction parse failed:", (err as Error).message, "| raw:", raw.slice(0, 200));
    return {
      summary: transcript.slice(0, 500),
      facts: [],
      goals: [],
      decisions: [],
      tasks: [],
    };
  }
}

// ============================================================
// Memory storage
// ============================================================

async function storeCallMemory(userId: string, extracted: ExtractedCall, timezone: string): Promise<void> {
  const lines: string[] = [];

  for (const fact of extracted.facts) {
    lines.push(`[REMEMBER: ${fact}]`);
  }
  for (const decision of extracted.decisions) {
    lines.push(`[REMEMBER: Decision: ${decision}]`);
  }
  for (const goal of extracted.goals) {
    lines.push(`[GOAL: ${goal}]`);
  }

  if (!lines.length) return;

  const tagString = lines.join("\n");
  try {
    await processMemoryIntents(db(), tagString, userId, timezone);
    emit({ type: "system.health", level: "info", userId, data: { message: `Stored ${lines.length} memory items from call`, module: "call-processor" } });
  } catch (err) {
    console.error("[call-processor] Memory storage failed:", (err as Error).message);
  }
}

// ============================================================
// Notion page creation
// ============================================================

function buildNotionPrompt(extracted: ExtractedCall, meta: CallMeta): string {
  const date = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const title = `${meta.title || "Call"} — Summary ${date}`;

  const sections: string[] = [
    `## Summary\n${extracted.summary}`,
  ];

  if (extracted.decisions.length) {
    sections.push(`## Key Decisions\n${extracted.decisions.map(d => `- ${d}`).join("\n")}`);
  }

  if (extracted.tasks.length) {
    const taskLines = extracted.tasks.map(t => {
      const who = t.assignee === "user" ? "You" : t.assignee === "nova" || t.assignee === "unassigned" ? NOVA_NAME : t.assignee;
      return `- [${who}] ${t.description}`;
    });
    sections.push(`## Action Items\n${taskLines.join("\n")}`);
  }

  if (extracted.goals.length) {
    sections.push(`## Goals Identified\n${extracted.goals.map(g => `- ${g}`).join("\n")}`);
  }

  if (extracted.facts.length) {
    sections.push(`## Key Facts\n${extracted.facts.map(f => `- ${f}`).join("\n")}`);
  }

  const content = sections.join("\n\n");

  return `Create a Notion page with the following details using the Notion API tools available to you.

Page title: "${title}"
${meta.participants?.length ? `Participants: ${meta.participants.join(", ")}` : ""}
${meta.duration_minutes ? `Duration: ${meta.duration_minutes} minutes` : ""}

Page content (use appropriate Notion blocks — headings for ##, bullets for lists):

${content}

After creating the page, respond with: "Notion page created: [page title]"`;
}

async function createNotionPage(userId: string, extracted: ExtractedCall, meta: CallMeta): Promise<boolean> {
  try {
    const prompt = buildNotionPrompt(extracted, meta);
    const result = await _callAI!(prompt, "standard", userId, "notion");
    const success = result.toLowerCase().includes("created") || result.toLowerCase().includes("notion");
    emit({ type: "system.health", level: "info", userId, data: { message: `Notion page ${success ? "created" : "attempted"}`, module: "call-processor" } });
    return success;
  } catch (err) {
    console.error("[call-processor] Notion creation failed:", (err as Error).message);
    return false;
  }
}

// ============================================================
// Task execution (Nova-assigned tasks)
// ============================================================

function buildTaskPrompt(task: string): string {
  return `Execute this task autonomously. Use any tools available to complete it.

Task: ${task}

Complete the task and report what you did.`;
}

async function executeNovaTasks(
  userId: string,
  tasks: Array<{ description: string; assignee: string }>
): Promise<string[]> {
  const novaTasks = tasks.filter(
    t => t.assignee === "nova" || t.assignee === "unassigned"
  );

  const results: string[] = [];

  for (const task of novaTasks) {
    try {
      emit({ type: "agent.dispatched", level: "info", userId, data: { message: `Executing call task: ${task.description.slice(0, 60)}`, module: "call-processor" } });
      const prompt = buildTaskPrompt(task.description);
      const result = await _callAI!(prompt, "standard", userId);
      results.push(`✓ ${task.description}`);
      emit({ type: "agent.completed", level: "info", userId, data: { message: `Call task completed: ${task.description.slice(0, 60)}`, result: result.slice(0, 200), module: "call-processor" } });
    } catch (err) {
      results.push(`⚠ ${task.description} (failed)`);
      console.error("[call-processor] Task execution failed:", (err as Error).message);
    }
  }

  return results;
}

// ============================================================
// Telegram notification
// ============================================================

function buildTelegramMessage(
  extracted: ExtractedCall,
  meta: CallMeta,
  notionCreated: boolean,
  executedTasks: string[],
  userTasks: string[]
): string {
  const lines: string[] = [];

  const title = meta.title || "Call";
  const parts = [
    meta.duration_minutes && `${meta.duration_minutes}m`,
    meta.participants?.length && meta.participants.join(", "),
  ].filter(Boolean);

  lines.push(`📞 *${title}*${parts.length ? ` — ${parts.join(" | ")}` : ""}`);
  lines.push("");
  lines.push(extracted.summary);

  if (userTasks.length) {
    lines.push("");
    lines.push("*Your action items:*");
    for (const t of userTasks) {
      lines.push(`• ${t}`);
    }
  }

  if (executedTasks.length) {
    lines.push("");
    lines.push("*Nova completed:*");
    for (const t of executedTasks) {
      lines.push(`• ${t}`);
    }
  }

  if (notionCreated) {
    lines.push("");
    lines.push("📄 Notion summary page created.");
  }

  return lines.join("\n");
}

// ============================================================
// Main entry point
// ============================================================

export async function processCallTranscript(
  userId: string,
  transcript: string,
  meta: CallMeta = {}
): Promise<void> {
  if (!_callAI || !_sendAlert) {
    console.error("[call-processor] Not initialized — call initCallProcessor first");
    return;
  }

  if (!transcript?.trim()) {
    console.warn("[call-processor] Empty transcript — skipped");
    return;
  }

  emit({ type: "system.health", level: "info", userId, data: { message: `Processing call transcript: "${meta.title || "untitled"}"`, module: "call-processor" } });

  // Get user timezone
  let timezone = "UTC";
  try {
    const user = db().getUserById(userId);
    if (user?.timezone) timezone = user.timezone;
  } catch {}

  // Step 1: Extract
  const extracted = await extractCallData(transcript, meta);

  // Step 2: Store memory (fire-and-forget — don't block on this)
  storeCallMemory(userId, extracted, timezone).catch(() => {});

  // Identify user vs Nova tasks in parallel with memory storage
  const userTasks = extracted.tasks
    .filter(t => t.assignee === "user")
    .map(t => t.description);

  const humanNameTasks = extracted.tasks
    .filter(t => t.assignee !== "user" && t.assignee !== "nova" && t.assignee !== "unassigned")
    .map(t => `${t.assignee}: ${t.description}`);

  // Step 3: Create Notion page
  const notionCreated = await createNotionPage(userId, extracted, meta);

  // Step 4: Execute Nova/unassigned tasks
  const executedResults = await executeNovaTasks(userId, extracted.tasks);

  // Combine user tasks + named-human tasks for the notification
  const allUserFacingTasks = [...userTasks, ...humanNameTasks];

  // Step 5: Send Telegram notification
  const message = buildTelegramMessage(extracted, meta, notionCreated, executedResults, allUserFacingTasks);
  await _sendAlert(userId, message);

  emit({ type: "system.health", level: "info", userId, data: { message: `Call processing complete: ${extracted.tasks.length} tasks, ${extracted.facts.length} facts, notion=${notionCreated}`, module: "call-processor" } });
}
