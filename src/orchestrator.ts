/**
 * Task Orchestrator
 *
 * Classifies incoming messages and routes them:
 * - Simple messages → existing callClaude() path (no extra latency)
 * - Complex messages → planner decomposition → parallel execution → aggregation
 * - Cached patterns → reuse known-good plans (skip classification)
 *
 * Human-in-the-Loop:
 * - Complex tasks split into "prepare" (safe) and "execute" (consequential) phases
 * - After prepare completes, user sees a summary + deliverables + approval buttons
 * - Execute phase only runs after explicit approval
 * - Auto-approve detection skips the gate when user says "just do it"
 *
 * Model strategy:
 * - Haiku for classification and decomposition (cheap overhead calls)
 * - Sonnet for actual task execution (quality matters)
 * - Haiku for aggregation of results (formatting, not reasoning)
 */

import { type Context, InlineKeyboard } from "grammy";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExecutionPlan } from "./patterns.ts";
import { findPattern, recordExecution } from "./patterns.ts";
import {
  initPlanner,
  decompose,
  executePhase,
  executeSubtasks,
  collectArtifacts,
  aggregate,
} from "./planner.ts";
import type { SubtaskResult, Artifact, ProgressCallback } from "./planner.ts";
import {
  processMemoryIntents,
  getMemoryContext,
  getRelevantContext,
  getRecentHistory,
  getTaskContext,
  getScheduleContext,
} from "./memory.ts";

type ModelTier = "haiku" | "sonnet" | "opus";

// Injected dependencies from relay.ts
let _callClaude: (prompt: string, model?: ModelTier, userId?: string) => Promise<string>;
let _buildPrompt: (...args: any[]) => string;
let _runTask: (
  ctx: Context,
  desc: string,
  buildTask: () => Promise<{ prompt: string; model?: ModelTier }>,
  opts?: { postProcess?: (r: string) => Promise<string>; userId?: string },
) => void;
let _saveMessage: (role: string, content: string, userId: string) => Promise<void>;
let _sendResponseWithVoice: (ctx: Context, response: string, userId?: string) => Promise<void>;

export function initOrchestrator(deps: {
  callClaude: (prompt: string, model?: ModelTier, userId?: string) => Promise<string>;
  buildPrompt: (...args: any[]) => string;
  runTask: typeof _runTask;
  saveMessage: (role: string, content: string, userId: string) => Promise<void>;
  sendResponseWithVoice: (ctx: Context, response: string, userId?: string) => Promise<void>;
}): void {
  _callClaude = deps.callClaude;
  _buildPrompt = deps.buildPrompt;
  _runTask = deps.runTask;
  _saveMessage = deps.saveMessage;
  _sendResponseWithVoice = deps.sendResponseWithVoice;

  // Initialize planner with shared dependencies
  initPlanner(deps.callClaude, deps.buildPrompt);
}

// ============================================================
// PENDING APPROVALS — stored in memory for callback handler
// ============================================================

export interface PendingApproval {
  id: string;
  ctx: Context;
  user: any;
  supabase: SupabaseClient | null;
  originalText: string;
  plan: ExecutionPlan;
  prepareResults: SubtaskResult[];
  artifacts: Artifact[];
  parentTaskId?: string;
  startTime: number;
}

const pendingApprovals = new Map<string, PendingApproval>();

/**
 * Handle an approval callback from the Telegram inline button.
 * Called by relay.ts when user taps Approve/Revise/Cancel.
 */
export async function handleApproval(
  approvalId: string,
  action: "approve" | "revise" | "cancel",
  ctx: Context,
  feedback?: string
): Promise<void> {
  const pending = pendingApprovals.get(approvalId);
  if (!pending) {
    await ctx.answerCallbackQuery({ text: "This approval has expired." });
    return;
  }

  await ctx.answerCallbackQuery({ text: action === "approve" ? "Executing..." : action === "revise" ? "Send your revision" : "Cancelled" });

  // Remove buttons from the approval message
  try {
    const originalText = ctx.callbackQuery?.message?.text || "";
    const statusLine = action === "approve" ? "\n\n>> Approved" : action === "cancel" ? "\n\n>> Cancelled" : "\n\n>> Revision requested";
    await ctx.editMessageText(`${originalText}${statusLine}`, { reply_markup: undefined });
  } catch {}

  // Update Supabase status
  if (pending.supabase) {
    const statusMap = { approve: "approved", cancel: "cancelled", revise: "revised" } as const;
    await pending.supabase.from("pending_approvals")
      .update({
        status: statusMap[action],
        feedback: feedback || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", approvalId);
  }

  if (action === "cancel") {
    pendingApprovals.delete(approvalId);
    await _saveMessage("assistant", "Task cancelled.", pending.user.id);
    await _sendResponseWithVoice(ctx, "Got it — cancelled.", pending.user.id);
    return;
  }

  if (action === "revise") {
    pendingApprovals.delete(approvalId);
    await _sendResponseWithVoice(ctx, "Send me your revision and I'll redo the prepare phase.", pending.user.id);
    return;
  }

  // action === "approve" — run execute phase
  pendingApprovals.delete(approvalId);

  try {
    await ctx.replyWithChatAction("typing");

    const executeResults = await executePhase(
      pending.plan,
      "execute",
      pending.user,
      pending.supabase,
      pending.parentTaskId,
      pending.artifacts,
      pending.prepareResults
    );

    const allResults = [...pending.prepareResults, ...executeResults];
    const allSucceeded = allResults.every((r) => r.success);

    // Aggregate
    const aggregated = await aggregate(pending.originalText, allResults);
    const processed = await processMemoryIntents(pending.supabase, aggregated, pending.user.id, pending.user.timezone);
    await _saveMessage("assistant", processed, pending.user.id);
    await _sendResponseWithVoice(ctx, processed, pending.user.id);

    // Mark parent task done
    if (pending.supabase && pending.parentTaskId) {
      await pending.supabase
        .from("agent_tasks")
        .update({
          status: allSucceeded ? "completed" : "blocked",
          result: `${allResults.length} subtasks, ${allResults.filter((r) => r.success).length} succeeded`,
          updated_at: new Date().toISOString(),
        })
        .eq("id", pending.parentTaskId);
    }

    // Record pattern
    const durationMs = Date.now() - pending.startTime;
    await recordExecution(pending.supabase, pending.originalText, pending.plan, allSucceeded, durationMs, pending.user.id);
  } catch (error) {
    console.error("[orchestrator] Execute phase error:", error);
    await _sendResponseWithVoice(ctx, "Something went wrong during the execute phase. The prepare work is still saved — try again.", pending.user.id);
  }
}

/**
 * Get pending approval count (for /status command).
 */
export function getPendingApprovalCount(): number {
  return pendingApprovals.size;
}

// ============================================================
// AUTO-APPROVE DETECTION
// ============================================================

const AUTO_APPROVE_PHRASES = [
  "just do it", "do everything", "approved in advance", "go ahead",
  "no need to confirm", "skip approval", "execute directly",
  "don't ask", "full auto", "run it all", "do it all",
  // Portuguese
  "deixe tudo pronto", "pode fazer tudo", "aprovado",
  "pode executar", "faz tudo", "manda ver",
];

function detectAutoApprove(text: string): boolean {
  // Only match phrases at the start of the message (first 60 chars) to avoid
  // false positives from embedded/quoted text
  const lower = text.toLowerCase().substring(0, 60);
  return AUTO_APPROVE_PHRASES.some((p) => lower.includes(p));
}

// ============================================================
// FAST HEURISTIC — catches ~80% of messages with zero extra cost
// ============================================================

const ACTION_VERBS = new Set([
  "research", "analyze", "compare", "create", "build", "write", "draft",
  "summarize", "review", "plan", "design", "evaluate", "investigate",
  "compile", "prepare", "develop", "generate", "organize", "calculate",
]);

const CONJUNCTIONS = new Set(["and", "then", "also", "plus", "after", "before", "while"]);

function isSimpleMessage(text: string): boolean {
  const words = text.trim().split(/\s+/);

  // Short messages are almost always simple
  if (words.length < 15) {
    const lower = words.map((w) => w.toLowerCase().replace(/[^a-z]/g, ""));
    const hasActionVerb = lower.some((w) => ACTION_VERBS.has(w));
    const hasConjunction = lower.some((w) => CONJUNCTIONS.has(w));

    // Only complex if it has both an action verb AND a conjunction
    if (!hasActionVerb || !hasConjunction) return true;
  }

  return false;
}

// ============================================================
// CLASSIFY — uses Haiku for cheap classification (~200 tokens)
// ============================================================

async function classify(
  text: string
): Promise<{ type: "simple" | "complex" }> {
  const prompt = `Classify this message as "simple" or "complex".

Simple: greetings, questions, single requests, short commands, casual conversation.
Complex: multi-step tasks, requests involving research + writing + analysis, tasks with multiple deliverables.

Message: "${text.substring(0, 300)}"

Return ONLY one word: simple or complex`;

  const result = await _callClaude(prompt, "haiku");
  const lower = result.toLowerCase().trim();

  return { type: lower.includes("complex") ? "complex" : "simple" };
}

// ============================================================
// MAIN ENTRY POINT
// ============================================================

export function orchestrate(
  ctx: Context,
  text: string,
  user: any,
  supabase: SupabaseClient | null
): void {
  // Step 1: Fast heuristic — no Claude call needed
  if (isSimpleMessage(text)) {
    console.log(`[orchestrator] Simple path (heuristic): ${text.substring(0, 50)}`);
    routeSimple(ctx, text, user, supabase);
    return;
  }

  // Step 2: Check pattern cache, then classify if needed
  _runTask(ctx, text.substring(0, 50), async () => {
    // Check for cached pattern first
    const pattern = await findPattern(supabase, text, user.id);
    if (pattern) {
      console.log(`[orchestrator] Pattern cache hit: ${pattern.task_signature.substring(0, 50)}`);
      await routeComplex(ctx, text, user, supabase, pattern.plan);
      return { prompt: "__ORCHESTRATOR_HANDLED__" };
    }

    // Classify via cheap Haiku call
    const classification = await classify(text);
    console.log(`[orchestrator] Classified as: ${classification.type}`);

    if (classification.type === "simple") {
      const [relevantContext, memoryContext, recentHistory, taskContext, scheduleContext] = await Promise.all([
        getRelevantContext(supabase, text, user.id),
        getMemoryContext(supabase, user.id),
        getRecentHistory(supabase, user.id),
        getTaskContext(supabase, user.id),
        getScheduleContext(supabase, user.id, user.timezone),
      ]);
      return {
        prompt: _buildPrompt(user, text, relevantContext, memoryContext, recentHistory, taskContext, scheduleContext),
      };
    }

    // Complex — decompose and execute
    await routeComplex(ctx, text, user, supabase);
    return { prompt: "__ORCHESTRATOR_HANDLED__" };
  }, {
    postProcess: async (raw) => {
      if (raw === "__ORCHESTRATOR_HANDLED__") return "__SKIP__";
      return processMemoryIntents(supabase, raw, user.id, user.timezone);
    },
    userId: user.id,
  });
}

// ============================================================
// SIMPLE PATH — unchanged from original relay behavior
// ============================================================

function routeSimple(
  ctx: Context,
  text: string,
  user: any,
  supabase: SupabaseClient | null
): void {
  _runTask(ctx, text.substring(0, 50), async () => {
    const [relevantContext, memoryContext, recentHistory, taskContext, scheduleContext] = await Promise.all([
      getRelevantContext(supabase, text, user.id),
      getMemoryContext(supabase, user.id),
      getRecentHistory(supabase, user.id),
      getTaskContext(supabase, user.id),
      getScheduleContext(supabase, user.id, user.timezone),
    ]);
    return {
      prompt: _buildPrompt(user, text, relevantContext, memoryContext, recentHistory, taskContext, scheduleContext),
    };
  }, {
    postProcess: (raw) => processMemoryIntents(supabase, raw, user.id, user.timezone),
  });
}

// ============================================================
// COMPLEX PATH — two-phase with approval gate
// Phase 1: prepare (safe) → show summary → wait for approval
// Phase 2: execute (consequential) → run on approval
// ============================================================

async function routeComplex(
  ctx: Context,
  text: string,
  user: any,
  supabase: SupabaseClient | null,
  cachedPlan?: ExecutionPlan
): Promise<void> {
  const startTime = Date.now();
  const autoApprove = detectAutoApprove(text);

  try {
    // Create parent task
    let parentTaskId: string | undefined;
    if (supabase) {
      const { data } = await supabase
        .from("agent_tasks")
        .insert({
          agent: "orchestrator",
          description: text.substring(0, 200),
          status: "in_progress",
          user_id: user.id,
        })
        .select("id")
        .single();
      parentTaskId = data?.id;
    }

    // Decompose using Haiku (cheap) or use cached plan
    const plan = cachedPlan || (await decompose(text, user));
    console.log(`[orchestrator] Plan: ${plan.subtasks.length} subtasks`);

    const hasExecutePhase = plan.subtasks.some((s) => s.phase === "execute");

    // If no execute subtasks or auto-approve: run everything straight through
    if (!hasExecutePhase || autoApprove) {
      if (autoApprove && hasExecutePhase) {
        console.log("[orchestrator] Auto-approve detected — running all phases");
      }

      // Send progress checklist for auto-approve/no-execute path
      const autoChecklistMsg = await sendProgressChecklist(ctx, plan);
      const autoStatuses = new Map<number, "pending" | "started" | "completed" | "failed">();
      plan.subtasks.forEach((_s, i) => autoStatuses.set(i, "pending"));
      let autoLastEdit = 0;
      let autoEditPending = false;

      const autoUpdateChecklist = async () => {
        const now = Date.now();
        if (now - autoLastEdit < 2000) {
          if (!autoEditPending) {
            autoEditPending = true;
            setTimeout(async () => {
              autoEditPending = false;
              await autoUpdateChecklist();
            }, 2000 - (now - autoLastEdit));
          }
          return;
        }
        autoLastEdit = now;
        try {
          if (autoChecklistMsg) {
            await ctx.api.editMessageText(
              ctx.chat!.id,
              autoChecklistMsg.message_id,
              buildChecklistText(plan, autoStatuses)
            );
          }
        } catch {}
      };

      const autoOnProgress: ProgressCallback = (index, status) => {
        autoStatuses.set(index, status === "started" ? "started" : status === "completed" ? "completed" : "failed");
        autoUpdateChecklist();
      };

      const results = await executeSubtasks(plan, user, supabase, parentTaskId, autoOnProgress);
      const allSucceeded = results.every((r) => r.success);

      const aggregated = await aggregate(text, results);
      const processed = await processMemoryIntents(supabase, aggregated, user.id, user.timezone);
      await _saveMessage("assistant", processed, user.id);

      // Delete checklist and send final response
      try {
        if (autoChecklistMsg) {
          await ctx.api.deleteMessage(ctx.chat!.id, autoChecklistMsg.message_id);
        }
      } catch {}
      await _sendResponseWithVoice(ctx, processed, user.id);

      // Mark parent task done
      if (supabase && parentTaskId) {
        await supabase
          .from("agent_tasks")
          .update({
            status: allSucceeded ? "completed" : "blocked",
            result: `${results.length} subtasks, ${results.filter((r) => r.success).length} succeeded`,
            updated_at: new Date().toISOString(),
          })
          .eq("id", parentTaskId);
      }

      const durationMs = Date.now() - startTime;
      await recordExecution(supabase, text, plan, allSucceeded, durationMs, user.id);
      return;
    }

    // === TWO-PHASE EXECUTION WITH APPROVAL GATE ===

    // Send progress checklist message
    const checklistMsg = await sendProgressChecklist(ctx, plan);

    // Build debounced progress callback for live checklist updates
    const subtaskStatuses = new Map<number, "pending" | "started" | "completed" | "failed">();
    plan.subtasks.forEach((_s, i) => subtaskStatuses.set(i, "pending"));
    let lastChecklistEdit = 0;
    let checklistEditPending = false;
    const CHECKLIST_DEBOUNCE_MS = 2000;

    const updateChecklist = async () => {
      const now = Date.now();
      if (now - lastChecklistEdit < CHECKLIST_DEBOUNCE_MS) {
        if (!checklistEditPending) {
          checklistEditPending = true;
          setTimeout(async () => {
            checklistEditPending = false;
            await updateChecklist();
          }, CHECKLIST_DEBOUNCE_MS - (now - lastChecklistEdit));
        }
        return;
      }
      lastChecklistEdit = now;
      const text = buildChecklistText(plan, subtaskStatuses);
      try {
        if (checklistMsg) {
          await ctx.api.editMessageText(ctx.chat!.id, checklistMsg.message_id, text);
        }
      } catch {}
    };

    const onProgress: ProgressCallback = (index, status) => {
      const statusMap = { started: "started", completed: "completed", failed: "failed" } as const;
      subtaskStatuses.set(index, statusMap[status]);
      updateChecklist();
    };

    // Phase 1: Run prepare subtasks
    console.log("[orchestrator] Phase 1: Running prepare subtasks");
    const prepareResults = await executePhase(plan, "prepare", user, supabase, parentTaskId, undefined, undefined, onProgress);
    const artifacts = collectArtifacts(prepareResults);

    // Delete checklist after prepare phase
    try {
      if (checklistMsg) {
        await updateChecklist(); // final update
        await new Promise((r) => setTimeout(r, 1500));
        await ctx.api.deleteMessage(ctx.chat!.id, checklistMsg.message_id);
      }
    } catch {}

    console.log(`[orchestrator] Prepare phase done: ${prepareResults.length} results, ${artifacts.length} artifacts`);

    // Build approval summary using Haiku
    const approvalSummary = await buildApprovalSummary(text, prepareResults, artifacts, plan);

    // Generate approval ID and store pending approval
    const approvalId = `apv-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

    pendingApprovals.set(approvalId, {
      id: approvalId,
      ctx,
      user,
      supabase,
      originalText: text,
      plan,
      prepareResults,
      artifacts,
      parentTaskId,
      startTime,
    });

    // Persist to Supabase so the Mini App can display and act on it
    if (supabase) {
      const chatId = ctx.chat?.id || 0;
      const execDescs = plan.subtasks
        .filter((s) => s.phase === "execute")
        .map((s) => s.description);
      await supabase.from("pending_approvals").insert({
        id: approvalId,
        user_id: user.id,
        chat_id: chatId,
        original_text: text.substring(0, 2000),
        plan: plan,
        prepare_summary: approvalSummary.substring(0, 5000),
        artifacts: artifacts.map((a) => ({ type: a.type, value: a.value, source: a.source })),
        execute_descriptions: execDescs,
        parent_task_id: parentTaskId || null,
        status: "pending",
      }).then(({ error }) => {
        if (error) console.error("[orchestrator] Failed to persist approval:", error.message);
      });
    }

    // Auto-expire after 30 minutes
    setTimeout(() => {
      if (pendingApprovals.has(approvalId)) {
        pendingApprovals.delete(approvalId);
        // Also expire in Supabase
        if (supabase) {
          supabase.from("pending_approvals")
            .update({ status: "expired", updated_at: new Date().toISOString() })
            .eq("id", approvalId)
            .eq("status", "pending")
            .then(() => {});
        }
        console.log(`[orchestrator] Approval ${approvalId} expired`);
      }
    }, 30 * 60 * 1000);

    // Send the summary with approval buttons (embedded approval ID in callback data)
    const executeDescriptions = plan.subtasks
      .filter((s) => s.phase === "execute")
      .map((s) => `• ${s.description}`)
      .join("\n");

    await _saveMessage("assistant", approvalSummary, user.id);
    await _sendResponseWithVoice(
      ctx,
      `${approvalSummary}\n\n**Pending actions:**\n${executeDescriptions}`,
      user.id
    );

    // Send approval buttons with embedded approval ID directly
    const keyboard = new InlineKeyboard()
      .text("Approve & Execute", `apv:${approvalId}:approve`)
      .text("Revise", `apv:${approvalId}:revise`)
      .text("Cancel", `apv:${approvalId}:cancel`);

    await ctx.reply("Tap below to proceed:", { reply_markup: keyboard });

    // Update parent task to waiting
    if (supabase && parentTaskId) {
      await supabase
        .from("agent_tasks")
        .update({
          status: "blocked",
          result: "Waiting for user approval",
          updated_at: new Date().toISOString(),
        })
        .eq("id", parentTaskId);
    }
  } catch (error) {
    console.error("[orchestrator] Complex route error:", error);

    // Mark parent task as blocked so it doesn't stay stuck as in_progress
    if (supabase && parentTaskId) {
      await supabase
        .from("agent_tasks")
        .update({
          status: "blocked",
          result: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
          updated_at: new Date().toISOString(),
        })
        .eq("id", parentTaskId)
        .catch(() => {});
    }

    console.log("[orchestrator] Falling back to simple path");
    routeSimple(ctx, text, user, supabase);
  }
}

// ============================================================
// MINI APP POLLING — check Supabase for approvals acted on via Mini App
// ============================================================

let _miniAppPollInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start polling Supabase for approvals that were approved/cancelled/revised
 * through the Mini App (not through Telegram buttons).
 * Runs every 5 seconds, only processes approvals that exist in the in-memory map.
 */
export function startMiniAppApprovalPolling(supabase: SupabaseClient | null): void {
  if (!supabase || _miniAppPollInterval) return;

  _miniAppPollInterval = setInterval(async () => {
    if (pendingApprovals.size === 0) return;

    try {
      const ids = Array.from(pendingApprovals.keys());
      const { data, error } = await supabase
        .from("pending_approvals")
        .select("id, status, feedback")
        .in("id", ids)
        .in("status", ["approved", "cancelled", "revised"]);

      if (error || !data?.length) return;

      for (const row of data) {
        const pending = pendingApprovals.get(row.id);
        if (!pending) continue;

        const actionMap: Record<string, "approve" | "cancel" | "revise"> = {
          approved: "approve",
          cancelled: "cancel",
          revised: "revise",
        };
        const action = actionMap[row.status];
        if (!action) continue;

        console.log(`[orchestrator] Mini App approval: ${row.id} → ${action}`);

        // Use the stored ctx to handle the approval
        await handleApproval(row.id, action, pending.ctx, row.feedback || undefined);
      }
    } catch (err) {
      // Silent — polling errors are non-critical
    }
  }, 5000);
}

// ============================================================
// PROGRESS CHECKLIST — edit-in-place with emoji status
// ============================================================

function buildChecklistText(
  plan: ExecutionPlan,
  statuses: Map<number, "pending" | "started" | "completed" | "failed">
): string {
  const lines = plan.subtasks.map((s, i) => {
    const status = statuses.get(i) || "pending";
    const emoji =
      status === "completed" ? "\u2705" :  // checkmark
      status === "failed" ? "\u274C" :      // X
      status === "started" ? "\u23F3" :     // hourglass
      "\u25AA\uFE0F";                       // small black square
    return `${emoji} ${s.description}`;
  });
  return `Working on your task...\n\n${lines.join("\n")}`;
}

async function sendProgressChecklist(
  ctx: Context,
  plan: ExecutionPlan
): Promise<{ message_id: number } | null> {
  if (plan.subtasks.length <= 1) return null; // no checklist for single-subtask plans
  try {
    const statuses = new Map<number, "pending" | "started" | "completed" | "failed">();
    plan.subtasks.forEach((_s, i) => statuses.set(i, "pending"));
    const text = buildChecklistText(plan, statuses);
    const msg = await ctx.reply(text);
    return { message_id: msg.message_id };
  } catch {
    return null;
  }
}

// ============================================================
// APPROVAL SUMMARY
// ============================================================

/**
 * Build a human-readable summary of prepare-phase results for the approval message.
 */
async function buildApprovalSummary(
  originalRequest: string,
  results: SubtaskResult[],
  artifacts: Artifact[],
  plan: ExecutionPlan
): Promise<string> {
  if (results.length === 0) return "Prepare phase produced no results.";

  const resultSummary = results
    .sort((a, b) => a.index - b.index)
    .map((r) => `[${r.agent || "general"}] ${r.description}: ${r.result.substring(0, 300)}`)
    .join("\n\n");

  const artifactSummary = artifacts.length > 0
    ? "\nDeliverables:\n" + artifacts.map((a) => `- ${a.type}: ${a.value}`).join("\n")
    : "";

  const prompt = `Summarize the preparation work done so far for the user. Be concise.

Original request: ${originalRequest}

Work completed:
${resultSummary}
${artifactSummary}

Write a brief Telegram-friendly summary (2-4 paragraphs max) of what was prepared.
Highlight the key deliverables. Do NOT mention "agents" or "subtasks" — just describe what was done.
End by noting that the next step requires their approval to execute.`;

  return _callClaude(prompt, "haiku");
}
