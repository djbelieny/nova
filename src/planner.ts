/**
 * Task Decomposer & Executor
 *
 * Handles complex tasks by decomposing them into subtasks,
 * executing independent groups in parallel, and aggregating results.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExecutionPlan } from "./patterns.ts";

// callClaude is injected from relay.ts to avoid circular imports
let _callClaude: (prompt: string) => Promise<string>;
let _buildPrompt: (...args: any[]) => string;

export function initPlanner(
  callClaude: (prompt: string) => Promise<string>,
  buildPrompt: (...args: any[]) => string
): void {
  _callClaude = callClaude;
  _buildPrompt = buildPrompt;
}

interface Subtask {
  description: string;
  agent?: string;
  dependsOn?: number[];
}

interface SubtaskResult {
  index: number;
  description: string;
  agent?: string;
  result: string;
  success: boolean;
}

/**
 * Decompose a complex task into ordered subtasks with dependencies.
 */
export async function decompose(
  text: string,
  user: { name: string; timezone: string }
): Promise<ExecutionPlan> {
  const prompt = `You are a task decomposition engine. Break the following complex request into 2-5 independent subtasks.

Return ONLY valid JSON in this exact format (no markdown, no explanation):
{"subtasks":[{"description":"...","agent":"general","dependsOn":[]}]}

Agent types: "research", "coding", "data", "content", "strategy", "general"
dependsOn is an array of 0-indexed subtask positions that must complete first.
If subtasks are independent, use empty dependsOn arrays so they run in parallel.

User: ${user.name}
Request: ${text}`;

  const raw = await _callClaude(prompt);

  try {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found");

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed.subtasks) || parsed.subtasks.length === 0) {
      throw new Error("Invalid plan structure");
    }

    return {
      subtasks: parsed.subtasks.map((s: any) => ({
        description: String(s.description || ""),
        agent: String(s.agent || "general"),
        dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : [],
      })),
    };
  } catch (error) {
    console.error("Decomposition parse error:", error);
    // Fallback: single subtask with the original text
    return { subtasks: [{ description: text, agent: "general" }] };
  }
}

/**
 * Execute subtasks respecting dependencies — independent tasks run in parallel.
 */
export async function executeSubtasks(
  plan: ExecutionPlan,
  user: any,
  supabase: SupabaseClient | null,
  parentTaskId?: string
): Promise<SubtaskResult[]> {
  const results: SubtaskResult[] = [];
  const completed = new Set<number>();

  // Log subtasks to agent_tasks table
  const subtaskIds: (string | null)[] = [];
  for (const subtask of plan.subtasks) {
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

  // Execute in dependency order
  while (completed.size < plan.subtasks.length) {
    // Find subtasks whose dependencies are all completed
    const ready: number[] = [];
    for (let i = 0; i < plan.subtasks.length; i++) {
      if (completed.has(i)) continue;
      const deps = plan.subtasks[i].dependsOn || [];
      if (deps.every((d) => completed.has(d))) {
        ready.push(i);
      }
    }

    if (ready.length === 0) {
      // Circular dependency — break out
      console.error("Circular dependency detected in subtasks");
      break;
    }

    // Execute ready subtasks in parallel
    const batchResults = await Promise.all(
      ready.map(async (idx) => {
        const subtask = plan.subtasks[idx];

        // Mark as in_progress
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

        const focusedPrompt = _buildPrompt(
          user,
          `${depContext ? `Context from prior steps:\n${depContext}\n\n` : ""}Task: ${subtask.description}`,
        );

        try {
          const result = await _callClaude(focusedPrompt);

          // Mark as done
          if (supabase && subtaskIds[idx]) {
            await supabase
              .from("agent_tasks")
              .update({
                status: "done",
                result: result.substring(0, 500),
                updated_at: new Date().toISOString(),
              })
              .eq("id", subtaskIds[idx]);
          }

          return {
            index: idx,
            description: subtask.description,
            agent: subtask.agent,
            result,
            success: true,
          };
        } catch (error) {
          console.error(`Subtask ${idx} error:`, error);

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

          return {
            index: idx,
            description: subtask.description,
            agent: subtask.agent,
            result: `Error: ${error}`,
            success: false,
          };
        }
      })
    );

    for (const r of batchResults) {
      results.push(r);
      completed.add(r.index);
    }
  }

  return results;
}

/**
 * Aggregate subtask results into a coherent final response.
 */
export async function aggregate(
  originalRequest: string,
  results: SubtaskResult[]
): Promise<string> {
  // If only one subtask, return its result directly
  if (results.length === 1) return results[0].result;

  const resultSummary = results
    .sort((a, b) => a.index - b.index)
    .map((r) => `## ${r.description}\n${r.result}`)
    .join("\n\n---\n\n");

  const prompt = `You are synthesizing results from parallel subtasks into one coherent response.

Original request: ${originalRequest}

Subtask results:
${resultSummary}

Combine these into a single, well-organized response. Remove redundancy. Keep it concise and actionable. Do not mention that subtasks were used — present it as one unified answer.`;

  return _callClaude(prompt);
}
