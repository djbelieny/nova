/**
 * Pattern Learning System
 *
 * Stores and retrieves execution patterns from past task decompositions.
 * Successful patterns get reused to skip classification on future similar tasks.
 */

import { mkdirSync } from "fs";
import { join } from "path";
import type { Database } from "./db.ts";

export interface ExecutionPlan {
  subtasks: { description: string; agent?: string; reviewAgent?: string; dependsOn?: number[]; phase?: "prepare" | "execute" }[];
}

export interface ExecutionPattern {
  id: string;
  task_signature: string;
  plan: ExecutionPlan;
  success_count: number;
  fail_count: number;
  avg_duration_ms: number;
  winning_strategy: number;
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
 * Promote a high-success pattern to a learned skill file + DB record.
 * Called automatically when success_count reaches 5.
 * Returns the slug on success, null if skipped (already promoted or count < 5).
 */
export async function promoteToSkill(
  db: Database,
  pattern: ExecutionPattern,
  userId: string
): Promise<string | null> {
  if (pattern.success_count < 5) return null;

  // Generate slug: lowercase, spaces → hyphens, strip punctuation, max 40 chars
  const slug = pattern.task_signature
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40)
    .replace(/-+$/, "");

  if (!slug) return null;

  // Check if already promoted
  const existing = db.getLearnedSkills(userId).find(
    (s: any) => s.source_signature === pattern.task_signature
  );
  if (existing) return null;

  // Ensure directory exists
  const homeDir = process.env.HOME || "~";
  const skillsDir = join(homeDir, ".nova", "skills", "learned");
  try {
    mkdirSync(skillsDir, { recursive: true });
  } catch {}

  const skillPath = join(skillsDir, `${slug}.md`);
  const triggerPhrases = pattern.task_signature.split(" ").filter((w) => w.length > 2);

  const triggerList = triggerPhrases.map((t) => `- ${t}`).join("\n");
  const planJson = JSON.stringify(pattern.plan, null, 2);
  const now = new Date().toISOString();

  const mdContent = `---
name: ${slug}
description: Auto-generated skill from ${pattern.success_count} successful executions
---

# ${slug}

## Trigger Phrases
${triggerList}

## Execution Plan
\`\`\`json
${planJson}
\`\`\`

## Performance
- Success count: ${pattern.success_count}
- Avg duration: ${pattern.avg_duration_ms}ms
- Winning strategy: ${pattern.winning_strategy}
- Last promoted: ${now}
`;

  await Bun.write(skillPath, mdContent);

  db.insertLearnedSkill(userId, {
    slug,
    trigger_phrases: triggerPhrases,
    skill_path: skillPath,
    success_count: pattern.success_count,
    avg_duration_ms: pattern.avg_duration_ms,
    source_signature: pattern.task_signature,
  });

  console.log(`[patterns] Promoted skill: "${slug}" (${pattern.success_count} successes) → ${skillPath}`);
  return slug;
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
        bestMatch = {
          ...(row as any),
          winning_strategy: (row as any).winning_strategy ?? 1,
        } as ExecutionPattern;
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
 * Rate the most recent successful execution pattern for this user.
 * Returns true if a pattern was found and rated, false otherwise.
 */
export async function rateLastPattern(
  db: Database,
  userId: string,
  rating: 1 | -1
): Promise<boolean> {
  try {
    const pattern = db.findMostRecentSuccessfulPattern(userId);
    if (!pattern) return false;
    db.ratePattern(userId, pattern.id, rating);
    return true;
  } catch (error) {
    console.error("[patterns] rateLastPattern error:", error);
    return false;
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
  userId: string,
  winningStrategy?: number
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

      const updates: Record<string, any> = {
        success_count: success
          ? existing.success_count + 1
          : existing.success_count,
        fail_count: success ? existing.fail_count : existing.fail_count + 1,
        avg_duration_ms: newAvg,
        plan,
      };

      // Only update winning_strategy when the execution succeeded
      if (success && winningStrategy !== undefined) {
        updates.winning_strategy = winningStrategy;
      }

      db.updatePattern(existing.id, updates, userId);

      // Promote to learned skill once threshold is reached
      if (success && updates.success_count >= 5) {
        const promoted: ExecutionPattern = {
          id: existing.id,
          task_signature: signature,
          plan,
          success_count: updates.success_count,
          fail_count: updates.fail_count,
          avg_duration_ms: updates.avg_duration_ms,
          winning_strategy: updates.winning_strategy ?? existing.winning_strategy ?? 1,
        };
        promoteToSkill(db, promoted, userId).catch((err) =>
          console.error("[patterns] promoteToSkill error:", err)
        );
      }
    } else {
      db.insertPattern({
        task_signature: signature,
        plan,
        success_count: success ? 1 : 0,
        fail_count: success ? 0 : 1,
        avg_duration_ms: durationMs,
        user_id: userId,
        winning_strategy: success ? (winningStrategy ?? 1) : 1,
      });
    }
  } catch (error) {
    console.error("Pattern record error:", error);
  }
}
