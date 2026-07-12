/**
 * Nova — Test SQLite Database
 *
 * Verifies the split SQLite database works correctly:
 * shared.db tables exist, user DB tables exist, CRUD operations work,
 * embeddings generate, and vector search returns results.
 *
 * Usage: bun run setup/test-sqlite.ts
 */

import "dotenv/config";
import { getDb } from "../src/db.ts";

// Colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const PASS = green("\u2713");
const FAIL = red("\u2717");

let passed = 0;
let failed = 0;

function check(label: string, fn: () => boolean | void) {
  try {
    const result = fn();
    if (result === false) {
      console.log(`  ${FAIL} ${label}`);
      failed++;
    } else {
      console.log(`  ${PASS} ${label}`);
      passed++;
    }
  } catch (err: any) {
    console.log(`  ${FAIL} ${label}`);
    console.log(`      ${dim(err.message)}`);
    failed++;
  }
}

async function main() {
  console.log("");
  console.log(bold("  SQLite Database Test (Split Architecture)"));
  console.log("");

  // 1. Open database
  const db = getDb();
  console.log(`  ${PASS} Database opened`);
  passed++;

  // 2. Check shared.db tables
  const sharedTables = ["users", "nova_status", "logs", "cost_tracking", "memory"];

  console.log("");
  console.log(bold("  Shared DB Tables:"));
  for (const table of sharedTables) {
    check(`Table "${table}" exists in shared.db`, () => {
      const row = db.raw.query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
      ).get(table) as any;
      if (!row) return false;
    });
  }

  // 3. CRUD operations
  console.log("");
  console.log(bold("  CRUD Operations:"));

  const testUserId = `test-${Date.now()}`;

  check("Insert user (shared.db)", () => {
    const user = db.upsertUser({
      telegram_id: testUserId,
      name: "Test User",
      timezone: "UTC",
      role: "member",
    });
    if (!user) return false;
  });

  check("Get user by telegram ID", () => {
    const user = db.getUserByTelegramId(testUserId);
    if (!user || user.name !== "Test User") return false;
  });

  const user = db.getUserByTelegramId(testUserId);
  const userId = user?.id || "";

  check("Save message (user DB)", () => {
    const id = db.saveMessage({
      role: "user",
      content: "Hello, this is a test message",
      channel: "test",
      user_id: userId,
    });
    if (!id) return false;
  });

  // Check user DB tables were created
  const userTables = [
    "messages", "memory", "agent_tasks", "task_artifacts",
    "scheduled_tasks", "execution_patterns", "pending_approvals",
    "revision_sessions", "workflow_preferences", "user_integrations",
  ];

  console.log("");
  console.log(bold("  User DB Tables:"));
  for (const table of userTables) {
    check(`Table "${table}" exists in user DB`, () => {
      const userRaw = db.getUserRaw(userId);
      const row = userRaw.query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
      ).get(table) as any;
      if (!row) return false;
    });
  }

  console.log("");
  console.log(bold("  Data Operations:"));

  check("Get recent messages", () => {
    const msgs = db.getRecentMessages(userId, 5);
    if (!msgs || msgs.length === 0) return false;
  });

  check("Insert memory (private fact → user DB)", () => {
    db.insertMemory({
      type: "fact",
      content: "Test fact: the sky is blue",
      user_id: userId,
      scope: "private",
    });
  });

  check("Insert memory (shared fact → shared.db)", () => {
    db.insertMemory({
      type: "fact",
      content: "Shared test fact: water is wet",
      user_id: userId,
      scope: "shared",
    });
  });

  check("Get facts (merges private + shared)", () => {
    const facts = db.getFacts(userId);
    if (!facts || facts.length < 2) return false;
  });

  check("Insert memory (goal)", () => {
    db.insertMemory({
      type: "goal",
      content: "Test goal: learn TypeScript",
      user_id: userId,
    });
  });

  check("Get active goals", () => {
    const goals = db.getActiveGoals(userId);
    if (!goals || goals.length === 0) return false;
  });

  check("Delete memory entries (both DBs)", () => {
    const facts = db.getFacts(userId);
    const ids = facts.map((f: any) => f.id);
    db.deleteMemoryEntries(ids);
    const remaining = db.getFacts(userId);
    if (remaining.length !== 0) return false;
  });

  // 4. Embeddings
  console.log("");
  console.log(bold("  Embeddings:"));

  let embeddingWorks = false;
  try {
    const { generateEmbedding } = await import("../src/embeddings.ts");
    const emb = await generateEmbedding("test embedding generation");
    if (emb && emb.length > 0) {
      console.log(`  ${PASS} Embedding generated (${emb.length} dimensions)`);
      passed++;
      embeddingWorks = true;

      // Save message with its own embedding
      const contentEmb = await generateEmbedding("I love programming in TypeScript");
      db.saveMessage({
        role: "user",
        content: "I love programming in TypeScript",
        channel: "test",
        user_id: userId,
        embedding: contentEmb ?? emb,
      });
      console.log(`  ${PASS} Message saved with embedding`);
      passed++;
    } else {
      console.log(`  ${FAIL} Embedding generation returned empty`);
      failed++;
    }
  } catch (err: any) {
    console.log(`  ${FAIL} Embedding generation failed`);
    console.log(`      ${dim(err.message)}`);
    failed++;
  }

  // 5. Vector search
  if (embeddingWorks) {
    console.log("");
    console.log(bold("  Vector Search:"));

    try {
      const { generateEmbedding: genEmb } = await import("../src/embeddings.ts");
      const queryEmb = await genEmb("TypeScript programming");
      if (queryEmb) {
        const results = db.matchMessages(queryEmb, userId, { matchCount: 3, matchThreshold: 0.5 });
        if (results && results.length > 0) {
          console.log(`  ${PASS} Semantic search returned ${results.length} result(s) (similarity: ${results[0].similarity.toFixed(3)})`);
          passed++;
        } else {
          console.log(`  ${FAIL} Semantic search returned no results`);
          failed++;
        }
      } else {
        console.log(`  ${FAIL} Could not generate query embedding`);
        failed++;
      }
    } catch (err: any) {
      console.log(`  ${FAIL} Semantic search failed`);
      console.log(`      ${dim(err.message)}`);
      failed++;
    }
  }

  // Cleanup test data
  try {
    const userRaw = db.getUserRaw(userId);
    userRaw.run("DELETE FROM messages WHERE user_id = ?", [userId]);
    userRaw.run("DELETE FROM memory WHERE user_id = ?", [userId]);
    db.raw.run("DELETE FROM memory WHERE user_id = ?", [userId]);
    db.raw.run("DELETE FROM users WHERE id = ?", [userId]);
  } catch {}

  // Summary
  console.log("");
  if (failed === 0) {
    console.log(`  ${green("All tests passed!")} (${passed}/${passed + failed})`);
  } else {
    console.log(`  ${red(`${failed} test(s) failed`)} (${passed}/${passed + failed})`);
  }
  console.log("");

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n  ${red("Error:")} ${err.message}`);
  process.exit(1);
});
