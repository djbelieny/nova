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
import { createClient, SupabaseClient } from "@supabase/supabase-js";
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
import { orchestrate, initOrchestrator, handleApproval, getPendingApprovalCount, startMiniAppApprovalPolling } from "./orchestrator.ts";
import { loadAgents } from "./agent-router.ts";
import { hasUserMcpConfig, getUserMcpConfigPath, getFilteredMcpConfigPath, getIntegrationCredentials } from "./integrations.ts";
import {
  ChannelRegistry,
  type IncomingMessage,
  type PlatformContext,
} from "./channels/index.ts";
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
process.on("SIGINT", async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[shutdown] SIGINT received, draining...");
  // Give in-flight tasks a few seconds to finish
  setTimeout(async () => {
    await releaseLock();
    process.exit(0);
  }, 3000);
});
process.on("SIGTERM", async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[shutdown] SIGTERM received, draining...");
  setTimeout(async () => {
    await releaseLock();
    process.exit(0);
  }, 3000);
});

// ============================================================
// SETUP
// ============================================================

// At least one channel must be configured
const hasAnyChannel = BOT_TOKEN || process.env.WHATSAPP_ENABLED === "true" || (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN);
if (!hasAnyChannel) {
  console.error("No messaging channel configured!");
  console.log("\nConfigure at least one:");
  console.log("  Telegram: Set TELEGRAM_BOT_TOKEN in .env");
  console.log("  WhatsApp: Set WHATSAPP_ENABLED=true in .env");
  console.log("  Slack: Set SLACK_BOT_TOKEN and SLACK_APP_TOKEN in .env");
  process.exit(1);
}

// Create directories
await mkdir(TEMP_DIR, { recursive: true });
await mkdir(UPLOADS_DIR, { recursive: true });

// ============================================================
// SUPABASE (optional — only if configured)
// ============================================================

const supabase: SupabaseClient | null =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

// Share supabase client with cost tracker (avoid duplicate connections)
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

  if (!supabase) return null;

  try {
    const rpcMap = {
      telegram: { fn: "get_user_by_telegram_id", param: "p_telegram_id" },
      whatsapp: { fn: "get_user_by_whatsapp_id", param: "p_whatsapp_id" },
      slack: { fn: "get_user_by_slack_id", param: "p_slack_id" },
    };

    const { fn, param } = rpcMap[channel];
    const { data, error } = await supabase.rpc(fn, { [param]: platformId });

    if (error || !data?.length) return null;

    const row = data[0];
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
  if (!supabase) return;
  try {
    await supabase.from("messages").insert({
      role,
      content,
      channel,
      metadata: metadata || {},
      user_id: userId,
    });
  } catch (error) {
    console.error("Supabase save error:", error);
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

// Persist usage stats to Supabase every 5 minutes
setInterval(async () => {
  if (!supabase || usage.callsTotal === 0) return;
  try {
    await supabase.from("cost_tracking").insert({
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
setInterval(async () => {
  if (!supabase) return;
  try {
    await supabase.from("nova_status").upsert({
      id: 1,
      updated_at: new Date().toISOString(),
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
}> = [];

async function acquireClaudeSlot(description?: string): Promise<void> {
  if (runningClaude < MAX_CONCURRENT_CLAUDE) {
    runningClaude++;
    return;
  }
  console.log(`[queue] Slot full (${runningClaude}/${MAX_CONCURRENT_CLAUDE}), queuing: ${description?.substring(0, 50) || "unknown"} (${claudeQueue.length + 1} waiting)`);
  return new Promise((resolve) => {
    claudeQueue.push({ resolve, description: description || "unknown", enqueuedAt: Date.now() });
  });
}

function releaseClaudeSlot(): void {
  const next = claudeQueue.shift();
  if (next) {
    const waitMs = Date.now() - next.enqueuedAt;
    console.log(`[queue] Dequeuing: ${next.description.substring(0, 50)} (waited ${(waitMs / 1000).toFixed(1)}s)`);
    next.resolve();
  } else {
    runningClaude--;
  }
}

// ============================================================
// CALL CLAUDE — with model selection, retry, and monitoring
// ============================================================

type ModelTier = "haiku" | "sonnet" | "opus";

async function callClaude(prompt: string, model?: ModelTier, userId?: string, hint?: string): Promise<string> {
  await acquireClaudeSlot(prompt.substring(0, 60));

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
  const args = [CLAUDE_PATH, "-p", prompt, "--output-format", "json", "--permission-mode", "bypassPermissions"];

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
      recordCall(false, modelLabel, durationMs, stderr.includes("rate") || stderr.includes("overloaded"));
      const detail = stderr.trim() || stdoutTail || `exit code ${exitCode}`;
      throw new Error(`Claude CLI exited with code ${exitCode}: ${detail}`);
    }

    // Parse JSON response to extract cost data
    try {
      const json = JSON.parse(output.trim());
      let result = typeof json.result === "string" ? json.result : output.trim();

      // Warn if result is empty — Claude used tools but produced no final text
      if (!result.trim()) {
        console.warn(`[callClaude] Empty result from Claude CLI (${json.num_turns || "?"} turns, ${durationMs}ms). This usually means Claude used tools without a final text reply.`);
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

  // Edit-in-place status indicator
  let statusMsgId: number | string | null = null;
  const chatId = ctx.chat?.id;

  // Send "Working on it..." after 8 seconds, edit to "taking longer" after 60s
  const statusTimer = setTimeout(async () => {
    if (!activeTasks.has(taskId) || !chatId) return;
    try {
      const queueLen = claudeQueue.length;
      const otherTasks = activeTasks.size - 1;
      let msg = "Working on it...";
      if (queueLen > 0) {
        msg = `Working on it... (${queueLen} queued ahead)`;
      } else if (otherTasks > 0) {
        msg = `Working on it... (${otherTasks + 1} tasks in progress)`;
      }
      const sent = await ctx.reply(msg);
      statusMsgId = sent.message_id;
      task.notified = true;
    } catch {}
  }, 8_000);

  const longerTimer = setTimeout(async () => {
    if (!activeTasks.has(taskId) || !chatId || !statusMsgId) return;
    try {
      await ctx.api.editMessageText(chatId, statusMsgId, "Taking longer than usual, still working on it...");
    } catch {}
  }, 60_000);

  // Fire and forget — run the task asynchronously
  (async () => {
    try {
      const { prompt, model, hint: taskHint } = await buildTask();

      // Skip calling Claude for orchestrator-handled prompts
      const taskUserId = opts?.userId || ((ctx as any).novaUser as NovaUser)?.id;
      const rawResponse = prompt === "__ORCHESTRATOR_HANDLED__"
        ? "__ORCHESTRATOR_HANDLED__"
        : await callClaude(prompt, model, taskUserId, taskHint);

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

      // Delete the status message before sending the real response
      if (statusMsgId && chatId) {
        try { await ctx.api.deleteMessage(chatId, statusMsgId); } catch {}
      }

      const userId = opts?.userId || ((ctx as any).novaUser as NovaUser)?.id;
      const channelType = (ctx as any).channelType || "telegram";
      if (userId) {
        await saveMessage("assistant", response, userId, undefined, channelType);
      }
      await sendResponseWithVoice(ctx, response, userId);
    } catch (error) {
      const err = error as Error;
      console.error(`Task ${taskId} error:`, err);

      // Build a diagnostic error message instead of a generic one
      const errMsg = err.message || String(error);
      let msg: string;
      if (errMsg.includes("rate") || errMsg.includes("overloaded")) {
        msg = `⚠️ Claude API is rate-limited or overloaded. Try again in ~30 seconds.\n\n_Error: ${errMsg.substring(0, 200)}_`;
      } else if (errMsg.includes("exited with code")) {
        msg = `⚠️ Claude CLI crashed (non-zero exit).\n\n_Error: ${errMsg.substring(0, 200)}_`;
      } else if (errMsg.includes("No JSON found") || errMsg.includes("parse")) {
        msg = `⚠️ AI returned an unparseable response (likely a malformed reply from the model).\n\n_Error: ${errMsg.substring(0, 200)}_`;
      } else if (errMsg.includes("timeout") || errMsg.includes("ETIMEDOUT")) {
        msg = `⚠️ Request timed out — the task may have been too complex or the API is slow.\n\n_Error: ${errMsg.substring(0, 200)}_`;
      } else {
        msg = `⚠️ Something went wrong.\n\n_Error: ${errMsg.substring(0, 300)}_`;
      }

      if (statusMsgId && chatId) {
        try { await ctx.api.editMessageText(chatId, statusMsgId, msg, { parse_mode: "Markdown" }); } catch {
          await ctx.reply(msg, { parse_mode: "Markdown" }).catch(() => {});
        }
      } else {
        await ctx.reply(msg, { parse_mode: "Markdown" }).catch(() => {});
      }
    } finally {
      clearTimeout(statusTimer);
      clearTimeout(longerTimer);
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

// ============================================================
// MESSAGE HANDLERS (all channels via adapter pattern)
// ============================================================

channels.onMessage(async (msg: IncomingMessage, reply) => {
  // Get platform context (attached by adapter)
  const platformCtx: PlatformContext | any = (msg as any)._platformContext;

  // --- User resolution for non-Telegram channels ---
  // Telegram resolves users in middleware; WhatsApp/Slack resolve here
  let user: NovaUser | null = null;
  if (msg.channelType === "telegram") {
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
    await saveMessage("user", text, user.id, undefined, msg.channelType);

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
});

// ============================================================
// HELPERS
// ============================================================

/**
 * Detect message intent for conditional prompt injection.
 * Returns which instruction blocks are relevant for this message.
 */
function detectPromptNeeds(text: string): {
  needsMemoryTags: boolean;
  needsTaskTags: boolean;
  needsScheduleTags: boolean;
  needsSelfMod: boolean;
  needsCapabilities: boolean;
  isTrivial: boolean;
} {
  const lower = text.toLowerCase().trim();

  // Trivial messages: greetings, acknowledgments, single words
  const trivialPatterns = [
    /^(?:hi|hello|hey|yo|sup|thanks|thank you|ok|okay|cool|nice|great|got it|sure|yep|yes|no|nah|lol|haha|good|morning|night|bye)[\s!.?]*$/i,
    /^.{1,5}$/, // Very short messages (1-5 chars)
  ];
  const isTrivial = trivialPatterns.some((p) => p.test(lower));

  // Memory-related keywords
  const needsMemoryTags = /(?:remember|memorize|save|store|forget|goal|done|share with team)/i.test(lower);

  // Task-related keywords
  const needsTaskTags = /(?:task|todo|assign|delegate|block|cancel task|pending)/i.test(lower);

  // Schedule-related keywords
  const needsScheduleTags = /(?:remind|schedule|alarm|timer|recur|every day|every week|follow up|check in)/i.test(lower);

  // Self-modification keywords
  const needsSelfMod = /(?:fix yourself|change how you|modify your|edit your code|update your|improve your|add.*agent|create.*agent|new skill|edit.*relay|change.*prompt)/i.test(lower);

  // Capabilities needed (when asking to use a specific tool)
  const needsCapabilities = !isTrivial; // Always include for non-trivial unless proven unnecessary

  return { needsMemoryTags, needsTaskTags, needsScheduleTags, needsSelfMod, needsCapabilities, isTrivial };
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
  options?: { ghlLocationId?: string }
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

  // Detect what instruction blocks this message actually needs
  const needs = detectPromptNeeds(userMessage);

  const parts = [
    "You are a personal AI assistant responding via messaging. Keep responses concise and conversational.",
  ];

  parts.push(`You are speaking with ${user.name}.`);
  parts.push(`Current time: ${timeStr}`);
  if (user.profile_text) parts.push(`\nProfile:\n${user.profile_text}`);
  if (tMemoryContext) parts.push(`\n${tMemoryContext}`);
  if (tTaskContext && !needs.isTrivial) parts.push(`\n${tTaskContext}`);
  if (tScheduleContext && !needs.isTrivial) parts.push(`\n${tScheduleContext}`);
  if (tRecentHistory) parts.push(`\n${tRecentHistory}`);
  if (tRelevantContext && !needs.isTrivial) parts.push(`\n${tRelevantContext}`);

  // Only include memory management tags when the message might trigger memory operations
  // or when it's a non-trivial message (always good to have for complex interactions)
  if (needs.needsMemoryTags || !needs.isTrivial) parts.push(
    "\nMEMORY MANAGEMENT:" +
      "\nWhen the user shares something worth remembering, sets goals, or completes goals, " +
      "include these tags in your response (they are processed automatically and hidden from the user):" +
      "\n[REMEMBER: fact to store] — private to this user" +
      "\n[SHARE: fact to share] — visible to all team members" +
      "\n[GOAL: goal text | DEADLINE: optional date]" +
      "\n[DONE: search text for completed goal]" +
      "\n" +
      "\nWhat to REMEMBER (ONLY durable, long-term facts — things still true months from now):" +
      "\n- Personal identity: names, relationships, birthdays, locations, contact info" +
      "\n- Business identity: company details, pricing, clients, partners, revenue figures" +
      "\n- Stable preferences: communication style, favorite tools, recurring workflows" +
      "\n- Major life decisions: strategies adopted, long-term commitments, career changes" +
      "\n- Recurring patterns: weekly routines, standing meetings, regular habits" +
      "\n" +
      "\nWhat NOT to remember (DO NOT use [REMEMBER:] for any of these):" +
      "\n- One-time events: dinner plans, lunch dates, appointments, meetings, reservations" +
      "\n- Calendar items: anything with a specific date/time that happens once — these belong in Google Calendar, NOT memory" +
      "\n- Schedule changes: moved/rescheduled events — update the calendar instead" +
      "\n- Transient tasks: things being done today/this week that won't matter next month" +
      "\n- Conversations: debugging, troubleshooting, technical discussions, corrections" +
      "\n- System details: file paths, tool access, configuration, implementation details" +
      "\n- Anything only relevant to the current conversation or the next few days" +
      "\n" +
      "\nRule of thumb: If it won't matter in 30 days, don't remember it. Use the calendar for events." +
      "\n" +
      "\nWhat to SHARE (team-wide knowledge, not personal):" +
      "\n- Company policies, shared processes, team contacts" +
      "\n- Decisions that affect the whole team" +
      "\n- Only use [SHARE:] when the user explicitly says to share with the team"
  );

  if (needs.needsTaskTags || !needs.isTrivial) parts.push(
    "\nTASK TRACKING:" +
      "\nWhen you start a task or delegate to a specialist agent, log it:" +
      "\n  [TASK: Agent Name | brief description]" +
      "\nWhen you begin working on a pending task:" +
      "\n  [TASK_START: search text matching description]" +
      "\nWhen you complete a task:" +
      "\n  [TASK_DONE: search text | brief result]" +
      "\nWhen a task is blocked:" +
      "\n  [TASK_BLOCKED: search text | what's blocking it]" +
      "\nTo cancel a task:" +
      "\n  [TASK_CANCEL: search text]"
  );

  if (needs.needsScheduleTags || !needs.isTrivial) parts.push(
    "\nSCHEDULED TASKS:" +
      "\nYou can schedule reminders, follow-ups, and recurring tasks. When the user asks to be reminded, " +
      "or when you think a follow-up check would be useful, include a schedule tag:" +
      "\n  [SCHEDULE: title | datetime | instructions]" +
      "\n  [SCHEDULE: title | datetime | instructions | RECUR: rule]" +
      "\n  [SCHEDULE: title | datetime | instructions | RECUR: rule | IF: condition]" +
      "\n  [SCHEDULE_CANCEL: search text matching title]" +
      "\n" +
      "\nDatetime formats:" +
      "\n  - Absolute: 2026-02-19T15:00:00 (ISO format, user's timezone)" +
      "\n  - Relative: +30m, +2h, +1d (from now)" +
      "\n" +
      "\nRecurrence rules (RECUR:):" +
      "\n  - daily:HH:MM — every day at HH:MM" +
      "\n  - weekly:DAY:HH:MM — every week (DAY: 0=Sun, 1=Mon, ...)" +
      "\n  - weekdays:HH:MM — Monday through Friday at HH:MM" +
      "\n  - interval:SECONDS — every N seconds" +
      "\n" +
      "\nConditions (IF:): Optional. Claude evaluates this at trigger time and skips if false." +
      "\n" +
      "\nExamples:" +
      "\n  [SCHEDULE: Call dentist | 2026-02-19T15:00:00 | Remind " + user.name + " to call the dentist for a cleaning appointment]" +
      "\n  [SCHEDULE: Weekly calendar preview | 2026-02-24T08:30:00 | Check " + user.name + "'s Google Calendar for the week ahead and send a summary | RECUR: weekly:1:08:30]" +
      "\n  [SCHEDULE: Q1 Report check | +2h | Check Notion for Q1 Report status | IF: Q1 Report task exists in Notion]" +
      "\n" +
      "\nSelf-scheduling: When you realize a follow-up would help (e.g., checking if a task got done, " +
      "following up on a request), proactively schedule one. " + user.name + " benefits from you being anticipatory."
  );

  parts.push(
    "\nCAPABILITIES — You have access to these tools and should use them when relevant:" +
      "\n" +
      "\n• Gmail & Google Calendar: Read, search, draft, and send emails. View, create, and update calendar events." +
      "\n• Notion: Search pages, read content, create and update pages and databases." +
      "\n• Zoom: Create, update, and delete Zoom meetings. Get meeting details and recordings. When scheduling meetings, create the Zoom meeting first to get the join link, then add it to Google Calendar with the Zoom link in the description/location." +
      "\n• Web Browser (Playwright): Navigate to URLs, take screenshots, fill forms, click buttons. Use for any website interaction." +
      "\n• Web Search: You have built-in web search. Use it to answer questions about current events, look up information, etc." +
      "\n• Apple Notes: Read and create notes using osascript. Example: osascript -e 'tell application \"Notes\" to get name of every note'" +
      "\n• Apple Contacts: Search and look up contacts synced via iCloud." +
      "\n  - Search by name: osascript -e 'tell application \"Contacts\" to get {name, value of phones, value of emails} of (every person whose name contains \"John\")'" +
      "\n  - Always look up a contact before calling or texting someone mentioned by name." +
      "\n• Phone Calls & SMS (Twilio + ElevenLabs): Make voice calls and send text messages." +
      (user.phone
        ? `\n  - ${user.name}'s phone: ${user.phone}. Use this when ${user.name} says "call me", "text me", or when something is urgent.`
        : "") +
      `\n  - SMS: Run \`bun run ${PROJECT_ROOT}/src/twilio.ts sms "<phone>" "message"\`` +
      `\n  - Call: Run \`bun run ${PROJECT_ROOT}/src/twilio.ts call "<phone>" "context"\`` +
      "\n  - Call third parties:" +
      `\n    bun run ${PROJECT_ROOT}/src/twilio.ts call-thirdparty "+1234567890" "Contact Name" "subject" [--lang language]` +
      "\n• Square: Query orders and transactions by date range, view payment history, check account balances, create payment links, manage customers and catalog items." +
      "\n  - LOCATIONS: Open Source Mind (Main) ID: LA50ZWAK48MD8 | Zaarvy AI ID: LNCSX2ST6EKCY" +
      "\n  - REPORTS/QUERIES: Always include BOTH locations and show results per-location plus a combined total." +
      "\n  - WRITE OPERATIONS: Always ask " + user.name + " which location to use BEFORE executing." +
      "\n• Go High Level (GHL): Full CRM and agency management via official MCP server." +
      (ghlLocationId
        ? `\n  - LOCATION ID: ${ghlLocationId} — use this for all GHL API calls that require a locationId.`
        : "") +
      "\n  - CONTACTS: Create, update, search, tag, add to workflows, manage custom fields" +
      "\n  - MEMBERSHIPS & COURSES: Grant/revoke contact access to courses, memberships, and groups" +
      "\n  - CALENDARS: Create/edit/delete calendars, appointments, check free slots, block time" +
      "\n  - OPPORTUNITIES: Create/update deals in existing pipelines, change deal status" +
      "\n  - CONVERSATIONS: Send SMS/email to contacts, manage conversation threads" +
      "\n  - EMAIL TEMPLATES: Create, edit, delete email templates" +
      "\n  - BLOG POSTS: Create, update, list blog posts, manage categories and authors" +
      "\n  - SOCIAL MEDIA: Create/schedule/manage social posts across connected accounts" +
      "\n  - PAYMENTS & INVOICES: List orders, manage subscriptions, create invoices" +
      "\n  - LIMITATIONS: Cannot create pipelines/stages, cannot create/edit forms, cannot edit funnel pages, cannot create/edit workflows (only add/remove contacts)" +
      "\n  - Always confirm before modifying contacts, sending messages, or changing access." +
      "\n• Cloudflare: Manage DNS records, deploy and manage Cloudflare Workers." +
      "\n• Task Scheduler: Create, list, and manage recurring scheduled tasks." +
      `\n  - List tasks: \`bun run ${PROJECT_ROOT}/src/scheduler.ts list\`` +
      `\n  - Create: \`bun run ${PROJECT_ROOT}/src/scheduler.ts create "<name>" "<schedule>" "<command>"\`` +
      "\n• File System: You can read, write, and manage files on the user's computer." +
      "\n• Terminal: You can run any shell command the user needs." +
      "\n" +
      "\nUse the right tool for the job. Always confirm before taking consequential actions (sending emails, making calls, etc.)." +
      "\n" +
      "\nRESPONSE PROTOCOL:" +
      "\n" + user.name + " can send you multiple requests at once — you handle them in parallel." +
      "\nJust do the work and deliver results. Keep responses focused and actionable." +
      "\nWhen a task involves creating a file that " + user.name + " needs, use the /telegram-file-sender skill to send it directly." +
      "\n" +
      "\nIMAGE/FILE GENERATION — When generating images (/image-gen, /canvas-design) or any files:" +
      "\n1. Generate the image(s)/file(s)" +
      "\n2. ALWAYS send each file to " + user.name + " via /telegram-file-sender — this is HOW files reach the user" +
      "\n3. ALWAYS include a clean text summary describing what was created" +
      "\n" +
      "\nCLEAN OUTPUT — " + user.name + " sees ONLY your final text response:" +
      "\n- NEVER include file paths, tool invocation details, or internal process notes" +
      "\n- NEVER show bash commands, script paths, or skill loading messages" +
      "\n- NEVER describe the steps you took internally — just share the result" +
      "\n- Write as if you're texting " + user.name + " — casual, clean, result-focused" +
      "\n" +
      "\nINLINE BUTTONS — Use buttons when asking for confirmation, selection, or quick input:" +
      "\nWhen you need " + user.name + " to choose between options, confirm an action, or approve something, " +
      "add a button tag at the end of your message:" +
      "\n  [BUTTONS: Option A | Option B | Option C]" +
      "\nThis renders as tappable buttons in Telegram — much faster than typing." +
      "\nKeep labels short (1-3 words). Max 6 buttons. The tag is hidden from the user — they only see the buttons." +
      "\nUse buttons whenever you would otherwise ask " + user.name + " to type a simple choice."
  );

  parts.push(
    "\nSKILLS — Specialized slash commands you can invoke:" +
      "\n• /canvas-design — Create visual designs, posters, and art as PNG/PDF" +
      "\n• /competitive-ads-extractor — Extract and analyze competitor ads from ad libraries" +
      "\n• /content-research-writer — Research-backed writing with citations and iterative feedback" +
      "\n• /docx — Create, edit, and analyze Word documents with tracked changes" +
      "\n• /file-organizer — Intelligently organize files and folders, find duplicates, suggest structures" +
      "\n• /ghostwriter — Transform transcriptions into complete, formatted books (DOCX + PDF)" +
      "\n• /lead-research-assistant — Identify and research high-quality business leads" +
      "\n• /notebooklm — Query Google NotebookLM for source-grounded, citation-backed answers" +
      "\n• /pdf — Extract text/tables, create, merge/split, and fill PDF forms" +
      "\n• /platform-maker — Generate complete SaaS platforms from YAML configuration" +
      "\n• /pptx — Create, edit, and analyze PowerPoint presentations" +
      "\n• /xlsx — Create, edit, and analyze spreadsheets with formulas and formatting" +
      "\n• /skill-creator — Create new skills to extend your own capabilities." +
      "\n• /telegram-file-sender — Send files as document attachments via Telegram."
  );

  parts.push(
    "\nSELF-IMPROVEMENT — You learn and evolve over time:" +
      "\n• PATTERN DETECTION: When you notice " + user.name + " repeatedly asks you to do the same kind of task, note the pattern." +
      "\n• SKILL CREATION: When you detect a recurring workflow or " + user.name + " asks you to create a skill, " +
      "use the /skill-creator skill to build it." +
      "\n• MEMORY TAGS: Continue using [REMEMBER: ...] tags for facts and context. Use [GOAL: ...] and [DONE: ...] for goal tracking." +
      "\n• PROACTIVE SUGGESTIONS: If you see an opportunity to automate something " + user.name + " does manually, suggest creating a skill for it."
  );

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
        "\n1. ALWAYS commit the current state first: `git -C " + PROJECT_ROOT + " add -A && git -C " + PROJECT_ROOT + " commit -m \"auto-save before self-edit\"`" +
        "\n2. Read the relevant file(s) to understand the current code" +
        "\n3. Make the change using your file editing tools" +
        "\n4. Log the change in CHANGELOG.md (see format below)" +
        "\n5. Commit the change: `git -C " + PROJECT_ROOT + " add -A && git -C " + PROJECT_ROOT + " commit -m \"self-edit: <description>\"`" +
        "\n6. Tell " + user.name + " what you changed and suggest they send /reload to apply it" +
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
        "\n5. Log in CHANGELOG.md, commit, and tell " + user.name + " to /reload" +
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
  console.log(`[prompt] ${prompt.length} chars (~${Math.round(prompt.length / 4)} tokens)`);
  return prompt;
}

// ============================================================
// ADMIN COMMANDS
// ============================================================

async function handleAdminCommand(ctx: Context, text: string, user: NovaUser): Promise<boolean> {
  if (!supabase) return false;

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
      await supabase.from("memory").insert({
        type: "fact",
        content: fact,
        user_id: user.id,
        scope: "shared",
      });
      await ctx.reply(`Shared with team: "${fact}"`);
    } catch (e: any) {
      await ctx.reply(`Error: ${e.message}`);
    }
    return true;
  }

  // Migrated to Mini App: /status
  if (command === "/status") {
    await ctx.reply("Status dashboard has moved to the Nova Mini App (Dashboard tab).");
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

    const chunks: string[] = [];
    let remaining = html;
    while (remaining.length > 0) {
      if (remaining.length <= MAX_LENGTH) { chunks.push(remaining); break; }
      let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
      if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
      if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
      if (splitIndex === -1) splitIndex = MAX_LENGTH;
      chunks.push(remaining.substring(0, splitIndex));
      remaining = remaining.substring(splitIndex).trim();
    }
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
          const chunks: string[] = [];
          let remaining = html;
          while (remaining.length > 0) {
            if (remaining.length <= MAX_LENGTH) { chunks.push(remaining); break; }
            let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
            if (splitIndex === -1 || splitIndex < MAX_LENGTH / 2) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
            if (splitIndex === -1 || splitIndex < MAX_LENGTH / 2) splitIndex = MAX_LENGTH;
            chunks.push(remaining.substring(0, splitIndex));
            remaining = remaining.substring(splitIndex).trim();
          }
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
});

// ============================================================
// HEARTBEAT — In-process proactive check-in loop
// ============================================================

if (supabase) {
  startHeartbeat({
    supabase,
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

const configStatus = [
  ["Supabase (memory/tasks)", !!supabase],
  ["Voice transcription", !!process.env.VOICE_PROVIDER],
  ["TTS (ElevenLabs)", !!process.env.ELEVENLABS_API_KEY],
  ["Mini App", !!process.env.MINIAPP_URL],
] as const;
for (const [feature, active] of configStatus) {
  console.log(`  ${active ? "+" : "-"} ${feature}: ${active ? "enabled" : "DISABLED (missing config)"}`);
}
if (!supabase) {
  console.warn("WARNING: No SUPABASE_URL — memory, tasks, patterns, and cost tracking are all disabled.");
}

// Start Mini App approval polling (checks Supabase for approvals made via Mini App)
startMiniAppApprovalPolling(supabase);

// Register Mini App menu button for Telegram (if configured)
const MINIAPP_URL = process.env.MINIAPP_URL;
if (MINIAPP_URL && telegramAdapter) {
  telegramAdapter.setMenuButton(MINIAPP_URL);
}

// Start all channel adapters
await channels.startAll();
console.log("All channels started! Users are managed via the 'users' table in Supabase.");

// Notify admin users that Nova is back online (via Telegram if available)
if (supabase && telegramAdapter) {
  try {
    const { data: admins } = await supabase
      .from("users")
      .select("telegram_id")
      .eq("role", "admin");
    if (admins?.length) {
      const adminIds = admins.map((a: any) => a.telegram_id).filter(Boolean);
      telegramAdapter.notifyAdmins(adminIds, "Nova is back online.");
    }
  } catch {}
}
