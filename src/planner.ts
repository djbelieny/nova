/**
 * Task Decomposer & Executor
 *
 * Handles complex tasks by decomposing them into subtasks,
 * executing independent groups in parallel, and aggregating results.
 *
 * Model strategy:
 * - Haiku for decomposition (structured output, cheap)
 * - Sonnet for subtask execution (quality matters)
 * - Haiku for aggregation (formatting, not reasoning)
 *
 * Agent routing:
 * - Decomposer sees the full agent catalog and picks specialists
 * - Each subtask gets the specialist's full system prompt injected
 * - Falls back to generic prompt if no specialist matches
 *
 * Phase execution:
 * - "prepare" subtasks run first (research, create content, generate images)
 * - "execute" subtasks run after approval (create campaigns, send emails, publish)
 * - Artifacts (file paths, copy, audiences) flow from prepare → execute
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExecutionPlan } from "./patterns.ts";
import { getAgentCatalog, buildAgentPrompt } from "./agent-router.ts";

type ModelTier = "sonnet" | "sonnet" | "opus";

let _callClaude: (prompt: string, model?: ModelTier, userId?: string, hint?: string) => Promise<string>;
let _buildPrompt: (...args: any[]) => string;

export function initPlanner(
  callClaude: (prompt: string, model?: ModelTier, userId?: string, hint?: string) => Promise<string>,
  buildPrompt: (...args: any[]) => string
): void {
  _callClaude = callClaude;
  _buildPrompt = buildPrompt;
}

export interface Artifact {
  type: string;   // "image", "copy", "audience", "url", "file", etc.
  value: string;  // file path, text content, or URL
  source: number; // subtask index that produced it
}

export interface SubtaskResult {
  index: number;
  description: string;
  agent?: string;
  result: string;
  success: boolean;
  artifacts: Artifact[];
}

export type ProgressCallback = (index: number, status: "started" | "completed" | "failed") => void;

/**
 * Parse [ARTIFACT: type | value] tags from agent output.
 */
export function extractArtifacts(text: string, sourceIndex: number): Artifact[] {
  const artifacts: Artifact[] = [];
  const pattern = /\[ARTIFACT:\s*(\w+)\s*\|\s*(.+?)\]/g;
  for (const match of text.matchAll(pattern)) {
    artifacts.push({
      type: match[1].toLowerCase(),
      value: match[2].trim(),
      source: sourceIndex,
    });
  }
  return artifacts;
}

/**
 * Collect all artifacts from a set of subtask results.
 */
export function collectArtifacts(results: SubtaskResult[]): Artifact[] {
  return results.flatMap((r) => r.artifacts);
}

/**
 * Decompose a complex task into ordered subtasks with dependencies and phases.
 * Uses Haiku — this is structured output, not creative work.
 * Includes the agent catalog so Haiku routes to the right specialist.
 */
export async function decompose(
  text: string,
  user: { name: string; timezone: string }
): Promise<ExecutionPlan> {
  const catalog = getAgentCatalog();

  const prompt = `You are a task decomposition engine. Break the following complex request into 2-5 subtasks.

Return ONLY valid JSON in this exact format (no markdown, no explanation):
{"subtasks":[{"description":"...","agent":"agent_slug","dependsOn":[],"phase":"prepare"}]}

${catalog || 'Agent types: "general" (default)'}

Rules:
- dependsOn is an array of 0-indexed subtask positions that must complete first.
- If subtasks are independent, use empty dependsOn arrays so they run in parallel.
- Match each subtask to the BEST specialist agent based on the task description.
- Use "general" only if no specialist clearly fits.
- Keep descriptions specific and actionable — the agent needs to know exactly what to do.

Each subtask MUST have a "phase" field:
- "prepare": research, create content, generate images, write copy, analyze, design — safe, reversible work
- "execute": create campaigns via API, send emails, publish posts, make calls, spend money — consequential, hard to reverse

Rule: Any subtask that calls an external API to CREATE, SEND, PUBLISH, or SPEND must be "execute".
If unsure, default to "prepare" — it's safer to ask for approval than to act without it.

User: ${user.name}
Request: ${text}`;

  const raw = await _callClaude(prompt, "sonnet");

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found");

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed.subtasks) || parsed.subtasks.length === 0) {
      throw new Error("Invalid plan structure");
    }

    const plan: ExecutionPlan = {
      subtasks: parsed.subtasks.map((s: any) => ({
        description: String(s.description || ""),
        agent: String(s.agent || "general"),
        dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : [],
        phase: s.phase === "execute" ? "execute" : "prepare",
      })),
    };

    // Log the routing decisions
    for (const st of plan.subtasks) {
      console.log(`[planner] → ${st.agent} [${st.phase}]: ${st.description.substring(0, 60)}`);
    }

    return plan;
  } catch (error) {
    console.error("Decomposition parse error:", error);
    return { subtasks: [{ description: text, agent: "general", phase: "prepare" }] };
  }
}

/**
 * Execute subtasks for a specific phase, respecting dependencies.
 * Each subtask gets its specialist agent's system prompt injected.
 * Prepare-phase agents are instructed to output [ARTIFACT:] tags.
 */
export async function executePhase(
  plan: ExecutionPlan,
  phase: "prepare" | "execute",
  user: any,
  supabase: SupabaseClient | null,
  parentTaskId?: string,
  priorArtifacts?: Artifact[],
  priorResults?: SubtaskResult[],
  onProgress?: ProgressCallback
): Promise<SubtaskResult[]> {
  const results: SubtaskResult[] = [...(priorResults || [])];
  const completed = new Set<number>(results.map((r) => r.index));

  // Only execute subtasks matching the requested phase
  const phaseIndices = new Set<number>();
  for (let i = 0; i < plan.subtasks.length; i++) {
    const subtaskPhase = plan.subtasks[i].phase || "prepare";
    if (subtaskPhase === phase) phaseIndices.add(i);
  }

  // Log subtasks to agent_tasks table
  const subtaskIds: (string | null)[] = [];
  for (let i = 0; i < plan.subtasks.length; i++) {
    if (!phaseIndices.has(i)) {
      subtaskIds.push(null);
      continue;
    }
    const subtask = plan.subtasks[i];
    if (supabase) {
      const { data } = await supabase
        .from("agent_tasks")
        .insert({
          agent: subtask.agent || "general",
          description: subtask.description,
          status: "pending",
          user_id: user.id,
          parent_task_id: parentTaskId || null,
        })
        .select("id")
        .single();
      subtaskIds.push(data?.id || null);
    } else {
      subtaskIds.push(null);
    }
  }

  // Build artifact context string for execute-phase subtasks
  const artifactContext = priorArtifacts?.length
    ? "\n\nArtifacts from prepare phase:\n" +
      priorArtifacts.map((a) => `- [${a.type}]: ${a.value}`).join("\n")
    : "";

  // Execute in dependency order
  const allIndices = [...phaseIndices];
  while (completed.size < plan.subtasks.length && allIndices.some((i) => !completed.has(i))) {
    const ready: number[] = [];
    for (const i of allIndices) {
      if (completed.has(i)) continue;
      const deps = plan.subtasks[i].dependsOn || [];
      if (deps.every((d) => completed.has(d))) {
        ready.push(i);
      }
    }

    if (ready.length === 0) {
      // Check if remaining subtasks are all from other phase (not a circular dep)
      const remaining = allIndices.filter((i) => !completed.has(i));
      if (remaining.length > 0) {
        console.error("Circular dependency detected in subtasks");
      }
      break;
    }

    // Execute ready subtasks in parallel
    const batchResults = await Promise.all(
      ready.map(async (idx) => {
        const subtask = plan.subtasks[idx];
        const agentSlug = subtask.agent || "general";

        if (supabase && subtaskIds[idx]) {
          await supabase
            .from("agent_tasks")
            .update({ status: "in_progress", updated_at: new Date().toISOString() })
            .eq("id", subtaskIds[idx]);
        }

        // Build context from completed dependency results
        const depContext = (subtask.dependsOn || [])
          .map((d) => {
            const depResult = results.find((r) => r.index === d);
            return depResult
              ? `[Result from "${depResult.description}"]: ${depResult.result}`
              : "";
          })
          .filter(Boolean)
          .join("\n\n");

        // Add artifact context for execute-phase subtasks
        const fullDepContext = phase === "execute"
          ? (depContext ? depContext + artifactContext : artifactContext)
          : depContext;

        // Build the prompt — specialist agent or generic
        const basePrompt = _buildPrompt(
          user,
          `${fullDepContext ? `Context from prior steps:\n${fullDepContext}\n\n` : ""}Task: ${subtask.description}`,
        );

        const prompt = buildAgentPrompt(
          agentSlug,
          subtask.description,
          basePrompt,
          fullDepContext || undefined,
          phase
        );

        console.log(`[planner] Executing subtask ${idx} via ${agentSlug} [${phase}]: ${subtask.description.substring(0, 50)}`);
        onProgress?.(idx, "started");

        try {
          const routingHint = `${agentSlug} ${subtask.description}`;
          const result = await _callClaude(prompt, undefined, user?.id, routingHint);

          // Extract artifacts from the result
          const artifacts = extractArtifacts(result, idx);

          if (supabase && subtaskIds[idx]) {
            await supabase
              .from("agent_tasks")
              .update({
                status: "completed",
                result: result.substring(0, 500),
                updated_at: new Date().toISOString(),
              })
              .eq("id", subtaskIds[idx]);
          }

          onProgress?.(idx, "completed");

          return {
            index: idx,
            description: subtask.description,
            agent: subtask.agent,
            result,
            success: true,
            artifacts,
          };
        } catch (error) {
          console.error(`Subtask ${idx} (${agentSlug}) error:`, error);

          if (supabase && subtaskIds[idx]) {
            await supabase
              .from("agent_tasks")
              .update({
                status: "blocked",
                result: String(error),
                updated_at: new Date().toISOString(),
              })
              .eq("id", subtaskIds[idx]);
          }

          onProgress?.(idx, "failed");

          return {
            index: idx,
            description: subtask.description,
            agent: subtask.agent,
            result: `Error: ${error}`,
            success: false,
            artifacts: [],
          };
        }
      })
    );

    for (const r of batchResults) {
      results.push(r);
      completed.add(r.index);
    }
  }

  // Return only the results from this phase
  return results.filter((r) => phaseIndices.has(r.index));
}

/**
 * Execute all subtasks (legacy — runs both phases without approval gate).
 * Kept for backward compatibility with auto-approve flow.
 */
export async function executeSubtasks(
  plan: ExecutionPlan,
  user: any,
  supabase: SupabaseClient | null,
  parentTaskId?: string,
  onProgress?: ProgressCallback
): Promise<SubtaskResult[]> {
  const prepareResults = await executePhase(plan, "prepare", user, supabase, parentTaskId, undefined, undefined, onProgress);
  const artifacts = collectArtifacts(prepareResults);

  const hasExecute = plan.subtasks.some((s) => s.phase === "execute");
  if (!hasExecute) return prepareResults;

  const executeResults = await executePhase(
    plan, "execute", user, supabase, parentTaskId, artifacts, prepareResults, onProgress
  );

  return [...prepareResults, ...executeResults];
}

/**
 * Aggregate subtask results into a coherent final response.
 * Uses Haiku — this is formatting/synthesis, not heavy reasoning.
 * Mentions which agents contributed so the user knows who did what.
 */
export async function aggregate(
  originalRequest: string,
  results: SubtaskResult[]
): Promise<string> {
  if (results.length === 1) return results[0].result;

  const resultSummary = results
    .sort((a, b) => a.index - b.index)
    .map((r) => `## [${r.agent || "general"}] ${r.description}\n${r.result}`)
    .join("\n\n---\n\n");

  const prompt = `You are synthesizing results from specialist agents into one coherent response for a Telegram user.

Original request: ${originalRequest}

Agent results:
${resultSummary}

Instructions:
- Combine into a single, well-organized response.
- Remove redundancy between agent outputs.
- Keep it concise and actionable.
- Do NOT mention "agents" or "subtasks" — present it as one unified answer.
- Preserve any actionable items, numbers, and specific recommendations.
- Use Telegram-friendly formatting (bold for headers, bullet points for lists).`;

  return _callClaude(prompt, "sonnet");
}
