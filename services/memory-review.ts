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
import { registerProvider, getDefaultProvider } from "../src/ai-provider.ts";
import { ClaudeProvider } from "../src/providers/claude.ts";

// Register AI provider (memory-review runs standalone)
registerProvider(new ClaudeProvider());

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
    return db.getMemoryFiltered({ type: "fact" }) || [];
  } catch (error) {
    console.error("Failed to fetch facts:", error);
    return [];
  }
}

function getCompletedGoals(db: Database): MemoryEntry[] {
  // Get completed goals older than 30 days — safe to archive
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const all = db.getMemoryFiltered({ type: "completed_goal" }) || [];
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
// CLAUDE REVIEW
// ============================================================

async function askClaudeToReview(facts: MemoryEntry[]): Promise<string[]> {
  if (!facts.length) return [];

  // Build a numbered list for Claude to review
  const factList = facts.map((f, i) =>
    `${i + 1}. [${f.id}] (${new Date(f.created_at).toLocaleDateString()}) ${f.content}`
  ).join("\n");

  const prompt = `You are reviewing a personal AI assistant's memory bank. Your job is to identify entries that should be DELETED.

DELETE entries that are:
1. EPHEMERAL EVENTS: One-time dates, dinners, lunches, appointments, meetings, reservations — anything with a specific date that has passed or will pass
2. SCHEDULE CHANGES: "moved to Thursday", "changed from Friday" — these are calendar updates, not long-term facts
3. DUPLICATES: Same information stated multiple ways — keep only the most recent/complete version
4. OUTDATED: Facts that were superseded by newer information (keep the newer one)
5. TRIVIAL: Implementation details, debugging notes, temporary states
6. TOO SPECIFIC: "DJ ordered the steak" — not useful long-term

KEEP entries that are:
1. IDENTITY: Names, relationships, contact info, birthdays
2. BUSINESS: Company details, pricing, clients, revenue
3. PREFERENCES: Communication style, tools, workflows, recurring schedules
4. MAJOR DECISIONS: Strategies, commitments, career moves

Here are the current facts:

${factList}

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

    if (result.text.toUpperCase() === "NONE") return [];

    const ids: string[] = [];
    for (const line of result.text.split("\n")) {
      const match = line.match(/DELETE:\s*([0-9a-f-]{36})/i);
      if (match) ids.push(match[1]);
    }
    return ids;
  } catch (error) {
    console.error("Claude review error:", error);
    return [];
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
  console.log("Running memory review...");
  const db = getDb();

  const facts = getAllFacts(db);
  const completedGoals = getCompletedGoals(db);
  const users = getActiveUsers(db);

  console.log(`Found ${facts.length} facts, ${completedGoals.length} old completed goals`);

  let totalDeleted = 0;
  const report: string[] = [];

  // Step 1: Remove exact duplicates (fast, no Claude needed)
  const dupeIds = findExactDuplicates(facts);
  if (dupeIds.length) {
    const deleted = await deleteMemoryEntries(db, dupeIds);
    totalDeleted += deleted;
    report.push(`Duplicates removed: ${deleted}`);
    console.log(`Removed ${deleted} exact duplicates`);
  }

  // Step 2: Archive old completed goals (> 30 days)
  if (completedGoals.length) {
    const goalIds = completedGoals.map(g => g.id);
    const deleted = await deleteMemoryEntries(db, goalIds);
    totalDeleted += deleted;
    report.push(`Archived completed goals (30d+): ${deleted}`);
    console.log(`Archived ${deleted} old completed goals`);
  }

  // Step 3: Claude reviews remaining facts for ephemeral/stale entries
  const remainingFacts = facts.filter(f => !dupeIds.includes(f.id));
  if (remainingFacts.length > 0) {
    console.log(`Asking Claude to review ${remainingFacts.length} facts...`);
    const idsToDelete = await askClaudeToReview(remainingFacts);

    if (idsToDelete.length) {
      // Log what's being deleted for transparency
      const deletedFacts = remainingFacts.filter(f => idsToDelete.includes(f.id));
      for (const f of deletedFacts) {
        console.log(`  Deleting: "${f.content.substring(0, 80)}"`);
      }

      const deleted = await deleteMemoryEntries(db, idsToDelete);
      totalDeleted += deleted;
      report.push(`Stale/ephemeral removed: ${deleted}`);
      console.log(`Claude flagged ${deleted} entries for removal`);
    } else {
      console.log("Claude: all facts look good");
    }
  }

  // Step 4: Report
  const remaining = facts.length - totalDeleted;
  console.log(`\nMemory review complete: ${totalDeleted} removed, ${remaining} remaining`);

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
