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
import { mkdir, readdir, rm } from "fs/promises";
import { join } from "path";
import type { ExecutionPlan } from "./patterns.ts";
import { findPattern, recordExecution } from "./patterns.ts";
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
let _callClaude: (prompt: string, model?: ModelTier, userId?: string, hint?: string) => Promise<string>;
let _buildPrompt: (...args: any[]) => string;
let _runTask: (
  ctx: Context,
  desc: string,
  buildTask: () => Promise<{ prompt: string; model?: ModelTier; hint?: string }>,
  opts?: { postProcess?: (r: string) => Promise<string>; userId?: string },
) => void;
let _saveMessage: (role: string, content: string, userId: string) => Promise<void>;
let _sendResponseWithVoice: (ctx: Context, response: string, userId?: string) => Promise<void>;
let _sendTelegramFile: (chatId: number | string, filePath: string, caption?: string) => Promise<void>;
let _relayDir: string;

export function initOrchestrator(deps: {
  callClaude: (prompt: string, model?: ModelTier, userId?: string, hint?: string) => Promise<string>;
  buildPrompt: (...args: any[]) => string;
  runTask: typeof _runTask;
  saveMessage: (role: string, content: string, userId: string) => Promise<void>;
  sendResponseWithVoice: (ctx: Context, response: string, userId?: string) => Promise<void>;
  sendTelegramFile: (chatId: number | string, filePath: string, caption?: string) => Promise<void>;
  relayDir: string;
}): void {
  _callClaude = deps.callClaude;
  _buildPrompt = deps.buildPrompt;
  _runTask = deps.runTask;
  _saveMessage = deps.saveMessage;
  _sendResponseWithVoice = deps.sendResponseWithVoice;
  _sendTelegramFile = deps.sendTelegramFile;
  _relayDir = deps.relayDir;

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
  workspaceDir?: string;
  workflowType?: "social-media" | "generic";
}

const pendingApprovals = new Map<string, PendingApproval>();

// ============================================================
// REVISION SESSIONS — tracks pending revision context per user
// ============================================================

interface RevisionSession {
  userId: string;
  originalText: string;
  plan: ExecutionPlan;
  prepareResults: SubtaskResult[];
  artifacts: Artifact[];
  parentTaskId?: string;
  workspaceDir?: string;
  workflowType: "social-media" | "generic";
  createdAt: number;
}

const revisionSessions = new Map<string, RevisionSession>(); // keyed by userId

/**
 * Check if a user has an active revision session.
 * Auto-expires after 10 minutes.
 */
export function getRevisionSession(userId: string): RevisionSession | null {
  const session = revisionSessions.get(userId);
  if (!session) return null;
  // Expire after 10 minutes
  if (Date.now() - session.createdAt > 10 * 60 * 1000) {
    revisionSessions.delete(userId);
    return null;
  }
  return session;
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
  supabase: SupabaseClient | null,
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
    await supabase.from("workflow_preferences").upsert(
      {
        user_id: userId,
        workflow_type: workflowType,
        task_signature: sig,
        plan,
        success_count: 1,
        last_used_at: new Date().toISOString(),
      },
      { onConflict: "user_id,task_signature" }
    ).then(({ error }) => {
      if (error) {
        // Table may not exist yet — not critical
        if (!error.message.includes("does not exist")) {
          console.error("[orchestrator] Failed to save workflow preference:", error.message);
        }
      } else {
        console.log(`[orchestrator] Saved workflow preference: ${sig}`);
      }
    });

    // If it already exists, increment success_count
    await supabase.rpc("increment_workflow_preference", { p_user_id: userId, p_sig: sig }).catch(() => {});
  } catch {}
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
    // Store revision context so the next message resumes the workflow
    revisionSessions.set(pending.user.id, {
      userId: pending.user.id,
      originalText: pending.originalText,
      plan: pending.plan,
      prepareResults: pending.prepareResults,
      artifacts: pending.artifacts,
      parentTaskId: pending.parentTaskId,
      workspaceDir: pending.workspaceDir,
      workflowType: pending.workflowType || "generic",
      createdAt: Date.now(),
    });
    pendingApprovals.delete(approvalId);

    if (pending.workflowType === "social-media") {
      await _sendResponseWithVoice(
        ctx,
        "Send me your revision. I'll figure out which steps to redo:\n• Copy/caption changes → skip research\n• Image changes only → skip research + copywriting\n• General feedback → full redo",
        pending.user.id
      );
    } else {
      await _sendResponseWithVoice(ctx, "Send me your revision and I'll redo the prepare phase.", pending.user.id);
    }
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
      pending.prepareResults,
      undefined,
      pending.workspaceDir
    );

    const allResults = [...pending.prepareResults, ...executeResults];
    const allSucceeded = allResults.every((r) => r.success);

    // Aggregate
    const aggregated = await aggregate(pending.originalText, allResults);
    const processed = await processMemoryIntents(pending.supabase, aggregated, pending.user.id, pending.user.timezone);
    await _saveMessage("assistant", processed, pending.user.id);

    // Deliver workspace files before text response
    const approvalChatId = ctx.chat?.id;
    if (approvalChatId && pending.workspaceDir) {
      const fileCount = await deliverWorkspaceFiles(approvalChatId, pending.workspaceDir);
      if (fileCount > 0) {
        console.log(`[orchestrator] Delivered ${fileCount} file(s) from workspace (post-approval)`);
      }
    }
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

    // Record pattern and save workflow preference
    const durationMs = Date.now() - pending.startTime;
    await recordExecution(pending.supabase, pending.originalText, pending.plan, allSucceeded, durationMs, pending.user.id);
    if (allSucceeded) {
      await saveWorkflowPreference(pending.supabase, pending.user.id, pending.workflowType || "generic", pending.originalText, pending.plan);
    }
  } catch (error) {
    console.error("[orchestrator] Execute phase error:", error);
    await _sendResponseWithVoice(ctx, "Something went wrong during the execute phase. The prepare work is still saved — try again.", pending.user.id);
  }
}

/**
 * Handle a revision by re-running the workflow from the appropriate step.
 * Uses stored context from the revision session to skip already-complete work.
 */
async function handleRevision(
  ctx: Context,
  feedback: string,
  user: any,
  supabase: SupabaseClient | null,
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

  pendingApprovals.set(approvalId, {
    id: approvalId,
    ctx,
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
  });

  // Persist to Supabase
  if (supabase) {
    const chatId = ctx.chat?.id || 0;
    const execDescs = plan.subtasks
      .filter((s) => s.phase === "execute")
      .map((s) => s.description);
    await supabase.from("pending_approvals").insert({
      id: approvalId,
      user_id: user.id,
      chat_id: chatId,
      original_text: session.originalText.substring(0, 2000),
      plan: plan,
      prepare_summary: approvalSummary.substring(0, 5000),
      artifacts: allArtifacts.map((a) => ({ type: a.type, value: a.value, source: a.source })),
      execute_descriptions: execDescs,
      parent_task_id: session.parentTaskId || null,
      status: "pending",
    }).then(({ error }) => {
      if (error) console.error("[orchestrator] Failed to persist revision approval:", error.message);
    });
  }

  // Auto-expire after 30 minutes
  setTimeout(() => {
    if (pendingApprovals.has(approvalId)) {
      pendingApprovals.delete(approvalId);
      if (supabase) {
        supabase.from("pending_approvals")
          .update({ status: "expired", updated_at: new Date().toISOString() })
          .eq("id", approvalId)
          .eq("status", "pending")
          .then(() => {});
      }
    }
  }, 30 * 60 * 1000);

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

function detectAutoApprove(text: string): boolean {
  // Only match if the phrase appears at the very start of the message
  // (after trimming whitespace) to prevent false positives from quoted/embedded text
  const lower = text.toLowerCase().trim();
  return AUTO_APPROVE_PHRASES.some((p) => lower.startsWith(p));
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

  const result = await _callClaude(prompt, "sonnet");
  const lower = result.toLowerCase().trim();

  if (lower.includes("complex")) return { type: "complex" };
  if (lower.includes("routed")) return { type: "routed", agent: singleAgent || undefined };
  return { type: "simple" };
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
  // Step 0: Check for active revision session — the user's message is feedback on prior work
  const revSession = getRevisionSession(user.id);
  if (revSession) {
    revisionSessions.delete(user.id);
    console.log(`[orchestrator] Revision session detected for ${user.name}: "${text.substring(0, 50)}"`);
    _runTask(ctx, `Revision: ${text.substring(0, 40)}`, async () => {
      await handleRevision(ctx, text, user, supabase, revSession);
      return { prompt: "__ORCHESTRATOR_HANDLED__" };
    }, {
      postProcess: async (raw) => raw === "__ORCHESTRATOR_HANDLED__" ? "__SKIP__" : processMemoryIntents(supabase, raw, user.id, user.timezone),
      userId: user.id,
    });
    return;
  }

  // Step 1: Fast heuristic — no Claude call needed
  if (isSimpleMessage(text)) {
    console.log(`[orchestrator] Simple path (heuristic): ${text.substring(0, 50)}`);
    routeSimple(ctx, text, user, supabase);
    return;
  }

  // Step 1.5: Detect social media workflow — hard-coded pipeline
  const socialReq = detectSocialMediaRequest(text);
  if (socialReq) {
    console.log(`[orchestrator] Social media workflow: "${socialReq.topic}" → ${socialReq.platforms.join(", ")}`);
    _runTask(ctx, text.substring(0, 50), async () => {
      const plan = buildSocialMediaPlan(socialReq.topic, socialReq.platforms);
      await routeComplex(ctx, text, user, supabase, plan, "social-media");
      return { prompt: "__ORCHESTRATOR_HANDLED__" };
    }, {
      postProcess: async (raw) => {
        if (raw === "__ORCHESTRATOR_HANDLED__") return "__SKIP__";
        return processMemoryIntents(supabase, raw, user.id, user.timezone);
      },
      userId: user.id,
    });
    return;
  }

  // Step 1.6: Detect other deterministic workflows
  const emailReq = detectEmailCampaignRequest(text);
  if (emailReq) {
    console.log(`[orchestrator] Email campaign workflow: "${emailReq.topic}"`);
    _runTask(ctx, text.substring(0, 50), async () => {
      const plan = buildEmailCampaignPlan(emailReq.topic, emailReq.audience);
      await routeComplex(ctx, text, user, supabase, plan, "generic");
      return { prompt: "__ORCHESTRATOR_HANDLED__" };
    }, {
      postProcess: async (raw) => raw === "__ORCHESTRATOR_HANDLED__" ? "__SKIP__" : processMemoryIntents(supabase, raw, user.id, user.timezone),
      userId: user.id,
    });
    return;
  }

  const blogReq = detectBlogPostRequest(text);
  if (blogReq) {
    console.log(`[orchestrator] Blog post workflow: "${blogReq.topic}"`);
    _runTask(ctx, text.substring(0, 50), async () => {
      const plan = buildBlogPostPlan(blogReq.topic);
      await routeComplex(ctx, text, user, supabase, plan, "generic");
      return { prompt: "__ORCHESTRATOR_HANDLED__" };
    }, {
      postProcess: async (raw) => raw === "__ORCHESTRATOR_HANDLED__" ? "__SKIP__" : processMemoryIntents(supabase, raw, user.id, user.timezone),
      userId: user.id,
    });
    return;
  }

  const presReq = detectPresentationRequest(text);
  if (presReq) {
    console.log(`[orchestrator] Presentation workflow: "${presReq.topic}"`);
    _runTask(ctx, text.substring(0, 50), async () => {
      const plan = buildPresentationPlan(presReq.topic);
      await routeComplex(ctx, text, user, supabase, plan, "generic");
      return { prompt: "__ORCHESTRATOR_HANDLED__" };
    }, {
      postProcess: async (raw) => raw === "__ORCHESTRATOR_HANDLED__" ? "__SKIP__" : processMemoryIntents(supabase, raw, user.id, user.timezone),
      userId: user.id,
    });
    return;
  }

  const adReq = detectAdCampaignRequest(text);
  if (adReq) {
    console.log(`[orchestrator] Ad campaign workflow: "${adReq.topic}" → ${adReq.platforms.join(", ")}`);
    _runTask(ctx, text.substring(0, 50), async () => {
      const plan = buildAdCampaignPlan(adReq.topic, adReq.platforms);
      await routeComplex(ctx, text, user, supabase, plan, "generic");
      return { prompt: "__ORCHESTRATOR_HANDLED__" };
    }, {
      postProcess: async (raw) => raw === "__ORCHESTRATOR_HANDLED__" ? "__SKIP__" : processMemoryIntents(supabase, raw, user.id, user.timezone),
      userId: user.id,
    });
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
        hint: text,
      };
    }

    if (classification.type === "routed" && classification.agent) {
      // Single-agent task — build a 1-subtask plan and route directly
      console.log(`[orchestrator] Routed to ${classification.agent}`);
      const singlePlan: ExecutionPlan = {
        subtasks: [{
          description: text,
          agent: classification.agent,
          dependsOn: [],
          phase: "prepare",
        }],
      };
      await routeComplex(ctx, text, user, supabase, singlePlan);
      return { prompt: "__ORCHESTRATOR_HANDLED__" };
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
      hint: text,
    };
  }, {
    postProcess: (raw) => processMemoryIntents(supabase, raw, user.id, user.timezone),
  });
}

// ============================================================
// WORKSPACE — shared directory for subtask file artifacts
// ============================================================

async function createWorkspace(userId: string, taskId?: string): Promise<string> {
  const id = taskId || crypto.randomUUID();
  const workspaceDir = join(_relayDir, "workspaces", userId, id);
  await mkdir(workspaceDir, { recursive: true });
  console.log(`[orchestrator] Workspace created: ${workspaceDir} (user=${userId})`);
  return workspaceDir;
}

/**
 * Scan workspace for files and send each to Telegram, then schedule cleanup.
 * Each workspace is scoped to user+task, so concurrent tasks never cross-deliver.
 */
async function deliverWorkspaceFiles(chatId: number | string, workspaceDir: string): Promise<number> {
  let delivered = 0;
  try {
    const entries = await readdir(workspaceDir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile());
    if (files.length === 0) return 0;

    console.log(`[orchestrator] Delivering ${files.length} file(s) from ${workspaceDir} → chat ${chatId}`);
    for (const entry of files) {
      const filePath = join(workspaceDir, entry.name);
      await _sendTelegramFile(chatId, filePath, entry.name);
      delivered++;
    }
  } catch (error) {
    console.error(`[orchestrator] Error scanning workspace ${workspaceDir}: ${error}`);
  }

  // Clean up workspace after 10 minutes
  setTimeout(() => {
    rm(workspaceDir, { recursive: true }).catch(() => {});
    console.log(`[orchestrator] Workspace cleaned: ${workspaceDir}`);
  }, 10 * 60 * 1000);

  return delivered;
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
  cachedPlan?: ExecutionPlan,
  workflowType?: "social-media" | "generic"
): Promise<void> {
  const startTime = Date.now();
  const autoApprove = detectAutoApprove(text);

  try {
    const chatId = ctx.chat?.id;

    // Create parent task first — we use its ID for the workspace directory
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

    // Create workspace scoped to user + task (isolates concurrent tasks)
    const workspaceDir = await createWorkspace(user.id, parentTaskId);

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

      const results = await executeSubtasks(plan, user, supabase, parentTaskId, autoOnProgress, workspaceDir);
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

      // Deliver workspace files before text response
      if (chatId) {
        const fileCount = await deliverWorkspaceFiles(chatId, workspaceDir);
        if (fileCount > 0) {
          console.log(`[orchestrator] Delivered ${fileCount} file(s) from workspace`);
        }
      }
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
    const prepareResults = await executePhase(plan, "prepare", user, supabase, parentTaskId, undefined, undefined, onProgress, workspaceDir);
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
      workspaceDir,
      workflowType: workflowType || "generic",
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

  return _callClaude(prompt, "sonnet");
}
