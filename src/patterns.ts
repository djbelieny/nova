/**
 * Pattern Learning System
 *
 * Stores and retrieves execution patterns from past task decompositions.
 * Successful patterns get reused to skip classification on future similar tasks.
 */

import type { Database } from "./db.ts";

export interface ExecutionPlan {
  subtasks: { description: string; agent?: string; dependsOn?: number[]; phase?: "prepare" | "execute" }[];
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
 * Strips filler words and lowercases, but preserves word order
 * to differentiate "create post about AI" from "create AI about post".
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
    .join(" ");
}

/**
 * Find a matching pattern for the given task text.
 * Returns the best pattern with 2+ successes, or null.
 */
export async function findPattern(
  db: Database | null,
  taskText: string,
  userId: string
): Promise<ExecutionPattern | null> {
  if (!db) return null;

  const signature = normalizeSignature(taskText);
  if (!signature) return null;

  try {
    // Search patterns that share keywords with the task
    const data = db.findPatterns(userId, 2, 10);

    if (!data?.length) return null;

    // Score each pattern by keyword overlap — use full signature, not just first 5
    const signatureWords = signature.split(" ");
    let bestMatch: ExecutionPattern | null = null;
    let bestScore = 0;

    for (const row of data) {
      const patternWords = new Set(row.task_signature.split(" "));
      const overlap = signatureWords.filter((k) => patternWords.has(k)).length;

      // Require at least 3 matching words to prevent spurious matches
      if (overlap < 3) continue;

      const score = overlap / Math.max(signatureWords.length, patternWords.size);

      if (score > 0.7 && score > bestScore) {
        bestScore = score;
        bestMatch = row as ExecutionPattern;
      }
    }

    if (bestMatch) {
      console.log(`[patterns] Matched with score ${bestScore.toFixed(2)}: "${bestMatch.task_signature.substring(0, 60)}"`);
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
  db: Database | null,
  taskText: string,
  plan: ExecutionPlan,
  success: boolean,
  durationMs: number,
  userId: string
): Promise<void> {
  if (!db) return;

  const signature = normalizeSignature(taskText);
  if (!signature) return;

  try {
    // Check for existing pattern
    const existing = db.findPatternBySignature(userId, signature);

    if (existing) {
      const totalRuns = existing.success_count + existing.fail_count;
      const newAvg =
        (existing.avg_duration_ms * totalRuns + durationMs) / (totalRuns + 1);

      db.updatePattern(existing.id, {
        success_count: success
          ? existing.success_count + 1
          : existing.success_count,
        fail_count: success ? existing.fail_count : existing.fail_count + 1,
        avg_duration_ms: newAvg,
        plan,
      });
    } else {
      db.insertPattern({
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
