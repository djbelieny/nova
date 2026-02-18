/**
 * Task Orchestrator
 *
 * Classifies incoming messages and routes them:
 * - Simple messages → existing callClaude() path (no extra latency)
 * - Complex messages → planner decomposition → parallel execution → aggregation
 * - Cached patterns → reuse known-good plans (skip classification)
 */

import type { Context } from "grammy";
import type { SupabaseClient } from "@supabase/supabase-js";
import { findPattern, recordExecution } from "./patterns.ts";
import { initPlanner, decompose, executeSubtasks, aggregate } from "./planner.ts";
import {
  processMemoryIntents,
  getMemoryContext,
  getRelevantContext,
  getRecentHistory,
  getTaskContext,
} from "./memory.ts";

// Injected dependencies from relay.ts
let _callClaude: (prompt: string) => Promise<string>;
let _buildPrompt: (...args: any[]) => string;
let _runTask: (
  ctx: Context,
  desc: string,
  buildTask: () => Promise<{ prompt: string }>,
  opts?: { postProcess?: (r: string) => Promise<string>; userId?: string }
) => void;
let _saveMessage: (role: string, content: string, userId: string) => Promise<void>;
let _sendResponseWithVoice: (ctx: Context, response: string, userId?: string) => Promise<void>;

export function initOrchestrator(deps: {
  callClaude: (prompt: string) => Promise<string>;
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
    // e.g., "research X and write a summary" is complex
    // e.g., "what's the weather" is simple
    if (!hasActionVerb || !hasConjunction) return true;
  }

  return false;
}

// ============================================================
// CLASSIFY — cheap Claude call for ambiguous messages (~200 tokens)
// ============================================================

async function classify(
  text: string
): Promise<{ type: "simple" | "complex" }> {
  const prompt = `Classify this message as "simple" or "complex".

Simple: greetings, questions, single requests, short commands, casual conversation.
Complex: multi-step tasks, requests involving research + writing + analysis, tasks with multiple deliverables.

Message: "${text.substring(0, 300)}"

Return ONLY one word: simple or complex`;

  const result = await _callClaude(prompt);
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
      // Return empty prompt — we already handled it
      return { prompt: "__ORCHESTRATOR_HANDLED__" };
    }

    // Classify via cheap Claude call
    const classification = await classify(text);
    console.log(`[orchestrator] Classified as: ${classification.type}`);

    if (classification.type === "simple") {
      // Build the normal prompt inline
      const [relevantContext, memoryContext, recentHistory, taskContext] = await Promise.all([
        getRelevantContext(supabase, text, user.id),
        getMemoryContext(supabase, user.id),
        getRecentHistory(supabase, user.id),
        getTaskContext(supabase, user.id),
      ]);
      return {
        prompt: _buildPrompt(user, text, relevantContext, memoryContext, recentHistory, taskContext),
      };
    }

    // Complex — decompose and execute
    await routeComplex(ctx, text, user, supabase);
    return { prompt: "__ORCHESTRATOR_HANDLED__" };
  }, {
    postProcess: async (raw) => {
      // If orchestrator handled it internally, skip normal post-processing
      if (raw === "__ORCHESTRATOR_HANDLED__") return "__SKIP__";
      return processMemoryIntents(supabase, raw, user.id);
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
    const [relevantContext, memoryContext, recentHistory, taskContext] = await Promise.all([
      getRelevantContext(supabase, text, user.id),
      getMemoryContext(supabase, user.id),
      getRecentHistory(supabase, user.id),
      getTaskContext(supabase, user.id),
    ]);
    return {
      prompt: _buildPrompt(user, text, relevantContext, memoryContext, recentHistory, taskContext),
    };
  }, {
    postProcess: (raw) => processMemoryIntents(supabase, raw, user.id),
  });
}

// ============================================================
// COMPLEX PATH — decompose → parallel execute → aggregate
// ============================================================

async function routeComplex(
  ctx: Context,
  text: string,
  user: any,
  supabase: SupabaseClient | null,
  cachedPlan?: { subtasks: { description: string; agent?: string; dependsOn?: number[] }[] }
): Promise<void> {
  const startTime = Date.now();

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

    // Decompose or use cached plan
    const plan = cachedPlan || (await decompose(text, user));
    console.log(`[orchestrator] Plan: ${plan.subtasks.length} subtasks`);

    // Execute subtasks
    const results = await executeSubtasks(plan, user, supabase, parentTaskId);
    const allSucceeded = results.every((r) => r.success);

    // Aggregate results
    const aggregated = await aggregate(text, results);

    // Process memory intents and send response
    const processed = await processMemoryIntents(supabase, aggregated, user.id);
    await _saveMessage("assistant", processed, user.id);
    await _sendResponseWithVoice(ctx, processed, user.id);

    // Mark parent task done
    if (supabase && parentTaskId) {
      await supabase
        .from("agent_tasks")
        .update({
          status: allSucceeded ? "done" : "blocked",
          result: `${results.length} subtasks, ${results.filter((r) => r.success).length} succeeded`,
          updated_at: new Date().toISOString(),
        })
        .eq("id", parentTaskId);
    }

    // Record pattern for learning
    const durationMs = Date.now() - startTime;
    await recordExecution(supabase, text, plan, allSucceeded, durationMs, user.id);
  } catch (error) {
    console.error("[orchestrator] Complex route error:", error);
    // Fallback to simple path
    console.log("[orchestrator] Falling back to simple path");
    routeSimple(ctx, text, user, supabase);
  }
}
