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
import type { Database } from "./db.ts";
import type { ApprovalRule } from "./db.ts";
import { getDb } from "./db.ts";
import type { ModelTier } from "./ai-provider.ts";
import { logError } from "./error-handler.ts";
import { mkdir, readdir, rename, stat } from "fs/promises";
import { join, extname } from "path";
import type { ExecutionPlan, ExecutionPattern } from "./patterns.ts";
import { findPattern, recordExecution } from "./patterns.ts";
import { reflectAndPropose } from "./learning-loop.ts";
import { type TrustLevel } from "./untrusted.ts";
import {
  initPlanner,
  decompose,
  buildSocialMediaPlan,
  buildEmailCampaignPlan,
  buildBlogPostPlan,
  buildPresentationPlan,
  buildAdCampaignPlan,
  executePhase,
  executeSubtasks,
  collectArtifacts,
  enrichArtifactsWithVision,
  aggregate,
} from "./planner.ts";
import type { SubtaskResult, Artifact, ProgressCallback } from "./planner.ts";
import { decideGate, recordOutcome, type GateMode } from "./autonomy.ts";
import { evaluatePolicies, policyForcesApproval, enforceBlockPolicies } from "./policy.ts";
import { deriveActionType } from "./ledger.ts";
import {
  processMemoryIntents,
  getMemoryContext,
  getRelevantContext,
  getRecentHistory,
  getTaskContext,
  getScheduleContext,
  getSessionSummaryContext,
} from "./memory.ts";
import { emit } from "./events.ts";
import { matchSchema, recordSchemaExecution } from "./schema-engine.ts";
import { getTrustLevel, checkTrustGate, recordSuccess as recordTrustSuccess, recordFailure as recordTrustFailure } from "./trust-budget.ts";
import { findLearnedSkillMatch } from "./agent-router.ts";

export interface WebContext {
  userId: string;
  chatId: string | number;
  reply: (text: string, options?: any) => Promise<any>;
  api?: any;
  chat?: { id?: string | number };
  replyWithChatAction?: (action: string) => Promise<void>;
  updateType?: string;
}

export type OrchestratorContext = Context | WebContext;

// Injected dependencies from relay.ts
let _callClaude: (prompt: string, model?: ModelTier, userId?: string, hint?: string, systemPrompt?: string) => Promise<string>;
let _buildPrompt: (...args: any[]) => { systemPrompt: string; userPrompt: string };
let _runTask: (
  ctx: Context,
  desc: string,
  buildTask: () => Promise<{ prompt: string; systemPrompt?: string; model?: ModelTier; hint?: string }>,
  opts?: {
    postProcess?: (r: string) => Promise<string>;
    userId?: string;
    sessionKey?: string;
    userMessage?: string;
  },
) => void;
let _saveMessage: (role: string, content: string, userId: string) => Promise<void>;
let _sendResponseWithVoice: (ctx: Context, response: string, userId?: string) => Promise<void>;
let _sendTelegramFile: (chatId: number | string, filePath: string, caption?: string) => Promise<void>;
let _sendMessageToChat: (chatId: number | string, text: string, keyboard?: InlineKeyboard) => Promise<void>;
let _novaDir: string;
let _supabase: Database | null = null;

export function initOrchestrator(deps: {
  callClaude: (prompt: string, model?: ModelTier, userId?: string, hint?: string, systemPrompt?: string) => Promise<string>;
  buildPrompt: (...args: any[]) => { systemPrompt: string; userPrompt: string };
  runTask: typeof _runTask;
  saveMessage: (role: string, content: string, userId: string) => Promise<void>;
  sendResponseWithVoice: (ctx: Context, response: string, userId?: string) => Promise<void>;
  sendTelegramFile: (chatId: number | string, filePath: string, caption?: string) => Promise<void>;
  sendMessageToChat: (chatId: number | string, text: string, keyboard?: InlineKeyboard) => Promise<void>;
  novaDir: string;
  supabase?: Database | null;
}): void {
  _callClaude = deps.callClaude;
  _buildPrompt = deps.buildPrompt;
  _runTask = deps.runTask;
  _saveMessage = deps.saveMessage;
  _sendResponseWithVoice = deps.sendResponseWithVoice;
  _sendTelegramFile = deps.sendTelegramFile;
  _sendMessageToChat = deps.sendMessageToChat;
  _novaDir = deps.novaDir;
  _supabase = deps.supabase || null;

  // Initialize planner with shared dependencies
  initPlanner(deps.callClaude, deps.buildPrompt);
}

// ============================================================
// PENDING APPROVALS — stored in memory for callback handler
// ============================================================

export interface PendingApproval {
  id: string;
  ctx: OrchestratorContext;
  chatId: number | string;  // stored for response delivery (survives ctx staleness)
  user: any;
  supabase: Database | null;
  originalText: string;
  plan: ExecutionPlan;
  prepareResults: SubtaskResult[];
  artifacts: Artifact[];
  parentTaskId?: string;
  startTime: number;
  workspaceDir?: string;
  workflowType?: "social-media" | "generic";
  requestId?: string;  // links back to originating user message for flow tracking
}

const pendingApprovals = new Map<string, PendingApproval>();

// ============================================================
// REVISION SESSIONS — tracks pending revision context per user
// ============================================================

interface RevisionSession {
  sessionId: string;   // unique ID for this revision session
  userId: string;
  originalText: string;
  plan: ExecutionPlan;
  prepareResults: SubtaskResult[];
  artifacts: Artifact[];
  parentTaskId?: string;
  workspaceDir?: string;
  workflowType: "social-media" | "generic";
  createdAt: number;
  requestId?: string;  // links back to originating user message
}

// Keyed by sessionId — supports multiple concurrent revision sessions per user
const revisionSessions = new Map<string, RevisionSession>();

// Periodic cleanup of expired approvals (24h) and revision sessions (1h)
setInterval(() => {
  const now = Date.now();
  for (const [id, approval] of pendingApprovals) {
    if (now - approval.startTime > 24 * 60 * 60 * 1000) pendingApprovals.delete(id);
  }
  for (const [id, session] of revisionSessions) {
    if (now - session.createdAt > 60 * 60 * 1000) revisionSessions.delete(id);
  }
}, 30 * 60 * 1000);

/**
 * Find the most recent pending revision session for a user.
 * When a user sends feedback, it applies to their latest revision request.
 */
function findLatestRevisionForUser(userId: string): RevisionSession | null {
  let latest: RevisionSession | null = null;
  for (const session of revisionSessions.values()) {
    if (session.userId === userId) {
      if (!latest || session.createdAt > latest.createdAt) {
        latest = session;
      }
    }
  }
  return latest;
}

/**
 * Persist a revision session to Supabase so it survives restarts and long delays.
 */
async function persistRevisionSession(
  supabase: Database | null,
  session: RevisionSession
): Promise<void> {
  if (!supabase) return;
  try {
    // Insert with unique session ID — supports multiple concurrent sessions per user
    supabase.insertRevisionSession({
      id: session.sessionId,
      user_id: session.userId,
      original_text: session.originalText.substring(0, 2000),
      plan: session.plan,
      prepare_results: session.prepareResults,
      artifacts: (session.artifacts || []).map((a: any) => ({ type: a.type, value: a.value, source: a.source })),
      parent_task_id: session.parentTaskId || null,
      workspace_dir: session.workspaceDir || null,
      workflow_type: session.workflowType,
      request_id: session.requestId || null,
      status: "pending",
    });
    console.log(`[orchestrator] Revision session ${session.sessionId} persisted for user ${session.userId}`);
  } catch (err) {
    console.error("[orchestrator] Error persisting revision session:", err);
  }
}

/**
 * Check if a user has an active revision session.
 * Revision sessions do NOT expire — they persist until the user sends feedback
 * or explicitly cancels. Returns the most recent session for the user.
 * Falls back to Supabase if not in memory.
 */
export function getRevisionSession(userId: string): RevisionSession | null {
  return findLatestRevisionForUser(userId);
}

/**
 * Async version that checks Supabase when not in memory.
 */
export async function getRevisionSessionAsync(userId: string): Promise<RevisionSession | null> {
  const inMemory = findLatestRevisionForUser(userId);
  if (inMemory) return inMemory;

  // Try to recover from Supabase
  if (!_supabase) return null;
  try {
    const data = _supabase.getLatestPendingRevisionSession(userId);

    if (!data) return null;

    const sessionId = data.id || `rev-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const session: RevisionSession = {
      sessionId,
      userId: data.user_id,
      originalText: data.original_text || "",
      plan: data.plan || { subtasks: [] },
      prepareResults: Array.isArray(data.prepare_results) ? data.prepare_results : [],
      artifacts: Array.isArray(data.artifacts) ? data.artifacts.map((a: any) => ({
        type: a.type || "file",
        value: a.value || "",
        source: a.source ?? 0,
      })) : [],
      parentTaskId: data.parent_task_id || undefined,
      workspaceDir: data.workspace_dir || undefined,
      workflowType: data.workflow_type || "generic",
      createdAt: new Date(data.created_at).getTime(),
      requestId: data.request_id || undefined,
    };

    // Restore to in-memory cache (keyed by sessionId)
    revisionSessions.set(sessionId, session);

    // Mark as consumed in DB
    _supabase.updateRevisionSessionStatus(data.id, "consumed");

    console.log(`[orchestrator] Recovered revision session ${sessionId} from Supabase for user ${userId}`);
    return session;
  } catch {
    return null;
  }
}

/**
 * Determine which step to resume from based on revision feedback.
 * Returns the subtask index to restart from.
 */
function detectRevisionResumePoint(feedback: string, workflowType: string): number {
  const lower = feedback.toLowerCase();

  if (workflowType === "social-media") {
    // Image-only changes → restart from step 2 (image generation)
    if (/(?:image|photo|picture|graphic|visual|slide|color|blue|red|green|style|design|look)/i.test(lower) &&
        !/(?:caption|text|copy|write|hashtag|hook|cta)/i.test(lower)) {
      return 2;
    }
    // Copy/caption changes → restart from step 1 (content creation)
    if (/(?:caption|text|copy|write|hashtag|hook|cta|wording|tone)/i.test(lower) &&
        !/(?:image|photo|picture|graphic|visual|slide)/i.test(lower)) {
      return 1;
    }
    // General or mixed → restart from step 0 (research)
    return 0;
  }

  // For generic workflows, restart from step 0 (full redo of prepare phase)
  return 0;
}

// ============================================================
// WORKFLOW PREFERENCES — reuse approved plans for similar tasks
// ============================================================

/**
 * Save a workflow preference when a plan is approved and executed successfully.
 */
async function saveWorkflowPreference(
  supabase: Database | null,
  userId: string,
  workflowType: string,
  originalText: string,
  plan: ExecutionPlan
): Promise<void> {
  if (!supabase) return;
  // Normalize the request into a reusable signature (strip topic specifics, keep structure)
  const sig = normalizeWorkflowSignature(originalText);
  if (!sig) return;

  try {
    // upsert increments success_count on conflict, so no separate increment is needed
    supabase.upsertWorkflowPreference({
      user_id: userId,
      workflow_type: workflowType,
      task_signature: sig,
      plan,
    });
    console.log(`[orchestrator] Saved workflow preference: ${sig}`);
  } catch (e) { logError(e, "orchestrator:save-workflow-preference", userId); }
}

/**
 * Normalize a task request into a structural signature.
 * Strips the specific topic but preserves the task type + platforms.
 * E.g., "create an instagram post about AI tools" → "create instagram post"
 */
function normalizeWorkflowSignature(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/(?:about|on|for|regarding|promoting)\s+.+$/i, "")
    .replace(/[^a-z0-9 ]/g, "")
    .trim()
    .split(" ")
    .slice(0, 6)
    .join(" ");
}

/**
 * Recover a single approval from Supabase into the in-memory map.
 * Used when a user taps an approval button but the bot has restarted
 * or the approval fell out of memory. Returns the PendingApproval if found.
 */
/**
 * Load a full user object from Supabase by user ID.
 * Used when recovering approvals/revision sessions where only the user_id was persisted.
 */
async function loadFullUser(db: Database, userId: string): Promise<any> {
  try {
    const data = db.getUserById(userId);
    if (!data) {
      console.warn(`[orchestrator] Could not load full user ${userId}, using minimal object`);
      return { id: userId };
    }
    return data;
  } catch {
    return { id: userId };
  }
}

async function recoverSingleApproval(
  approvalId: string,
  ctx: Context
): Promise<PendingApproval | null> {
  if (!_supabase) return null;

  try {
    const data = _supabase.getApproval(approvalId);

    if (!data) return null;

    const chatId = data.chat_id || ctx.chat?.id || 0;
    const prepareResults: SubtaskResult[] = Array.isArray(data.prepare_results) ? data.prepare_results : [];
    const artifacts: Artifact[] = Array.isArray(data.artifacts) ? data.artifacts.map((a: any) => ({
      type: a.type || "file",
      value: a.value || "",
      source: a.source ?? 0,
    })) : [];

    // Load full user object (name, timezone, etc.) — needed for execute phase context
    const user = await loadFullUser(_supabase, data.user_id);

    const pending: PendingApproval = {
      id: data.id,
      ctx,
      chatId,
      user,
      supabase: _supabase,
      originalText: data.original_text || "",
      plan: data.plan || { subtasks: [] },
      prepareResults,
      artifacts,
      parentTaskId: data.parent_task_id || undefined,
      startTime: new Date(data.created_at).getTime(),
      workspaceDir: data.workspace_dir || undefined,
      workflowType: (data.workflow_type as any) || "generic",
      requestId: data.request_id || undefined,
    };

    pendingApprovals.set(approvalId, pending);
    return pending;
  } catch (err) {
    console.error(`[orchestrator] Failed to recover approval ${approvalId}:`, err);
    return null;
  }
}

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
  let pending = pendingApprovals.get(approvalId);

  // If not in memory, try to recover from Supabase (handles restarts, long delays)
  if (!pending) {
    pending = await recoverSingleApproval(approvalId, ctx);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: "Approval not found. It may have already been processed." });
      return;
    }
    console.log(`[orchestrator] Recovered approval ${approvalId} from Supabase on-demand`);
  }

  emit({ type: "approval.resolved", level: "info", userId: pending.user.id, data: { message: `Approval: ${action}`, action } });
  await ctx.answerCallbackQuery({ text: action === "approve" ? "Executing..." : action === "revise" ? "Send your revision" : "Cancelled" });

  // Remove buttons from the approval message
  try {
    const originalText = ctx.callbackQuery?.message?.text || "";
    const statusLine = action === "approve" ? "\n\n>> Approved" : action === "cancel" ? "\n\n>> Cancelled" : "\n\n>> Revision requested";
    await ctx.editMessageText(`${originalText}${statusLine}`, { reply_markup: undefined });
  } catch {}

  // Update DB status
  if (pending.supabase) {
    const statusMap = { approve: "approved", cancel: "cancelled", revise: "revised" } as const;
    pending.supabase.updateApprovalStatus(approvalId, statusMap[action], feedback || null);
  }

  if (action === "cancel") {
    pendingApprovals.delete(approvalId);
    // P2 ladder: a user rejection instantly demotes the involved actions to L0.
    const cancelExecuteTasks = (pending.plan?.subtasks || []).filter((s: any) => s.phase === "execute");
    recordLadderOutcomes(pending.user.id, cancelExecuteTasks, { success: false, rejected: true });
    await _saveMessage("assistant", "Task cancelled.", pending.user.id);
    await _sendResponseWithVoice(ctx as any,"Got it — cancelled.", pending.user.id);
    return;
  }

  if (action === "revise") {
    // Store revision context so the next message resumes the workflow
    const revSessionId = `rev-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const revSession: RevisionSession = {
      sessionId: revSessionId,
      userId: pending.user.id,
      originalText: pending.originalText,
      plan: pending.plan,
      prepareResults: pending.prepareResults,
      artifacts: pending.artifacts,
      parentTaskId: pending.parentTaskId,
      workspaceDir: pending.workspaceDir,
      workflowType: pending.workflowType || "generic",
      createdAt: Date.now(),
      requestId: pending.requestId,
    };
    revisionSessions.set(revSessionId, revSession);

    // Persist to Supabase so it survives restarts and long delays
    await persistRevisionSession(pending.supabase || _supabase, revSession);

    pendingApprovals.delete(approvalId);

    if (pending.workflowType === "social-media") {
      await _sendResponseWithVoice(
        ctx,
        "Send me your revision. I'll figure out which steps to redo:\n• Copy/caption changes → skip research\n• Image changes only → skip research + copywriting\n• General feedback → full redo",
        pending.user.id
      );
    } else {
      await _sendResponseWithVoice(ctx as any,"Send me your revision and I'll redo the prepare phase.", pending.user.id);
    }
    return;
  }

  // action === "approve" — run execute phase
  pendingApprovals.delete(approvalId);

  // Hard-block compliance: a content_check policy set to `block` prevents execution even
  // after approval (true compliance block). Checked against the prepared content.
  {
    const preparedContent = [
      ...(pending.artifacts || []).map((a: any) => String(a?.value ?? "")),
      ...(pending.prepareResults || []).map((r: any) => String(r?.result ?? "")),
    ].join("\n");
    const executeAgents = (pending.plan?.subtasks || []).filter((s: any) => s.phase === "execute").map((s: any) => s.agent || "general");
    const block = enforceBlockPolicies(pending.supabase, pending.user.id, preparedContent, { agents: executeAgents });
    if (block.blocked) {
      recordLadderOutcomes(pending.user.id, (pending.plan?.subtasks || []).filter((s: any) => s.phase === "execute"), { success: false, rejected: true });
      if (pending.supabase && pending.parentTaskId) pending.supabase.updateTask(pending.parentTaskId, { status: "blocked", result: `blocked by policy: ${block.reasons.join(", ")}` });
      await _sendResponseWithVoice(ctx as any, `🛡️ Execution blocked by a compliance policy (${block.reasons.join(", ")}). Nothing was sent or published. Revise the content and try again.`, pending.user.id);
      return;
    }
  }

  try {
    await ctx.replyWithChatAction("typing");

    const executeResults = await executePhase(
      pending.plan,
      "execute",
      pending.user,
      pending.supabase,
      pending.parentTaskId,
      pending.artifacts,
      pending.prepareResults,
      undefined,
      pending.workspaceDir
    );

    const allResults = [...pending.prepareResults, ...executeResults];
    const allSucceeded = allResults.every((r) => r.success);

    // Aggregate
    const aggregated = await aggregate(pending.originalText, allResults);
    const processed = await processMemoryIntents(pending.supabase, aggregated, pending.user.id, pending.user.timezone, { agentSlug: "planner", sessionId: pending.requestId });
    await _saveMessage("assistant", processed, pending.user.id);

    // Deliver workspace files before text response
    const approvalChatId = ctx.chat?.id;
    if (approvalChatId && pending.workspaceDir) {
      const fileCount = await deliverWorkspaceFiles(approvalChatId, pending.workspaceDir, pending.parentTaskId, pending.user.id, pending.supabase);
      if (fileCount > 0) {
        emit({ type: "task.completed", level: "info", userId: pending.user.id, data: { message: `Delivered ${fileCount} file(s) from workspace (post-approval)`, fileCount } });
      }
    }
    await _sendResponseWithVoice(ctx as any,processed, pending.user.id);

    // Mark parent task done
    if (pending.supabase && pending.parentTaskId) {
      pending.supabase.updateTask(pending.parentTaskId, {
        status: allSucceeded ? "completed" : "blocked",
        result: `${allResults.length} subtasks, ${allResults.filter((r) => r.success).length} succeeded`,
      });
    }

    // Record pattern and save workflow preference
    const durationMs = Date.now() - pending.startTime;
    await recordExecution(pending.supabase, pending.originalText, pending.plan, allSucceeded, durationMs, pending.user.id);
    if (allSucceeded) {
      await saveWorkflowPreference(pending.supabase, pending.user.id, pending.workflowType || "generic", pending.originalText, pending.plan);
    }

    // Update trust budget based on post-approval execution outcome
    if (pending.supabase) {
      const executeTasks = pending.plan.subtasks.filter((s: any) => s.phase === "execute");
      for (const task of executeTasks) {
        const taskType = detectCategory(task.agent || "general", task.description);
        if (allSucceeded) {
          recordTrustSuccess(pending.supabase, pending.user.id, taskType).catch(() => {});
        } else {
          recordTrustFailure(pending.supabase, pending.user.id, taskType).catch(() => {});
        }
      }
      // P2 ladder: approved success is an earned clean run; failure demotes to L0.
      recordLadderOutcomes(pending.user.id, executeTasks, { success: allSucceeded });
    }
  } catch (error) {
    console.error("[orchestrator] Execute phase error:", error);
    // P2 ladder: an execute-phase throw is a failure → demote to L0.
    recordLadderOutcomes(pending.user.id, (pending.plan?.subtasks || []).filter((s: any) => s.phase === "execute"), { success: false });
    await _sendResponseWithVoice(ctx as any,"Something went wrong during the execute phase. The prepare work is still saved — try again.", pending.user.id);
  }
}

/**
 * Handle a revision by re-running the workflow from the appropriate step.
 * Uses stored context from the revision session to skip already-complete work.
 */
async function handleRevision(
  ctx: OrchestratorContext,
  feedback: string,
  user: any,
  supabase: Database | null,
  session: RevisionSession
): Promise<void> {
  const resumeFrom = detectRevisionResumePoint(feedback, session.workflowType);
  const plan = session.plan;

  console.log(`[orchestrator] Revision resume from step ${resumeFrom} (workflow: ${session.workflowType})`);

  // Build a modified plan that only re-runs from resumeFrom onward (prepare phase only)
  const modifiedPlan: ExecutionPlan = {
    subtasks: plan.subtasks.map((s, i) => {
      if (s.phase === "execute") return s; // execute phase stays as-is
      if (i < resumeFrom) return s; // steps before resumeFrom are kept (already completed)
      // Steps from resumeFrom onward get the revision feedback injected
      return {
        ...s,
        description: i === resumeFrom
          ? `REVISION — The user reviewed the previous output and wants changes: "${feedback}"\n\nOriginal task: ${s.description}`
          : s.description,
      };
    }),
  };

  // Keep prior results for steps before resumeFrom
  const keptResults = session.prepareResults.filter((r) => r.index < resumeFrom);

  await ctx.replyWithChatAction("typing");

  // Re-run the prepare phase from resumeFrom
  const newPrepareResults = await executePhase(
    modifiedPlan,
    "prepare",
    user,
    supabase,
    session.parentTaskId,
    collectArtifacts(keptResults),
    keptResults,
    undefined,
    session.workspaceDir
  );

  // Merge: kept results + new results
  const allPrepareResults = [...keptResults, ...newPrepareResults.filter((r) => r.index >= resumeFrom)];
  const allArtifacts = collectArtifacts(allPrepareResults);

  // Build approval summary and present for re-approval
  const approvalSummary = await buildApprovalSummary(session.originalText, allPrepareResults, allArtifacts, plan);

  const approvalId = `apv-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

  const revisionChatId = ctx.chat?.id || 0;

  pendingApprovals.set(approvalId, {
    id: approvalId,
    ctx,
    chatId: revisionChatId,
    user,
    supabase,
    originalText: session.originalText,
    plan,
    prepareResults: allPrepareResults,
    artifacts: allArtifacts,
    parentTaskId: session.parentTaskId,
    startTime: Date.now(),
    workspaceDir: session.workspaceDir,
    workflowType: session.workflowType,
    requestId: session.requestId,
  });

  console.log(`[orchestrator] Approval created (revision): ${approvalId} | request="${session.originalText.substring(0, 60)}" | requestId=${session.requestId} | total pending: ${pendingApprovals.size}`);

  // Persist to DB — includes prepareResults for potential restart recovery
  if (supabase) {
    const execDescs = plan.subtasks
      .filter((s) => s.phase === "execute")
      .map((s) => s.description);
    try {
      supabase.insertApproval({
        id: approvalId,
        user_id: user.id,
        chat_id: revisionChatId,
        original_text: session.originalText.substring(0, 2000),
        plan: plan,
        prepare_summary: approvalSummary.substring(0, 5000),
        prepare_results: allPrepareResults,
        artifacts: allArtifacts.map((a) => ({ type: a.type, value: a.value, source: a.source })),
        execute_descriptions: execDescs,
        parent_task_id: session.parentTaskId || null,
        workspace_dir: session.workspaceDir || null,
        workflow_type: session.workflowType || "generic",
        request_id: session.requestId || null,
        status: "pending",
      });
    } catch (error: any) {
      console.error("[orchestrator] Failed to persist revision approval:", error.message);
    }
  }

  // Note: approvals do NOT expire — they remain pending until the user acts on them.

  const executeDescriptions = plan.subtasks
    .filter((s) => s.phase === "execute")
    .map((s) => `• ${s.description}`)
    .join("\n");

  const requestLabel = session.originalText.length > 80 ? `${session.originalText.substring(0, 80)}...` : session.originalText;
  const approvalMessage = `📋 **Task:** ${requestLabel}\n\n${approvalSummary}\n\n**Pending actions:**\n${executeDescriptions}`;

  await _saveMessage("assistant", approvalSummary, user.id);
  await _sendResponseWithVoice(ctx as any, approvalMessage, user.id);

  const keyboard = new InlineKeyboard()
    .text("Approve & Execute", `apv:${approvalId}:approve`)
    .text("Revise", `apv:${approvalId}:revise`)
    .text("Cancel", `apv:${approvalId}:cancel`);

  await ctx.reply("Tap below to proceed:", { reply_markup: keyboard });
}

/**
 * Get pending approval count (for /status command).
 */
export function getPendingApprovalCount(): number {
  return pendingApprovals.size;
}

// ============================================================
// DEV TASK DETECTION
// ============================================================

const DEV_TASK_PATTERNS = [
  /\b(fix|implement|add|refactor|update|debug|write|build|create)\b.{3,50}\b(bug|feature|function|component|test|endpoint|route|script|module)\b/i,
  /\b(in|on|for|to)\s+(the\s+)?\w+\s+(repo|codebase|project|app|service)\b/i,
  /\b(commit|push|branch|pr|pull request)\b/i,
];

function detectDevTaskRequest(text: string, supabase: Database | null, userId: string): boolean {
  if (!supabase) return false;
  const projects = supabase.getProjects(userId);
  if (projects.length === 0) return false;
  return DEV_TASK_PATTERNS.some((p) => p.test(text));
}

// ============================================================
// SOCIAL MEDIA WORKFLOW DETECTION
// ============================================================

interface SocialMediaRequest {
  isSocial: boolean;
  topic: string;
  platforms: string[];
}

const SOCIAL_PATTERNS = [
  /(?:create|make|design|draft|write|build|prepare|generate)\s+(?:a\s+|an\s+)?(?:social\s+media\s+)?(?:instagram|ig|insta)\s+(?:post|reel|story|carousel|content)/i,
  /(?:create|make|design|draft|write|build|prepare|generate)\s+(?:a\s+|an\s+)?(?:social\s+media\s+)?(?:facebook|fb)\s+(?:post|story|content)/i,
  /(?:create|make|design|draft|write|build|prepare|generate)\s+(?:a\s+|an\s+)?(?:social\s+media\s+)?(?:linkedin|li)\s+(?:post|article|content)/i,
  /(?:create|make|design|draft|write|build|prepare|generate)\s+(?:a\s+|an\s+)?(?:social\s+media\s+)?(?:tiktok|tt)\s+(?:post|video|content)/i,
  /(?:create|make|design|draft|write|build|prepare|generate)\s+(?:a\s+|an\s+)?(?:social\s+media\s+)?(?:twitter|x)\s+(?:post|tweet|content|thread)/i,
  /(?:create|make|design|draft|write|build|prepare|generate)\s+(?:a\s+|an\s+)?(?:social\s+media\s+)?(?:post|carousel|content)\s+(?:about|on|for|regarding)/i,
  /(?:create|make|design|draft|write|build|prepare|generate)\s+(?:a\s+|an\s+)?(?:carousel|post)\s+(?:about|on|for|regarding)/i,
  /(?:schedule|publish)\s+(?:a\s+|an\s+)?(?:social\s+media\s+)?(?:post|content)\s+(?:about|on|for|regarding)/i,
  /(?:social\s+media\s+post)\s+(?:about|on|for|regarding)/i,
];

const PLATFORM_KEYWORDS: Record<string, string[]> = {
  instagram: ["instagram", "ig", "insta"],
  facebook: ["facebook", "fb"],
  linkedin: ["linkedin", "li"],
  tiktok: ["tiktok", "tt"],
  twitter: ["twitter", "x", "tweet"],
};

function detectSocialMediaRequest(text: string): SocialMediaRequest | null {
  const lower = text.toLowerCase();

  // Check if any social pattern matches
  const matched = SOCIAL_PATTERNS.some((p) => p.test(text));
  if (!matched) return null;

  // Extract platforms
  const platforms: string[] = [];
  for (const [platform, keywords] of Object.entries(PLATFORM_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      platforms.push(platform);
    }
  }
  // Default to instagram + facebook if no specific platform mentioned
  if (platforms.length === 0) {
    platforms.push("instagram", "facebook");
  }

  // Extract topic — take everything after "about", "on", "for", "regarding"
  let topic = "";
  const topicMatch = text.match(/(?:about|on|for|regarding)\s+(.+)/i);
  if (topicMatch) {
    // Clean up: remove trailing platform mentions and filler
    topic = topicMatch[1]
      .replace(/\s+on\s+(instagram|facebook|linkedin|tiktok|twitter|x)\b/gi, "")
      .replace(/\s+for\s+(instagram|facebook|linkedin|tiktok|twitter|x)\b/gi, "")
      .trim();
  }

  if (!topic) {
    // Fallback: use the whole message minus the action verb prefix
    topic = text
      .replace(/^(?:create|make|design|draft|write|build|prepare|generate|schedule|publish)\s+(?:a\s+|an\s+)?(?:social\s+media\s+)?(?:post|carousel|content|reel|story)\s*/i, "")
      .trim();
  }

  if (!topic) return null;

  return { isSocial: true, topic, platforms };
}

// ============================================================
// EMAIL CAMPAIGN WORKFLOW DETECTION
// ============================================================

const EMAIL_PATTERNS = [
  /(?:create|make|build|send|draft|write|launch|set up)\s+(?:a\s+|an\s+)?(?:email\s+)?(?:campaign|newsletter|drip|sequence|blast|broadcast)\s+(?:about|for|to|targeting)/i,
  /(?:email\s+campaign|email\s+marketing|newsletter|drip\s+sequence|email\s+blast)\s+(?:about|for|to|targeting)/i,
  /(?:send|draft|create)\s+(?:a\s+|an\s+)?(?:marketing\s+)?email\s+(?:about|for|to|regarding)/i,
];

function detectEmailCampaignRequest(text: string): { topic: string; audience: string } | null {
  const matched = EMAIL_PATTERNS.some((p) => p.test(text));
  if (!matched) return null;

  let topic = "";
  const topicMatch = text.match(/(?:about|for|regarding)\s+(.+?)(?:\s+to\s+|\s+targeting\s+|$)/i);
  if (topicMatch) topic = topicMatch[1].trim();
  if (!topic) {
    topic = text.replace(/^(?:create|make|build|send|draft|write|launch|set up)\s+(?:a\s+|an\s+)?(?:email\s+)?(?:campaign|newsletter|drip|sequence|blast|broadcast)\s*/i, "").trim();
  }

  let audience = "";
  const audienceMatch = text.match(/(?:to|targeting|for)\s+(?:our\s+|the\s+)?(.+?)$/i);
  if (audienceMatch && audienceMatch[1] !== topic) audience = audienceMatch[1].trim();

  if (!topic) return null;
  return { topic, audience };
}

// ============================================================
// BLOG POST WORKFLOW DETECTION
// ============================================================

const BLOG_PATTERNS = [
  /(?:write|create|draft|publish)\s+(?:a\s+|an\s+)?(?:blog\s+post|blog\s+article|article|blog)\s+(?:about|on|for|regarding)/i,
  /(?:blog\s+post|blog\s+article)\s+(?:about|on|for|regarding)/i,
];

function detectBlogPostRequest(text: string): { topic: string } | null {
  const matched = BLOG_PATTERNS.some((p) => p.test(text));
  if (!matched) return null;

  let topic = "";
  const topicMatch = text.match(/(?:about|on|for|regarding)\s+(.+)/i);
  if (topicMatch) topic = topicMatch[1].trim();
  if (!topic) return null;
  return { topic };
}

// ============================================================
// PRESENTATION WORKFLOW DETECTION
// ============================================================

const PRESENTATION_PATTERNS = [
  /(?:create|make|build|prepare|design)\s+(?:a\s+|an\s+)?(?:presentation|deck|slide\s*deck|pitch\s*deck|pptx|powerpoint|slides)\s+(?:about|on|for|regarding)/i,
  /(?:presentation|deck|slide\s*deck|pitch\s*deck)\s+(?:about|on|for|regarding)/i,
];

function detectPresentationRequest(text: string): { topic: string } | null {
  const matched = PRESENTATION_PATTERNS.some((p) => p.test(text));
  if (!matched) return null;

  let topic = "";
  const topicMatch = text.match(/(?:about|on|for|regarding)\s+(.+)/i);
  if (topicMatch) topic = topicMatch[1].trim();
  if (!topic) return null;
  return { topic };
}

// ============================================================
// AD CAMPAIGN WORKFLOW DETECTION
// ============================================================

const AD_CAMPAIGN_PATTERNS = [
  /(?:create|launch|build|set up|run)\s+(?:a\s+|an\s+)?(?:ad|ads|advertising|paid)\s+(?:campaign|ads?)\s+(?:about|for|on|promoting)/i,
  /(?:create|launch|build|set up|run)\s+(?:a\s+|an\s+)?(?:facebook|google|linkedin|meta|instagram)\s+(?:ad|ads|campaign)\s+(?:about|for|on|promoting)/i,
  /(?:ad\s+campaign|advertising\s+campaign|paid\s+campaign)\s+(?:about|for|on|promoting)/i,
];

const AD_PLATFORM_KEYWORDS: Record<string, string[]> = {
  facebook: ["facebook", "fb", "meta"],
  google: ["google", "google ads", "adwords"],
  linkedin: ["linkedin"],
  instagram: ["instagram", "ig"],
};

function detectAdCampaignRequest(text: string): { topic: string; platforms: string[] } | null {
  const matched = AD_CAMPAIGN_PATTERNS.some((p) => p.test(text));
  if (!matched) return null;

  const lower = text.toLowerCase();
  const platforms: string[] = [];
  for (const [platform, keywords] of Object.entries(AD_PLATFORM_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) platforms.push(platform);
  }
  if (platforms.length === 0) platforms.push("facebook", "instagram");

  let topic = "";
  const topicMatch = text.match(/(?:about|for|on|promoting)\s+(.+?)(?:\s+on\s+(?:facebook|google|linkedin|meta|instagram)\b|$)/i);
  if (topicMatch) topic = topicMatch[1].trim();
  if (!topic) return null;

  return { topic, platforms };
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

export function detectAutoApprove(text: string, trust: TrustLevel = "trusted"): boolean {
  // Untrusted-provenance input (e.g. content ingested from an external source) can never
  // auto-execute — it must always pass through the human approval gate.
  if (trust !== "trusted") return false;
  // Only match if the phrase appears at the very start of the message
  // (after trimming whitespace) to prevent false positives from quoted/embedded text
  const lower = text.toLowerCase().trim();
  return AUTO_APPROVE_PHRASES.some((p) => lower.startsWith(p));
}

// Provenance gate: no matter what upstream signals (phrase-based auto-approve, approval
// rules, or trust-budget autonomy) computed, an untrusted-triggered plan can never take
// the straight-through execute path — it must always land on the human approval gate.
export function resolveAutoApprove(opts: {
  autoApprove: boolean;
  ruleAutoApprove: boolean;
  trust: TrustLevel;
}): boolean {
  return opts.trust === "trusted" && (opts.autoApprove || opts.ruleAutoApprove);
}

// ============================================================
// BUDGET-GATED AUTONOMY — rule-based auto-approval
// ============================================================

// ============================================================
// P2 AUTONOMY LADDER — bridge between execute subtasks and the ladder engine
// ============================================================

const LADDER_EST_COST_USD = 0.01;

interface LadderExecuteTask { agent?: string; description: string }

interface LadderGate { mode: GateMode; spentContext?: string }

/** Most-restrictive gate decision across all execute subtasks. */
function resolveExecuteGate(userId: string, executeTasks: LadderExecuteTask[]): LadderGate {
  if (executeTasks.length === 0) return { mode: "auto" };
  const rank: Record<GateMode, number> = { auto: 0, notify: 1, "escalate-cap": 2, ask: 3 };
  let worst: GateMode = "auto";
  let spentContext: string | undefined;
  for (const t of executeTasks) {
    const agent = t.agent || "general";
    const actionType = deriveActionType(t.description);
    let d;
    try {
      d = decideGate(userId, agent, actionType, LADDER_EST_COST_USD);
    } catch {
      return { mode: "ask" };
    }
    if (d.mode === "escalate-cap" && d.cap != null) {
      const spent = d.spentToday != null ? `$${d.spentToday.toFixed(2)} spent today, ` : "";
      spentContext = `Spend cap reached for ${agent} / ${actionType}: ${spent}cap $${d.cap.toFixed(2)}.`;
    }
    // Compliance layer: policies can only ADD friction (force approval). No policies → no-op.
    try {
      const pol = evaluatePolicies(getDb(), { userId, agent, actionType, estimateUsd: LADDER_EST_COST_USD, content: t.description });
      if (policyForcesApproval(pol)) {
        if (rank["ask"] > rank[worst]) worst = "ask";
        if (pol.reasons.length) spentContext = `${spentContext ? spentContext + " " : ""}Policy: ${pol.reasons.join("; ")}.`;
      }
    } catch { /* policy evaluation is best-effort; never blocks the gate on error */ }
    if (rank[d.mode] > rank[worst]) worst = d.mode;
  }
  return { mode: worst, spentContext };
}

/** Record ladder outcomes for every execute subtask. Never throws. */
function recordLadderOutcomes(
  userId: string,
  executeTasks: LadderExecuteTask[],
  opts: { success: boolean; rejected?: boolean; oneShot?: boolean },
): void {
  for (const t of executeTasks) {
    try {
      recordOutcome(userId, t.agent || "general", deriveActionType(t.description), {
        success: opts.success,
        rejected: opts.rejected,
        oneShot: opts.oneShot,
      });
    } catch (err) {
      console.error("[autonomy] recordOutcome failed:", err);
    }
  }
}

function detectCategory(agentSlug: string, taskDescription: string): string {
  const desc = taskDescription.toLowerCase();
  const slug = agentSlug.toLowerCase();

  if (["pixel", "kai"].includes(slug)) return "social_post";
  if (slug === "helios") return "ad_spend";
  if (slug === "orion") return "email";
  if (["architect", "joule"].includes(slug)) return "code_deploy";
  if (["magnus", "cyra"].includes(slug)) return "seo";
  if (["athena", "oracle", "cipher"].includes(slug)) return "research";
  if (desc.includes("email") || desc.includes("send message")) return "email";
  if (desc.includes("publish") || desc.includes("post")) return "social_post";
  if (desc.includes("deploy") || desc.includes("push")) return "code_deploy";
  return "general";
}

function shouldAutoApproveByRules(rules: ApprovalRule[], agentSlug: string, taskDescription: string): boolean {
  if (rules.length === 0) return false;
  const category = detectCategory(agentSlug, taskDescription);

  for (const rule of rules) {
    if (rule.category !== category && rule.category !== "*") continue;
    if (rule.agent_slugs?.length && !rule.agent_slugs.includes(agentSlug)) continue;
    return rule.auto_approve === true;
  }
  return false;
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

/**
 * Single-agent routing keywords.
 * Maps keywords to agent slugs for tasks that clearly need one specialist
 * but aren't complex enough for full orchestration.
 */
const SINGLE_AGENT_ROUTES: Array<{ pattern: RegExp; agent: string }> = [
  { pattern: /(?:seo|keyword research|backlink|ranking|search engine)/i, agent: "magnus" },
  { pattern: /(?:audit|ux review|website review|conversion rate|cro)\s+(?:of|for|on)\s/i, agent: "cyra" },
  { pattern: /(?:brand voice|brand identity|tone of voice|messaging framework|brand personality)/i, agent: "aura" },
  { pattern: /(?:data analysis|dashboard|kpi|metrics|analytics report|sales data)/i, agent: "digit" },
  { pattern: /(?:security audit|vulnerability|penetration test|infosec|cybersecurity)/i, agent: "rift" },
  { pattern: /(?:automate|automation|workflow|zapier|make\.com|webhook|integration)/i, agent: "joule" },
  { pattern: /(?:community|discord|circle|moderation|engagement strategy)/i, agent: "nexus" },
  { pattern: /(?:video script|storyboard|video strategy|youtube|video content)/i, agent: "morpheus" },
  { pattern: /(?:grant|proposal|funding|rfp|business proposal)/i, agent: "quill" },
  { pattern: /(?:legal|contract|compliance|gdpr|privacy policy|terms of service|nda)/i, agent: "lex" },
  { pattern: /(?:press release|media outreach|pr strategy|public relations|crisis comm)/i, agent: "helia" },
  { pattern: /(?:partnership|strategic partner|collaboration|co-marketing|joint venture)/i, agent: "bridge" },
  { pattern: /(?:trend forecast|scenario planning|future|foresight|emerging tech)/i, agent: "oracle" },
  { pattern: /(?:funnel|landing page|conversion|offer sequence|lead magnet)/i, agent: "flux" },
  { pattern: /(?:systems thinking|causal loop|leverage point|feedback loop|interconnect)/i, agent: "tesseract" },
  { pattern: /(?:productivity|time management|focus|habit|workflow optimization)/i, agent: "zen" },
];

/**
 * Try to match a message to a single specialist agent.
 * Returns the agent slug if it's a clear single-agent task, null otherwise.
 */
function detectSingleAgentRoute(text: string): string | null {
  const lower = text.toLowerCase();
  const matches: string[] = [];

  for (const route of SINGLE_AGENT_ROUTES) {
    if (route.pattern.test(text)) {
      matches.push(route.agent);
    }
  }

  // Only route if exactly one agent matched — ambiguity means decomposition
  return matches.length === 1 ? matches[0] : null;
}

async function classify(
  text: string
): Promise<{ type: "simple" | "routed" | "complex"; agent?: string }> {
  // Pre-check: does this clearly route to a single agent?
  const singleAgent = detectSingleAgentRoute(text);
  if (singleAgent) {
    // Still need to check if it's truly single-step or needs decomposition
    // Short requests with a single agent match → routed
    const words = text.trim().split(/\s+/);
    if (words.length < 40) {
      return { type: "routed", agent: singleAgent };
    }
  }

  const prompt = `Classify this message as "simple", "routed", or "complex".

Simple: greetings, questions, single requests, short commands, casual conversation, lookups.
Routed: single-domain task needing a specialist (e.g., "audit my website", "analyze our sales data", "write a press release") — one agent can handle the whole thing.
Complex: multi-step tasks, requests involving research + writing + analysis, tasks with multiple deliverables, cross-domain work.

Message: "${text.substring(0, 300)}"

Return ONLY one word: simple, routed, or complex`;

  const result = await _callClaude(prompt, "haiku" as any, undefined, "classify");
  const lower = result.toLowerCase().trim();

  if (lower.includes("complex")) return { type: "complex" };
  if (lower.includes("routed")) return { type: "routed", agent: singleAgent || undefined };
  return { type: "simple" };
}

// ============================================================
// MAIN ENTRY POINT
// ============================================================

export function orchestrate(
  ctx: OrchestratorContext,
  text: string,
  user: any,
  supabase: Database | null,
  sessionKey?: string,
  channel?: string,
  trust: TrustLevel = "trusted"
): void {
  // Generate a request_id for message flow tracking
  const requestId = `req-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

  // Step 0: Check for active revision session — the user's message is feedback on prior work
  // First check in-memory (fast), then Supabase (async) inside _runTask
  const revSession = getRevisionSession(user.id);
  if (revSession) {
    revisionSessions.delete(revSession.sessionId);
    emit({ type: "message.classified", level: "info", requestId, userId: user.id, data: { message: `Revision session for ${user.name}: "${text.substring(0, 50)}"`, classification: "revision" } });
    _runTask(ctx as Context, `Revision: ${text.substring(0, 40)}`, async () => {
      await handleRevision(ctx, text, user, supabase, revSession);
      return { prompt: "__ORCHESTRATOR_HANDLED__" };
    }, {
      postProcess: async (raw) => raw === "__ORCHESTRATOR_HANDLED__" ? "__SKIP__" : processMemoryIntents(supabase, raw, user.id, user.timezone, { sessionId: requestId }),
      userId: user.id,
      sessionKey: sessionKey ?? "",
      userMessage: text,
    });
    return;
  }

  // Step 0b: Check Supabase for persisted revision sessions (survives restarts + long delays)
  // This runs inside _runTask since it's async
  if (supabase) {
    // Quick sync check failed, try async Supabase recovery
    _runTask(ctx as Context, `Check revision: ${text.substring(0, 30)}`, async () => {
      const recoveredSession = await getRevisionSessionAsync(user.id);
      if (recoveredSession) {
        revisionSessions.delete(recoveredSession.sessionId);
        console.log(`[orchestrator] Recovered revision session from Supabase for ${user.name}`);
        await handleRevision(ctx, text, user, supabase, recoveredSession);
        return { prompt: "__ORCHESTRATOR_HANDLED__" };
      }
      // Not a revision — fall through to normal routing
      return { prompt: "__NOT_REVISION__" };
    }, {
      postProcess: async (raw) => {
        if (raw === "__ORCHESTRATOR_HANDLED__") return "__SKIP__";
        if (raw === "__NOT_REVISION__") {
          // Continue with normal orchestration
          orchestrateMain(ctx, text, user, supabase, requestId, sessionKey, trust);
          return "__SKIP__";
        }
        return processMemoryIntents(supabase, raw, user.id, user.timezone, { sessionId: requestId });
      },
      userId: user.id,
      sessionKey: sessionKey ?? "",
      userMessage: text,
    });
    return;
  }

  // No supabase — go directly to main orchestration
  orchestrateMain(ctx, text, user, supabase, requestId, sessionKey, trust);
}

/**
 * Main orchestration logic — split out so revision recovery can fall through to it.
 */
function orchestrateMain(
  ctx: OrchestratorContext,
  text: string,
  user: any,
  supabase: Database | null,
  requestId: string,
  sessionKey?: string,
  trust: TrustLevel = "trusted"
): void {
  // Step 0.5: Dev task detection — prompt user to confirm routing to background dev worker
  if (detectDevTaskRequest(text, supabase, user.id)) {
    const projects = supabase!.getProjects(user.id);
    const chatId = ctx.chat?.id || (ctx as WebContext).chatId;
    if (chatId) {
      emit({ type: "message.classified", level: "info", requestId, userId: user.id, data: { message: `Dev task detected: "${text.substring(0, 60)}"`, classification: "dev-task-prompt" } });
      const keyboard = new InlineKeyboard();
      projects.forEach((p) => keyboard.text(`Queue for ${p.name}`, `devtask:${p.id}:${text.substring(0, 200)}`).row());
      keyboard.text("Handle normally", `devtask:normal:${text.substring(0, 200)}`);
      _sendMessageToChat(
        chatId,
        `This looks like a dev task. Queue it as background work on a registered project, or handle normally?\n\n*Task:* ${text.substring(0, 200)}`,
        keyboard
      ).catch((err) => console.warn("[orchestrator] Dev task prompt failed:", err));
      return;
    }
  }

  // Step 1: Fast heuristic — no Claude call needed
  if (isSimpleMessage(text)) {
    emit({ type: "message.classified", level: "info", requestId, userId: user.id, data: { message: `Simple path (heuristic): ${text.substring(0, 50)}`, classification: "simple" } });
    routeSimple(ctx, text, user, supabase, sessionKey);
    return;
  }

  // Step 1.5: Detect social media workflow — hard-coded pipeline
  const socialReq = detectSocialMediaRequest(text);
  if (socialReq) {
    emit({ type: "message.classified", level: "info", requestId, userId: user.id, data: { message: `Social media workflow: "${socialReq.topic}" → ${socialReq.platforms.join(", ")}`, classification: "social-media" } });
    _runTask(ctx as Context, text.substring(0, 50), async () => {
      const plan = buildSocialMediaPlan(socialReq.topic, socialReq.platforms);
      await routeComplex(ctx, text, user, supabase, plan, "social-media", requestId, undefined, undefined, sessionKey, trust);
      return { prompt: "__ORCHESTRATOR_HANDLED__" };
    }, {
      postProcess: async (raw) => {
        if (raw === "__ORCHESTRATOR_HANDLED__") return "__SKIP__";
        return processMemoryIntents(supabase, raw, user.id, user.timezone, { agentSlug: "planner", sessionId: requestId });
      },
      userId: user.id,
    });
    return;
  }

  // Step 1.6: Detect other deterministic workflows
  const emailReq = detectEmailCampaignRequest(text);
  if (emailReq) {
    emit({ type: "message.classified", level: "info", requestId, userId: user.id, data: { message: `Email campaign workflow: "${emailReq.topic}"`, classification: "email-campaign" } });
    _runTask(ctx as Context, text.substring(0, 50), async () => {
      const plan = buildEmailCampaignPlan(emailReq.topic, emailReq.audience);
      await routeComplex(ctx, text, user, supabase, plan, "generic", requestId, undefined, undefined, sessionKey, trust);
      return { prompt: "__ORCHESTRATOR_HANDLED__" };
    }, {
      postProcess: async (raw) => raw === "__ORCHESTRATOR_HANDLED__" ? "__SKIP__" : processMemoryIntents(supabase, raw, user.id, user.timezone, { agentSlug: "planner", sessionId: requestId }),
      userId: user.id,
    });
    return;
  }

  const blogReq = detectBlogPostRequest(text);
  if (blogReq) {
    emit({ type: "message.classified", level: "info", requestId, userId: user.id, data: { message: `Blog post workflow: "${blogReq.topic}"`, classification: "blog-post" } });
    _runTask(ctx as Context, text.substring(0, 50), async () => {
      const plan = buildBlogPostPlan(blogReq.topic);
      await routeComplex(ctx, text, user, supabase, plan, "generic", requestId, undefined, undefined, sessionKey, trust);
      return { prompt: "__ORCHESTRATOR_HANDLED__" };
    }, {
      postProcess: async (raw) => raw === "__ORCHESTRATOR_HANDLED__" ? "__SKIP__" : processMemoryIntents(supabase, raw, user.id, user.timezone, { agentSlug: "planner", sessionId: requestId }),
      userId: user.id,
    });
    return;
  }

  const presReq = detectPresentationRequest(text);
  if (presReq) {
    emit({ type: "message.classified", level: "info", requestId, userId: user.id, data: { message: `Presentation workflow: "${presReq.topic}"`, classification: "presentation" } });
    _runTask(ctx as Context, text.substring(0, 50), async () => {
      const plan = buildPresentationPlan(presReq.topic);
      await routeComplex(ctx, text, user, supabase, plan, "generic", requestId, undefined, undefined, sessionKey, trust);
      return { prompt: "__ORCHESTRATOR_HANDLED__" };
    }, {
      postProcess: async (raw) => raw === "__ORCHESTRATOR_HANDLED__" ? "__SKIP__" : processMemoryIntents(supabase, raw, user.id, user.timezone, { agentSlug: "planner", sessionId: requestId }),
      userId: user.id,
    });
    return;
  }

  const adReq = detectAdCampaignRequest(text);
  if (adReq) {
    emit({ type: "message.classified", level: "info", requestId, userId: user.id, data: { message: `Ad campaign workflow: "${adReq.topic}" → ${adReq.platforms.join(", ")}`, classification: "ad-campaign" } });
    _runTask(ctx as Context, text.substring(0, 50), async () => {
      const plan = buildAdCampaignPlan(adReq.topic, adReq.platforms);
      await routeComplex(ctx, text, user, supabase, plan, "generic", requestId, undefined, undefined, sessionKey, trust);
      return { prompt: "__ORCHESTRATOR_HANDLED__" };
    }, {
      postProcess: async (raw) => raw === "__ORCHESTRATOR_HANDLED__" ? "__SKIP__" : processMemoryIntents(supabase, raw, user.id, user.timezone, { agentSlug: "planner", sessionId: requestId }),
      userId: user.id,
    });
    return;
  }

  // Step 2: Check pattern cache, then classify if needed
  _runTask(ctx as Context, text.substring(0, 50), async () => {
    // Tier -1: Learned skill match — user-defined skills take priority over catalog routing
    if (supabase) {
      try {
        const learnedSkillMatch = await findLearnedSkillMatch(supabase, user.id, text);
        if (learnedSkillMatch) {
          emit({ type: "message.classified", level: "info", requestId, userId: user.id, data: { message: `Learned skill hit: ${learnedSkillMatch.slug}`, classification: "learned-skill" } });
          const skillContent = await Bun.file(learnedSkillMatch.skillPath).text();
          const [relevantContext, memoryContext, sessionSummary, taskContext, scheduleContext] = await Promise.all([
            getRelevantContext(supabase, text, user.id),
            getMemoryContext(supabase, user.id, 1500),
            getSessionSummaryContext(supabase, user.id, sessionKey ?? ""),
            getTaskContext(supabase, user.id),
            getScheduleContext(supabase, user.id, user.timezone),
          ]);
          const recentHistory = await getRecentHistory(supabase, user.id, sessionSummary ? 5 : 12);
          const { systemPrompt: skillSysPrompt, userPrompt: skillUserPrompt } = _buildPrompt(user, text, relevantContext, memoryContext, recentHistory, taskContext, scheduleContext, { contactContext: (ctx as any)?._whatsappContactContext, sessionSummary: sessionSummary || undefined });
          return { prompt: `${skillUserPrompt}\n\n---\nSKILL CONTEXT:\n${skillContent}`, systemPrompt: skillSysPrompt, hint: text };
        }
      } catch (e) { logError(e, "orchestrator:learned-skill-check", user?.id); }
    }

    // Tier 0: Schema engine match (zero LLM tokens for recurring task types)
    if (supabase) {
      try {
        const schemaMatch = await matchSchema(supabase, user.id, text);
        if (schemaMatch) {
          emit({ type: "message.classified", level: "info", requestId, userId: user.id, data: { message: `Schema Tier-0 hit: ${schemaMatch.name}`, classification: "schema" } });
          const schemaPlan: ExecutionPlan = {
            subtasks: [{
              description: schemaMatch.executionTemplate,
              agent: "orchestrator",
              dependsOn: [],
              phase: "prepare",
            }],
          };
          await routeComplex(ctx, text, user, supabase, schemaPlan, undefined, requestId, undefined, undefined, sessionKey, trust);
          recordSchemaExecution(supabase, schemaMatch.id, true).catch(() => {});
          return { prompt: "__ORCHESTRATOR_HANDLED__" };
        }
      } catch (e) { logError(e, "orchestrator:schema-check", user?.id); }
    }

    // Check for cached pattern first
    const pattern = await findPattern(supabase, text, user.id);
    if (pattern) {
      emit({ type: "message.classified", level: "info", requestId, userId: user.id, data: { message: `Pattern cache hit: ${pattern.task_signature.substring(0, 50)}`, classification: "cached" } });
      await routeComplex(ctx, text, user, supabase, pattern.plan, undefined, requestId, undefined, undefined, sessionKey, trust);
      return { prompt: "__ORCHESTRATOR_HANDLED__" };
    }

    // Classify via cheap Haiku call
    const classification = await classify(text);
    emit({ type: "message.classified", level: "info", requestId, userId: user.id, data: { message: `Classified as: ${classification.type}`, classification: classification.type } });

    if (classification.type === "simple") {
      const [relevantContext, memoryContext, sessionSummary, taskContext, scheduleContext] = await Promise.all([
        getRelevantContext(supabase, text, user.id),
        getMemoryContext(supabase, user.id, 1500),
        getSessionSummaryContext(supabase, user.id, sessionKey ?? ""),
        getTaskContext(supabase, user.id),
        getScheduleContext(supabase, user.id, user.timezone),
      ]);
      const recentHistory = await getRecentHistory(supabase, user.id, sessionSummary ? 5 : 12); // 12 = pre-existing default
      const { systemPrompt: orchSysPrompt, userPrompt: orchUserPrompt } = _buildPrompt(user, text, relevantContext, memoryContext, recentHistory, taskContext, scheduleContext, { contactContext: (ctx as any)?._whatsappContactContext, sessionSummary: sessionSummary || undefined });
      return {
        prompt: orchUserPrompt,
        systemPrompt: orchSysPrompt,
        hint: text,
      };
    }

    if (classification.type === "routed" && classification.agent) {
      // Single-agent task — build a 1-subtask plan and route directly
      emit({ type: "agent.dispatched", level: "info", requestId, userId: user.id, agentSlug: classification.agent, data: { message: `Routed to ${classification.agent}`, agent: classification.agent } });
      const singlePlan: ExecutionPlan = {
        subtasks: [{
          description: text,
          agent: classification.agent,
          dependsOn: [],
          phase: "prepare",
        }],
      };
      await routeComplex(ctx, text, user, supabase, singlePlan, undefined, requestId, undefined, undefined, sessionKey, trust);
      return { prompt: "__ORCHESTRATOR_HANDLED__" };
    }

    // Complex — decompose and execute
    await routeComplex(ctx, text, user, supabase, undefined, undefined, requestId, undefined, undefined, sessionKey, trust);
    return { prompt: "__ORCHESTRATOR_HANDLED__" };
  }, {
    postProcess: async (raw) => {
      if (raw === "__ORCHESTRATOR_HANDLED__") return "__SKIP__";
      return processMemoryIntents(supabase, raw, user.id, user.timezone, { sessionId: requestId });
    },
    userId: user.id,
    sessionKey: sessionKey ?? "",
    userMessage: text,
  });
}

// ============================================================
// SIMPLE PATH — unchanged from original behavior
// ============================================================

function routeSimple(
  ctx: OrchestratorContext,
  text: string,
  user: any,
  supabase: Database | null,
  sessionKey?: string
): void {
  _runTask(ctx as Context, text.substring(0, 50), async () => {
    const [relevantContext, memoryContext, sessionSummary, taskContext, scheduleContext] = await Promise.all([
      getRelevantContext(supabase, text, user.id),
      getMemoryContext(supabase, user.id, 1500),
      getSessionSummaryContext(supabase, user.id, sessionKey ?? ""),
      getTaskContext(supabase, user.id),
      getScheduleContext(supabase, user.id, user.timezone),
    ]);
    const recentHistory = await getRecentHistory(supabase, user.id, sessionSummary ? 5 : 12);
    const { systemPrompt: simpleSysPrompt, userPrompt: simpleUserPrompt } = _buildPrompt(user, text, relevantContext, memoryContext, recentHistory, taskContext, scheduleContext, { contactContext: (ctx as any)?._whatsappContactContext, sessionSummary: sessionSummary || undefined });
    return {
      prompt: simpleUserPrompt,
      systemPrompt: simpleSysPrompt,
      hint: text,
    };
  }, {
    postProcess: (raw) => processMemoryIntents(supabase, raw, user.id, user.timezone, {}),
    userId: user.id,
    sessionKey: sessionKey ?? "",
    userMessage: text,
  });
}

// ============================================================
// WORKSPACE — shared directory for subtask file artifacts
// ============================================================

async function createWorkspace(userId: string, taskId?: string): Promise<string> {
  const id = taskId || crypto.randomUUID();
  const workspaceDir = join(_novaDir, "workspace", ".tasks", id);
  await mkdir(workspaceDir, { recursive: true });
  console.log(`[orchestrator] Workspace created: ${workspaceDir} (task=${id})`);
  return workspaceDir;
}

/**
 * Determine the persistent workspace subdirectory for a file based on its extension.
 */
function classifyFileDestination(fileName: string): { dir: string; type: string } {
  const ext = extname(fileName).toLowerCase();
  const imageExts = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"]);
  const docExts = new Set([".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt", ".csv", ".txt", ".md", ".rtf"]);
  const mediaExts = new Set([".mp4", ".mp3", ".wav", ".ogg", ".webm", ".mov", ".avi", ".m4a"]);

  if (imageExts.has(ext)) return { dir: "images", type: "image" };
  if (docExts.has(ext)) return { dir: "documents", type: "document" };
  if (mediaExts.has(ext)) return { dir: "media", type: "media" };
  return { dir: "documents", type: "file" };
}

/**
 * Move files from the task staging directory to the persistent workspace,
 * register them in the artifact DB, and send each to the user.
 * Never auto-deletes — staging dir is kept on failure for inspection.
 */
async function deliverWorkspaceFiles(
  chatId: number | string,
  workspaceDir: string,
  taskId?: string,
  userId?: string,
  supabase?: Database | null,
): Promise<number> {
  let delivered = 0;
  try {
    const entries = await readdir(workspaceDir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile());
    if (files.length === 0) return 0;

    console.log(`[orchestrator] Delivering ${files.length} file(s) from ${workspaceDir} → chat ${chatId}`);
    for (const entry of files) {
      const srcPath = join(workspaceDir, entry.name);

      // Determine persistent destination
      const { dir, type } = classifyFileDestination(entry.name);
      const destDir = join(_novaDir, "workspace", dir);
      await mkdir(destDir, { recursive: true });
      const destPath = join(destDir, entry.name);

      // Send to user first
      await _sendTelegramFile(chatId, srcPath, entry.name);
      delivered++;

      // Move to persistent location
      try {
        await rename(srcPath, destPath);
      } catch {
        // rename fails across filesystems — fall back to copy+keep
        console.warn(`[orchestrator] Could not move ${entry.name} to ${destDir}, keeping in staging`);
      }

      // Register artifact in DB
      if (supabase && userId) {
        try {
          const fileStat = await stat(destPath).catch(() => null);
          supabase.insertArtifact({
            task_id: taskId || null,
            user_id: userId,
            artifact_type: type,
            file_path: destPath,
            file_name: entry.name,
            file_size: fileStat?.size || null,
            verified: !!fileStat,
            delivered: true,
            metadata: {},
          });
        } catch (e) {
          // Table may not exist yet — non-critical
          console.warn(`[orchestrator] Could not register artifact: ${e}`);
        }
      }
    }
  } catch (error) {
    console.error(`[orchestrator] Error scanning workspace ${workspaceDir}: ${error}`);
  }

  // Do NOT auto-delete the staging dir — user cleans up explicitly
  return delivered;
}

// ============================================================
// COMPLEX PATH — two-phase with approval gate
// Phase 1: prepare (safe) → show summary → wait for approval
// Phase 2: execute (consequential) → run on approval
// ============================================================

/**
 * Execute a pre-built ExecutionPlan (e.g. rendered from a playbook) through the normal
 * complex-task path — decomposition is skipped, but two-phase prepare→approve→execute,
 * artifacts, and the approval gate all apply exactly as usual.
 */
export function runPlan(
  ctx: OrchestratorContext,
  text: string,
  user: any,
  supabase: Database | null,
  plan: ExecutionPlan,
  sessionKey?: string,
  trust: TrustLevel = "trusted"
): void {
  const requestId = `req-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  if (supabase && user?.id) supabase.insertRunEvent(user.id, { kind: 'playbook', refId: requestId, refName: (text || '').slice(0, 60), status: 'started', detail: (text || '').slice(0, 500) }); // [trust]
  routeComplex(ctx, text, user, supabase, plan, undefined, requestId, undefined, undefined, sessionKey, trust)
    .catch((err) => logError(err, "orchestrator:runPlan", user?.id));
}

async function routeComplex(
  ctx: OrchestratorContext,
  text: string,
  user: any,
  supabase: Database | null,
  cachedPlan?: ExecutionPlan,
  workflowType?: "social-media" | "generic",
  requestId?: string,
  existingTaskId?: string,
  existingWorkspaceDir?: string,
  sessionKey?: string,
  trust: TrustLevel = "trusted"
): Promise<void> {
  const startTime = Date.now();
  const autoApprove = detectAutoApprove(text, trust);

  // Declared outside try so the catch block can reference it for cleanup
  let parentTaskId: string | undefined;

  try {
    const chatId = "chat" in ctx ? ctx.chat?.id : (ctx as WebContext).chatId;

    // Create parent task first — we use its ID for the workspace directory
    if (supabase) {
      parentTaskId = supabase.insertTask({
        agent: "orchestrator",
        description: text.substring(0, 200),
        status: "in_progress",
        user_id: user.id,
      });
    }

    // Create workspace scoped to user + task (isolates concurrent tasks)
    const workspaceDir = await createWorkspace(user.id, parentTaskId);

    // Decompose using Haiku (cheap) or use cached plan
    const plan = cachedPlan || (await decompose(text, user, supabase));
    emit({ type: "task.created", level: "info", requestId, userId: user.id, data: { message: `Plan: ${plan.subtasks.length} subtasks`, subtaskCount: plan.subtasks.length } });

    const hasExecutePhase = plan.subtasks.some((s) => s.phase === "execute");

    // Check rule-based auto-approve (budget-gated autonomy)
    let ruleAutoApprove = false;
    if (hasExecutePhase && trust === "untrusted") {
      // Provenance gate: untrusted-triggered plans may prepare but never auto-execute —
      // skip rule/trust-budget computation entirely and fall through to the approval gate.
      ruleAutoApprove = false;
    } else if (hasExecutePhase && !autoApprove && supabase) {
      const rules = supabase.getApprovalRules(user.id);
      if (rules.length > 0) {
        const executeTasks = plan.subtasks.filter((s) => s.phase === "execute");
        ruleAutoApprove = executeTasks.length > 0 && executeTasks.every((task) =>
          shouldAutoApproveByRules(rules, task.agent || "general", task.description)
        );
        if (ruleAutoApprove) {
          console.log(`[orchestrator] Rule-based auto-approve triggered for user ${user.id}`);
          emit({ type: "approval.resolved", level: "info", requestId, userId: user.id, data: { message: "Rule-based auto-approve — skipping approval gate", action: "rule-auto-approve" } });
        }
      }

      // Trust budget: check earned autonomy per task type
      if (!ruleAutoApprove) {
        const executeTasks = plan.subtasks.filter((s) => s.phase === "execute");
        if (executeTasks.length > 0) {
          const trustLevels = await Promise.all(
            executeTasks.map((task) => getTrustLevel(supabase, user.id, detectCategory(task.agent || "general", task.description)).catch(() => 0 as const))
          );
          const minTrust = Math.min(...trustLevels) as 0 | 1 | 2 | 3;
          const trustGate = checkTrustGate(minTrust, {
            isExternal: executeTasks.some((t) => /email|post|send|publish/i.test(t.description)),
            modifiesSharedData: executeTasks.some((t) => /crm|calendar|update|write/i.test(t.description)),
          });
          if (!trustGate.requiresApproval) {
            ruleAutoApprove = true;
            console.log(`[trust-budget] Level ${minTrust} — skipping approval gate`);
            emit({ type: "approval.resolved", level: "info", requestId, userId: user.id, data: { message: `Trust budget level ${minTrust} — auto-approved`, action: "trust-auto-approve" } });
          }
        }
      }
    }

    // If no execute subtasks or auto-approve: run everything straight through
    if (!hasExecutePhase || resolveAutoApprove({ autoApprove, ruleAutoApprove, trust })) {
      if (autoApprove && hasExecutePhase) {
        emit({ type: "approval.resolved", level: "info", requestId, userId: user.id, data: { message: "Auto-approve detected — running all phases", action: "auto-approve" } });
      }

      // ============================================================
      // ADAPTIVE RETRY STRATEGY LADDER
      // 1 = Original (same plan, same provider)
      // 2 = Provider swap (re-decompose, alt provider gets picked by rate-limit fallback)
      // 3 = Simplify (single-agent, no decomposition — same as routeSimple path)
      // 4 = Different specialist (kai as broad-purpose fallback)
      // 5 = Ask user (4 attempts exhausted)
      // ============================================================

      // Determine starting strategy from cached pattern (if available)
      let cachedPatternForStrategy: ExecutionPattern | null = null;
      if (supabase) {
        cachedPatternForStrategy = await findPattern(supabase, text, user.id);
      }
      const startStrategy = cachedPatternForStrategy?.winning_strategy ?? 1;
      const MAX_STRATEGIES = 5;

      let lastError: unknown = null;
      let partialResult: string | undefined;
      let winningStrategy = startStrategy;

      for (let strategy = startStrategy; strategy <= MAX_STRATEGIES; strategy++) {
        try {
          let activePlan = plan;

          if (strategy === 2) {
            // Re-decompose the task — a fresh plan may route to a different provider
            // depending on current rate-limit state.
            emit({ type: "task.retry", level: "info", requestId, userId: user.id, data: { message: `Strategy 2: provider swap re-decompose`, strategy } });
            activePlan = await decompose(text, user, supabase);
          } else if (strategy === 3) {
            // Simplify: single-agent, no decomposition — call AI directly (awaitable)
            emit({ type: "task.retry", level: "info", requestId, userId: user.id, data: { message: `Strategy 3: simplify to single-agent`, strategy } });
            const [relevantContext, memoryContext, sessionSummary, taskContext, scheduleContext] = await Promise.all([
              getRelevantContext(supabase, text, user.id),
              getMemoryContext(supabase, user.id, 1500),
              getSessionSummaryContext(supabase, user.id, sessionKey ?? ""),
              getTaskContext(supabase, user.id),
              getScheduleContext(supabase, user.id, user.timezone),
            ]);
            const recentHistory = await getRecentHistory(supabase, user.id, sessionSummary ? 5 : 12);
            const { userPrompt: retryUserPrompt } = _buildPrompt(user, text, relevantContext, memoryContext, recentHistory, taskContext, scheduleContext, { contactContext: (ctx as any)?._whatsappContactContext, sessionSummary: sessionSummary || undefined });
            const raw = await _callClaude(retryUserPrompt, undefined, user.id, text);
            const processed = await processMemoryIntents(supabase, raw, user.id, user.timezone, { sessionId: requestId });
            await _saveMessage("assistant", processed, user.id);
            await _sendResponseWithVoice(ctx as Context, processed, user.id);
            winningStrategy = 3;
            const durationMs = Date.now() - startTime;
            await recordExecution(supabase, text, plan, true, durationMs, user.id, winningStrategy);
            // Fire-and-forget reflective review (propose-don't-commit). Never blocks the reply.
            reflectAndPropose({ db: supabase, userId: user.id, taskText: text, plan, callLLM: _callClaude }).catch(() => {});
            return;
          } else if (strategy === 4) {
            // Different specialist: route to kai (broad content/writing generalist)
            emit({ type: "task.retry", level: "info", requestId, userId: user.id, data: { message: `Strategy 4: fallback to kai specialist`, strategy } });
            activePlan = {
              subtasks: [{
                description: text,
                agent: "kai",
                dependsOn: [],
                phase: "prepare" as const,
              }],
            };
          } else if (strategy === MAX_STRATEGIES) {
            // Ask user — all strategies exhausted
            emit({ type: "task.retry", level: "info", requestId, userId: user.id, data: { message: `Strategy 5: escalate to user`, strategy } });
            const escalationMsg = `I tried 4 different approaches and couldn't complete this task.\n\nHere's what I know so far:\n${partialResult || "(no partial result)"}\n\nHow would you like me to proceed?`;
            await _saveMessage("assistant", escalationMsg, user.id);
            await _sendResponseWithVoice(ctx as any,escalationMsg, user.id);
            if (supabase && parentTaskId) {
              supabase.updateTask(parentTaskId, { status: "blocked", result: "All retry strategies exhausted — awaiting user guidance" });
            }
            return;
          }

          if (strategy > 1) {
            emit({ type: "task.retry", level: "info", requestId, userId: user.id, data: { message: `Retry with strategy ${strategy}`, strategy } });
          }

          // Send progress checklist for this attempt
          const autoChecklistMsg = await sendProgressChecklist(ctx as any, activePlan);
          const autoStatuses = new Map<number, "pending" | "started" | "completed" | "failed" | "healing">();
          activePlan.subtasks.forEach((_s, i) => autoStatuses.set(i, "pending"));
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
                const checkText = buildChecklistText(activePlan, autoStatuses);
                if ("api" in ctx) {
                  await ctx.api.editMessageText(ctx.chat!.id, autoChecklistMsg.message_id, checkText);
                } else {
                  emit({ type: "chat.update", level: "info", data: { messageId: autoChecklistMsg.message_id, text: checkText, requestId } });
                }
              }
            } catch {}
          };

          const autoOnProgress: ProgressCallback = (index, status) => {
            autoStatuses.set(index, status);
            autoUpdateChecklist();
          };

          const results = await executeSubtasks(activePlan, user, supabase, parentTaskId, autoOnProgress, workspaceDir);
          const allSucceeded = results.every((r) => r.success);

          if (!allSucceeded) {
            // Capture partial result for escalation message
            const partialResultText = results
              .filter((r) => r.success && r.result)
              .map((r) => r.result)
              .join("\n\n");
            if (partialResultText) partialResult = partialResultText;
            throw new Error(`${results.filter((r) => !r.success).length} subtask(s) failed`);
          }

          // Success — record winning strategy
          winningStrategy = strategy;

          const aggregated = await aggregate(text, results);
          const processed = await processMemoryIntents(supabase, aggregated, user.id, user.timezone, { agentSlug: "planner", sessionId: requestId });
          await _saveMessage("assistant", processed, user.id);

          // Final checklist update with completion timestamp
          try {
            if (autoChecklistMsg) {
              await autoUpdateChecklist();
              const elapsed = Math.round((Date.now() - startTime) / 1000);
              const finalText = buildChecklistText(activePlan, autoStatuses) + `\n\nDone (${elapsed}s)`;
              if ("api" in ctx) {
                await ctx.api.editMessageText(ctx.chat!.id, autoChecklistMsg.message_id, finalText).catch(() => {});
              } else {
                emit({ type: "chat.update", level: "info", data: { messageId: autoChecklistMsg.message_id, text: finalText, requestId } });
              }
            }
          } catch {}

          // Deliver workspace files before text response
          if (chatId) {
            const fileCount = await deliverWorkspaceFiles(chatId, workspaceDir, parentTaskId, user.id, supabase);
            if (fileCount > 0) {
              emit({ type: "task.completed", level: "info", requestId, userId: user.id, data: { message: `Delivered ${fileCount} file(s) from workspace`, fileCount } });
            }
          }
          await _sendResponseWithVoice(ctx as any,processed, user.id);

          // Mark parent task done
          if (supabase && parentTaskId) {
            supabase.updateTask(parentTaskId, {
              status: "completed",
              result: `${results.length} subtasks succeeded (strategy ${winningStrategy})`,
            });
          }

          const durationMs = Date.now() - startTime;
          await recordExecution(supabase, text, activePlan, true, durationMs, user.id, winningStrategy);
          // Fire-and-forget reflective review (propose-don't-commit). Never blocks the reply.
          reflectAndPropose({ db: supabase, userId: user.id, taskText: text, plan: activePlan, callLLM: _callClaude }).catch(() => {});

          // Update trust budget based on execution outcome
          if (supabase) {
            const executeTasks = activePlan.subtasks.filter((s) => s.phase === "execute");
            for (const task of executeTasks) {
              const taskType = detectCategory(task.agent || "general", task.description);
              recordTrustSuccess(supabase, user.id, taskType).catch(() => {});
            }
            // P2 ladder: "just do it" phrases are a one-shot L2 override (never persist);
            // rule/trust auto-approve counts as an earned clean run.
            recordLadderOutcomes(user.id, executeTasks, { success: true, oneShot: autoApprove });
          }
          return; // Done — exit retry loop

        } catch (err) {
          lastError = err;
          // Extract partial result from error if available
          if (!partialResult && err instanceof Error) {
            partialResult = err.message;
          }
          emit({ type: "task.retry", level: "warn", requestId, userId: user.id, data: { message: `Strategy ${strategy} failed: ${err instanceof Error ? err.message : String(err)}`, strategy } });

          // Record failure (no winning_strategy on fail)
          if (strategy === startStrategy) {
            const durationMs = Date.now() - startTime;
            await recordExecution(supabase, text, plan, false, durationMs, user.id);
          }
          // Continue to next strategy
        }
      }

      // All strategies exhausted without success (shouldn't reach here — strategy 5 returns early)
      if (supabase && parentTaskId) {
        supabase.updateTask(parentTaskId, {
          status: "blocked",
          result: `All retry strategies failed. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
        });
      }
      // P2 ladder: a real (non-override) execution failure demotes to L0.
      if (supabase && !autoApprove) {
        recordLadderOutcomes(user.id, plan.subtasks.filter((s) => s.phase === "execute"), { success: false });
      }
      return;
    }

    // === TWO-PHASE EXECUTION WITH APPROVAL GATE ===

    // Send progress checklist message
    const checklistMsg = await sendProgressChecklist(ctx as any, plan);

    // Build debounced progress callback for live checklist updates
    const subtaskStatuses = new Map<number, "pending" | "started" | "completed" | "failed" | "healing">();
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
          if ("api" in ctx) {
            await ctx.api.editMessageText(ctx.chat!.id, checklistMsg.message_id, text);
          } else {
            // Web: update via event bus
            emit({ type: "chat.update", level: "info", data: { messageId: checklistMsg.message_id, text, requestId } });
          }
        }
      } catch {}
    };

    const onProgress: ProgressCallback = (index, status) => {
      subtaskStatuses.set(index, status);
      updateChecklist();
    };

    // Phase 1: Run prepare subtasks
    console.log("[orchestrator] Phase 1: Running prepare subtasks");
    const prepareResults = await executePhase(plan, "prepare", user, supabase, parentTaskId, undefined, undefined, onProgress, workspaceDir);
    const artifacts = await enrichArtifactsWithVision(collectArtifacts(prepareResults));

    // Final checklist update with completion timestamp
    try {
      if (checklistMsg) {
        await updateChecklist();
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const finalText = buildChecklistText(plan, subtaskStatuses) + `\n\nDone (${elapsed}s)`;
        if ("api" in ctx) {
          await ctx.api.editMessageText(ctx.chat!.id, checklistMsg.message_id, finalText).catch(() => {});
        } else {
          emit({ type: "chat.update", level: "info", data: { messageId: checklistMsg.message_id, text: finalText, requestId } });
        }
      }
    } catch {}

    console.log(`[orchestrator] Prepare phase done: ${prepareResults.length} results, ${artifacts.length} artifacts`);

    // === P2 AUTONOMY LADDER — earned autonomy bypasses the gate ===
    const ladderExecuteTasks = plan.subtasks.filter((s) => s.phase === "execute");
    const ladderGate = supabase ? resolveExecuteGate(user.id, ladderExecuteTasks) : { mode: "ask" as GateMode };

    if (ladderGate.mode === "auto" || ladderGate.mode === "notify") {
      // Hard-block compliance still applies on the autopilot path (block ≠ friction).
      if (supabase) {
        const preparedContent = [...artifacts.map((a: any) => String(a?.value ?? "")), ...prepareResults.map((r: any) => String(r?.result ?? ""))].join("\n");
        const block = enforceBlockPolicies(supabase, user.id, preparedContent, { agents: ladderExecuteTasks.map((s) => s.agent || "general") });
        if (block.blocked) {
          recordLadderOutcomes(user.id, ladderExecuteTasks, { success: false, rejected: true });
          if (parentTaskId) supabase.updateTask(parentTaskId, { status: "blocked", result: `blocked by policy: ${block.reasons.join(", ")}` });
          await _sendResponseWithVoice(ctx as any, `🛡️ Execution blocked by a compliance policy (${block.reasons.join(", ")}). Nothing was sent or published.`, user.id);
          return;
        }
      }
      emit({ type: "approval.resolved", level: "info", requestId, userId: user.id, data: { message: `Autonomy ladder ${ladderGate.mode} — executing without gate`, action: `ladder-${ladderGate.mode}` } });

      const executeResults = await executePhase(plan, "execute", user, supabase, parentTaskId, artifacts, prepareResults, onProgress, workspaceDir);
      const allResults = [...prepareResults, ...executeResults];
      const allSucceeded = allResults.every((r) => r.success);

      const aggregated = await aggregate(text, allResults);
      const processed = await processMemoryIntents(supabase, aggregated, user.id, user.timezone, { agentSlug: "planner", sessionId: requestId });
      await _saveMessage("assistant", processed, user.id);

      if (chatId) {
        const fileCount = await deliverWorkspaceFiles(chatId, workspaceDir, parentTaskId, user.id, supabase);
        if (fileCount > 0) emit({ type: "task.completed", level: "info", requestId, userId: user.id, data: { message: `Delivered ${fileCount} file(s) from workspace`, fileCount } });
      }

      // L2 = ledger-only (no notification); L1 = notify after
      if (ladderGate.mode === "notify") await _sendResponseWithVoice(ctx as any, processed, user.id);

      if (supabase && parentTaskId) {
        supabase.updateTask(parentTaskId, {
          status: allSucceeded ? "completed" : "blocked",
          result: `${allResults.length} subtasks (autonomy ${ladderGate.mode})`,
        });
      }

      const durationMs = Date.now() - startTime;
      await recordExecution(supabase, text, plan, allSucceeded, durationMs, user.id);
      // Fire-and-forget reflective review (propose-don't-commit) — success path only.
      if (allSucceeded) reflectAndPropose({ db: supabase, userId: user.id, taskText: text, plan, callLLM: _callClaude }).catch(() => {});
      recordLadderOutcomes(user.id, ladderExecuteTasks, { success: allSucceeded });
      return;
    }

    // Build approval summary using Haiku
    const approvalSummary = await buildApprovalSummary(text, prepareResults, artifacts, plan);

    // Generate approval ID and store pending approval
    const approvalId = `apv-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

    const taskChatId = chatId || 0;

    pendingApprovals.set(approvalId, {
      id: approvalId,
      ctx,
      chatId: taskChatId,
      user,
      supabase,
      originalText: text,
      plan,
      prepareResults,
      artifacts,
      parentTaskId,
      startTime,
      workspaceDir,
      workflowType: workflowType || "generic",
      requestId,
    });

    console.log(`[orchestrator] Approval created: ${approvalId} | request="${text.substring(0, 60)}" | requestId=${requestId} | total pending: ${pendingApprovals.size}`);

    // Persist to DB — includes prepareResults for potential restart recovery
    if (supabase) {
      const execDescs = plan.subtasks
        .filter((s) => s.phase === "execute")
        .map((s) => s.description);
      try {
        supabase.insertApproval({
          id: approvalId,
          user_id: user.id,
          chat_id: taskChatId,
          original_text: text.substring(0, 2000),
          plan: JSON.stringify(plan),
          prepare_summary: approvalSummary.substring(0, 5000),
          prepare_results: prepareResults,
          artifacts: artifacts.map((a) => ({ type: a.type, value: a.value, source: a.source })),
          execute_descriptions: execDescs,
          parent_task_id: parentTaskId || null,
          workspace_dir: workspaceDir || null,
          workflow_type: workflowType || "generic",
          request_id: requestId || null,
          status: "pending",
        });
      } catch (e) {
        console.error("[orchestrator] Failed to persist approval:", e);
      }
    }

    // Note: approvals do NOT expire — they remain pending until the user acts on them.

    // Send the summary with approval buttons (embedded approval ID in callback data)
    const executeDescriptions = plan.subtasks
      .filter((s) => s.phase === "execute")
      .map((s) => `• ${s.description}`)
      .join("\n");

    const requestLabel = text.length > 80 ? `${text.substring(0, 80)}...` : text;

    // Simple cost estimate based on subtask count
    const subtaskCount = plan.subtasks?.length ?? 0;
    let estimatedCost: string;
    if (subtaskCount <= 1) estimatedCost = "~$0.01";
    else if (subtaskCount <= 3) estimatedCost = `~$${(subtaskCount * 0.01).toFixed(2)}`;
    else estimatedCost = "~$0.05+";
    const costLine = `\n\n⏱ Estimated cost: ${estimatedCost}`;
    const capLine = ladderGate.spentContext ? `\n\n⚠️ ${ladderGate.spentContext} Approval required.` : "";

    const approvalMessage = `📋 **Task:** ${requestLabel}\n\n${approvalSummary}\n\n**Pending actions:**\n${executeDescriptions}${costLine}${capLine}`;

    await _saveMessage("assistant", approvalSummary, user.id);
    await _sendResponseWithVoice(ctx as any,approvalMessage, user.id);

    // Send approval buttons with embedded approval ID directly
    const keyboard = new InlineKeyboard()
      .text("Approve & Execute", `apv:${approvalId}:approve`)
      .text("Revise", `apv:${approvalId}:revise`)
      .text("Cancel", `apv:${approvalId}:cancel`);

    await ctx.reply("Tap below to proceed:", { reply_markup: keyboard });

    // Update parent task to waiting
    if (supabase && parentTaskId) {
      supabase.updateTask(parentTaskId, {
        status: "blocked",
        result: "Waiting for user approval",
      });
    }
  } catch (error) {
    console.error("[orchestrator] Complex route error:", error);

    // Mark parent task as blocked so it doesn't stay stuck as in_progress
    if (supabase && parentTaskId) {
      try {
        supabase.updateTask(parentTaskId, {
          status: "blocked",
          result: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        });
      } catch {}
    }

    console.log("[orchestrator] Falling back to simple path");
    routeSimple(ctx, text, user, supabase, sessionKey);
  }
}

// ============================================================
// APPROVAL RECOVERY — reload pending approvals after bot restart
// ============================================================

/**
 * On startup, reload any pending approvals from Supabase that were never acted on.
 * This handles the case where the bot restarted while the user had approval requests open.
 * For each recovered approval, the old Telegram buttons remain valid because the approval ID
 * is embedded in the button callback data — we just need to restore the in-memory state.
 * If prepareResults are available (stored since this fix), the execute phase can run normally.
 * For older records without prepareResults, we send a fresh prompt to the chat.
 */
export async function recoverPendingApprovals(
  supabase: Database | null,
  userId: string,
): Promise<void> {
  if (!supabase) return;

  try {
    // Cancel any approvals that have passed their 24h TTL
    const expired = supabase.cancelExpiredApprovals(userId);
    for (const row of expired) {
      console.log(`[orchestrator] Expired approval ${row.id} for user ${userId}`);
    }

    const data = supabase.getPendingApprovals(userId);

    if (!data?.length) return;

    console.log(`[orchestrator] Recovering ${data.length} pending approval(s) from Supabase`);

    // Load full user object once for all approvals (name, timezone, etc.)
    const user = await loadFullUser(supabase, userId);

    for (const row of data) {
      if (pendingApprovals.has(row.id)) continue; // already in memory

      const chatId = row.chat_id || 0;
      const prepareResults: SubtaskResult[] = Array.isArray(row.prepare_results) ? row.prepare_results : [];
      const artifacts: Artifact[] = Array.isArray(row.artifacts) ? row.artifacts.map((a: any) => ({
        type: a.type || "file",
        value: a.value || "",
        source: a.source ?? 0,
      })) : [];

      // Build a minimal fake ctx that routes send/reply to the actual chat
      const fakeCtx = {
        chat: { id: chatId },
        reply: async (text: string, opts?: any) => {
          await _sendMessageToChat(chatId, text, opts?.reply_markup);
        },
        replyWithChatAction: async () => {},
        editMessageText: async () => {},
        answerCallbackQuery: async () => {},
      } as unknown as Context;

      pendingApprovals.set(row.id, {
        id: row.id,
        ctx: fakeCtx,
        chatId,
        user,
        supabase,
        originalText: row.original_text || "",
        plan: row.plan || { subtasks: [] },
        prepareResults,
        artifacts,
        parentTaskId: row.parent_task_id || undefined,
        startTime: new Date(row.created_at).getTime(),
        workspaceDir: row.workspace_dir || undefined,
        workflowType: (row.workflow_type as any) || "generic",
        requestId: row.request_id || undefined,
      });

      // Notify the user that this approval survived the restart and is still actionable
      const requestLabel = (row.original_text || "").substring(0, 80);
      const execList = Array.isArray(row.execute_descriptions)
        ? row.execute_descriptions.map((d: string) => `• ${d}`).join("\n")
        : "";

      const keyboard = new InlineKeyboard()
        .text("Approve & Execute", `apv:${row.id}:approve`)
        .text("Revise", `apv:${row.id}:revise`)
        .text("Cancel", `apv:${row.id}:cancel`);

      const recoveryMsg = `🔄 **Recovered approval** (from before restart)\n📋 **Task:** ${requestLabel}\n\n${row.prepare_summary || "Prepare phase results are ready."}\n\n**Pending actions:**\n${execList}`;

      await _sendMessageToChat(chatId, recoveryMsg, keyboard);
      console.log(`[orchestrator] Recovered approval ${row.id} — notified chat ${chatId}`);
    }
  } catch (err) {
    console.error("[orchestrator] Failed to recover pending approvals:", err);
  }
}

// ============================================================
// PROGRESS CHECKLIST — edit-in-place with emoji status
// ============================================================

function buildChecklistText(
  plan: ExecutionPlan,
  statuses: Map<number, "pending" | "started" | "completed" | "failed" | "healing">
): string {
  const lines = plan.subtasks.map((s, i) => {
    const status = statuses.get(i) || "pending";
    const emoji =
      status === "completed" ? "✅" :
      status === "failed" ? "❌" :
      status === "healing" ? "🩹" :
      status === "started" ? "⏳" :
      "▪️";
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
    const statuses = new Map<number, "pending" | "started" | "completed" | "failed" | "healing">();
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

  return _callClaude(prompt, "haiku" as any, undefined, "approval-summary");
}
