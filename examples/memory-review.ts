/**
 * Memory Review
 *
 * Periodic self-maintenance: Nova reviews its own memory bank and removes
 * stale, duplicate, or ephemeral entries that shouldn't have been saved.
 * Keeps prompt context tight and token usage low.
 *
 * Runs once daily (e.g., 3am) via scheduler or launchd.
 *
 * Run: bun run examples/memory-review.ts
 */

import "dotenv/config";
import { spawn } from "bun";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { dirname, join } from "path";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_ROOT = join(dirname(import.meta.path), "..");

// ============================================================
// SUPABASE
// ============================================================

function getSupabase(): SupabaseClient {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
    process.exit(1);
  }
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
}

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

async function getAllFacts(supabase: SupabaseClient): Promise<MemoryEntry[]> {
  const { data, error } = await supabase
    .from("memory")
    .select("id, type, content, created_at, user_id, scope")
    .eq("type", "fact")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Failed to fetch facts:", error.message);
    return [];
  }
  return data || [];
}

async function getCompletedGoals(supabase: SupabaseClient): Promise<MemoryEntry[]> {
  // Get completed goals older than 30 days — safe to archive
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("memory")
    .select("id, type, content, created_at, user_id, scope")
    .eq("type", "completed_goal")
    .lt("completed_at", thirtyDaysAgo);

  if (error) {
    console.error("Failed to fetch completed goals:", error.message);
    return [];
  }
  return data || [];
}

async function getActiveUsers(supabase: SupabaseClient): Promise<UserInfo[]> {
  const { data } = await supabase
    .from("users")
    .select("id, name, telegram_id")
    .eq("active", true);
  return data || [];
}

async function deleteMemoryEntries(supabase: SupabaseClient, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const { error } = await supabase
    .from("memory")
    .delete()
    .in("id", ids);
  if (error) {
    console.error("Delete error:", error.message);
    return 0;
  }
  return ids.length;
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
    const proc = spawn(
      [CLAUDE_PATH, "-p", prompt, "--output-format", "text", "--permission-mode", "bypassPermissions"],
      { stdout: "pipe", stderr: "pipe", cwd: PROJECT_ROOT, env: { ...process.env, CLAUDECODE: undefined } }
    );

    const [output, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      console.error("Claude error:", stderr);
      return [];
    }

    if (output.trim().toUpperCase() === "NONE") return [];

    // Parse DELETE: <id> lines
    const ids: string[] = [];
    for (const line of output.split("\n")) {
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
  const supabase = getSupabase();

  const [facts, completedGoals, users] = await Promise.all([
    getAllFacts(supabase),
    getCompletedGoals(supabase),
    getActiveUsers(supabase),
  ]);

  console.log(`Found ${facts.length} facts, ${completedGoals.length} old completed goals`);

  let totalDeleted = 0;
  const report: string[] = [];

  // Step 1: Remove exact duplicates (fast, no Claude needed)
  const dupeIds = findExactDuplicates(facts);
  if (dupeIds.length) {
    const deleted = await deleteMemoryEntries(supabase, dupeIds);
    totalDeleted += deleted;
    report.push(`Duplicates removed: ${deleted}`);
    console.log(`Removed ${deleted} exact duplicates`);
  }

  // Step 2: Archive old completed goals (> 30 days)
  if (completedGoals.length) {
    const goalIds = completedGoals.map(g => g.id);
    const deleted = await deleteMemoryEntries(supabase, goalIds);
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

      const deleted = await deleteMemoryEntries(supabase, idsToDelete);
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
//   0 3 * * * cd /path/to/nova && bun run examples/memory-review.ts
//
// LAUNCHD (macOS):
//   bun run setup:launchd -- --service memory-review
//
