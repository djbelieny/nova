/**
 * Pattern Learning System
 *
 * Stores and retrieves execution patterns from past task decompositions.
 * Successful patterns get reused to skip classification on future similar tasks.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface ExecutionPlan {
  subtasks: { description: string; agent?: string; dependsOn?: number[] }[];
}

export interface ExecutionPattern {
  id: string;
  task_signature: string;
  plan: ExecutionPlan;
  success_count: number;
  fail_count: number;
  avg_duration_ms: number;
}

/**
 * Normalize task text into a signature for matching.
 * Strips filler words, lowercases, and sorts key terms.
 */
function normalizeSignature(text: string): string {
  const stopWords = new Set([
    "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "is", "it", "my", "me", "i", "we", "you", "this",
    "that", "then", "also", "just", "can", "please", "could", "would",
  ]);

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stopWords.has(w))
    .sort()
    .join(" ");
}

/**
 * Find a matching pattern for the given task text.
 * Returns the best pattern with 2+ successes, or null.
 */
export async function findPattern(
  supabase: SupabaseClient | null,
  taskText: string,
  userId: string
): Promise<ExecutionPattern | null> {
  if (!supabase) return null;

  const signature = normalizeSignature(taskText);
  if (!signature) return null;

  try {
    // Extract key terms for keyword matching
    const keywords = signature.split(" ").slice(0, 5);

    // Search patterns that share keywords with the task
    const { data, error } = await supabase
      .from("execution_patterns")
      .select("*")
      .eq("user_id", userId)
      .gte("success_count", 2)
      .order("success_count", { ascending: false })
      .limit(10);

    if (error || !data?.length) return null;

    // Score each pattern by keyword overlap
    let bestMatch: ExecutionPattern | null = null;
    let bestScore = 0;

    for (const row of data) {
      const patternWords = new Set(row.task_signature.split(" "));
      const overlap = keywords.filter((k) => patternWords.has(k)).length;
      const score = overlap / Math.max(keywords.length, patternWords.size);

      if (score > 0.5 && score > bestScore) {
        bestScore = score;
        bestMatch = row as ExecutionPattern;
      }
    }

    return bestMatch;
  } catch (error) {
    console.error("Pattern lookup error:", error);
    return null;
  }
}

/**
 * Record an execution result to build the pattern database.
 * Creates new patterns or updates existing ones with running averages.
 */
export async function recordExecution(
  supabase: SupabaseClient | null,
  taskText: string,
  plan: ExecutionPlan,
  success: boolean,
  durationMs: number,
  userId: string
): Promise<void> {
  if (!supabase) return;

  const signature = normalizeSignature(taskText);
  if (!signature) return;

  try {
    // Check for existing pattern
    const { data: existing } = await supabase
      .from("execution_patterns")
      .select("id, success_count, fail_count, avg_duration_ms")
      .eq("task_signature", signature)
      .eq("user_id", userId)
      .limit(1);

    if (existing?.length) {
      const row = existing[0];
      const totalRuns = row.success_count + row.fail_count;
      const newAvg =
        (row.avg_duration_ms * totalRuns + durationMs) / (totalRuns + 1);

      await supabase
        .from("execution_patterns")
        .update({
          success_count: success
            ? row.success_count + 1
            : row.success_count,
          fail_count: success ? row.fail_count : row.fail_count + 1,
          avg_duration_ms: newAvg,
          plan,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
    } else {
      await supabase.from("execution_patterns").insert({
        task_signature: signature,
        plan,
        success_count: success ? 1 : 0,
        fail_count: success ? 0 : 1,
        avg_duration_ms: durationMs,
        user_id: userId,
      });
    }
  } catch (error) {
    console.error("Pattern record error:", error);
  }
}
