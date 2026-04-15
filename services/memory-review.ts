/**
 * Memory Review
 *
 * Periodic self-maintenance: Nova reviews its own memory bank and removes
 * stale, duplicate, or ephemeral entries that shouldn't have been saved.
 * Keeps prompt context tight and token usage low.
 *
 * Runs once daily (e.g., 3am) via scheduler or launchd.
 *
 * Run: bun run services/memory-review.ts
 */

import "dotenv/config";
import { getDb, type Database } from "../src/db.ts";
import { registerProvider, getDefaultProvider, getProvider } from "../src/ai-provider.ts";
import { ClaudeProvider } from "../src/providers/claude.ts";
import { GeminiProvider } from "../src/providers/gemini.ts";
import { CodexProvider } from "../src/providers/codex.ts";
import { memwright, type SearchResult } from "../src/memwright-client.ts";

// Register AI providers (memory-review runs standalone)
registerProvider(new ClaudeProvider());
registerProvider(new GeminiProvider());
registerProvider(new CodexProvider());

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

// ============================================================
// DATABASE
// ============================================================

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(chatId: string, message: string): Promise<boolean> {
  if (!BOT_TOKEN) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ============================================================
// MEMORY FETCHING
// ============================================================

interface MemoryEntry {
  id: string;
  type: string;
  content: string;
  created_at: string;
  last_accessed_at: string;
  weight: number;
  user_id: string;
  scope: string;
}

interface UserInfo {
  id: string;
  name: string;
  telegram_id: string;
}

function getAllFacts(db: Database): MemoryEntry[] {
  try {
    return db.getMemoryFiltered({ type: "fact", limit: 1000 }) || [];
  } catch (error) {
    console.error("Failed to fetch facts:", error);
    return [];
  }
}

function getCompletedGoals(db: Database): MemoryEntry[] {
  // Get completed goals older than 30 days — safe to archive
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const all = db.getMemoryFiltered({ type: "completed_goal", limit: 1000 }) || [];
    return all.filter((g: any) => g.completed_at && g.completed_at < thirtyDaysAgo);
  } catch (error) {
    console.error("Failed to fetch completed goals:", error);
    return [];
  }
}

function getActiveUsers(db: Database): UserInfo[] {
  return db.getAllActiveUsers() || [];
}

function deleteMemoryEntries(db: Database, ids: string[]): number {
  if (!ids.length) return 0;
  try {
    db.deleteMemoryEntries(ids);
    return ids.length;
  } catch (error) {
    console.error("Delete error:", error);
    return 0;
  }
}

// ============================================================
// CONSOLIDATION & DECAY
// ============================================================

async function decayMemoryWeights(db: Database, facts: MemoryEntry[]): Promise<number> {
  const now = Date.now();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  let updated = 0;

  for (const f of facts) {
    const lastAccessed = new Date(f.last_accessed_at).getTime();
    if (now - lastAccessed > THIRTY_DAYS_MS) {
      const newWeight = Math.max(0.1, f.weight - 0.1);
      if (newWeight !== f.weight) {
        db.updateMemoryWeight(f.id, newWeight);
        updated++;
      }
    }
  }
  return updated;
}

async function consolidateMemories(db: Database, facts: MemoryEntry[]): Promise<number> {
  // Only consolidate memories with low weight (< 0.5) that are old (> 60 days)
  const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  
  const candidates = facts.filter(f => 
    f.weight < 0.5 && 
    (now - new Date(f.created_at).getTime()) > SIXTY_DAYS_MS
  );

  if (candidates.length < 5) return 0; // Not enough to consolidate

  console.log(`[memory-review] Analyzing ${candidates.length} low-weight memories for consolidation...`);

  const prompt = `You are an AI memory manager. Your task is to group related but low-importance memories and summarize them into high-level, permanent facts.

Here are some old, infrequently accessed memories:
${candidates.map((c, i) => `${i + 1}. [${c.id}] ${c.content}`).join("\n")}

Identify groups of 3 or more memories that are related to the same topic (e.g., "travel preferences", "project X details", "meeting notes").
For each group, write a single concise summary fact that captures the essence of those memories.

Respond ONLY with a JSON array of objects, each representing a consolidated summary and the IDs of the original memories:
[
  {
    "summary": "User prefers flying Delta and staying in Marriott hotels for business travel.",
    "original_ids": ["uuid1", "uuid2", "uuid3"]
  }
]

If no meaningful consolidation can be done, return: []`;

  try {
    const claudeProvider = getProvider("claude") ?? getDefaultProvider();
    const result = await claudeProvider.call({
      prompt,
      model: claudeProvider.mapModelTier("standard"),
      maxTurns: 1,
      outputFormat: "text",
    });

    const match = result.text.match(/\[[\s\S]*\]/);
    if (!match) return 0;
    const consolidations = JSON.parse(match[0]);

    let totalConsolidated = 0;
    for (const c of consolidations) {
      if (c.original_ids.length >= 3) {
        // Find the user_id from one of the originals
        const sample = candidates.find(f => f.id === c.original_ids[0]);
        if (!sample) continue;

        // Insert new consolidated fact
        db.insertMemory({
          type: "fact",
          content: `[Consolidated Memory]: ${c.summary}`,
          user_id: sample.user_id,
          scope: sample.scope,
          weight: 0.8, // New summaries start with higher weight
        });

        // Delete originals
        db.deleteMemoryEntries(c.original_ids);
        totalConsolidated += c.original_ids.length;
        console.log(`[memory-review] Consolidated ${c.original_ids.length} memories into: "${c.summary}"`);
      }
    }
    return totalConsolidated;
  } catch (error) {
    console.error("Consolidation error:", error);
    return 0;
  }
}

// ============================================================
// CLAUDE REVIEW
// ============================================================

interface InsightEntry {
  id: string;
  content: string;
}

interface ReviewResult {
  factIdsToDelete: string[];
  insightIdsToDelete: string[];
}

async function askClaudeToReview(
  facts: MemoryEntry[],
  insightsByUser: Map<string, InsightEntry[]> = new Map()
): Promise<ReviewResult> {
  const allInsights = Array.from(insightsByUser.values()).flat();
  if (!facts.length && !allInsights.length) return { factIdsToDelete: [], insightIdsToDelete: [] };

  // Build a numbered list for Claude to review
  const factList = facts.map((f, i) =>
    `${i + 1}. [${f.id}] (${new Date(f.created_at).toLocaleDateString()}) ${f.content}`
  ).join("\n");

  const insightSection = allInsights.length
    ? `\n\n--- DREAM-MODE INSIGHTS ---\nThese are behavioral/strategic insights derived during background analysis. Apply the same hygiene:\nDELETE insights that are: REDUNDANT (same idea multiple ways), CONTRADICTED (superseded by newer), STALE (time-bound and no longer relevant), or TRIVIAL (low-signal).\nKEEP insights that are durable patterns, strategic observations, or unique non-obvious connections.\n\n${allInsights.map((ins, i) => `${i + 1}. [${ins.id}] ${ins.content}`).join("\n")}`
    : "";

  const prompt = `You are reviewing a personal AI assistant's memory bank. Your job is to identify entries that should be DELETED.

DELETE facts that are:
1. EPHEMERAL EVENTS: One-time dates, dinners, lunches, appointments, meetings, reservations — anything with a specific date that has passed or will pass
2. SCHEDULE CHANGES: "moved to Thursday", "changed from Friday" — these are calendar updates, not long-term facts
3. DUPLICATES: Same information stated multiple ways — keep only the most recent/complete version
4. OUTDATED: Facts that were superseded by newer information (keep the newer one)
5. TRIVIAL: Implementation details, debugging notes, temporary states
6. TOO SPECIFIC: "DJ ordered the steak" — not useful long-term

KEEP facts that are:
1. IDENTITY: Names, relationships, contact info, birthdays
2. BUSINESS: Company details, pricing, clients, revenue
3. PREFERENCES: Communication style, tools, workflows, recurring schedules
4. MAJOR DECISIONS: Strategies, commitments, career moves

Here are the current facts:

${factList}${insightSection}

Respond with ONLY the IDs to DELETE, one per line, in this exact format:
DELETE: <id>
DELETE: <id>

If nothing should be deleted, respond with:
NONE

Do not explain your reasoning. Just list the IDs.`;

  try {
    const result = await getDefaultProvider().call({
      prompt,
      model: "haiku",
      maxTurns: 1,
      outputFormat: "text",
    });

    if (result.text.trim().toUpperCase() === "NONE") return { factIdsToDelete: [], insightIdsToDelete: [] };

    const insightIdSet = new Set(allInsights.map(i => i.id));
    const factIdsToDelete: string[] = [];
    const insightIdsToDelete: string[] = [];

    // Memwright IDs are standard UUIDs (8-4-4-4-12 hex, e.g. "550e8400-e29b-41d4-a716-446655440000")
    for (const line of result.text.split("\n")) {
      const m = line.match(/DELETE:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (m) {
        const id = m[1];
        if (insightIdSet.has(id)) {
          insightIdsToDelete.push(id);
        } else {
          factIdsToDelete.push(id);
        }
      }
    }
    return { factIdsToDelete, insightIdsToDelete };
  } catch (error) {
    console.error("Claude review error:", error);
    return { factIdsToDelete: [], insightIdsToDelete: [] };
  }
}

// ============================================================
// DUPLICATE DETECTION (no Claude needed)
// ============================================================

function findExactDuplicates(facts: MemoryEntry[]): string[] {
  const seen = new Map<string, string>(); // content -> first id
  const dupes: string[] = [];

  for (const f of facts) {
    const normalized = f.content.trim().toLowerCase();
    if (seen.has(normalized)) {
      dupes.push(f.id); // keep the earlier one, delete later dupes
    } else {
      seen.set(normalized, f.id);
    }
  }
  return dupes;
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("[memory-review] Running memory review...");
  const db = getDb();

  const facts = getAllFacts(db);
  const completedGoals = getCompletedGoals(db);
  const users = getActiveUsers(db);

  console.log(`[memory-review] Found ${facts.length} facts, ${completedGoals.length} old completed goals`);

  let totalDeleted = 0;
  const report: string[] = [];

  // Step 1: Remove exact duplicates (fast, no Claude needed)
  const dupeIds = findExactDuplicates(facts);
  if (dupeIds.length) {
    const deleted = await deleteMemoryEntries(db, dupeIds);
    totalDeleted += deleted;
    report.push(`Duplicates removed: ${deleted}`);
    console.log(`[memory-review] Removed ${deleted} exact duplicates`);
  }

  // Step 2: Archive old completed goals (> 30 days)
  if (completedGoals.length) {
    const goalIds = completedGoals.map(g => g.id);
    const deleted = await deleteMemoryEntries(db, goalIds);
    totalDeleted += deleted;
    report.push(`Archived completed goals (30d+): ${deleted}`);
    console.log(`[memory-review] Archived ${deleted} old completed goals`);
  }

  // Step 3: Claude reviews remaining facts + insights in one pass
  const remainingFacts = facts.filter(f => !dupeIds.includes(f.id));

  // Fetch insights per user for co-review
  const insightsByUser = new Map<string, InsightEntry[]>();
  await Promise.all(
    users.map(async (user) => {
      try {
        const insights = await memwright.search({
          namespace: `user:${user.id}`,
          category: "insight",
          limit: 50,
        });
        const validInsights = (insights ?? []).filter((m: SearchResult) => m.content?.trim());
        if (validInsights.length >= 3) {
          insightsByUser.set(
            user.id,
            validInsights.map((m: SearchResult) => ({ id: m.id, content: m.content }))
          );
        } else {
          console.log(`[memory-review] Skipping insight review for ${user.name}: ${validInsights.length} valid insights (min 3)`);
        }
      } catch (err) {
        console.warn(`[memory-review] Failed to fetch insights for ${user.name}:`, err);
      }
    })
  );

  const totalInsightCount = Array.from(insightsByUser.values()).reduce((s, arr) => s + arr.length, 0);
  if (remainingFacts.length > 0 || totalInsightCount > 0) {
    console.log(`[memory-review] Asking Claude to review ${remainingFacts.length} facts + ${totalInsightCount} insights...`);
    const { factIdsToDelete, insightIdsToDelete } = await askClaudeToReview(remainingFacts, insightsByUser);

    if (factIdsToDelete.length) {
      const deletedFacts = remainingFacts.filter(f => factIdsToDelete.includes(f.id));
      for (const f of deletedFacts) {
        console.log(`[memory-review]   Deleting fact: "${f.content.substring(0, 80)}"`);
      }
      const deleted = await deleteMemoryEntries(db, factIdsToDelete);
      totalDeleted += deleted;
      report.push(`Stale/ephemeral removed: ${deleted}`);
      console.log(`[memory-review] Claude flagged ${deleted} facts for removal`);
    }

    if (insightIdsToDelete.length) {
      let insightsPruned = 0;
      for (const id of insightIdsToDelete) {
        const ok = await memwright.forget(id);
        if (ok) {
          insightsPruned++;
          console.log(`[memory-review]   Deleted insight ${id}`);
        } else {
          console.warn(`[memory-review]   forget() returned false for insight ${id}`);
        }
      }
      if (insightsPruned > 0) {
        report.push(`Insights pruned: ${insightsPruned}`);
        console.log(`[memory-review] Claude flagged ${insightsPruned} insights for removal`);
      }
    }

    if (!factIdsToDelete.length && !insightIdsToDelete.length) {
      console.log("[memory-review] Claude: all facts and insights look good");
    }
  }

  // Step 4: Decay memory weights based on access time
  const decayedCount = await decayMemoryWeights(db, facts);
  if (decayedCount > 0) {
    report.push(`Memory weights decayed: ${decayedCount}`);
    console.log(`[memory-review] Decayed weight for ${decayedCount} inactive memories`);
  }

  // Step 5: Consolidate old low-weight memories
  const consolidatedCount = await consolidateMemories(db, facts);
  if (consolidatedCount > 0) {
    totalDeleted += consolidatedCount;
    report.push(`Memories consolidated: ${consolidatedCount}`);
    console.log(`[memory-review] Consolidated ${consolidatedCount} low-weight memories`);
  }

  // Step 6: Prune expired short-term memories from Memwright
  console.log("[memory-review] Step 6: Pruning expired short-term memories...");
  const expired = db.getExpiredShortTermMemories();
  if (expired.length > 0) {
    console.log(`[memory-review] Found ${expired.length} expired short-term entries`);
    const results = await Promise.all(
      expired.map(async (entry) => {
        try {
          const ok = await memwright.forget(entry.id);
          // Delete from tracking regardless of forget() result:
          // false = either Memwright reset (orphaned) or already gone — clean up either way
          db.deleteShortTermMemory(entry.id);
          if (!ok) {
            console.warn(`[memory-review] Memwright forget returned false for ${entry.id} — cleaned up tracking anyway`);
          }
          return ok ? "pruned" : "orphaned";
        } catch (err) {
          console.warn(`[memory-review] Error forgetting ${entry.id}:`, err);
          return "orphaned";
        }
      })
    );
    const pruned = results.filter((r) => r === "pruned").length;
    const orphaned = results.filter((r) => r === "orphaned").length;
    console.log(`[memory-review] Step 6 complete: ${pruned} pruned, ${orphaned} orphaned IDs cleaned`);
    if (pruned > 0) report.push(`Short-term memories pruned: ${pruned}`);
    if (orphaned > 0) report.push(`Orphaned short-term IDs cleaned: ${orphaned}`);
  } else {
    console.log("[memory-review] Step 6: No expired short-term memories");
  }

  // Report
  const remaining = facts.length - totalDeleted + (consolidatedCount > 0 ? 1 : 0);
  console.log(`[memory-review] Memory review complete: ${totalDeleted} removed/consolidated, ${remaining} remaining`);

  if (totalDeleted > 0) {
    // Notify admin
    const adminUser = users.find(u => u.telegram_id);
    if (adminUser) {
      const msg = `🧹 Memory review: removed ${totalDeleted} entries\n${report.join("\n")}\n${remaining} facts remaining`;
      await sendTelegram(adminUser.telegram_id, msg);
    }
  }
}

main();

// ============================================================
// SCHEDULING
// ============================================================
//
// Run once daily at 3am:
//
// CRON (Linux):
//   0 3 * * * cd /path/to/nova && bun run services/memory-review.ts
//
// LAUNCHD (macOS):
//   bun run setup:launchd -- --service memory-review
//
