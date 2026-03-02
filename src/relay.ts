/**
 * Nova — Personal AI Assistant
 *
 * Multi-channel relay that connects Telegram, WhatsApp, and Slack to Claude Code CLI.
 * Channel adapters handle platform-specific I/O; this file is the coordinator.
 *
 * Run: bun run src/relay.ts
 */

import { InputFile } from "grammy";
import type { Context } from "grammy";
import { spawn } from "bun";
import { writeFile, mkdir, readFile, unlink, stat } from "fs/promises";
import { join, dirname, basename, resolve } from "path";
import { getDb, type Database, embeddingToBlob } from "./db.ts";
import { transcribe } from "./transcribe.ts";
import { trackCost, initCostTracker } from "./cost-tracker.ts";
import {
  processMemoryIntents,
  getMemoryContext,
  getRelevantContext,
  getRecentHistory,
  getTaskContext,
  getScheduleContext,
} from "./memory.ts";
import { textToSpeech, isTTSEnabled } from "./tts.ts";
import { toggleVoiceResponses, loadSettings } from "./settings.ts";
import { orchestrate, initOrchestrator, handleApproval, getPendingApprovalCount, startMiniAppApprovalPolling, recoverPendingApprovals } from "./orchestrator.ts";
import { loadAgents } from "./agent-router.ts";
import { hasUserMcpConfig, getUserMcpConfigPath, getFilteredMcpConfigPath, getIntegrationCredentials } from "./integrations.ts";
import {
  ChannelRegistry,
  type IncomingMessage,
  type PlatformContext,
} from "./channels/index.ts";
import { WhatsAppManager } from "./whatsapp-manager.ts";
import { startHeartbeat, appendToHeartbeat } from "./heartbeat.ts";
import {
  markdownToTelegramHTML,
  parseButtons,
  cleanResponseForUser,
} from "./channels/telegram.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || "";
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".nova");

// Directories
const TEMP_DIR = join(RELAY_DIR, "temp");
const UPLOADS_DIR = join(RELAY_DIR, "uploads");

// Persistent workspace directories
const WORKSPACE_DIR = join(RELAY_DIR, "workspace");
const WORKSPACE_PROJECTS = join(WORKSPACE_DIR, "projects");
const WORKSPACE_DOCUMENTS = join(WORKSPACE_DIR, "documents");
const WORKSPACE_IMAGES = join(WORKSPACE_DIR, "images");
const WORKSPACE_MEDIA = join(WORKSPACE_DIR, "media");
const WORKSPACE_TASKS = join(WORKSPACE_DIR, ".tasks");

// ============================================================
// LOCK FILE (prevent multiple instances)
// ============================================================

const LOCK_FILE = join(RELAY_DIR, "bot.lock");

async function acquireLock(): Promise<boolean> {
  try {
    const existingLock = await readFile(LOCK_FILE, "utf-8").catch(() => null);

    if (existingLock) {
      const pid = parseInt(existingLock);
      try {
        process.kill(pid, 0); // Check if process exists
        console.log(`Another instance running (PID: ${pid})`);
        return false;
      } catch {
        console.log("Stale lock found, taking over...");
      }
    }

    // Atomic write: write to temp file then rename (prevents TOCTOU race)
    const tmpLock = `${LOCK_FILE}.${process.pid}`;
    await writeFile(tmpLock, process.pid.toString());
    const { renameSync } = require("fs");
    renameSync(tmpLock, LOCK_FILE);
    return true;
  } catch (error) {
    console.error("Lock error:", error);
    return false;
  }
}

async function releaseLock(): Promise<void> {
  await unlink(LOCK_FILE).catch(() => {});
}

// Cleanup on exit
process.on("exit", () => {
  try {
    require("fs").unlinkSync(LOCK_FILE);
  } catch {}
});
let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, draining in-flight tasks...`);

  // Wait up to 30s for active tasks to finish, checking every 500ms
  const maxWaitMs = 30_000;
  const start = Date.now();
  while (activeTasks.size > 0 && Date.now() - start < maxWaitMs) {
    console.log(`[shutdown] Waiting for ${activeTasks.size} task(s)...`);
    await new Promise((r) => setTimeout(r, 500));
  }

  if (activeTasks.size > 0) {
    console.warn(`[shutdown] Force-exiting with ${activeTasks.size} task(s) still running.`);
  } else {
    console.log("[shutdown] All tasks drained. Exiting cleanly.");
  }

  // Stop WhatsApp sessions gracefully
  try { await whatsappManager.stopAll(); } catch {}

  await releaseLock();
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// ============================================================
// SETUP
// ============================================================

// At least one channel must be configured
const hasAnyChannel = BOT_TOKEN || (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN);
if (!hasAnyChannel) {
  console.error("No messaging channel configured!");
  console.log("\nConfigure at least one:");
  console.log("  Telegram: Set TELEGRAM_BOT_TOKEN in .env");
  console.log("  Slack: Set SLACK_BOT_TOKEN and SLACK_APP_TOKEN in .env");
  console.log("  WhatsApp: Connect via Mini App (Integrations tab)");
  process.exit(1);
}

// Create directories
await mkdir(TEMP_DIR, { recursive: true });
await mkdir(UPLOADS_DIR, { recursive: true });

// Create persistent workspace directories
await mkdir(WORKSPACE_PROJECTS, { recursive: true });
await mkdir(WORKSPACE_DOCUMENTS, { recursive: true });
await mkdir(WORKSPACE_IMAGES, { recursive: true });
await mkdir(WORKSPACE_MEDIA, { recursive: true });
await mkdir(WORKSPACE_TASKS, { recursive: true });

// ============================================================
// STARTUP CONFIG VALIDATION
// ============================================================

const configWarnings: string[] = [];
// Database is always available via local SQLite
if (!process.env.USER_NAME) {
  configWarnings.push("USER_NAME not set — bot won't know your name");
}
if (!process.env.USER_TIMEZONE) {
  configWarnings.push("USER_TIMEZONE not set — defaulting to UTC (time-aware features may be inaccurate)");
}
if (BOT_TOKEN && !process.env.TELEGRAM_USER_ID) {
  configWarnings.push("TELEGRAM_USER_ID not set — user resolution may fail for admin features");
}
if (configWarnings.length > 0) {
  console.warn("=== CONFIG WARNINGS ===");
  for (const w of configWarnings) {
    console.warn(`  ⚠ ${w}`);
  }
  console.warn("=======================");
}

// ============================================================
// DATABASE (local SQLite — always available)
// ============================================================

const supabase: Database = getDb();

// Share db with cost tracker
initCostTracker(supabase);

// ============================================================
// MULTI-USER: User resolution + cache
// ============================================================

interface NovaUser {
  id: string;           // UUID from users table
  telegram_id: string;
  name: string;
  timezone: string;
  phone: string;
  role: string;
  preferences: Record<string, any>;
  profile_text: string;
}

const USER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const userCache = new Map<string, { user: NovaUser; cachedAt: number }>();
// GHL location ID cache: userId → locationId
const ghlLocationCache = new Map<string, string>();

/**
 * Resolve a user by platform-specific ID.
 * Supports Telegram ID, WhatsApp phone, or Slack user ID.
 */
async function resolveUser(platformId: string, channel: "telegram" | "whatsapp" | "slack" = "telegram"): Promise<NovaUser | null> {
  const cacheKey = `${channel}:${platformId}`;
  const cached = userCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < USER_CACHE_TTL_MS) return cached.user;

  try {
    const lookupMap: Record<string, (id: string) => any | null> = {
      telegram: (id) => supabase.getUserByTelegramId(id),
      whatsapp: (id) => supabase.getUserByWhatsappId(id),
      slack: (id) => supabase.getUserBySlackId(id),
    };

    const row = lookupMap[channel]?.(platformId);
    if (!row) return null;

    const user: NovaUser = {
      id: row.id,
      telegram_id: row.telegram_id,
      name: row.name,
      timezone: row.timezone || "UTC",
      phone: row.phone || "",
      role: row.role,
      preferences: row.preferences || {},
      profile_text: row.profile_text || "",
    };

    userCache.set(cacheKey, { user, cachedAt: Date.now() });

    // Pre-load GHL location ID (non-blocking)
    if (supabase && !ghlLocationCache.has(user.id)) {
      getIntegrationCredentials(supabase, user.id, "gohighlevel").then((ghl) => {
        if (ghl?.metadata?.location_id) {
          ghlLocationCache.set(user.id, ghl.metadata.location_id);
        }
      }).catch(() => {});
    }

    return user;
  } catch (error) {
    console.error("User resolution error:", error);
    return null;
  }
}

function invalidateUserCache(platformId?: string): void {
  if (platformId) {
    // Clear all cache entries containing this platform ID
    for (const key of userCache.keys()) {
      if (key.includes(platformId)) userCache.delete(key);
    }
    ghlLocationCache.clear();
  } else {
    userCache.clear();
    ghlLocationCache.clear();
  }
}

async function saveMessage(
  role: string,
  content: string,
  userId: string,
  metadata?: Record<string, unknown>,
  channel: string = "telegram"
): Promise<void> {
  try {
    const { generateEmbedding } = await import("./embeddings.ts");
    const embedding = await generateEmbedding(content);
    supabase.saveMessage({
      role,
      content,
      channel,
      metadata: metadata || {},
      user_id: userId,
      embedding: embedding || null,
    });
  } catch (error) {
    console.error("DB save error:", error);
  }
}

// Acquire lock
if (!(await acquireLock())) {
  console.error("Could not acquire lock. Another instance may be running.");
  process.exit(1);
}

// ============================================================
// CHANNEL REGISTRY — Initialize all enabled channel adapters
// ============================================================

const channels = new ChannelRegistry();
channels.init(RELAY_DIR);

// WhatsApp per-user sessions (managed via Mini App, not env flag)
const whatsappManager = new WhatsAppManager(supabase);
// Export for miniapp.ts to access
(globalThis as any).__novaWhatsAppManager = whatsappManager;

// Set up Telegram middleware for user resolution (if Telegram is enabled)
const telegramAdapter = channels.getTelegram();
if (telegramAdapter) {
  telegramAdapter.use(async (ctx, next) => {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const user = await resolveUser(telegramId, "telegram");
    if (!user) {
      console.log(`Unauthorized: ${telegramId}`);
      await ctx.reply("This bot is private. Ask the admin to add you.");
      return;
    }

    (ctx as any).novaUser = user;
    await next();
  });

  // Register approval handler — this needs the raw grammY Context
  telegramAdapter.onApproval(async (data, ctx) => {
    const parts = data.split(":");
    const approvalId = parts[1];
    const action = parts[2] as "approve" | "revise" | "cancel";
    const user = (ctx as any).novaUser as NovaUser;
    if (approvalId && action && user) {
      console.log(`Approval ${action} by ${user.name}: ${approvalId}`);
      await handleApproval(approvalId, action, ctx);
    }
  });
}

// ============================================================
// INLINE BUTTON CALLBACKS (all channels)
// ============================================================

channels.onButtonPress(async (chatId, userId, platformUserId, buttonData, reply, editOriginal) => {
  // Resolve user from cache (should already be cached from the message that triggered buttons)
  let user: NovaUser | null = null;
  for (const [_key, cached] of userCache) {
    if (cached.user.id === userId) { user = cached.user; break; }
  }
  // Fallback: try to resolve by telegram ID
  if (!user) user = await resolveUser(platformUserId, "telegram");
  if (!user) return;

  // Approval buttons (apv:...) are handled directly by the Telegram adapter's onApproval handler

  if (buttonData.startsWith("btn:")) {
    const selection = buttonData.substring(4);
    console.log(`Button pressed by ${user.name}: ${selection}`);

    if (editOriginal) {
      await editOriginal(`>> ${selection}`);
    }

    await saveMessage("user", selection, user.id);

    // Build a PlatformContext for the button handler
    const adapter = channels.get("telegram") || channels.getAll()[0];
    if (!adapter) return;

    const platformCtx = createGenericPlatformContext(adapter, chatId, user);
    await platformCtx.replyWithChatAction("typing");

    runTask(platformCtx, `Button: ${selection.substring(0, 40)}`, async () => {
      const [relevantContext, memoryContext, recentHistory, taskContext, scheduleContext] = await Promise.all([
        getRelevantContext(supabase, selection, user!.id),
        getMemoryContext(supabase, user!.id),
        getRecentHistory(supabase, user!.id),
        getTaskContext(supabase, user!.id),
        getScheduleContext(supabase, user!.id, user!.timezone),
      ]);
      return {
        prompt: buildPrompt(
          user!,
          `[Button selected in response to a question]: ${selection}`,
          relevantContext,
          memoryContext,
          recentHistory,
          taskContext,
          scheduleContext
        ),
        hint: selection,
      };
    }, {
      postProcess: (raw) => processMemoryIntents(supabase, raw, user!.id, user!.timezone),
    });
  }
});

// ============================================================
// CORE: Call Claude CLI
// ============================================================

// Track active tasks for parallel execution
interface ActiveTask {
  id: string;
  description: string;
  startTime: number;
  notified: boolean; // whether we sent a "still working" update
}
const activeTasks = new Map<string, ActiveTask>();
let taskCounter = 0;

// Cost tracking is now handled by src/cost-tracker.ts

// ============================================================
// RATE LIMIT MONITORING
// ============================================================

interface UsageStats {
  callsTotal: number;
  callsSuccess: number;
  callsFailed: number;
  callsByModel: Record<string, number>;
  rateLimitHits: number;
  lastRateLimitAt: number | null;
  uptimeSince: number;
  avgDurationMs: number;
  totalDurationMs: number;
}

const usage: UsageStats = {
  callsTotal: 0,
  callsSuccess: 0,
  callsFailed: 0,
  callsByModel: {},
  rateLimitHits: 0,
  lastRateLimitAt: null,
  uptimeSince: Date.now(),
  avgDurationMs: 0,
  totalDurationMs: 0,
};

function recordCall(success: boolean, model: string, durationMs: number, rateLimited: boolean): void {
  usage.callsTotal++;
  if (success) usage.callsSuccess++;
  else usage.callsFailed++;
  usage.callsByModel[model] = (usage.callsByModel[model] || 0) + 1;
  if (rateLimited) {
    usage.rateLimitHits++;
    usage.lastRateLimitAt = Date.now();
  }
  usage.totalDurationMs += durationMs;
  usage.avgDurationMs = usage.totalDurationMs / usage.callsTotal;
}

// Persist usage stats to DB every 5 minutes
setInterval(() => {
  if (usage.callsTotal === 0) return;
  try {
    supabase.insertCostEntry({
      provider: "claude",
      model: "usage_stats",
      input_tokens: usage.callsTotal,
      output_tokens: usage.callsSuccess,
      cache_read_tokens: usage.callsFailed,
      cache_creation_tokens: usage.rateLimitHits,
      cost_usd: 0,
      duration_ms: usage.avgDurationMs,
      metadata: {
        type: "usage_snapshot",
        calls_by_model: usage.callsByModel,
        queue_depth: claudeQueue.length,
        active_tasks: activeTasks.size,
        uptime_hours: ((Date.now() - usage.uptimeSince) / 3600000).toFixed(1),
      },
    });
  } catch {}
}, 5 * 60 * 1000);

// Broadcast live status to nova_status table for Mini App dashboard (every 60s)
setInterval(() => {
  try {
    supabase.upsertNovaStatus({
      uptime_since: new Date(usage.uptimeSince).toISOString(),
      calls_total: usage.callsTotal,
      calls_success: usage.callsSuccess,
      calls_failed: usage.callsFailed,
      calls_by_model: usage.callsByModel,
      rate_limit_hits: usage.rateLimitHits,
      last_rate_limit_at: usage.lastRateLimitAt ? new Date(usage.lastRateLimitAt).toISOString() : null,
      avg_duration_ms: usage.avgDurationMs,
      active_slots: runningClaude,
      max_slots: MAX_CONCURRENT_CLAUDE,
      queue_depth: claudeQueue.length,
      active_tasks: activeTasks.size,
      pending_approvals: getPendingApprovalCount(),
    });
  } catch {}
}, 60_000);

// ============================================================
// CONCURRENCY LIMITER + REQUEST QUEUE
// ============================================================

const MAX_CONCURRENT_CLAUDE = 2;
let runningClaude = 0;
const claudeQueue: Array<{
  resolve: (v: void) => void;
  description: string;
  enqueuedAt: number;
  onDequeue?: () => void;
}> = [];

async function acquireClaudeSlot(description?: string, callbacks?: { onQueued?: () => void; onDequeue?: () => void }): Promise<void> {
  if (runningClaude < MAX_CONCURRENT_CLAUDE) {
    runningClaude++;
    return;
  }
  const position = claudeQueue.length + 1;
  console.log(`[queue] Slot full (${runningClaude}/${MAX_CONCURRENT_CLAUDE}), queuing: ${description?.substring(0, 50) || "unknown"} (#${position} waiting)`);
  callbacks?.onQueued?.();
  return new Promise((resolve) => {
    claudeQueue.push({ resolve, description: description || "unknown", enqueuedAt: Date.now(), onDequeue: callbacks?.onDequeue });
  });
}

function releaseClaudeSlot(): void {
  const next = claudeQueue.shift();
  if (next) {
    const waitMs = Date.now() - next.enqueuedAt;
    console.log(`[queue] Dequeuing: ${next.description.substring(0, 50)} (waited ${(waitMs / 1000).toFixed(1)}s)`);
    next.onDequeue?.();
    next.resolve();
  } else {
    runningClaude--;
  }
}

// ============================================================
// CALL CLAUDE — with model selection, retry, and monitoring
// ============================================================

type ModelTier = "haiku" | "sonnet" | "opus";

async function callClaude(prompt: string, model?: ModelTier, userId?: string, hint?: string, queueCallbacks?: { onQueued?: () => void; onDequeue?: () => void }): Promise<string> {
  await acquireClaudeSlot(prompt.substring(0, 60), queueCallbacks);

  const maxRetries = 2;
  let lastError: Error | null = null;

  try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          // Exponential backoff: 3s, 9s
          const delay = 3000 * Math.pow(3, attempt - 1);
          console.log(`[retry] Attempt ${attempt + 1}/${maxRetries + 1} after ${delay / 1000}s delay`);
          await new Promise((r) => setTimeout(r, delay));
        }
        return await _callClaudeOnce(prompt, model, userId, hint);
      } catch (error) {
        lastError = error as Error;
        const isRateLimit = lastError.message.includes("rate") || lastError.message.includes("overloaded");
        if (isRateLimit) {
          recordCall(false, model || "sonnet", 0, true);
          console.warn(`[rate-limit] Hit rate limit on attempt ${attempt + 1}`);
          continue; // retry
        }
        // Non-rate-limit errors: retry once, then give up
        if (attempt >= 1) break;
      }
    }

    throw lastError || new Error("Claude call failed after retries");
  } finally {
    releaseClaudeSlot();
  }
}

async function _callClaudeOnce(prompt: string, model?: ModelTier, userId?: string, hint?: string): Promise<string> {
  const args = [CLAUDE_PATH, "-p", prompt, "--output-format", "json", "--permission-mode", "bypassPermissions", "--max-turns", process.env.MAX_CLAUDE_TURNS || "50"];

  // Add model flag if specified (uses Max plan quota for all models)
  if (model) {
    args.push("--model", model);
  }

  // Per-user MCP config: if user has connected integrations, use their config
  // Smart routing: filter to only relevant servers based on hint
  if (userId && hasUserMcpConfig(userId)) {
    const mcpConfigPath = hint
      ? await getFilteredMcpConfigPath(userId, hint)
      : getUserMcpConfigPath(userId);
    args.push("--mcp-config", mcpConfigPath);
  }

  const modelLabel = model || "default";
  console.log(`Calling Claude [${modelLabel}] (${runningClaude}/${MAX_CONCURRENT_CLAUDE} slots, ${claudeQueue.length} queued): ${prompt.substring(0, 50)}...`);

  const startTime = Date.now();

  try {
    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        CLAUDECODE: undefined, // Allow nested Claude sessions
      },
    });

    const [output, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;
    const durationMs = Date.now() - startTime;

    if (exitCode !== 0) {
      // Log both stderr and stdout tail for diagnosis (stdout may contain error JSON)
      const stderrSnippet = stderr.trim() || "(empty stderr)";
      const stdoutTail = output.trim().slice(-500) || "(empty stdout)";
      console.error(`Claude error (exit ${exitCode}): stderr=${stderrSnippet} | stdout_tail=${stdoutTail}`);

      // Try to salvage a result from the JSON output even on non-zero exit
      // Claude CLI sometimes exits non-zero but still produces a valid result
      try {
        const json = JSON.parse(output.trim());
        if (json.result && typeof json.result === "string" && json.result.trim()) {
          console.warn(`[callClaude] Salvaged result from non-zero exit (code ${exitCode}, ${json.result.length} chars)`);
          recordCall(true, modelLabel, durationMs, false);
          if (json.usage) {
            trackCost({
              provider: "claude",
              model: json.model || modelLabel,
              input_tokens: json.usage?.input_tokens || 0,
              output_tokens: json.usage?.output_tokens || 0,
              cache_read_tokens: json.usage?.cache_read_input_tokens || 0,
              cache_creation_tokens: json.usage?.cache_creation_input_tokens || 0,
              cost_usd: json.cost_usd || json.total_cost_usd || 0,
              duration_ms: durationMs,
              session_id: json.session_id || undefined,
            });
          }
          return json.result;
        }
      } catch {
        // JSON parse failed — fall through to error
      }

      recordCall(false, modelLabel, durationMs, stderr.includes("rate") || stderr.includes("overloaded"));
      // Build a readable error instead of dumping raw JSON
      const isApiError = stderrSnippet.includes("APIError") || stderrSnippet.includes("status code");
      const detail = isApiError
        ? stderrSnippet.substring(0, 300)
        : stderr.trim() || `Claude CLI exited with code ${exitCode} (0 output tokens — likely an API or auth error)`;
      throw new Error(`Claude CLI exited with code ${exitCode}: ${detail}`);
    }

    // Parse JSON response to extract cost data
    try {
      const json = JSON.parse(output.trim());

      // Handle error subtypes from Claude CLI (e.g. error_max_turns, prompt too long)
      if (json.subtype === "error_max_turns") {
        console.warn(`[callClaude] Hit max turns (${json.num_turns} turns, ${durationMs}ms)`);
      }

      let result = typeof json.result === "string" ? json.result : "";

      // Warn if result is empty — Claude used tools but produced no final text
      if (!result.trim()) {
        console.warn(`[callClaude] Empty result from Claude CLI (${json.num_turns || "?"} turns, ${durationMs}ms). This usually means Claude used tools without a final text reply.`);
        result = "Sorry, I wasn't able to complete that request — I ran out of processing steps. Try simplifying your request or breaking it into smaller parts.";
      }

      const resolvedModel = json.model
        || json.metadata?.model
        || (typeof json.result === "object" && json.result?.model)
        || process.env.ANTHROPIC_MODEL
        || modelLabel;

      recordCall(true, resolvedModel, durationMs, false);

      if (json.usage) {
        trackCost({
          provider: "claude",
          model: resolvedModel,
          input_tokens: json.usage?.input_tokens || 0,
          output_tokens: json.usage?.output_tokens || 0,
          cache_read_tokens: json.usage?.cache_read_input_tokens || 0,
          cache_creation_tokens: json.usage?.cache_creation_input_tokens || 0,
          cost_usd: json.cost_usd || json.total_cost_usd || 0,
          duration_ms: durationMs,
          session_id: json.session_id || undefined,
        });
      }

      return result;
    } catch {
      recordCall(true, modelLabel, durationMs, false);
      return output.trim();
    }
  } catch (error) {
    if (error instanceof Error && (error.message.includes("Claude CLI exited") || error.message.includes("rate") || error.message.includes("overloaded"))) {
      throw error;
    }
    const durationMs = Date.now() - startTime;
    recordCall(false, modelLabel, durationMs, false);
    console.error("Spawn error:", error);
    throw new Error("Could not run Claude CLI");
  }
}

/**
 * Run a Claude task asynchronously — sends typing indicator, handles long-running
 * tasks with progress updates, and delivers the result when done.
 * Does NOT block the message handler, so Nova can work on multiple tasks at once.
 *
 * Accepts either a grammY Context (backward compat) or a PlatformContext (new channels).
 */
function runTask(
  ctx: Context | PlatformContext | any,
  taskDescription: string,
  buildTask: () => Promise<{ prompt: string; model?: ModelTier; hint?: string }>,
  opts?: { postProcess?: (response: string) => Promise<string>; userId?: string }
): void {
  const taskId = `task-${++taskCounter}`;
  const task: ActiveTask = {
    id: taskId,
    description: taskDescription,
    startTime: Date.now(),
    notified: false,
  };
  activeTasks.set(taskId, task);

  // Keep typing indicator alive
  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {});
  }, 4000);

  // Fire and forget — run the task asynchronously
  (async () => {
    try {
      const { prompt, model, hint: taskHint } = await buildTask();

      // Skip calling Claude for orchestrator sentinel prompts
      const taskUserId = opts?.userId || ((ctx as any).novaUser as NovaUser)?.id;
      const isSentinel = prompt.startsWith("__") && prompt.endsWith("__");
      const queueCallbacks = {
        onQueued: () => {
          ctx.reply("⏳ All slots are busy — your request is queued. I'll get to it shortly.").catch(() => {});
        },
        onDequeue: () => {
          ctx.reply("▶️ Your request is now being processed.").catch(() => {});
          ctx.replyWithChatAction("typing").catch(() => {});
        },
      };
      const rawResponse = isSentinel
        ? prompt
        : await callClaude(prompt, model, taskUserId, taskHint, queueCallbacks);

      const response = opts?.postProcess
        ? await opts.postProcess(rawResponse)
        : rawResponse;

      // Orchestrator handled the response internally — skip sending
      if (response === "__SKIP__") return;

      // Self-scheduling: if response contains <follow_up> tags, add to heartbeat checklist
      const followUpMatch = response.match(/<follow_up>([\s\S]*?)<\/follow_up>/i);
      if (followUpMatch) {
        appendToHeartbeat(followUpMatch[1].trim()).catch(() => {});
      }

      const userId = opts?.userId || ((ctx as any).novaUser as NovaUser)?.id;
      const channelType = (ctx as any).channelType || "telegram";
      if (userId) {
        await saveMessage("assistant", response, userId, undefined, channelType);
      }
      await sendResponseWithVoice(ctx, response, userId);

      // Auto-reload after self-edit: if the response mentions a self-edit commit
      // and production branch was pushed, schedule a process restart so the new code loads
      if (response.includes("self-edit:") || response.includes("self-edit/")) {
        try {
          const headProc = spawn(["git", "-C", PROJECT_ROOT, "log", "-1", "--format=%s"], { stdout: "pipe", stderr: "pipe" });
          const headMsg = (await new Response(headProc.stdout).text()).trim();
          await headProc.exited;
          if (headMsg.startsWith("self-edit:")) {
            console.log("[self-edit] Detected self-edit commit, scheduling auto-reload...");
            await ctx.reply("Reloading with new code... I'll be back in a few seconds.");
            setTimeout(() => {
              console.log("[self-edit] Auto-reload — exiting for systemd restart");
              process.exit(0);
            }, 1500);
          }
        } catch (e) {
          console.warn("[self-edit] Auto-reload check failed:", e);
        }
      }
    } catch (error) {
      const err = error as Error;
      console.error(`Task ${taskId} error:`, err);

      // Build a diagnostic error message instead of a generic one
      const errMsg = err.message || String(error);
      let msg: string;
      if (errMsg.includes("rate") || errMsg.includes("overloaded")) {
        msg = `⚠️ Claude API is rate-limited or overloaded. Try again in ~30 seconds.\n\n_Error: ${errMsg.substring(0, 200)}_`;
      } else if (errMsg.includes("exited with code")) {
        // Extract just the meaningful part — skip raw JSON garbage
        const codeMatch = errMsg.match(/exited with code (\d+)/);
        const exitCode = codeMatch ? codeMatch[1] : "?";
        const hasZeroOutput = errMsg.includes("0 output tokens");
        msg = hasZeroOutput
          ? `⚠️ Claude CLI failed (exit ${exitCode}) — the AI couldn't generate a response. This is usually a transient API error. Try again.`
          : `⚠️ Claude CLI crashed (exit ${exitCode}). Try again in a moment.`;
      } else if (errMsg.includes("No JSON found") || errMsg.includes("parse")) {
        msg = `⚠️ AI returned an unparseable response (likely a malformed reply from the model).\n\n_Error: ${errMsg.substring(0, 200)}_`;
      } else if (errMsg.includes("timeout") || errMsg.includes("ETIMEDOUT")) {
        msg = `⚠️ Request timed out — the task may have been too complex or the API is slow.\n\n_Error: ${errMsg.substring(0, 200)}_`;
      } else if (errMsg.toLowerCase().includes("prompt is too long") || errMsg.includes("too many tokens")) {
        msg = `⚠️ That message was too long for me to process. Try shortening it or breaking it into smaller parts.`;
      } else {
        msg = `⚠️ Something went wrong.\n\n_Error: ${errMsg.substring(0, 300)}_`;
      }

      await ctx.reply(msg, { parse_mode: "Markdown" }).catch(() => {});
    } finally {
      clearInterval(typingInterval);
      activeTasks.delete(taskId);
    }
  })();
}

// ============================================================
// PER-USER RATE LIMITING
// ============================================================

const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 10;           // max messages per window
const rateLimitMap = new Map<string, number[]>();

function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const timestamps = rateLimitMap.get(userId) || [];
  const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  rateLimitMap.set(userId, recent);
  return recent.length > RATE_LIMIT_MAX;
}

// Cleanup stale rate limit entries every 5 minutes to prevent memory bloat
setInterval(() => {
  const now = Date.now();
  for (const [userId, timestamps] of rateLimitMap) {
    const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (recent.length === 0) {
      rateLimitMap.delete(userId);
    } else {
      rateLimitMap.set(userId, recent);
    }
  }
}, 5 * 60 * 1000);

// ============================================================
// MESSAGE HANDLERS (all channels via adapter pattern)
// ============================================================

/** Shared message handler for all channels (Telegram, Slack, WhatsApp). */
const handleIncomingMessage = async (msg: IncomingMessage, reply: (m: any) => Promise<void>) => {
  // Get platform context (attached by adapter)
  const platformCtx: PlatformContext | any = (msg as any)._platformContext;
  const whatsappMeta = (msg as any)._whatsappMeta;
  const contactContext = (msg as any)._contactContext;

  // --- User resolution ---
  let user: NovaUser | null = null;
  if (msg.channelType === "whatsapp" && msg.userId) {
    // WhatsApp: userId already set by WhatsAppManager's classification pipeline
    user = await resolveUser(msg.userId, "telegram") || null;
    // Try by user ID directly if platform lookup fails
    if (!user) {
      const dbUser = supabase.getUserById(msg.userId);
      if (dbUser) {
        user = {
          id: dbUser.id,
          telegram_id: dbUser.telegram_id,
          name: dbUser.name,
          timezone: dbUser.timezone || "UTC",
          phone: dbUser.phone || "",
          role: dbUser.role,
          preferences: dbUser.preferences || {},
          profile_text: dbUser.profile_text || "",
        };
      }
    }
    if (!user) return;
    if (platformCtx) platformCtx.novaUser = user;
  } else if (msg.channelType === "telegram") {
    user = platformCtx?.novaUser || null;
  } else {
    user = await resolveUser(msg.platformUserId, msg.channelType);
    if (!user) {
      console.log(`Unauthorized ${msg.channelType}: ${msg.platformUserId}`);
      await reply({ text: "This bot is private. Ask the admin to add you." });
      return;
    }
    if (platformCtx) platformCtx.novaUser = user;
  }

  if (!user) return;

  // Use the platform context for all subsequent operations
  const ctx = platformCtx || createGenericPlatformContext(msg.channelType === "telegram"
    ? channels.getTelegram()!
    : channels.get(msg.channelType)!, msg.channelChatId, user);
  (ctx as any).novaUser = user;
  (ctx as any).channelType = msg.channelType;

  // --- TEXT MESSAGES ---
  if (msg.text) {
    const text = msg.text;
    (ctx as any).novaReplyTo = msg.channelMessageId;
    console.log(`[${msg.channelType}] Message from ${user.name}: ${text.substring(0, 50)}...`);

    // Rate limit check (skip for admin commands)
    if (!text.startsWith("/") && isRateLimited(user.id)) {
      await ctx.reply("You're sending messages too fast. Please wait a moment.");
      return;
    }

    // /voice toggle
    if (text.trim().toLowerCase() === "/voice") {
      if (!isTTSEnabled()) {
        await ctx.reply("Voice responses are not set up yet. Add ELEVENLABS_API_KEY to .env to enable.");
        return;
      }
      const enabled = await toggleVoiceResponses(supabase, user.id);
      await ctx.reply(
        enabled
          ? "Voice mode on. You can also toggle this in the Nova Mini App (Profile > Preferences)."
          : "Voice mode off. You can also toggle this in the Nova Mini App (Profile > Preferences)."
      );
      return;
    }

    // Handle admin commands (Telegram only — uses ctx.reply for rich formatting)
    if (text.startsWith("/") && user.role === "admin" && msg.channelType === "telegram") {
      const handled = await handleAdminCommand(ctx._raw || ctx, text, user);
      if (handled) return;
    }

    await ctx.replyWithChatAction("typing");
    await saveMessage("user", text, user.id, whatsappMeta || undefined, msg.channelType);

    // For WhatsApp contact messages, inject contact context into the orchestration
    if (contactContext && msg.channelType === "whatsapp") {
      (ctx as any)._whatsappContactContext = contactContext;
    }

    orchestrate(ctx._raw || ctx, text, user, supabase);
    return;
  }

  // --- VOICE MESSAGES ---
  if (msg.voice) {
    (ctx as any).novaReplyTo = msg.channelMessageId;
    console.log(`[${msg.channelType}] Voice message from ${user.name}: ${msg.voice.durationSec}s`);
    await ctx.replyWithChatAction("typing");

    if (!process.env.VOICE_PROVIDER) {
      await ctx.reply(
        "Voice transcription is not set up yet. " +
          "Run the setup again and choose a voice provider (Groq or local Whisper)."
      );
      return;
    }

    try {
      const transcription = await transcribe(msg.voice.buffer);
      if (!transcription) {
        await ctx.reply("Could not transcribe voice message.");
        return;
      }

      await saveMessage("user", `[Voice ${msg.voice.durationSec}s]: ${transcription}`, user.id, undefined, msg.channelType);

      runTask(ctx, `Voice: ${transcription.substring(0, 40)}`, async () => {
        const [relevantContext, memoryContext, recentHistory, taskContext, scheduleContext] = await Promise.all([
          getRelevantContext(supabase, transcription, user!.id),
          getMemoryContext(supabase, user!.id),
          getRecentHistory(supabase, user!.id),
          getTaskContext(supabase, user!.id),
          getScheduleContext(supabase, user!.id, user!.timezone),
        ]);
        return {
          prompt: buildPrompt(
            user!,
            `[Voice message transcribed]: ${transcription}`,
            relevantContext,
            memoryContext,
            recentHistory,
            taskContext,
            scheduleContext
          ),
          hint: transcription,
        };
      }, {
        postProcess: (raw) => processMemoryIntents(supabase, raw, user!.id, user!.timezone),
      });
    } catch (error) {
      console.error("Voice error:", error);
      await ctx.reply("Could not process voice message. Check logs for details.");
    }
    return;
  }

  // --- IMAGE MESSAGES ---
  if (msg.image) {
    (ctx as any).novaReplyTo = msg.channelMessageId;
    console.log(`[${msg.channelType}] Image received from ${user.name}`);
    await ctx.replyWithChatAction("typing");

    try {
      // Save image to disk
      const fileId = crypto.randomUUID();
      const filePath = join(UPLOADS_DIR, `image_${fileId}.jpg`);
      await writeFile(filePath, msg.image.buffer);

      const caption = msg.image.caption || "Analyze this image.";
      const memoryMode = isMemoryIntent(caption);
      await saveMessage("user", `[Image]: ${caption}`, user.id, undefined, msg.channelType);

      runTask(ctx, `Image: ${caption.substring(0, 40)}`, async () => {
        const [memoryContext, recentHistory, taskContext, scheduleContext] = await Promise.all([
          getMemoryContext(supabase, user!.id),
          getRecentHistory(supabase, user!.id),
          getTaskContext(supabase, user!.id),
          getScheduleContext(supabase, user!.id, user!.timezone),
        ]);
        const contextPrefix = [memoryContext, taskContext, scheduleContext, recentHistory].filter(Boolean).join("\n\n");
        const prompt = memoryMode
          ? buildMemoryExtractionPrompt(filePath, `image_${fileId}.jpg`, caption)
          : (contextPrefix ? contextPrefix + "\n\n" : "") + `[Image: ${filePath}]\n\n${caption}`;
        return { prompt, hint: caption };
      }, {
        postProcess: async (raw) => {
          setTimeout(() => unlink(filePath).catch(() => {}), 10 * 60 * 1000);
          return processMemoryIntents(supabase, raw, user!.id, user!.timezone);
        },
      });
    } catch (error) {
      console.error("Image error:", error);
      await ctx.reply("Could not process image.");
    }
    return;
  }

  // --- DOCUMENT MESSAGES ---
  if (msg.document) {
    (ctx as any).novaReplyTo = msg.channelMessageId;
    console.log(`[${msg.channelType}] Document from ${user.name}: ${msg.document.filename}`);
    await ctx.replyWithChatAction("typing");

    try {
      const timestamp = Date.now();
      const rawName = msg.document.filename || `file_${timestamp}`;
      const safeName = basename(rawName).replace(/[^a-zA-Z0-9._-]/g, "_").substring(0, 100);
      const filePath = join(UPLOADS_DIR, `${timestamp}_${safeName}`);
      if (!resolve(filePath).startsWith(resolve(UPLOADS_DIR))) {
        await ctx.reply("Invalid file name.");
        return;
      }

      await writeFile(filePath, msg.document.buffer);

      const caption = msg.document.caption || `Analyze: ${msg.document.filename}`;
      const memoryMode = isMemoryIntent(caption);
      await saveMessage("user", `[Document: ${msg.document.filename}]: ${caption}`, user.id, undefined, msg.channelType);

      runTask(ctx, `Doc: ${msg.document.filename}`, async () => {
        const [memoryContext, recentHistory, taskContext, scheduleContext] = await Promise.all([
          getMemoryContext(supabase, user!.id),
          getRecentHistory(supabase, user!.id),
          getTaskContext(supabase, user!.id),
          getScheduleContext(supabase, user!.id, user!.timezone),
        ]);
        const contextPrefix = [memoryContext, taskContext, scheduleContext, recentHistory].filter(Boolean).join("\n\n");
        const prompt = memoryMode
          ? buildMemoryExtractionPrompt(filePath, msg.document!.filename || "document", caption)
          : (contextPrefix ? contextPrefix + "\n\n" : "") + `[File: ${filePath}]\n\n${caption}`;
        return { prompt, hint: caption };
      }, {
        postProcess: async (raw) => {
          const delay = memoryMode ? 2 * 60 * 1000 : 0;
          if (delay > 0) {
            setTimeout(() => unlink(filePath).catch(() => {}), delay);
          } else {
            await unlink(filePath).catch(() => {});
          }
          return processMemoryIntents(supabase, raw, user!.id, user!.timezone);
        },
      });
    } catch (error) {
      console.error("Document error:", error);
      await ctx.reply("Could not process document.");
    }
    return;
  }
};

// Register message handler on all channel adapters
channels.onMessage(handleIncomingMessage);

// Wire the same handler into the WhatsApp per-user session manager
whatsappManager.setMessageHandler(handleIncomingMessage);

// ============================================================
// HELPERS
// ============================================================

/**
 * Prompt tier system — 3 levels of context injection:
 *   Tier 1 (minimal):  Greetings, acks, emojis → identity + history only (~500 tokens)
 *   Tier 2 (standard): General conversation → + memory + compact instructions (~3,000 tokens)
 *   Tier 3 (full):     Tool/integration requests → + capabilities + scheduling + full instructions (~6,000 tokens)
 */
type PromptTier = 1 | 2 | 3;

interface PromptNeeds {
  tier: PromptTier;
  needsMemoryTags: boolean;
  needsTaskTags: boolean;
  needsScheduleTags: boolean;
  needsSelfMod: boolean;
  needsCapabilities: boolean;
}

function detectPromptNeeds(text: string): PromptNeeds {
  const lower = text.toLowerCase().trim();

  // Tier 1: trivial — greetings, acks, emojis, short affirmations
  const tier1Patterns = [
    /^(?:hi|hello|hey|yo|sup|thanks|thank you|thx|ty|ok|okay|k|cool|nice|great|got it|sure|yep|yes|no|nah|nope|lol|haha|lmao|good|morning|gm|night|gn|bye|see ya|later|word|bet|dope|sick|awesome|perfect|sounds good|will do|on it|noted|roger|copy|ack|aight|right|exactly|true|same|agreed|fair|interesting|wow|damn|whoa|oh|ah|hmm|hm|mhm|yup|yea|yeah|naw)[\s!.?~]*$/i,
    /^.{1,5}$/,                  // Very short (1-5 chars)
    /^[\p{Emoji}\s!?.]+$/u,      // Emoji-only messages
    /^(?:ok|got it|sounds good|thank(?:s| you)|perfect|great|nice|cool|awesome|good one|love it|haha\w*|lol\w*|right on)\s*[!.?]*$/i,
  ];
  const isTier1 = tier1Patterns.some((p) => p.test(lower));

  if (isTier1) {
    return { tier: 1, needsMemoryTags: false, needsTaskTags: false, needsScheduleTags: false, needsSelfMod: false, needsCapabilities: false };
  }

  // Detect specific instruction needs
  const needsMemoryTags = /(?:remember|memorize|save|store|forget|goal|done|share with team)/i.test(lower);
  const needsTaskTags = /(?:task|todo|assign|delegate|block|cancel task|pending)/i.test(lower);
  const needsScheduleTags = /(?:remind|schedule|alarm|timer|recur|every day|every week|follow up|check in)/i.test(lower);
  const needsSelfMod = /(?:self-edit|fix yourself|change how you|modify your|edit your (?:code|source)|update your|improve your|add.*agent|create.*agent|new skill|edit.*relay|change.*prompt|change.*code|edit.*changelog|modify.*source)/i.test(lower);

  // Tier 3: needs integrations/tools — trigger on action verbs + tool mentions
  const needsCapabilities = /(?:email|gmail|send|draft|calendar|event|meeting|zoom|call|phone|sms|text|notion|page|database|square|invoice|order|payment|revenue|ghl|high.?level|contact|crm|pipeline|opportunity|lead|cloudflare|deploy|worker|dns|browse|website|screenshot|navigate|search.*(?:web|online|google)|create.*(?:file|doc|pdf|slide|sheet|presentation|image|video|poster|design)|download|upload|organize|file)/i.test(lower);

  const tier: PromptTier = needsCapabilities || needsScheduleTags || needsSelfMod ? 3 : 2;

  return { tier, needsMemoryTags, needsTaskTags, needsScheduleTags, needsSelfMod, needsCapabilities };
}

/**
 * Detect if a caption/message signals the user wants to store the file contents to memory.
 */
function isMemoryIntent(text: string): boolean {
  const lower = text.toLowerCase();
  const phrases = [
    "remember this",
    "save to memory",
    "store this",
    "memorize",
    "learn this",
    "ingest this",
    "save this",
    "remember these",
    "store these",
    "memorize this",
  ];
  return phrases.some((p) => lower.includes(p));
}

/**
 * Build a prompt that tells Claude to analyze the file AND extract discrete facts
 * as [REMEMBER: ...] tags for memory storage.
 */
function buildMemoryExtractionPrompt(filePath: string, fileName: string, caption: string): string {
  return (
    `[File: ${filePath}]\n\n` +
    `The user sent this file ("${fileName}") and wants its key information saved to memory.\n\n` +
    `Instructions:\n` +
    `1. Analyze the file thoroughly and give a brief summary to the user.\n` +
    `2. Extract every discrete, self-contained fact from the document as [REMEMBER: From ${fileName}: fact] tags.\n` +
    `3. Prioritize: names, dates, numbers, amounts, decisions, action items, key concepts, relationships, deadlines, terms, and conditions.\n` +
    `4. Each [REMEMBER: ...] tag should contain ONE fact — not a summary paragraph.\n` +
    `5. Include enough context in each tag so it's useful on its own (e.g., "From contract.pdf: Payment terms are Net 30" not just "Net 30").\n` +
    `6. At the end, tell the user how many facts were stored.\n\n` +
    `User's caption: ${caption}`
  );
}

/**
 * Truncate a section to fit within a character budget.
 * For list-style sections (lines starting with -), drops middle items.
 * For prose, keeps first and last portions.
 */
function truncateSection(text: string, maxChars: number): string {
  if (!text || text.length <= maxChars) return text;

  const lines = text.split("\n");
  // First line is usually the header (e.g., "FACTS:", "ACTIVE TASKS:")
  const header = lines[0];
  const items = lines.slice(1);

  if (items.length <= 2) {
    // Too few items to drop from middle — hard truncate
    const truncated = text.slice(0, maxChars - 40);
    const lastNewline = truncated.lastIndexOf("\n");
    return (lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated) +
      `\n[...truncated ${text.length - maxChars + 40} chars...]`;
  }

  // Drop items from the middle until within budget
  let kept = [...items];
  while (kept.join("\n").length + header.length + 1 > maxChars && kept.length > 2) {
    const mid = Math.floor(kept.length / 2);
    kept.splice(mid, 1);
  }

  const dropped = items.length - kept.length;
  if (dropped > 0) {
    const mid = Math.floor(kept.length / 2);
    kept.splice(mid, 0, `[...${dropped} items truncated...]`);
  }

  return header + "\n" + kept.join("\n");
}

function buildPrompt(
  user: NovaUser,
  userMessage: string,
  relevantContext?: string,
  memoryContext?: string,
  recentHistory?: string,
  taskContext?: string,
  scheduleContext?: string,
  options?: { ghlLocationId?: string; contactContext?: string }
): string {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: user.timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  // Context budget — cap dynamic sections to prevent prompt overflow
  const MAX_CONTEXT_CHARS = 24_000;
  const budgets = {
    recentHistory: Math.floor(MAX_CONTEXT_CHARS * 0.35),   // 8,400 chars
    memoryContext: Math.floor(MAX_CONTEXT_CHARS * 0.25),    // 6,000 chars
    relevantContext: Math.floor(MAX_CONTEXT_CHARS * 0.20),  // 4,800 chars
    taskContext: Math.floor(MAX_CONTEXT_CHARS * 0.10),      // 2,400 chars
    scheduleContext: Math.floor(MAX_CONTEXT_CHARS * 0.10),  // 2,400 chars
  };

  // Apply truncation to each dynamic section
  const tRecentHistory = recentHistory ? truncateSection(recentHistory, budgets.recentHistory) : undefined;
  const tMemoryContext = memoryContext ? truncateSection(memoryContext, budgets.memoryContext) : undefined;
  const tRelevantContext = relevantContext ? truncateSection(relevantContext, budgets.relevantContext) : undefined;
  const tTaskContext = taskContext ? truncateSection(taskContext, budgets.taskContext) : undefined;
  const tScheduleContext = scheduleContext ? truncateSection(scheduleContext, budgets.scheduleContext) : undefined;

  // Resolve GHL location ID from cache or options
  const ghlLocationId = options?.ghlLocationId || ghlLocationCache.get(user.id);
  const contactContext = options?.contactContext;

  // Detect what instruction blocks this message actually needs
  const needs = detectPromptNeeds(userMessage);

  const parts = [
    "You are a personal AI assistant responding via messaging. Keep responses concise and conversational.",
  ];

  // WhatsApp contact context — override identity when responding on behalf of user
  if (contactContext) {
    parts.push(contactContext);
  } else {
    parts.push(`You are speaking with ${user.name}.`);
  }
  parts.push(`Current time: ${timeStr}`);

  // ── TIER 1 (minimal): identity + history only ──
  if (user.profile_text) parts.push(`\nProfile:\n${user.profile_text}`);
  if (tRecentHistory) parts.push(`\n${tRecentHistory}`);

  if (needs.tier === 1) {
    // Minimal prompt — just respond naturally
    parts.push(`\nUser: ${userMessage}`);
    const prompt = parts.join("\n");
    console.log(`[prompt] T1 ${prompt.length} chars (~${Math.round(prompt.length / 4)} tokens)`);
    return prompt;
  }

  // ── TIER 2+ (standard): add memory, tasks, context ──
  if (tMemoryContext) parts.push(`\n${tMemoryContext}`);
  if (tTaskContext) parts.push(`\n${tTaskContext}`);
  if (tScheduleContext) parts.push(`\n${tScheduleContext}`);
  if (tRelevantContext) parts.push(`\n${tRelevantContext}`);

  // Compact memory tags (always included at tier 2+)
  parts.push(
    "\nMEMORY TAGS (auto-processed, hidden from user):" +
      "\n[REMEMBER: fact] — durable facts (identity, business, preferences, patterns). Skip if it won't matter in 30 days." +
      "\n[SHARE: fact] — team-visible. Only when user explicitly says to share." +
      "\n[GOAL: text | DEADLINE: date] / [DONE: search text]" +
      "\nNEVER remember: one-time events, calendar items, transient tasks, conversations, system details. Use calendar for events."
  );

  // Compact task tags
  if (needs.needsTaskTags || needs.tier >= 2) parts.push(
    "\nTASK TAGS: [TASK: Agent | desc] [TASK_START: text] [TASK_DONE: text | result] [TASK_BLOCKED: text | reason] [TASK_CANCEL: text]"
  );

  // Schedule tags — compact at tier 2, full syntax at tier 3
  if (needs.needsScheduleTags) parts.push(
    "\nSCHEDULING:" +
      "\n[SCHEDULE: title | datetime | instructions] [SCHEDULE: ... | RECUR: rule] [SCHEDULE: ... | RECUR: rule | IF: condition]" +
      "\n[SCHEDULE_CANCEL: title] Datetime: ISO (2026-02-21T15:00:00) or relative (+30m, +2h, +1d)" +
      "\nRECUR: daily:HH:MM | weekly:DAY:HH:MM | weekdays:HH:MM | interval:SECONDS" +
      "\nProactively schedule follow-ups when useful. " + user.name + " benefits from anticipatory check-ins."
  );

  // Response protocol (tier 2+)
  parts.push(
    "\nRESPONSE RULES:" +
      "\n• Casual, clean, result-focused. No file paths, no internal steps, no bash commands in output." +
      "\n• Send files via /telegram-file-sender. Generated images/files MUST be sent this way." +
      "\n• [BUTTONS: A | B | C] for quick choices (max 6, short labels). Hidden tag — user sees buttons only." +
      "\n• Handle multiple requests in parallel." +
      "\n" +
      "\nHONESTY PROTOCOL:" +
      "\n• NEVER report work as complete unless you verified output exists (check files with ls/stat)." +
      "\n• If a tool call fails, tell the user immediately — do not pretend it succeeded." +
      "\n• If a task is partially complete, say exactly what succeeded and what failed." +
      "\n• When building projects: run ls on the output directory before saying \"it's ready.\"" +
      "\n• NEVER fabricate file paths, line counts, or build results." +
      "\n" +
      "\nPERMISSIONS:" +
      "\n• If you encounter EACCES/EPERM, ask: \"I need permission to [action]. Can you grant access or suggest another path?\"" +
      "\n• Before creating directories outside the workspace, tell the user where and ask for confirmation." +
      "\n• Never silently skip steps due to permission errors."
  );

  // ── TIER 3 (full): add capabilities, skills, self-improvement ──
  if (needs.tier === 3) {
    parts.push(
      "\nCAPABILITIES:" +
        "\n• Gmail & Calendar: Read, search, draft, send emails. View, create, update events." +
        "\n• Notion: Search, read, create, update pages and databases." +
        "\n• Zoom: Create/update meetings. Create Zoom meeting first, then add to Calendar with join link." +
        "\n• Web Browser (Playwright): Navigate URLs, screenshots, fill forms, click buttons." +
        "\n• Web Search: Built-in. Use for current events and lookups." +
        "\n• Apple Notes/Contacts: Via osascript. Always look up contacts before calling/texting." +
        "\n• Phone/SMS (Twilio):" +
        (user.phone ? ` ${user.name}'s phone: ${user.phone}.` : "") +
        `\n  SMS: bun run ${PROJECT_ROOT}/src/twilio.ts sms "<phone>" "msg"` +
        `\n  Call: bun run ${PROJECT_ROOT}/src/twilio.ts call "<phone>" "context"` +
        `\n  Third-party: bun run ${PROJECT_ROOT}/src/twilio.ts call-thirdparty "+1234567890" "Name" "subject"` +
        "\n• Square: Orders, payments, catalog. Locations: Open Source Mind ID: LA50ZWAK48MD8 | Zaarvy AI ID: LNCSX2ST6EKCY" +
        "\n  Reports: always BOTH locations + combined total. Writes: ask which location first." +
        "\n• GHL (CRM): Contacts, calendars, opportunities, conversations, templates, blog, social, invoices." +
        (ghlLocationId ? ` Location: ${ghlLocationId}.` : "") +
        " Cannot create pipelines/forms/funnels/workflows. Confirm before modifying." +
        "\n• Cloudflare: DNS, Workers. Task Scheduler: bun run " + PROJECT_ROOT + "/src/scheduler.ts list|create" +
        "\n• File System & Terminal: Full access." +
        "\nAlways confirm before consequential actions (sending emails, calls, modifying contacts)."
    );

    parts.push(
      "\nSKILLS:" +
        "\n/ai-video-creator, /book-formatter, /canvas-design, /competitive-ads-extractor," +
        "\n/content-architect, /content-research-writer, /customer-support, /docx," +
        "\n/email-marketing, /file-organizer, /ghostwriter, /image-gen," +
        "\n/lead-research-assistant, /md-to-docx, /meta-ads-manager, /notebooklm," +
        "\n/pdf, /platform-maker, /pptx, /reviews-testimonials," +
        "\n/social-media-manager, /voice-extractor, /xlsx," +
        "\n/skill-creator, /telegram-file-sender"
    );

    parts.push(
      "\nSELF-IMPROVEMENT:" +
        "\n• Detect repeating patterns → suggest or create skills via /skill-creator." +
        "\n• Use [REMEMBER:] for durable facts, [GOAL:]/[DONE:] for tracking." +
        "\n• Suggest automating manual workflows."
    );
  }

  if (user.role === "admin" && needs.needsSelfMod) {
    parts.push(
      "\nSELF-MODIFICATION — You can edit your own source code:" +
        `\n• Your source code lives at: ${PROJECT_ROOT}` +
        `\n• Key files:` +
        `\n  - src/relay.ts — Main bot, message handlers, system prompt` +
        `\n  - src/orchestrator.ts — Task routing (simple vs complex)` +
        `\n  - src/planner.ts — Task decomposition and execution` +
        `\n  - src/agent-router.ts — Agent definitions, tool mappings, prompt building` +
        `\n  - src/patterns.ts — Execution pattern learning` +
        `\n  - src/memory.ts — Memory and context retrieval` +
        `\n  - src/settings.ts — User settings` +
        `\n  - .claude/agents/*.md — Agent personality files (frontmatter + markdown)` +
        `\n  - .claude/skills/*/ — Skill definitions` +
        `\n  - CHANGELOG.md — Your modification log (YOU maintain this)` +
        "\n" +
        "\nWhen " + user.name + " asks you to fix, improve, or change how you work:" +
        "\n1. Create a feature branch from production: `git -C " + PROJECT_ROOT + " checkout -b self-edit/<short-slug> production`" +
        "\n2. Read the relevant file(s) to understand the current code" +
        "\n3. Make the change using your file editing tools" +
        "\n4. Log the change in CHANGELOG.md (see format below)" +
        "\n5. Commit: `git -C " + PROJECT_ROOT + " add -A && git -C " + PROJECT_ROOT + " commit -m \"self-edit: <description>\"`" +
        "\n6. Merge to main and push: `git -C " + PROJECT_ROOT + " checkout main && git -C " + PROJECT_ROOT + " merge self-edit/<short-slug> && git -C " + PROJECT_ROOT + " push origin main`" +
        "\n7. Merge to production and push: `git -C " + PROJECT_ROOT + " checkout production && git -C " + PROJECT_ROOT + " merge main && git -C " + PROJECT_ROOT + " push origin production`" +
        "\n8. Clean up: `git -C " + PROJECT_ROOT + " branch -d self-edit/<short-slug>`" +
        "\n9. Tell " + user.name + " what you changed. The relay will detect the self-edit commit and auto-reload with the new code." +
        "\n" +
        `\nCHANGELOG.md — You MUST maintain ${PROJECT_ROOT}/CHANGELOG.md. Append an entry for EVERY modification:` +
        "\n  Format:" +
        "\n  ## [YYYY-MM-DD HH:MM] <trigger>" +
        "\n  **Trigger:** user-request | auto-correction | self-learning | agent-creation" +
        "\n  **Files:** list of files modified" +
        "\n  **Summary:** what changed and why" +
        "\n  **Risk:** low | medium | high" +
        "\n  ---" +
        "\n" +
        "\nAGENT CREATION — When " + user.name + " asks you to create a new agent:" +
        "\n1. Ask for: agent name, description (one-liner), personality, core capabilities" +
        "\n2. If " + user.name + " sends knowledge base files (PDFs, docs), save them to `agent-team/` and reference them in the agent" +
        "\n3. Create the agent file at `.claude/agents/<slug>.md` using this format:" +
        "\n   ---" +
        "\n   name: AgentName" +
        "\n   description: One-line description for the catalog" +
        "\n   ---" +
        "\n   # AgentName — Role Title" +
        "\n   You are **AgentName**, a [personality]. [Backstory]." +
        "\n   ## Personality" +
        "\n   [2-3 sentences]" +
        "\n   ## Core Capabilities" +
        "\n   1. **Capability** — description" +
        "\n   ## Playbook" +
        "\n   [numbered rules]" +
        "\n   ## Knowledge Base" +
        "\n   - `agent-team/knowledge_bases/<file>`" +
        "\n4. Add the agent's tool mapping to `src/agent-router.ts` in the AGENT_TOOLS object" +
        "\n   Pick from available MCP tools: Google Workspace (Gmail, Calendar, Docs, Sheets, Slides, Drive, Chat), " +
        "Notion, Playwright (browser), Go High Level (CRM), Square (payments), Cloudflare (deploy), Zoom (meetings), Supabase (database)" +
        "\n   And skills: /image-gen, /canvas-design, /docx, /xlsx, /pptx, /pdf, /content-research-writer, " +
        "/competitive-ads-extractor, /lead-research-assistant, /ghostwriter, /platform-maker, /notebooklm, /telegram-file-sender, /skill-creator" +
        "\n5. Log in CHANGELOG.md and commit (follow the self-edit git workflow above)" +
        "\n" +
        "\nAUTO-CORRECTION — When you encounter errors, try to fix them yourself:" +
        "\n• If a subtask fails with a code error (syntax, import, type), read the file, identify the bug, and fix it." +
        "\n• If a skill invocation fails, check the skill's README and adjust parameters." +
        "\n• If an MCP tool call fails, check the error message and retry with corrected parameters." +
        "\n• If you successfully auto-correct, log it in CHANGELOG.md with trigger: auto-correction." +
        "\n• If you cannot fix it after one attempt, report the error to " + user.name + " with diagnostics." +
        "\n• NEVER auto-correct core files (relay.ts, orchestrator.ts) without telling " + user.name + " first." +
        "\n• For agent/skill files, you may auto-correct silently and report what you fixed." +
        "\n" +
        "\nSELF-LEARNING — You evolve by detecting patterns and creating reusable capabilities:" +
        "\n" +
        "\n1. SKILL CREATION FROM REPETITION:" +
        "\n   When you notice " + user.name + " has asked for the same type of task 3+ times:" +
        "\n   - Identify the pattern (e.g., \"generate Instagram carousel for product\")" +
        "\n   - Use /skill-creator to build a dedicated skill that automates the workflow" +
        "\n   - Tell " + user.name + ": \"I noticed you do [pattern] often. I created a /[skill-name] skill for it.\"" +
        "\n   - Log it in CHANGELOG.md with trigger: self-learning" +
        "\n" +
        "\n2. AGENT SPECIALIZATION:" +
        "\n   When you notice a recurring problem domain that doesn't fit existing agents:" +
        "\n   - After seeing 3+ requests in that domain, propose creating a specialist agent" +
        "\n   - If " + user.name + " agrees (or says \"just do it\"), create the agent automatically" +
        "\n   - Give it the right MCP tools and skills for its domain" +
        "\n   - Log it in CHANGELOG.md with trigger: self-learning" +
        "\n" +
        "\n3. PROMPT REFINEMENT:" +
        "\n   When an agent consistently produces poor results for a task type:" +
        "\n   - Identify what's going wrong (too verbose, missing context, wrong tool usage)" +
        "\n   - Edit the agent's .md file or AGENT_TOOLS entry to improve instructions" +
        "\n   - Log it in CHANGELOG.md with trigger: auto-correction" +
        "\n" +
        "\n4. WORKFLOW OPTIMIZATION:" +
        "\n   When you notice an execution pattern that's slow or wasteful:" +
        "\n   - Adjust decomposition prompts or dependency chains" +
        "\n   - Cache intermediate results that get reused" +
        "\n   - Log it in CHANGELOG.md with trigger: self-learning" +
        "\n" +
        "\nSAFETY RULES FOR SELF-MODIFICATION:" +
        "\n• ALWAYS git commit before AND after changes (never lose work)" +
        "\n• ALWAYS log every change in CHANGELOG.md" +
        "\n• NEVER modify .env or credentials files" +
        "\n• NEVER delete files without asking " + user.name + " first" +
        "\n• For core files (relay.ts, orchestrator.ts, planner.ts): describe the plan first and ask for confirmation" +
        "\n• For agent/skill files: you may edit freely but always log it" +
        "\n• If something breaks, tell " + user.name + " and offer to revert: `git -C " + PROJECT_ROOT + " revert HEAD`" +
        "\n• Max 5 self-initiated changes per day without explicit user request (prevents runaway self-modification)"
    );
  }

  parts.push(`\nUser: ${userMessage}`);

  const prompt = parts.join("\n");
  console.log(`[prompt] T${needs.tier} ${prompt.length} chars (~${Math.round(prompt.length / 4)} tokens)`);
  return prompt;
}

// ============================================================
// ADMIN COMMANDS
// ============================================================

async function handleAdminCommand(ctx: Context, text: string, user: NovaUser): Promise<boolean> {

  const parts = text.trim().split(/\s+/);
  const command = parts[0].toLowerCase();

  // Migrated to Mini App: /adduser, /removeuser, /listusers
  if (command === "/adduser" || command === "/removeuser" || command === "/listusers") {
    await ctx.reply("This command has moved to the Nova Mini App (Users tab).");
    return true;
  }

  if (command === "/share") {
    // /share <fact> — shortcut to insert shared memory
    const fact = parts.slice(1).join(" ");
    if (!fact) {
      await ctx.reply("Usage: /share <fact to share with team>");
      return true;
    }

    try {
      const { generateEmbedding } = await import("./embeddings.ts");
      const embedding = await generateEmbedding(fact);
      supabase.insertMemory({
        type: "fact",
        content: fact,
        user_id: user.id,
        scope: "shared",
        embedding: embedding || undefined,
      });
      await ctx.reply(`Shared with team: "${fact}"`);
    } catch (e: any) {
      await ctx.reply(`Error: ${e.message}`);
    }
    return true;
  }

  // System status overview
  if (command === "/status") {
    const uptime = Date.now() - usage.uptimeSince;
    const uptimeH = Math.floor(uptime / 3600000);
    const uptimeM = Math.floor((uptime % 3600000) / 60000);

    // Slots & queue
    const slotsLine = `${runningClaude}/${MAX_CONCURRENT_CLAUDE} slots in use`;
    const queueLine = claudeQueue.length > 0
      ? `${claudeQueue.length} request(s) queued`
      : "No queued requests";

    // Active tasks
    let tasksBlock = "";
    if (activeTasks.size > 0) {
      const taskLines: string[] = [];
      for (const [, task] of activeTasks) {
        const elapsed = ((Date.now() - task.startTime) / 1000).toFixed(0);
        taskLines.push(`  • ${task.description.substring(0, 50)} (${elapsed}s)`);
      }
      tasksBlock = `\n\n<b>Active Tasks</b>\n${taskLines.join("\n")}`;
    }

    // Usage stats
    const successRate = usage.callsTotal > 0
      ? ((usage.callsSuccess / usage.callsTotal) * 100).toFixed(1)
      : "0";
    const avgDur = usage.callsTotal > 0
      ? (usage.avgDurationMs / 1000).toFixed(1)
      : "0";

    // Model breakdown
    let modelLines = "";
    const models = Object.entries(usage.callsByModel).sort(([, a], [, b]) => b - a);
    if (models.length > 0) {
      modelLines = models.map(([m, c]) => `  ${m}: ${c}`).join("\n");
    }

    // Cost today
    let costLine = "";
    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayEntries = supabase.getCostEntries({ since: todayStart.toISOString() });
      const todayCost = (todayEntries as any[]).reduce((sum: number, e: any) => sum + (e.cost_usd || 0), 0);
      costLine = `\nCost today: $${todayCost.toFixed(4)}`;
    } catch {}

    // Pending approvals
    const pendingApprovals = getPendingApprovalCount();
    const approvalsLine = pendingApprovals > 0
      ? `\nPending approvals: ${pendingApprovals}`
      : "";

    // WhatsApp sessions
    const waSessions = whatsappManager.getActiveSessions();
    const waLine = waSessions.length > 0
      ? `\nWhatsApp: ${waSessions.filter(s => s.status.state === "connected").length}/${waSessions.length} connected`
      : "";

    // Rate limits
    const rlLine = usage.rateLimitHits > 0
      ? `\nRate limit hits: ${usage.rateLimitHits}${usage.lastRateLimitAt ? ` (last: ${new Date(usage.lastRateLimitAt).toLocaleTimeString()})` : ""}`
      : "";

    const statusMsg = `<b>Nova System Status</b>

<b>Uptime</b>: ${uptimeH}h ${uptimeM}m
<b>Slots</b>: ${slotsLine}
<b>Queue</b>: ${queueLine}${tasksBlock}

<b>Usage</b> (this session)
Calls: ${usage.callsTotal} (${successRate}% success)
Avg duration: ${avgDur}s${costLine}${rlLine}${approvalsLine}${waLine}
${modelLines ? `\n<b>Models</b>\n${modelLines}` : ""}
<i>Full dashboard: nova.07labs.com</i>`;

    await ctx.reply(statusMsg, { parse_mode: "HTML" });
    return true;
  }

  if (command === "/reload") {
    // Safety check: show diff of uncommitted changes so admin knows what's being applied
    try {
      const diffProc = spawn(["git", "-C", PROJECT_ROOT, "diff", "--stat", "HEAD"], { stdout: "pipe", stderr: "pipe" });
      const diffOut = await new Response(diffProc.stdout).text();
      await diffProc.exited;
      if (diffOut.trim()) {
        await ctx.reply(`Uncommitted changes:\n${diffOut.trim()}\n\nReloading...`);
      } else {
        await ctx.reply("Reloading Nova... I'll be back in a few seconds.");
      }
    } catch {
      await ctx.reply("Reloading Nova... I'll be back in a few seconds.");
    }
    // Give the message time to send, then restart the process
    // launchd (KeepAlive=true) will restart us automatically
    setTimeout(() => {
      console.log("[reload] Admin requested reload — exiting for launchd restart");
      process.exit(0);
    }, 1000);
    return true;
  }

  if (command === "/revert") {
    // Revert the last git commit (safety net for self-edits)
    try {
      const proc = spawn(["git", "-C", PROJECT_ROOT, "log", "--oneline", "-5"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(proc.stdout).text();
      await proc.exited;

      const lines = output.trim().split("\n");
      const lastCommit = lines[0] || "(no commits)";

      if (parts[1] === "confirm") {
        const revertProc = spawn(["git", "-C", PROJECT_ROOT, "revert", "--no-edit", "HEAD"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const revertErr = await new Response(revertProc.stderr).text();
        const revertCode = await revertProc.exited;

        if (revertCode !== 0) {
          await ctx.reply(`Revert failed: ${revertErr.trim()}\nYou may need to resolve this manually.`);
        } else {
          await ctx.reply(`Reverted: ${lastCommit}\nSend /reload to apply the revert.`);
        }
      } else {
        await ctx.reply(
          `Last 5 commits:\n${output.trim()}\n\nTo revert the latest commit, send:\n/revert confirm`
        );
      }
    } catch (e: any) {
      await ctx.reply(`Error: ${e.message}`);
    }
    return true;
  }

  // Migrated to Mini App: /schedules, /agents
  if (command === "/schedules") {
    await ctx.reply("Scheduled tasks have moved to the Nova Mini App (Schedules tab).");
    return true;
  }

  if (command === "/agents") {
    await ctx.reply("Agent list has moved to the Nova Mini App (Agents tab).");
    return true;
  }

  // Not an admin command — fall through to normal handling
  return false;
}

// markdownToTelegramHTML, parseButtons, cleanResponseForUser are imported from ./channels/telegram.ts

/**
 * Send a text response to any channel. Uses Telegram HTML for Telegram, plain text for others.
 */
/**
 * Split text into chunks that respect code blocks, tables, and list boundaries.
 * Avoids splitting inside ``` blocks or mid-table.
 */
function smartSplit(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) { chunks.push(remaining); break; }

    // Find a safe split point within maxLength
    const window = remaining.substring(0, maxLength);

    // Don't split inside a code block — find the last complete code block boundary
    const codeBlockPositions: number[] = [];
    let searchFrom = 0;
    while (true) {
      const idx = window.indexOf("```", searchFrom);
      if (idx === -1) break;
      codeBlockPositions.push(idx);
      searchFrom = idx + 3;
    }

    // If odd number of ``` markers, we're inside a code block — split before the last opening ```
    const insideCodeBlock = codeBlockPositions.length % 2 !== 0;
    let splitIndex: number;

    if (insideCodeBlock && codeBlockPositions.length > 0) {
      // Split before the unclosed code block
      splitIndex = codeBlockPositions[codeBlockPositions.length - 1];
      // Back up to the previous newline for a clean break
      const nlBefore = remaining.lastIndexOf("\n", splitIndex);
      if (nlBefore > maxLength / 4) splitIndex = nlBefore;
    } else {
      // Split at paragraph boundary, then line boundary
      splitIndex = window.lastIndexOf("\n\n");
      // Avoid splitting inside a table (lines starting with |)
      if (splitIndex > 0) {
        const afterSplit = remaining.substring(splitIndex + 2, splitIndex + 50);
        if (afterSplit.trimStart().startsWith("|")) {
          // Inside a table — look for the table start and split before it
          const tableStart = remaining.lastIndexOf("\n\n", splitIndex - 1);
          if (tableStart > maxLength / 4) splitIndex = tableStart;
        }
      }
      if (splitIndex === -1 || splitIndex < maxLength / 4) {
        splitIndex = window.lastIndexOf("\n");
      }
      if (splitIndex === -1 || splitIndex < maxLength / 4) {
        splitIndex = window.lastIndexOf(" ");
      }
      if (splitIndex === -1 || splitIndex < maxLength / 4) {
        splitIndex = maxLength;
      }
    }

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  return chunks;
}

async function sendResponse(ctx: Context | PlatformContext | any, response: string): Promise<void> {
  const channelType = (ctx as any).channelType || "telegram";

  if (channelType === "telegram") {
    // Telegram: send with HTML formatting
    const html = markdownToTelegramHTML(response);
    const MAX_LENGTH = 4000;
    const replyTo = (ctx as any).novaReplyTo as number | undefined;
    const replyOpts = replyTo ? { reply_parameters: { message_id: replyTo } } : {};

    if (html.length <= MAX_LENGTH) {
      await ctx.reply(html, { parse_mode: "HTML", ...replyOpts }).catch(async () => {
        await ctx.reply(response, replyOpts);
      });
      delete (ctx as any).novaReplyTo;
      return;
    }

    const chunks = smartSplit(html, MAX_LENGTH);
    for (let i = 0; i < chunks.length; i++) {
      const opts = i === 0 ? { parse_mode: "HTML" as const, ...replyOpts } : { parse_mode: "HTML" as const };
      await ctx.reply(chunks[i], opts).catch(async () => { await ctx.reply(chunks[i]); });
    }
    delete (ctx as any).novaReplyTo;
  } else {
    // WhatsApp/Slack: send plain text via adapter
    const adapter = (ctx as PlatformContext).adapter;
    if (adapter) {
      const chatId = String(ctx.chat?.id || "");
      await adapter.send(chatId, { text: response });
    } else {
      await ctx.reply(response);
    }
  }
}

/**
 * Send response with voice and button support — works across all channels.
 */
async function sendResponseWithVoice(
  ctx: Context | PlatformContext | any,
  response: string,
  userId?: string
): Promise<void> {
  const cleaned = cleanResponseForUser(response);

  if (!cleaned) {
    await ctx.reply("Done — but I didn't have any text to send back. Let me know if something's missing.");
    return;
  }

  const channelType = (ctx as any).channelType || "telegram";
  const { text, buttons } = parseButtons(cleaned);

  if (buttons && buttons.length > 0) {
    const adapter = (ctx as PlatformContext)?.adapter || channels.get(channelType);
    if (adapter) {
      // For Telegram, use the rich HTML + inline keyboard path
      if (channelType === "telegram") {
        const { InlineKeyboard } = await import("grammy");
        const keyboard = new InlineKeyboard();
        for (let i = 0; i < buttons.length; i++) {
          keyboard.text(buttons[i].label, buttons[i].callbackData);
          if ((i + 1) % 3 === 0 && i < buttons.length - 1) keyboard.row();
        }
        const html = markdownToTelegramHTML(text);
        const MAX_LENGTH = 4000;
        const replyTo = (ctx as any).novaReplyTo as number | undefined;
        const replyOpts = replyTo ? { reply_parameters: { message_id: replyTo } } : {};

        if (html.length <= MAX_LENGTH) {
          await ctx.reply(html, { reply_markup: keyboard, parse_mode: "HTML", ...replyOpts }).catch(async () => {
            await ctx.reply(text, { reply_markup: keyboard, ...replyOpts });
          });
        } else {
          // Split and put buttons on last chunk
          const chunks = smartSplit(html, MAX_LENGTH);
          for (let i = 0; i < chunks.length; i++) {
            const baseOpts = i === 0 ? replyOpts : {};
            const isLast = i === chunks.length - 1;
            await ctx.reply(chunks[i], {
              ...(isLast ? { reply_markup: keyboard } : {}),
              parse_mode: "HTML",
              ...baseOpts,
            }).catch(async () => {
              await ctx.reply(chunks[i], isLast ? { reply_markup: keyboard, ...baseOpts } : baseOpts);
            });
          }
        }
        delete (ctx as any).novaReplyTo;
      } else {
        // WhatsApp/Slack: send via adapter with buttons
        const chatId = String(ctx.chat?.id || "");
        await adapter.send(chatId, { text, buttons });
      }
    }
  } else {
    await sendResponse(ctx, text);
  }

  // Send voice ONLY when /voice toggle is on
  if (isTTSEnabled()) {
    const settings = await loadSettings(supabase, userId);
    if (settings.voiceResponses) {
      const audio = await textToSpeech(text);
      if (audio) {
        const channelType = (ctx as any).channelType || "telegram";
        if (channelType === "telegram" && ctx.replyWithVoice) {
          await ctx.replyWithVoice(new InputFile(audio, "response.ogg"));
        } else {
          // Send voice via adapter
          const adapter = (ctx as PlatformContext)?.adapter || channels.get(channelType);
          if (adapter) {
            await adapter.send(String(ctx.chat?.id || ""), { voice: audio });
          }
        }
      }
    }
  }
}

// ============================================================
// FILE DELIVERY — Send files via any channel adapter
// ============================================================

/**
 * Send a file to a chat. Routes to the appropriate channel adapter.
 * For backward compat, defaults to Telegram if no adapter context is available.
 */
async function sendFile(
  chatId: number | string,
  filePath: string,
  caption?: string
): Promise<void> {
  try {
    await stat(filePath);
  } catch {
    console.warn(`[sendFile] File not found: ${filePath}`);
    return;
  }

  // Try Telegram first (most common), then fall back to any available adapter
  const adapter = channels.getTelegram() || channels.getAll()[0];
  if (adapter) {
    await adapter.sendFile(String(chatId), filePath, caption);
  } else {
    console.warn(`[sendFile] No adapter available to send ${filePath}`);
  }
}

/**
 * Create a generic PlatformContext for channels without a native ctx object.
 * Used by WhatsApp, Slack, and the button handler.
 */
function createGenericPlatformContext(
  adapter: import("./channels/types.ts").ChannelAdapter,
  chatId: string,
  user: NovaUser,
): PlatformContext {
  let lastMessageId = 0;
  return {
    adapter,
    chat: { id: chatId },
    channelType: adapter.type,
    novaUser: user,
    async reply(text: string, _opts?: any) {
      await adapter.send(chatId, { text });
      lastMessageId++;
      return { message_id: lastMessageId };
    },
    async replyWithChatAction(_action: string) {
      await adapter.sendTyping(chatId);
    },
    api: {
      async editMessageText(_chatId, _messageId, _text, _opts?) { /* no-op for generic */ },
      async deleteMessage(_chatId, _messageId) { /* no-op for generic */ },
      async sendMessage(targetChatId, text, _opts?) {
        await adapter.send(String(targetChatId), { text });
      },
    },
  };
}

// ============================================================
// ORCHESTRATOR INIT
// ============================================================

initOrchestrator({
  callClaude,
  buildPrompt,
  runTask,
  saveMessage,
  sendResponseWithVoice,
  sendTelegramFile: sendFile,
  relayDir: RELAY_DIR,
  supabase,
  sendMessageToChat: async (chatId, text, keyboard) => {
    const bot = telegramAdapter?.getBot();
    if (!bot) return;
    const html = markdownToTelegramHTML(text);
    await bot.api.sendMessage(Number(chatId), html, {
      parse_mode: "HTML",
      ...(keyboard ? { reply_markup: keyboard } : {}),
    }).catch(async () => {
      // Fallback to plain text if HTML fails
      await bot.api.sendMessage(Number(chatId), text, keyboard ? { reply_markup: keyboard } : {});
    });
  },
});

// ============================================================
// HEARTBEAT — In-process proactive check-in loop
// ============================================================

if (supabase) {
  startHeartbeat({
    db: supabase,
    callClaude,
    saveMessage,
    sendAlert: async (user, message) => {
      // Route heartbeat alerts through the user's preferred channel
      // Default to Telegram since all users have a telegram_id
      const adapter = channels.getTelegram() || channels.getAll()[0];
      if (!adapter) return;
      await adapter.send(user.telegram_id, { text: message });
    },
  });
}

// ============================================================
// START
// ============================================================

// Load specialist agents before starting
await loadAgents();

// Startup config validation — report which features are active/disabled
console.log("Starting Nova (multi-channel mode)...");
console.log(`Project directory: ${PROJECT_DIR || "(relay working directory)"}`);

// Channel status
const channelStatus = channels.getStatus();
for (const [channel, active] of channelStatus) {
  console.log(`  ${active ? "+" : "-"} ${channel}: ${active ? "enabled" : "not configured"}`);
}
console.log(`  + WhatsApp: per-user via Mini App`);

const configStatus = [
  ["SQLite (memory/tasks)", !!supabase],
  ["Voice transcription", !!process.env.VOICE_PROVIDER],
  ["TTS (ElevenLabs)", !!process.env.ELEVENLABS_API_KEY],
  ["Mini App", !!process.env.MINIAPP_URL],
] as const;
for (const [feature, active] of configStatus) {
  console.log(`  ${active ? "+" : "-"} ${feature}: ${active ? "enabled" : "DISABLED (missing config)"}`);
}
// Database is always available with local SQLite

// Sync config/profile.md to DB (so file edits are reflected in the bot)
try {
  const profilePath = join(PROJECT_ROOT, "config", "profile.md");
  const profileText = await readFile(profilePath, "utf-8");
  if (profileText.trim()) {
    const admins = supabase.getUsersByRole("admin");
    for (const admin of admins) {
      if (admin.profile_text !== profileText) {
        supabase.updateUser(admin.id, { profile_text: profileText });
        console.log(`[profile-sync] Updated profile for admin ${admin.id}`);
      }
    }
  }
} catch {}

// Start Mini App approval polling (checks Supabase for approvals made via Mini App)
startMiniAppApprovalPolling(supabase);

// Register Mini App menu button for Telegram (if configured)
const MINIAPP_URL = process.env.MINIAPP_URL;
if (MINIAPP_URL && telegramAdapter) {
  telegramAdapter.setMenuButton(MINIAPP_URL);
}

// Start all channel adapters
await channels.startAll();

// Restore existing WhatsApp sessions (per-user, auto-reconnect)
await whatsappManager.restoreConnectedSessions();

console.log("All channels started! Users are managed via the 'users' table in the local DB.");

// Notify admin users that Nova is back online (via Telegram if available)
// Also recover any pending approvals that survived the restart
if (telegramAdapter) {
  try {
    const admins = supabase.getUsersByRole("admin");
    if (admins?.length) {
      const adminIds = admins.map((a: any) => a.telegram_id).filter(Boolean);
      telegramAdapter.notifyAdmins(adminIds, "Nova is back online.");

      // Recover pending approvals for each admin user
      for (const admin of admins) {
        if (admin.id) {
          await recoverPendingApprovals(supabase, admin.id);
        }
      }
    }
  } catch {}
}
