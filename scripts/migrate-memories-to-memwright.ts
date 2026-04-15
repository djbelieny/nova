#!/usr/bin/env bun

import { getDb } from "../src/db.ts";
import { memwright } from "../src/memwright-client.ts";
import { detectFactCategory } from "../src/memory.ts";

async function main() {
  console.log("[migrate] Starting Nova → Memwright migration");

  // 1. Check Memwright is running
  const ok = await memwright.health();
  if (!ok) {
    console.error("[migrate] Memwright is not running. Start it first: scripts/start-memwright.sh");
    process.exit(1);
  }

  const db = getDb();

  let totalMemories = 0;
  let totalMessages = 0;
  let totalErrors = 0;

  // 2. Migrate shared memories
  console.log("[migrate] Migrating shared memories...");
  try {
    const sharedMemories = (db as any).shared.db.query(`
      SELECT id, type, content, scope, deadline, created_at, user_id
      FROM memory
      WHERE type IN ('fact', 'goal', 'preference')
      ORDER BY created_at ASC
    `).all() as any[];

    if (sharedMemories.length > 0) {
      const requests = sharedMemories.map((mem: any) => {
        const isGoal = mem.type === "goal";
        return {
          content: mem.content,
          namespace: "nova:shared",
          category: isGoal ? "goal" : detectFactCategory(mem.content),
          tags: isGoal ? ["goal"] : [mem.type, mem.scope].filter(Boolean),
          metadata: {
            originalId: mem.id,
            type: mem.type,
            scope: mem.scope,
            deadline: mem.deadline,
            userId: mem.user_id,
            createdAt: mem.created_at,
          },
        };
      });

      try {
        await memwright.batchAdd(requests);
        totalMemories += sharedMemories.length;
        console.log(`[migrate] Shared memories migrated: ${sharedMemories.length}`);
      } catch (err) {
        console.error("[migrate] Failed to batch-add shared memories:", err);
        totalErrors += sharedMemories.length;
      }
    } else {
      console.log("[migrate] No shared memories found");
    }
  } catch (err) {
    console.error("[migrate] Could not query shared memories:", err);
    totalErrors++;
  }

  // 3. Migrate per-user memories + messages
  let users: any[] = [];
  try {
    users = db.getAllActiveUsers();
  } catch (err) {
    console.error("[migrate] Could not load users:", err);
    process.exit(1);
  }

  console.log(`[migrate] Found ${users.length} users`);

  for (const user of users) {
    const userId = user.id;
    const namespace = `user:${userId}`;
    console.log(`[migrate] Processing user ${userId} (${user.name ?? "unknown"})...`);

    let userRaw: any;
    try {
      userRaw = db.getUserRaw(userId);
    } catch (err) {
      console.error(`[migrate] Could not open DB for user ${userId}, skipping:`, err);
      totalErrors++;
      continue;
    }

    // Migrate memories
    let memories: any[] = [];
    try {
      memories = userRaw.query(`
        SELECT id, type, content, scope, deadline, created_at, user_id
        FROM memory
        WHERE type IN ('fact', 'goal', 'preference')
        ORDER BY created_at ASC
      `).all() as any[];
    } catch (err) {
      console.error(`[migrate] Could not query memories for user ${userId}:`, err);
      totalErrors++;
    }

    if (memories.length > 0) {
      const memRequests = memories.map((mem: any) => {
        const isGoal = mem.type === "goal";
        return {
          content: mem.content,
          namespace,
          category: isGoal ? "goal" : detectFactCategory(mem.content),
          tags: isGoal ? ["goal"] : [mem.type, mem.scope].filter(Boolean),
          metadata: {
            originalId: mem.id,
            type: mem.type,
            scope: mem.scope,
            deadline: mem.deadline,
            userId: mem.user_id ?? userId,
            createdAt: mem.created_at,
          },
        };
      });

      try {
        await memwright.batchAdd(memRequests);
        totalMemories += memories.length;
        console.log(`[migrate]   Memories: ${memories.length}`);
      } catch (err) {
        console.error(`[migrate]   Failed to batch-add memories for user ${userId}:`, err);
        totalErrors += memories.length;
      }
    }

    // Migrate messages
    let messages: any[] = [];
    try {
      messages = userRaw.query(`
        SELECT id, role, content, channel, created_at, user_id
        FROM messages
        ORDER BY created_at ASC
      `).all() as any[];
    } catch (err) {
      console.error(`[migrate] Could not query messages for user ${userId}:`, err);
      totalErrors++;
    }

    if (messages.length > 0) {
      const msgRequests = messages.map((msg: any) => ({
        content: `[${msg.role}] ${msg.content}`,
        namespace,
        category: "conversation",
        tags: [msg.role].filter(Boolean),
        metadata: {
          originalId: msg.id,
          role: msg.role,
          channel: msg.channel,
          userId: msg.user_id ?? userId,
          createdAt: msg.created_at,
        },
      }));

      try {
        await memwright.batchAdd(msgRequests);
        totalMessages += messages.length;
        console.log(`[migrate]   Messages: ${messages.length}`);
      } catch (err) {
        console.error(`[migrate]   Failed to batch-add messages for user ${userId}:`, err);
        totalErrors += messages.length;
      }
    }
  }

  console.log(
    `[migrate] Done. Memories: ${totalMemories}, Messages: ${totalMessages}, Errors: ${totalErrors}`
  );
}

main().catch((err) => {
  console.error("[migrate] Fatal error:", err);
  process.exit(1);
});
