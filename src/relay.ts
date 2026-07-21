/**
 * Nova — Personal AI Assistant
 *
 * Multi-channel message handler that connects Telegram, WhatsApp, and Slack to AI backends.
 * Channel adapters handle platform-specific I/O; this file is the coordinator.
 * AI providers (Claude, Gemini, etc.) are abstracted behind the AIProvider interface.
 *
 * Run: bun run src/relay.ts
 */

import { InputFile } from "grammy";
import type { Context } from "grammy";
import { logError, notifyAdmin, setAdminNotifier } from "./error-handler.ts";
import { spawn } from "bun";
import { writeFile, mkdir, readFile, unlink, stat } from "fs/promises";
import { join, dirname, basename, resolve } from "path";
import { getDb, type Database, embeddingToBlob } from "./db.ts";
import { memwright } from "./memwright-client.ts";
import { transcribe } from "./transcribe.ts";
import { trackCost, initCostTracker } from "./cost-tracker.ts";
import {
  processMemoryIntents,
  getMemoryContext,
  getRelevantContext,
  getRecentHistory,
  getTaskContext,
  getScheduleContext,
  getSessionSummaryContext,
  updateSessionSummaryAsync,
} from "./memory.ts";
import { textToSpeech, isTTSEnabled } from "./tts.ts";
import { toggleVoiceResponses, loadSettings } from "./settings.ts";
import { orchestrate, initOrchestrator, handleApproval, getPendingApprovalCount, recoverPendingApprovals, runPlan } from "./orchestrator.ts";
import { renderPlaybook, describePlaybook, SEED_PLAYBOOKS } from "./playbooks.ts";
import { loadAgents, getAllAgents, buildAgentPrompt } from "./agent-router.ts";
import {
  buildWelcomeMessage,
  buildHelpMessage,
  buildTeamMessage,
  buildExamplesMessage,
  exampleButtons,
} from "./onboarding.ts";
import { recordSubtaskAction } from "./ledger.ts";
import { hasUserMcpConfig, getUserMcpConfigPath, getFilteredMcpConfigPath, getIntegrationCredentials, regenerateMcpConfig } from "./integrations.ts";
import {
  ChannelRegistry,
  type IncomingMessage,
  type PlatformContext,
} from "./channels/index.ts";
import { WhatsAppManager } from "./whatsapp-manager.ts";
import { startHeartbeat, appendToHeartbeat } from "./heartbeat.ts";
import {
  type ModelTier,
  type AIProviderResult,
  registerProvider,
  getProvider,
  getDefaultProvider,
  getAllProviders,
  getAvailableProviderNames,
} from "./ai-provider.ts";
import { ClaudeProvider } from "./providers/claude.ts";
import { GeminiProvider } from "./providers/gemini.ts";
import { CodexProvider } from "./providers/codex.ts";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.ts";
import { loadProviderProfiles } from "./provider-registry.ts";
import { selectProvider, parseProviderPrefix, recordRateLimit, recordUsage } from "./ai-router.ts";
import {
  markdownToTelegramHTML,
  parseButtons,
  cleanResponseForUser,
} from "./channels/telegram.ts";
import { getDecisionContext, initMemorySummarizer, initSessionSummarizer } from "./memory.ts";
import { emit, initEventBus, startStallDetection, shutdownEventBus } from "./events.ts";
import { initGoalEngine, start as startGoalEngine, runOnce as runGoalEngineOnce } from "../services/goal-engine.ts";
import { initPredictiveScheduler, start as startPredictiveScheduler } from "../services/predictive-scheduler.ts";
import { startWebhookServer, generateWebhookSecret } from "./webhook-server.ts";
import { formatBudgetSummary, getBudgetSummary, requestSpend } from "./budget.ts";
import { getReputationContext, getWeeklyReputationReport, recordTaskOutcome } from "./reputation.ts";
import { listProjects, getProjectBrief, createProject } from "./projects.ts";
import { runCognitiveCascade } from "./cognitive-cascade.ts";
import { rateLastPattern } from "./patterns.ts";
import { approveProposal, rejectProposal, parseProposalCallback } from "./learning-loop.ts";
import { triggerPredictions } from "./predictor.ts";
import { initCallProcessor, processCallTranscript } from "../services/call-processor.ts";
import { searchZoomRecordings, processRecordingById, type ZoomMeeting } from "../services/zoom-transcript-poller.ts";
import { startHealthMonitor } from "../services/health-monitor.ts";
import { startDevTaskDispatcher } from "../services/dev-task-dispatcher.ts";
import { startKbWatcher } from "../services/kb-watch.ts";
import { startAutomationPoller } from "../services/automation-poller.ts";
import { checkCliAuth } from "./cli-auth.ts";
import { startCsRouter } from './cs-router.ts';

// Executive board (optional — only active if a board backend is configured)
let boardModule: { conveneBoard: (q: string, userId: string, chatId: string | number) => Promise<void>; handleBoardDecision: (sessionId: string, option: string, userId: string) => Promise<void> } | null = null;

const PROJECT_ROOT = dirname(dirname(import.meta.path));
let _botName = process.env.BOT_NAME ?? "Nova";
let _botIdentity = "";

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const PROJECT_DIR = process.env.PROJECT_DIR || "";
const NOVA_DIR = process.env.NOVA_DIR || process.env.RELAY_DIR || join(process.env.HOME || "~", ".nova");

// Directories
const TEMP_DIR = join(NOVA_DIR, "temp");
const UPLOADS_DIR = join(NOVA_DIR, "uploads");

// Persistent workspace directories
const WORKSPACE_DIR = join(NOVA_DIR, "workspace");
const SHARED_WORKSPACE_DIR = join(WORKSPACE_DIR, "shared");
const WORKSPACE_PROJECTS = join(WORKSPACE_DIR, "projects");
const WORKSPACE_DOCUMENTS = join(WORKSPACE_DIR, "documents");
const WORKSPACE_IMAGES = join(WORKSPACE_DIR, "images");
const WORKSPACE_MEDIA = join(WORKSPACE_DIR, "media");
const WORKSPACE_TASKS = join(WORKSPACE_DIR, ".tasks");

function getUserWorkspaceDir(userId: string): string {
  return join(NOVA_DIR, "workspace", "users", userId);
}

// ============================================================
// LOCK FILE (prevent multiple instances)
// ============================================================

const LOCK_FILE = join(NOVA_DIR, "bot.lock");

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

  // Flush event bus and close database
  shutdownEventBus();
  try { supabase.close(); } catch {}

  await releaseLock();
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

process.on("uncaughtException", (err: Error) => {
  logError(err, "uncaughtException");
  // Fire-and-forget notification; exit guaranteed even if notifyAdmin hangs
  notifyAdmin(`Nova crashed: ${err.message}. Restarting...`).catch(() => {}).finally(() => process.exit(1));
  setTimeout(() => process.exit(1), 3000).unref();
});

process.on("unhandledRejection", (reason: unknown) => {
  logError(reason, "unhandledRejection");
});

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
  console.log("  WhatsApp: Connect via web dashboard (Integrations tab)");
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
await mkdir(SHARED_WORKSPACE_DIR, { recursive: true });

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

// Cancel any tasks left in_progress from a previous run (they can't resume)
supabase.resetStaleInProgressTasks();

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
  team_id?: string;
}

const USER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const userCache = new Map<string, { user: NovaUser; cachedAt: number }>();
// GHL location ID cache: userId → locationId
const ghlLocationCache = new Map<string, string>();

/**
 * Resolve a user by platform-specific ID.
 * Supports Telegram ID, WhatsApp phone, or Slack user ID.
 */
async function resolveUser(platformId: string, channel: "telegram" | "whatsapp" | "slack" | "cli" | "discord" = "telegram"): Promise<NovaUser | null> {
  const cacheKey = `${channel}:${platformId}`;
  const cached = userCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < USER_CACHE_TTL_MS) return cached.user;

  try {
    const lookupMap: Record<string, (id: string) => any | null> = {
      telegram: (id) => supabase.getUserByTelegramId(id),
      whatsapp: (id) => supabase.getUserByWhatsappId(id),
      slack: (id) => supabase.getUserBySlackId(id),
      // CLI is a single local surface → resolve to the owner (admin, else first user).
      cli: () => supabase.getUsersByRole("admin")?.[0] ?? supabase.getAllActiveUsers()?.[0] ?? null,
      // Unknown Discord users are routed into the self-serve pairing flow by the
      // message handler (see handleUnknownDiscordUser).
      discord: (id) => supabase.getUserByDiscordId(id),
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
      team_id: row.team_id || undefined,
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

function getSessionKey(userId: string, channel: string): string {
  const now = new Date();
  // 6 buckets of 4 hours each per UTC day (hours 0–3, 4–7, ..., 20–23)
  const bucket = Math.floor(now.getUTCHours() / 4);
  return `${userId}-${channel}-${now.toISOString().slice(0, 10)}-b${bucket}`;
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
    if (role === "user" || role === "assistant") {
      const result = await memwright.add({
        content,
        namespace: `user:${userId}`,
        category: "conversation",
        tags: [role],
        metadata: { role, channel, short_term: true, ttl_days: 7, promoted: false },
      });
      if (result?.id) {
        const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
        supabase.insertShortTermMemory(userId, result.id, expiresAt);
      }
    }
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
channels.init(NOVA_DIR);

// WhatsApp per-user sessions (managed via Mini App, not env flag)
const whatsappManager = new WhatsAppManager(supabase);

// ============================================================
// PAIRING AUTH — self-serve teammate onboarding
// ============================================================

// Matches an 8-char invite code from the unambiguous alphabet (case-insensitive).
const PAIRING_CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/i;
const PAIRING_MAX_ATTEMPTS = 5;
const PAIRING_LOCKOUT_MS = 5 * 60_000; // 5 minutes after too many bad tries
const pairingAttempts = new Map<string, { count: number; lockedUntil: number }>();
// Discord pairing requests awaiting admin approval. Keyed by Discord user id →
// the DM channel to welcome/deny them in and their display name. In-memory
// (consistent with pairingAttempts); a restart drops pending requests, after
// which the requester simply re-sends their code / re-taps Request access.
const discordPairRequests = new Map<string, { channelId: string; name: string }>();

function pairingFirstName(name?: string): string {
  const cleaned = (name || "there").replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 32);
  return cleaned || "there";
}

function isPairingLockedOut(telegramId: string): boolean {
  const rec = pairingAttempts.get(telegramId);
  return !!rec && rec.lockedUntil > Date.now();
}

function recordPairingAttempt(telegramId: string): void {
  const rec = pairingAttempts.get(telegramId) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= PAIRING_MAX_ATTEMPTS) rec.lockedUntil = Date.now() + PAIRING_LOCKOUT_MS;
  pairingAttempts.set(telegramId, rec);
}

function clearPairingAttempts(telegramId: string): void {
  pairingAttempts.delete(telegramId);
}

/** Send the first-run welcome to a freshly-paired user and mark them onboarded once. */
async function sendPairingWelcome(telegramId: string, name: string, userId?: string): Promise<void> {
  const tg = channels.getTelegram();
  if (!tg) return;
  try {
    await tg.send(telegramId, {
      text: buildWelcomeMessage(name),
      buttons: exampleButtons().flat().map((b) => ({ label: b.label, callbackData: b.callbackData })),
    });
    if (userId) supabase.setOnboardedAt(userId);
  } catch (err) {
    console.warn("[relay] pairing welcome failed:", err);
  }
}

/** Send the first-run welcome to a freshly-paired Discord user via their reply channel. */
async function sendDiscordPairingWelcome(reply: (m: any) => Promise<void>, name: string, userId?: string): Promise<void> {
  try {
    await reply({
      text: buildWelcomeMessage(name),
      buttons: exampleButtons().flat().map((b) => ({ label: b.label, callbackData: b.callbackData })),
    });
    if (userId) supabase.setOnboardedAt(userId);
  } catch (err) {
    console.warn("[relay] discord pairing welcome failed:", err);
  }
}

/**
 * Self-serve pairing for an unknown Discord DM — the Discord equivalent of the
 * Telegram middleware's pairing entry. A valid code pairs immediately; anything
 * else offers the Request-access → admin-approval flow. Reuses the shared
 * pairing helpers (redeemPairingCode/upsertUser/pair_* callbacks) — no fork.
 */
async function handleUnknownDiscordUser(msg: IncomingMessage, reply: (m: any) => Promise<void>): Promise<void> {
  const discordId = msg.platformUserId;
  const name = pairingFirstName(msg.senderName);
  const raw = (msg.text || "").trim();

  if (PAIRING_CODE_RE.test(raw)) {
    if (isPairingLockedOut(discordId)) {
      await reply({ text: "Too many attempts. Please wait a few minutes and try your code again." });
      return;
    }
    const result: { ok: boolean; role?: string; error?: "invalid" | "expired" | "used" } =
      supabase.redeemPairingCode(raw, discordId, "discord");
    if (!result.ok) {
      recordPairingAttempt(discordId);
      const reason =
        result.error === "expired" ? "That code has expired. Ask the admin for a fresh invite."
        : result.error === "used" ? "That code was already used. Ask the admin for a new one."
        : "That code isn't valid. Double-check it, or tap Request access below.";
      await reply({ text: reason, buttons: [{ label: "Request access", callbackData: `pair_req:discord:${discordId}:${name}` }] });
      return;
    }
    clearPairingAttempts(discordId);
    const created = supabase.upsertUser({ discord_id: discordId, name, role: result.role });
    invalidateUserCache(discordId);
    await sendDiscordPairingWelcome(reply, name, created?.id);
    return;
  }

  console.log(`Unpaired Discord DM: ${discordId}`);
  await reply({
    text: "You're not connected to this Nova yet. If you were given an invite code, send it here. Otherwise tap Request access.",
    buttons: [{ label: "Request access", callbackData: `pair_req:discord:${discordId}:${name}` }],
  });
}

// Set up Telegram middleware for user resolution (if Telegram is enabled)
const telegramAdapter = channels.getTelegram();
if (telegramAdapter) {
  telegramAdapter.use(async (ctx, next) => {
    const telegramId = ctx.from?.id.toString();
    if (!telegramId) return;

    const chatType = (ctx.chat as any)?.type;
    const isGroup = chatType === "group" || chatType === "supergroup" || chatType === "channel";

    if (isGroup) {
      // In groups: resolve the bot owner (admin) as the user context.
      // The group message will be filtered by the group message handler below.
      const admins = supabase.getUsersByRole("admin");
      const admin = admins?.[0];
      if (!admin) return; // No admin configured, skip group messages
      (ctx as any).novaUser = admin;
      (ctx as any).isGroupMessage = true;
      (ctx as any).groupSenderTelegramId = telegramId;
      await next();
      return;
    }

    const user = await resolveUser(telegramId, "telegram");
    if (!user) {
      // Unknown DM — run the self-serve pairing flow instead of dead-ending.
      // Button presses (e.g. "Request access") carry no message text; let them
      // flow through to the callback handler, which resolves pairing callbacks
      // before the usual "must be a known user" guard.
      if (ctx.callbackQuery) {
        await next();
        return;
      }

      const raw = (ctx.message?.text || "").trim();
      const firstName = pairingFirstName(ctx.from?.first_name);

      // A code-shaped message is treated as a redemption attempt.
      if (PAIRING_CODE_RE.test(raw)) {
        if (isPairingLockedOut(telegramId)) {
          await ctx.reply("Too many attempts. Please wait a few minutes and try your code again.");
          return;
        }
        // Widened at the call site: this project builds with strictNullChecks off,
        // where discriminated-union narrowing on a boolean flag is unreliable.
        const result: { ok: boolean; role?: string; error?: "invalid" | "expired" | "used" } =
          supabase.redeemPairingCode(raw, telegramId);
        if (!result.ok) {
          recordPairingAttempt(telegramId);
          const reason =
            result.error === "expired" ? "That code has expired. Ask the admin for a fresh invite."
            : result.error === "used" ? "That code was already used. Ask the admin for a new one."
            : "That code isn't valid. Double-check it, or tap Request access below.";
          await ctx.reply(reason, {
            reply_markup: { inline_keyboard: [[{ text: "Request access", callback_data: `pair_req:${telegramId}:${firstName}` }]] },
          });
          return;
        }
        clearPairingAttempts(telegramId);
        const created = supabase.upsertUser({ telegram_id: telegramId, name: firstName, role: result.role });
        invalidateUserCache(telegramId);
        await sendPairingWelcome(telegramId, firstName, created?.id);
        return;
      }

      console.log(`Unpaired DM: ${telegramId}`);
      await ctx.reply(
        "You're not connected to this Nova yet. If you were given an invite code, send it here. Otherwise tap Request access.",
        { reply_markup: { inline_keyboard: [[{ text: "Request access", callback_data: `pair_req:${telegramId}:${firstName}` }]] } }
      );
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
  // Pairing request — pressed by an UNKNOWN user, so it must run before the
  // "must be a known user" guard below. Notifies every admin with Approve/Deny.
  if (buttonData.startsWith("pair_req:")) {
    // Telegram (legacy): pair_req:<tgId>:<name>. Discord: pair_req:discord:<discordId>:<name>.
    // Discord ids never look numeric like a Telegram id, so a "discord" marker in
    // slot 1 unambiguously selects the channel while keeping Telegram byte-identical.
    const parts = buttonData.split(":");
    const isDiscord = parts[1] === "discord";
    const requesterPlatformId = isDiscord ? parts[2] : parts[1];
    const requesterName = pairingFirstName((isDiscord ? parts.slice(3) : parts.slice(2)).join(":"));
    if (isDiscord) {
      // Remember where to welcome/deny them once an admin decides.
      discordPairRequests.set(requesterPlatformId, { channelId: chatId, name: requesterName });
    }
    const okData = isDiscord ? `pair_ok:discord:${requesterPlatformId}` : `pair_ok:${requesterPlatformId}:${requesterName}`;
    const noData = isDiscord ? `pair_no:discord:${requesterPlatformId}` : `pair_no:${requesterPlatformId}`;
    const originLabel = isDiscord ? `discord:${requesterPlatformId}` : `tg:${requesterPlatformId}`;
    const admins = supabase.getUsersByRole("admin");
    const tg = channels.getTelegram();
    if (tg && admins?.length) {
      for (const admin of admins) {
        if (!admin.telegram_id) continue;
        await tg.send(admin.telegram_id, {
          text: `${requesterName} (${originLabel}) is requesting access to Nova.`,
          buttons: [
            { label: "✅ Approve", callbackData: okData },
            { label: "❌ Deny", callbackData: noData },
          ],
        }).catch(() => {});
      }
      await reply("Thanks! I've let the admin know. You'll hear back here once you're approved.");
    } else {
      await reply("Thanks! There's no admin available to approve access right now.");
    }
    return;
  }

  // Resolve user from cache (should already be cached from the message that triggered buttons)
  let user: NovaUser | null = null;
  for (const [_key, cached] of userCache) {
    if (cached.user.id === userId) { user = cached.user; break; }
  }
  // Fallback: try to resolve by telegram ID
  if (!user) user = await resolveUser(platformUserId, "telegram");
  if (!user) return;

  // Pairing approval/denial — admin-only, extends the existing callback machinery.
  if (buttonData.startsWith("pair_ok:")) {
    if (user.role !== "admin") { await reply("Only an admin can approve access."); return; }
    const parts = buttonData.split(":");
    // Discord variant: pair_ok:discord:<discordId> (name/channel come from the pending map).
    if (parts[1] === "discord") {
      const newDiscordId = parts[2];
      const pending = discordPairRequests.get(newDiscordId);
      const newName = pending?.name || pairingFirstName();
      if (supabase.getUserByDiscordId(newDiscordId)) {
        discordPairRequests.delete(newDiscordId);
        if (editOriginal) await editOriginal(`${newName} already has access.`);
        return;
      }
      const created = supabase.upsertUser({ discord_id: newDiscordId, name: newName, role: "member" });
      invalidateUserCache(newDiscordId);
      // Welcome the requester in their Discord DM if we still know where they are.
      const discord = channels.get("discord");
      if (pending?.channelId && discord) {
        await discord.send(pending.channelId, {
          text: buildWelcomeMessage(newName),
          buttons: exampleButtons().flat().map((b) => ({ label: b.label, callbackData: b.callbackData })),
        }).catch(() => {});
        if (created?.id) supabase.setOnboardedAt(created.id);
      }
      discordPairRequests.delete(newDiscordId);
      if (editOriginal) await editOriginal(`✅ Approved ${newName}. They now have access.`);
      return;
    }
    const newTgId = parts[1];
    const newName = pairingFirstName(parts.slice(2).join(":"));
    if (supabase.getUserByTelegramId(newTgId)) {
      if (editOriginal) await editOriginal(`${newName} already has access.`);
      return;
    }
    const created = supabase.upsertUser({ telegram_id: newTgId, name: newName, role: "member" });
    invalidateUserCache(newTgId);
    await sendPairingWelcome(newTgId, newName, created?.id);
    if (editOriginal) await editOriginal(`✅ Approved ${newName}. They now have access.`);
    return;
  }

  if (buttonData.startsWith("pair_no:")) {
    if (user.role !== "admin") { await reply("Only an admin can deny access."); return; }
    const parts = buttonData.split(":");
    if (parts[1] === "discord") {
      const newDiscordId = parts[2];
      const pending = discordPairRequests.get(newDiscordId);
      const discord = channels.get("discord");
      if (pending?.channelId && discord) {
        await discord.send(pending.channelId, { text: "Thanks for your interest — the admin isn't able to grant access right now." }).catch(() => {});
      }
      discordPairRequests.delete(newDiscordId);
      if (editOriginal) await editOriginal("Request denied.");
      return;
    }
    const newTgId = parts[1];
    const tg = channels.getTelegram();
    if (tg) await tg.send(newTgId, "Thanks for your interest — the admin isn't able to grant access right now.").catch(() => {});
    if (editOriginal) await editOriginal("Request denied.");
    return;
  }

  // Skill-proposal review (prop:<id>:approve | prop:<id>:reject) — admin-guarded,
  // extends the existing callback machinery like the pair_* handlers above.
  if (buttonData.startsWith("prop:")) {
    if (user.role !== "admin") { await reply("Only an admin can review skill ideas."); return; }
    const parsed = parseProposalCallback(buttonData);
    if (!parsed) { await reply("Invalid proposal action."); return; }
    if (parsed.action === "approve") {
      const res = await approveProposal(supabase, user.id, parsed.id);
      const msg = res.ok
        ? (res.slug ? "✓ Saved as a learned skill." : "✓ Saved to memory.")
        : "Couldn't save that idea — it may already have been decided.";
      if (editOriginal) await editOriginal(msg); else await reply(msg);
    } else {
      await rejectProposal(supabase, user.id, parsed.id);
      const msg = "Dismissed.";
      if (editOriginal) await editOriginal(msg); else await reply(msg);
    }
    return;
  }

  // Approval buttons (apv:...) are handled directly by the Telegram adapter's onApproval handler

  // Health monitor buttons (hm:fix:<id>, hm:ignore:<id>, hm:detail:<id>)
  if (buttonData.startsWith("hm:")) {
    const parts = buttonData.split(":");
    const action = parts[1]; // fix, ignore, detail
    const issueId = parts.slice(2).join(":");
    console.log(`[health-monitor] Button: ${action} for issue ${issueId}`);

    try {
      const pendingPath = join(PROJECT_ROOT, "data", "health-pending.json");
      const pendingRaw = await Bun.file(pendingPath).text();
      const pending = JSON.parse(pendingRaw) as { issues: any[] };
      const issue = pending.issues.find((i: any) => i.id === issueId);

      if (!issue) {
        await reply("Issue not found — it may have already been resolved.");
        return;
      }

      const adapter = channels.get("telegram") || channels.getAll()[0];
      if (!adapter) return;

      if (action === "fix") {
        if (editOriginal) await editOriginal(`Fixing: ${issue.title}...`);

        // Execute fix based on fixAction
        let fixResult = "";
        try {
          if (issue.fixAction === "restart_service") {
            const isMac = process.platform === "darwin";
            if (isMac) {
              const plistPath = join(process.env.HOME || "", "Library", "LaunchAgents", `${issue.fixTarget}.plist`);
              const unload = spawn(["launchctl", "unload", plistPath], { stdout: "pipe", stderr: "pipe" });
              await unload.exited;
              const load = spawn(["launchctl", "load", plistPath], { stdout: "pipe", stderr: "pipe" });
              await load.exited;
            } else {
              const svc = issue.fixTarget.replace("com.nova.", "nova-");
              const proc = spawn(["sudo", "systemctl", "restart", svc], { stdout: "pipe", stderr: "pipe" });
              await proc.exited;
            }
            fixResult = `Restarted ${issue.fixTarget}`;
          } else if (issue.fixAction === "delete_branch") {
            const proc = spawn(["git", "-C", PROJECT_ROOT, "branch", "-d", issue.fixTarget], { stdout: "pipe", stderr: "pipe" });
            await proc.exited;
            fixResult = `Deleted branch ${issue.fixTarget}`;
          } else if (issue.fixAction === "git_stash") {
            const proc = spawn(["git", "-C", PROJECT_ROOT, "stash", "--include-untracked"], { stdout: "pipe", stderr: "pipe" });
            await proc.exited;
            fixResult = "Stashed dirty working tree";
          } else if (issue.fixAction === "bun_install") {
            const proc = spawn(["bun", "install", "--cwd", PROJECT_ROOT], { stdout: "pipe", stderr: "pipe" });
            await proc.exited;
            fixResult = "Ran bun install to sync dependencies";
          } else {
            fixResult = `Unknown fix action: ${issue.fixAction}`;
          }
        } catch (e: any) {
          fixResult = `Fix failed: ${e.message}`;
        }

        issue.status = "resolved";
        await Bun.write(pendingPath, JSON.stringify(pending, null, 2));
        if (editOriginal) await editOriginal(`Fixed: ${issue.title}\n${fixResult}`);

      } else if (action === "ignore") {
        issue.status = "suppressed";
        issue.suppressedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        await Bun.write(pendingPath, JSON.stringify(pending, null, 2));
        if (editOriginal) await editOriginal(`Ignored for 24h: ${issue.title}`);

      } else if (action === "detail") {
        const detail = `Issue: ${issue.title}\nCheck: ${issue.check}\nSeverity: ${issue.severity}\nTime: ${issue.timestamp}\n\n${issue.detail}`;
        await reply(detail);
      }
    } catch (e: any) {
      console.error("[health-monitor] Button handler error:", e);
      await reply(`Error handling health monitor action: ${e.message}`);
    }
    return;
  }

  // Board meeting option selection (board_option:<sessionId>:<optionIndex>)
  if (buttonData.startsWith("board_option:") && boardModule) {
    const parts = buttonData.split(":");
    const sessionId = parts[1];
    const optionIndex = parts[2];
    if (sessionId && optionIndex) {
      await reply(`Selected option ${parseInt(optionIndex) + 1}. Processing decision...`);
      boardModule.handleBoardDecision(sessionId, optionIndex, user.id).catch((err) => {
        console.error("[board] Decision handler error:", err);
      });
    }
    return;
  }

  // Board meeting dismiss
  if (buttonData.startsWith("board_dismiss:") && boardModule) {
    await reply("Board meeting dismissed.");
    return;
  }

  // Zoom recording selection (zoom_pick:<uuid>:<userId>)
  if (buttonData.startsWith("zoom_pick:")) {
    const parts = buttonData.split(":");
    const uuid = parts[1];
    const targetUserId = parts[2];
    const meeting = zoomSearchCache.get(uuid);
    if (!meeting) {
      await reply("Recording not found in cache — try /zoom search again.");
      return;
    }
    if (editOriginal) await editOriginal(`Processing: ${meeting.topic}...`);
    processRecordingById(targetUserId, meeting).catch((err: Error) =>
      reply(`Failed to process recording: ${err.message}`)
    );
    return;
  }

  if (buttonData.startsWith("use_agent:")) {
    const slug = buttonData.slice("use_agent:".length);
    const agents = getAllAgents();
    const agent = agents.find((a) => a.slug === slug);
    if (!agent) {
      await reply("Agent not found.");
      return;
    }
    await reply({
      html: `You selected <b>${agent.name}</b> — ${agent.description}.\n\nWhat would you like <b>${agent.name}</b> to help with?`,
    });
    return;
  }

  if (buttonData === "feedback:good" || buttonData === "feedback:bad") {
    const rating = buttonData === "feedback:good" ? 1 : -1;
    const rated = await rateLastPattern(supabase, user.id, rating as 1 | -1);
    if (rating === 1) {
      await reply(rated ? "Thanks! I'll prioritize this approach." : "Thanks for the feedback!");
    } else {
      await reply(rated ? "Got it. I'll try a different approach next time." : "Got it. I'll keep that in mind.");
    }
    return;
  }

  if (buttonData.startsWith("cancel_schedule:")) {
    const taskId = buttonData.slice("cancel_schedule:".length).trim();
    if (!taskId) {
      await reply("Invalid schedule ID.");
      return;
    }
    try {
      const cancelled = supabase.cancelScheduledTask(user.id, taskId);
      await reply(cancelled ? "Schedule cancelled." : "Schedule not found or already cancelled.");
    } catch (e: any) {
      console.error("[cancel_schedule] Error:", e);
      await reply("Something went wrong cancelling the schedule.");
    }
    return;
  }

  if (buttonData.startsWith("pause_schedule:")) {
    const taskId = buttonData.slice("pause_schedule:".length).trim();
    if (!taskId) {
      await reply("Invalid schedule ID.");
      return;
    }
    try {
      supabase.updateScheduledTask(taskId, { status: "paused" }, user.id);
      await reply("Schedule paused. Send /schedule to resume it anytime.");
    } catch (e: any) {
      console.error("[pause_schedule] Error:", e);
      await reply("Something went wrong pausing the schedule.");
    }
    return;
  }

  if (buttonData.startsWith("resume_schedule:")) {
    const taskId = buttonData.slice("resume_schedule:".length).trim();
    if (!taskId) {
      await reply("Invalid schedule ID.");
      return;
    }
    try {
      supabase.updateScheduledTask(taskId, { status: "active" }, user.id);
      await reply("Schedule resumed.");
    } catch (e: any) {
      console.error("[resume_schedule] Error:", e);
      await reply("Something went wrong resuming the schedule.");
    }
    return;
  }

  if (buttonData.startsWith("tkt:")) {
    const [, ticketId, action] = buttonData.split(":");
    const operator = process.env.TICKET_OPERATOR_USER_ID || "";
    if (!operator || user.id !== operator) { await reply("Not authorized to act on support tickets."); return; }
    try {
      const { handleTicketApproval } = await import("../services/ticket-worker.ts");
      const { sendTicketEmail } = await import("./resend-client.ts");
      const dryRun = (process.env.TICKET_DEPLOY_DRYRUN || "true") === "true";
      await handleTicketApproval(supabase, operator, ticketId, action === "approve" ? "approve" : "reject", { sendEmail: sendTicketEmail, dryRun });
      await reply(action === "approve" ? "Approved — deploying the fix." : "Rejected. The client will get a personal follow-up.");
    } catch (e: any) {
      console.error("[tkt approval]", e);
      await reply("Something went wrong handling that ticket action.");
    }
    return;
  }

  if (buttonData.startsWith("devtask_pick:")) {
    const [, projectId, encodedDesc] = buttonData.split(":");
    const description = decodeURIComponent(encodedDesc ?? "");

    if (!description) {
      await editOriginal?.("Please use /devtask <description> to specify what to work on.");
      return;
    }

    const project = supabase.getProject(user.id, projectId);
    if (!project) {
      await editOriginal?.("Project not found.");
      return;
    }

    const taskId = supabase.createDevTask(user.id, projectId, description);
    await editOriginal?.(
      `📋 Dev task queued on ${project.name}\nID: ${taskId}\nI'll start working shortly.`
    );
    return;
  }

  // devtask:<projectId>:<text> — NL dev task confirmation from orchestrator
  // devtask:normal:<text>     — user chose to handle normally
  if (buttonData.startsWith("devtask:")) {
    const firstColon = buttonData.indexOf(":");
    const secondColon = buttonData.indexOf(":", firstColon + 1);
    const projectIdOrNormal = buttonData.slice(firstColon + 1, secondColon);
    const taskText = buttonData.slice(secondColon + 1);

    if (projectIdOrNormal === "normal") {
      // Treat as a regular message — route back through orchestrator
      await editOriginal?.(`Handling normally: ${taskText.substring(0, 60)}...`);
      const adapter = channels.get("telegram") || channels.getAll()[0];
      if (!adapter) return;
      const platformCtx = createGenericPlatformContext(adapter, chatId, user);
      const sk = getSessionKey(user.id, "telegram");
      orchestrate(platformCtx as any, taskText, user, supabase, sk, "telegram");
    } else {
      const project = supabase.getProject(user.id, projectIdOrNormal);
      if (!project) {
        await editOriginal?.("Project not found.");
        return;
      }
      const taskId = supabase.createDevTask(user.id, projectIdOrNormal, taskText);
      await editOriginal?.(
        `Dev task queued on ${project.name}\nID: ${taskId}\nI'll start working shortly.`
      );
    }
    return;
  }

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

    const buttonSessionKey = getSessionKey(user!.id, "telegram");
    runTask(platformCtx, `Button: ${selection.substring(0, 40)}`, async () => {
      const [relevantContext, memoryContext, sessionSummary, taskContext, scheduleContext] = await Promise.all([
        getRelevantContext(supabase, selection, user!.id),
        getMemoryContext(supabase, user!.id),
        getSessionSummaryContext(supabase, user!.id, buttonSessionKey),
        getTaskContext(supabase, user!.id),
        getScheduleContext(supabase, user!.id, user!.timezone),
      ]);
      const recentHistory = await getRecentHistory(supabase, user!.id, sessionSummary ? 5 : 12);
      const { systemPrompt: btnSysPrompt, userPrompt: btnUserPrompt } = buildPrompt(
        user!,
        `[Button selected in response to a question]: ${selection}`,
        relevantContext,
        memoryContext,
        recentHistory,
        taskContext,
        scheduleContext,
        { sessionSummary: sessionSummary || undefined }
      );
      return {
        prompt: btnUserPrompt,
        systemPrompt: btnSysPrompt,
        hint: selection,
      };
    }, {
      postProcess: (raw) => processMemoryIntents(supabase, raw, user!.id, user!.timezone),
      userId: user!.id,
      sessionKey: buttonSessionKey,
      userMessage: selection,
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
// CALL AI — provider-agnostic with model selection, retry, and monitoring
// ============================================================

// Re-export ModelTier from ai-provider for backward compat
type LegacyModelTier = "haiku" | "sonnet" | "opus";

/** Map legacy Claude-specific model tier names to generic tiers */
function legacyToGenericTier(model?: LegacyModelTier | ModelTier): ModelTier {
  switch (model) {
    case "haiku": case "fast": return "fast";
    case "sonnet": case "standard": return "standard";
    case "opus": case "premium": return "premium";
    default: return "standard";
  }
}

async function callAI(prompt: string, model?: LegacyModelTier | ModelTier, userId?: string, hint?: string, queueCallbacks?: { onQueued?: () => void; onDequeue?: () => void }, forceProvider?: string, userDefaultProvider?: string, systemPrompt?: string): Promise<string> {
  await acquireClaudeSlot(prompt.substring(0, 60), queueCallbacks);

  const maxRetries = 2;
  let lastError: Error | null = null;

  try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = 3000 * Math.pow(3, attempt - 1);
          emit({
            type: "error",
            level: "warn",
            userId: userId,
            data: { message: `Attempt ${attempt + 1}/${maxRetries + 1} after ${delay / 1000}s delay`, module: "retry" },
          });
          await new Promise((r) => setTimeout(r, delay));
        }
        return await _callAIOnce(prompt, model, userId, hint, forceProvider, userDefaultProvider, systemPrompt);
      } catch (error) {
        lastError = error as Error;
        const isRateLimit = (lastError as any).isRateLimit || lastError.message.includes("rate") || lastError.message.includes("overloaded");
        if (isRateLimit) {
          // Record rate limit for routing fallback
          const providerName = (lastError as any).providerName;
          if (providerName) recordRateLimit(providerName);
          recordCall(false, model || "standard", 0, true);
          console.warn(`[rate-limit] Hit rate limit on attempt ${attempt + 1}`);
          // On retry, clear forceProvider to allow fallback
          forceProvider = undefined;
          continue;
        }
        if (attempt >= 1) break;
      }
    }

    throw lastError || new Error("AI call failed after retries");
  } finally {
    releaseClaudeSlot();
  }
}

async function _callAIOnce(prompt: string, model?: LegacyModelTier | ModelTier, userId?: string, hint?: string, forceProvider?: string, userDefaultProvider?: string, systemPrompt?: string): Promise<string> {
  const tier = legacyToGenericTier(model);

  // Resolve MCP config for user — regenerate if missing or if any token is expiring soon
  let mcpConfigPath: string | undefined;
  if (userId) {
    const connected = supabase.getConnectedIntegrations(userId);
    if (connected && connected.length > 0) {
      const configMissing = !hasUserMcpConfig(userId);
      const TOKEN_BUFFER_MS = 2 * 60 * 1000; // 2-minute buffer
      const hasExpiringToken = connected.some(i => {
        const exp = i.credentials?.expires_at;
        return exp && Date.now() >= exp - TOKEN_BUFFER_MS;
      });
      if (configMissing || hasExpiringToken) {
        await regenerateMcpConfig(supabase, userId);
      }
    }
    if (hasUserMcpConfig(userId)) {
      mcpConfigPath = hint
        ? await getFilteredMcpConfigPath(userId, hint)
        : getUserMcpConfigPath(userId);
    }
  }

  // Smart route to best provider (userDefaultProvider passed from caller to avoid DB lookup per call)
  const resolvedDefault = userDefaultProvider || (userId ? supabase.getUserById(userId)?.ai_provider : undefined);
  const route = await selectProvider({
    tier,
    hint,
    userId,
    forceProvider,
    hasMcpConfig: !!mcpConfigPath,
    requiresTools: !!mcpConfigPath,
    userDefaultProvider: resolvedDefault || undefined,
  });

  const { provider, model: resolvedModel, reason } = route;
  emit({
    type: "agent.dispatched",
    level: "info",
    userId: userId,
    data: {
      message: `Calling ${provider.name} [${resolvedModel}] (${runningClaude}/${MAX_CONCURRENT_CLAUDE} slots, ${claudeQueue.length} queued, route: ${reason}): ${prompt.substring(0, 50)}...`,
      module: "ai",
      provider: provider.name,
      model: resolvedModel,
      reason,
    },
  });

  try {
    // Only disable MCP for explicitly tool-free contexts (heartbeat, etc.)
    const noToolHints = ["heartbeat", "memory-review", "log-monitor"];
    const noMcp = hint ? noToolHints.includes(hint) : false;

    // Sandboxed hints: pure text LLM calls (classification, summarization) — no bypass flags, no tools.
    const sandboxedHints = ["classify", "summarize", "approval-summary"];
    const sandboxed = hint ? sandboxedHints.includes(hint) : false;

    // mcp2cli: always use CLI-based tool access unless explicitly disabled.
    // Agents call mcp2cli via Bash on-demand — no --mcp-config schema injection needed.
    // Set MCP2CLI_ENABLED=false only as a local dev fallback if mcp2cli isn't installed.
    const mcp2cliEnabled = process.env.MCP2CLI_ENABLED !== "false";
    const useMcp2cli = mcp2cliEnabled && !noMcp && !sandboxed && !!mcpConfigPath;

    const traceId = crypto.randomUUID();

    // Cognitive cascade: for conversational calls that don't need tool access.
    // Skipped for sandboxed (classify/summarize), tool-heavy (mcp), and noTool hints.
    const cascadeEnabled = process.env.NOVA_CASCADE_ENABLED !== "false";
    if (cascadeEnabled && !sandboxed && !noMcp && !mcpConfigPath) {
      try {
        const cascadeResult = await runCognitiveCascade({
          prompt,
          systemPrompt,
          userId,
          hint,
          userDefaultProvider: resolvedDefault || undefined,
          hasMcpConfig: false,
          traceId,
        });
        recordCall(true, cascadeResult.model, 0, false);
        recordUsage(cascadeResult.provider, 0);
        console.log(`[cascade] tier=${cascadeResult.tier} provider=${cascadeResult.provider} iter=${cascadeResult.iterations}`);
        return cascadeResult.text;
      } catch (cascadeErr) {
        console.warn("[cascade] Failed, falling back to direct call:", cascadeErr);
      }
    }

    const result: AIProviderResult = await provider.call({
      prompt,
      systemPrompt: sandboxed ? undefined : systemPrompt,
      model: resolvedModel,
      mcpConfigPath: useMcp2cli ? undefined : (sandboxed ? undefined : mcpConfigPath),
      useMcp2cli,
      noMcp: noMcp || sandboxed,
      sandboxed,
      outputFormat: sandboxed ? "text" : "json",
      userId,
      traceId,
    });

    // Async logging of the trace to DB (no await)
    if (userId) {
      (async () => {
        try {
          supabase.saveLlmTrace({
            trace_id: traceId,
            user_id: userId,
            provider: result.provider,
            model: result.model,
            prompt, // Scrubbing sensitive info could be added here
            response: result.text,
            input_tokens: result.usage?.input_tokens || 0,
            output_tokens: result.usage?.output_tokens || 0,
            cost_usd: result.cost_usd || 0,
            duration_ms: result.duration_ms,
            metadata: { hint, reason },
          });
        } catch (e) {
          console.error("[tracing] Failed to log trace:", e);
        }
      })();
    }

    // Record stats
    recordCall(true, result.model, result.duration_ms, false);

    // Track cost
    if (result.usage) {
      trackCost({
        provider: result.provider as any,
        model: result.model,
        input_tokens: result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
        cache_read_tokens: result.usage.cache_read_tokens || 0,
        cache_creation_tokens: result.usage.cache_creation_tokens || 0,
        cost_usd: result.cost_usd || 0,
        duration_ms: result.duration_ms,
        session_id: result.session_id || undefined,
      });
      emit({
        type: "cost.tracked",
        level: "debug",
        userId: userId,
        data: {
          message: `${result.provider} ${result.model}: $${(result.cost_usd || 0).toFixed(4)}`,
          provider: result.provider,
          model: result.model,
          cost_usd: result.cost_usd || 0,
          input_tokens: result.usage?.input_tokens || 0,
          output_tokens: result.usage?.output_tokens || 0,
        },
      });
    }

    return result.text;
  } catch (error) {
    // Tag error with provider name for retry routing
    if (error instanceof Error) {
      (error as any).providerName = provider.name;
    }
    throw error;
  }
}

/** Backward-compatible alias */
const callClaude = callAI;

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
  buildTask: () => Promise<{ prompt: string; systemPrompt?: string; model?: ModelTier; hint?: string }>,
  opts?: { postProcess?: (response: string) => Promise<string>; userId?: string; sessionKey?: string; userMessage?: string }
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
    // Send a progress message and update it with elapsed time
    let progressMsgId: number | null = null;
    let progressFinalized = false;
    try {
      const msg = await ctx.reply("Working on it...");
      progressMsgId = msg.message_id;
    } catch {}

    const progressInterval = setInterval(async () => {
      if (!progressMsgId) return;
      const elapsed = Math.round((Date.now() - task.startTime) / 1000);
      try {
        await ctx.api.editMessageText(
          ctx.chat!.id, progressMsgId,
          `Working on it... (${elapsed}s)`
        );
      } catch {}
    }, 8000);

    try {
      const { prompt, systemPrompt: taskSysPrompt, model, hint: taskHint } = await buildTask();

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
      const forceProvider = (ctx as any)._forceProvider || undefined;
      const userDefaultProvider = taskUserId ? supabase.getUserById(taskUserId)?.ai_provider : undefined;
      const rawResponse = isSentinel
        ? prompt
        : await callAI(prompt, model, taskUserId, taskHint, queueCallbacks, forceProvider, userDefaultProvider, taskSysPrompt);

      const response = opts?.postProcess
        ? await opts.postProcess(rawResponse)
        : rawResponse;

      // Update working memory session summary (fire-and-forget)
      if (opts?.userId && opts?.sessionKey) {
        updateSessionSummaryAsync(
          supabase,
          opts.userId,
          opts.sessionKey,
          opts.userMessage || "",
          rawResponse
        );
      }

      // Orchestrator handled the response internally — skip sending
      if (response === "__SKIP__") {
        clearInterval(progressInterval);
        progressFinalized = true;
        if (progressMsgId) {
          try { await ctx.api.deleteMessage(ctx.chat!.id, progressMsgId); } catch {}
        }
        return;
      }

      // Finalize progress message
      clearInterval(progressInterval);
      progressFinalized = true;
      if (progressMsgId) {
        const elapsed = Math.round((Date.now() - task.startTime) / 1000);
        try {
          await ctx.api.editMessageText(
            ctx.chat!.id, progressMsgId,
            `Done (${elapsed}s)`
          );
        } catch {}
      }

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

      // Fire-and-forget: pre-compute likely next queries for faster future responses
      if (userId && opts?.userMessage) {
        const recentMsgs = supabase.getRecentMessages(userId, 6);
        triggerPredictions(supabase, userId, recentMsgs, response, (p) => callAI(p, "fast", userId, "predict"));
      }

      emit({
        type: "message.responded",
        level: "info",
        userId,
        data: { message: `Response sent to ${((ctx as any).novaUser as NovaUser)?.name || "user"}`, responseLength: response?.length || 0 },
      });

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
            // Install dependencies before restarting to pick up any new packages
            try {
              const installProc = spawn(["bun", "install", "--cwd", PROJECT_ROOT], { stdout: "pipe", stderr: "pipe" });
              await installProc.exited;
              console.log("[self-edit] bun install completed");
            } catch (e) {
              console.warn("[self-edit] bun install failed:", e);
            }
            setTimeout(() => {
              console.log("[self-edit] Auto-reload — exiting for service manager restart");
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
        const codeMatch = errMsg.match(/exited with code (\d+)/);
        const exitCode = codeMatch ? codeMatch[1] : "?";
        const providerMatch = errMsg.match(/^(\w+) CLI exited/);
        const providerName = providerMatch ? providerMatch[1] : "AI";
        const hasZeroOutput = errMsg.includes("0 output tokens");
        msg = hasZeroOutput
          ? `⚠️ ${providerName} CLI failed (exit ${exitCode}) — the AI couldn't generate a response. This is usually a transient API error. Try again.`
          : `⚠️ ${providerName} CLI crashed (exit ${exitCode}). Try again in a moment.`;
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
      clearInterval(progressInterval);
      clearInterval(typingInterval);
      activeTasks.delete(taskId);
      // Mark progress message as failed if it wasn't already finalized
      if (progressMsgId && !progressFinalized) {
        const elapsed = Math.round((Date.now() - task.startTime) / 1000);
        await ctx.api.editMessageText(
          ctx.chat!.id, progressMsgId,
          `Failed (${elapsed}s)`
        ).catch(() => {});
      }
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
// GROUP MESSAGE FILTER
// In group chats (Telegram / Slack), Nova only responds when:
//   1. Directly @mentioned by name
//   2. Message directly relates to an active goal or task Nova is tracking
// DMs always process normally.
// ============================================================

/**
 * Determine if Nova should respond to a group message.
 * Returns true if it should respond, false to silently ignore.
 */
async function shouldRespondToGroupMessage(msg: IncomingMessage, user: NovaUser, text: string): Promise<boolean> {
  // Always respond if @mentioned
  if (msg.isMentioned) return true;

  // Check if text contains the bot name / "nova" keyword (case-insensitive)
  const escapedBotName = _botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const botNamePattern = new RegExp(`\\b${escapedBotName}\\b`, "i");
  if (/\bnova\b/i.test(text) || botNamePattern.test(text)) return true;

  // Check for reply to Nova's own message (always respond in threads)
  if (msg.replyToMessageId) return true;

  // Check if message relates to active goals or tasks
  // Use a quick keyword overlap check against active goals/tasks
  try {
    const activeGoals = supabase.getGoalsNeedingReview(user.id, 9999);
    const activeTasks = supabase.getActiveTasks(user.id);

    const relevantContent = [
      ...activeGoals.map((g: any) => g.content),
      ...activeTasks.map((t: any) => t.description),
    ].join(" ").toLowerCase();

    if (relevantContent.length === 0) return false;

    // Simple keyword overlap: tokenize message and check against active work context
    const msgWords = text.toLowerCase().split(/\W+/).filter(w => w.length > 3);
    const contextWords = new Set(relevantContent.split(/\W+/).filter(w => w.length > 3));
    const overlap = msgWords.filter(w => contextWords.has(w)).length;

    // At least 2 meaningful word overlaps to be considered relevant
    if (overlap >= 2) return true;
  } catch {
    // Non-critical: if check fails, default to not responding in groups
  }

  return false;
}

// ============================================================
// INPUT SANITIZATION (prompt injection defense)
// ============================================================

/** Strip intent tags from untrusted user input to prevent prompt injection.
 *  Only applied to external channel messages — NOT to internal AI responses. */
const INTENT_TAG_RE = /\[(?:TASK|REMEMBER|SHARE|GOAL|DONE|SCHEDULE|SCHEDULE_CANCEL|SCHEDULE_PAUSE|SCHEDULE_RESUME|SCHEDULE_EDIT|DELEGATE|BRIEF|DECISION|MESSAGE):[^\]]*\]/gi;

function sanitizeUserInput(text: string): string {
  return text
    .replace(INTENT_TAG_RE, "")
    .replace(/^(system|assistant|human)\s*:/gim, "")
    .trim();
}

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
      // Discord: run the same self-serve pairing the Telegram middleware offers.
      if (msg.channelType === "discord") {
        await handleUnknownDiscordUser(msg, reply);
        return;
      }
      console.log(`Unauthorized ${msg.channelType}: ${msg.platformUserId}`);
      await reply({ text: "This bot is private. Ask the admin to add you." });
      return;
    }
    if (platformCtx) platformCtx.novaUser = user;
  }

  if (!user) return;

  // ============================================================
  // GROUP MESSAGE FILTER
  // Groups: only respond if @mentioned OR message relates to active goals/tasks
  // DMs: always process normally
  // ============================================================
  if (msg.isGroup && msg.text) {
    const shouldRespond = await shouldRespondToGroupMessage(msg, user, msg.text);
    if (!shouldRespond) return; // silently ignore
  }

  // Ensure per-user workspace directory exists (lazy creation on first message)
  mkdir(getUserWorkspaceDir(user.id), { recursive: true }).catch(() => {});

  // Use the platform context for all subsequent operations
  const ctx = platformCtx || createGenericPlatformContext(msg.channelType === "telegram"
    ? channels.getTelegram()!
    : channels.get(msg.channelType)!, msg.channelChatId, user);
  (ctx as any).novaUser = user;
  (ctx as any).channelType = msg.channelType;

  // --- TEXT MESSAGES ---
  if (msg.text) {
    const text = sanitizeUserInput(msg.text);
    (ctx as any).novaReplyTo = msg.channelMessageId;
    emit({
      type: "message.received",
      level: "info",
      userId: user.id,
      data: { message: `${user.name}: ${text.substring(0, 80)}`, channel: msg.channelType, textLength: text.length },
    });

    // Rate limit check (skip for admin commands)
    if (!text.startsWith("/") && isRateLimited(user.id)) {
      await ctx.reply("You're sending messages too fast. Please wait a moment.");
      return;
    }

    // First-run welcome — fires exactly once, on the user's first non-command message.
    // Sends the friendly welcome + tappable starter buttons, then continues to process
    // whatever they actually typed.
    if (!text.trim().startsWith("/") && !supabase.getOnboardedAt(user.id)) {
      try {
        await ctx.reply(buildWelcomeMessage(user.name), {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: exampleButtons().map((row) => row.map((b) => ({ text: b.label, callback_data: b.callbackData }))) },
        });
      } catch (err) {
        console.warn("[relay] first-run welcome failed:", err);
      }
      supabase.setOnboardedAt(user.id);
      // fall through — still handle their message
    }

    // /start — always greets and shows starter buttons (replayable anytime).
    if (text.trim().toLowerCase() === "/start") {
      await ctx.reply(buildWelcomeMessage(user.name), {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: exampleButtons().map((row) => row.map((b) => ({ text: b.label, callback_data: b.callbackData }))) },
      });
      supabase.setOnboardedAt(user.id);
      return;
    }

    // /help — friendly, task-oriented help (plain language for non-technical users).
    if (text.trim().toLowerCase() === "/help" || text.trim().toLowerCase() === "/help ") {
      await ctx.reply(buildHelpMessage(), { parse_mode: "Markdown" });
      return;
    }

    // /team — meet your specialists, grouped by outcome in plain language.
    if (text.trim().toLowerCase() === "/team") {
      await ctx.reply(buildTeamMessage(getAllAgents()), { parse_mode: "Markdown" });
      return;
    }

    // /playbooks — list; /playbook seed — load starters; /playbook run <name> [k=v] — run one.
    {
      const lc = text.trim().toLowerCase();
      if (lc === "/playbooks" || lc === "/playbook" || lc === "/playbook list") {
        const pbs = supabase.listPlaybooksVisible(user.id);
        if (!pbs.length) {
          await ctx.reply("📋 *No playbooks yet.*\n\nPlaybooks are reusable SOPs — author a process once, run it many times. Load the starter library with `/playbook seed`, then run one with `/playbook run <name> key=value`.", { parse_mode: "Markdown" });
          return;
        }
        const lines = ["📋 *Playbooks*", "", ...pbs.map(p => `• ${describePlaybook(p)}`), "", "_Run one:_ `/playbook run <name> key=value`"];
        await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
        return;
      }
      if (lc === "/playbook seed") {
        let n = 0;
        for (const s of SEED_PLAYBOOKS) {
          if (!supabase.findPlaybook(user.id, s.name)) { supabase.insertPlaybook({ ...s, scope: "personal", userId: user.id }); n++; }
        }
        await ctx.reply(`✓ Loaded ${n} starter playbook${n === 1 ? "" : "s"}. Send /playbooks to see them.`);
        return;
      }
      if (lc.startsWith("/playbook run ") || /\brun\s+(?:the\s+)?[\w-]+\s+playbook\b/i.test(text) || /\brun\s+playbook\s+[\w-]+/i.test(text)) {
        const { parsePlaybookInvocation } = await import("./playbooks.ts");
        const { name, vars } = parsePlaybookInvocation(text);
        if (!name) { await ctx.reply("Which playbook? Try `/playbook run <name> key=value`.", { parse_mode: "Markdown" }); return; }
        const found = supabase.findPlaybook(user.id, name);
        if (!found) { await ctx.reply(`No playbook named *${name}*. Send /playbooks to list, or /playbook seed for starters.`, { parse_mode: "Markdown" }); return; }
        const { plan, missing, errors } = renderPlaybook(found, vars);
        if (errors.length) { await ctx.reply(`Can't run it: ${errors.join("; ")}`); return; }
        if (missing.length || !plan) {
          await ctx.reply(`*${found.name}* needs: ${missing.map(m => `\`${m}\``).join(", ")}\n\nExample: \`/playbook run ${found.name} ${missing.map(m => `${m}=…`).join(" ")}\``, { parse_mode: "Markdown" });
          return;
        }
        await saveMessage("user", `[Playbook: ${found.name}]`, user.id, undefined, msg.channelType);
        runPlan(ctx, `Playbook: ${found.name}`, user, supabase, plan, getSessionKey(user.id, msg.channelType));
        await ctx.reply(`▶️ Running playbook *${found.name}* (${plan.subtasks.length} steps)…`, { parse_mode: "Markdown" });
        return;
      }
    }

    // /processes — list durable processes; /process signal <event> resumes those waiting on it.
    {
      const lc = text.trim().toLowerCase();
      if (lc === "/processes" || lc === "/process") {
        const procs = supabase.listProcesses(user.id);
        if (!procs.length) {
          await ctx.reply("⏳ *No durable processes.*\n\nProcesses run multi-step work that spans time — with waits for a timer or an external event. Start one from a playbook: `nova process start <name> --from-playbook <pb>`, or design one in the dashboard.", { parse_mode: "Markdown" });
          return;
        }
        const lines = ["⏳ *Durable processes*", "", ...procs.slice(0, 20).map(p => {
          const wait = p.state === "waiting" ? (p.waitUntil ? ` ⏱ ${p.waitUntil}` : p.waitEvent ? ` ⏸ ${p.waitEvent}` : "") : "";
          return `${p.state === "done" ? "✓" : p.state === "waiting" ? "⏸" : p.state === "failed" ? "✗" : "▶"} *${p.name}* — step ${p.currentStep}/${p.steps.length}${wait}`;
        })];
        await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
        return;
      }
      const sig = text.trim().match(/^\/process\s+signal\s+([\w.:-]+)/i);
      if (sig) {
        const { resumeOnEvent } = await import("./process-engine.ts");
        const runStep = async (uid: string, description: string, agent: string | undefined) => {
          const taskId = await dispatchAutonomousTask(uid, agent || "general", description, "process").catch(() => null);
          return { success: true, result: taskId || "dispatched" };
        };
        const n = await resumeOnEvent(supabase, sig[1], runStep).catch(() => 0);
        await ctx.reply(n ? `▶️ Resumed ${n} process(es) waiting on \`${sig[1]}\`.` : `No processes were waiting on \`${sig[1]}\`.`, { parse_mode: "Markdown" });
        return;
      }
    }

    // /automations — list your event-driven automations.
    if (text.trim().toLowerCase() === "/automations" || text.trim().toLowerCase() === "/automation") {
      const autos = supabase.listAutomations(user.id);
      if (!autos.length) {
        await ctx.reply("⚡ *No automations yet.*\n\nAutomations run a workflow when an event arrives (a webhook, a metric crossing a threshold). Create one from a terminal: `nova automation add <name> --agent <slug> --template \"…\"` — or `--playbook <name>`. Every fire still passes the approval gate.", { parse_mode: "Markdown" });
        return;
      }
      const lines = ["⚡ *Automations*", "", ...autos.map(a => {
        const action = a.actionType === "playbook" ? `playbook:${a.actionRef}` : `agent:${a.actionRef}`;
        return `${a.enabled ? "●" : "○"} *${a.name}* — ${a.sourceType} → ${action} (fired ${a.fireCount}×)`;
      })];
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
      return;
    }

    // /knowledge — list the documents in your knowledge base, grouped by scope.
    if (text.trim().toLowerCase() === "/knowledge" || text.trim().toLowerCase() === "/kb") {
      const docs = supabase.listKbDocsVisible(user.id);
      if (!docs.length) {
        await ctx.reply(
          "📚 *Your knowledge base is empty.*\n\nDrop me a PDF, DOCX, or text file with a caption like _\"add to knowledge\"_ (or _\"add to team knowledge\"_) and I'll learn it — then use and cite it automatically.\n\nFrom a terminal: `nova kb add <file|url>`.",
          { parse_mode: "Markdown" }
        );
        return;
      }
      const byScope: Record<string, string[]> = {};
      for (const d of docs) {
        const key = d.scope === "agent" ? `agent/${d.agentSlug}` : d.scope;
        (byScope[key] ||= []).push(`  • ${d.title} (${d.status === "ready" ? `${d.chunkCount} chunks` : d.status})`);
      }
      const lines = ["📚 *Knowledge base*", ""];
      for (const [scope, items] of Object.entries(byScope)) {
        lines.push(`*${scope}* (${items.length})`, ...items, "");
      }
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
      return;
    }

    // /examples — starter ideas you can tap to run right now.
    if (text.trim().toLowerCase() === "/examples") {
      await ctx.reply(buildExamplesMessage(), {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: exampleButtons().map((row) => row.map((b) => ({ text: b.label, callback_data: b.callbackData }))) },
      });
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
          ? "Voice mode on. You can also toggle this in the Nova web dashboard (Profile > Preferences)."
          : "Voice mode off. You can also toggle this in the Nova web dashboard (Profile > Preferences)."
      );
      return;
    }

    // /feedback — rate the last response
    if (text.trim().toLowerCase().startsWith("/feedback") || text.trim() === "👍" || text.trim() === "👎") {
      const trimmed = text.trim().toLowerCase();
      let rating: 1 | -1 | null = null;
      if (trimmed === "/feedback good" || trimmed === "👍") rating = 1;
      else if (trimmed === "/feedback bad" || trimmed === "👎") rating = -1;

      if (rating !== null) {
        const rated = await rateLastPattern(supabase, user.id, rating);
        if (rating === 1) {
          await ctx.reply(rated ? "Thanks! I'll prioritize this approach." : "Thanks for the feedback!");
        } else {
          await ctx.reply(rated ? "Got it. I'll try a different approach next time." : "Got it. I'll keep that in mind.");
        }
      } else {
        await ctx.reply(
          "How did I do?",
          {
            reply_markup: {
              inline_keyboard: [[
                { text: "👍 Good", callback_data: "feedback:good" },
                { text: "👎 Bad", callback_data: "feedback:bad" },
              ]],
            },
          }
        );
      }
      return;
    }

    // /agents — list all 24 specialist agents
    if (text.trim() === "/agents") {
      // Let admin users fall through to handleAdminCommand for the Mini App deep-link
      if (user?.role === "admin") return;
      try {
        const agentList = getAllAgents();
        const list = agentList
          .map((a) => `• <b>${a.name}</b> — ${a.description}`)
          .join("\n");
        const rows: { text: string; callback_data: string }[][] = [];
        for (let i = 0; i < agentList.length; i += 3) {
          rows.push(
            agentList.slice(i, i + 3).map((a) => ({
              text: `Use ${a.name}`,
              callback_data: `use_agent:${a.slug}`,
            }))
          );
        }
        await ctx.reply(
          `<b>24 Specialist Agents</b>\n\n${list}\n\n<i>Just ask me to do something — I'll pick the right agent automatically. Or say "Use Helios to..." to route directly.</i>`,
          { parse_mode: "HTML", reply_markup: { inline_keyboard: rows } }
        );
      } catch {
        await ctx.reply("Couldn't load agent list. Try again.");
      }
      return;
    }

    // /memory — show the user's 10 most recent memories (facts only)
    if (text.trim() === "/memory") {
      try {
        const rows = supabase.getMemoryForDashboard({ userId: user.id, limit: 20 }) || [];
        const facts = rows
          .filter((r: any) => r.type !== "goal")
          .slice(0, 10);
        if (!facts.length) {
          await ctx.reply("No memories yet. I'll remember things as we chat!");
          return;
        }
        const items = facts
          .map((r: any) => `• ${(r.content || "").substring(0, 100)}`)
          .join("\n");
        await ctx.reply(
          `<b>Your Memories</b> (recent 10)\n\n${items}\n\n<i>To forget something, say "Forget [topic]"</i>`,
          { parse_mode: "HTML" }
        );
      } catch (e) {
        logError(e, "/memory");
        await ctx.reply("Something went wrong. Please try again.");
      }
      return;
    }

    // /goals — show active (non-completed) goals
    if (text.trim() === "/goals") {
      try {
        const rows = (supabase.getMemoryForDashboard({ userId: user.id, limit: 50 }) || [])
          .filter((r: any) => r.type === "goal" && !r.completed_at);
        if (!rows.length) {
          await ctx.reply(`No active goals. Set one by saying "Goal: [your goal]"`);
          return;
        }
        const items = rows.slice(0, 10).map((r: any) => {
          const deadline = r.deadline ? ` (by ${r.deadline})` : "";
          return `• ${(r.content || "").substring(0, 100)}${deadline}`;
        }).join("\n");
        await ctx.reply(`<b>Active Goals</b>\n\n${items}`, { parse_mode: "HTML" });
      } catch (e) {
        logError(e, "/goals");
        await ctx.reply("Something went wrong. Please try again.");
      }
      return;
    }

    // /tasks — show pending/in-progress agent tasks
    if (text.trim() === "/tasks") {
      try {
        const rows = supabase.getAgentTasksRecent({ userId: user.id, limit: 20 }) || [];
        const pending = rows.filter((r: any) => r.status === "pending" || r.status === "in_progress");
        if (!pending.length) {
          await ctx.reply("No pending agent tasks.");
          return;
        }
        const items = pending.map((r: any) =>
          `• [${r.status}] ${(r.description || "task").substring(0, 80)}`
        ).join("\n");
        await ctx.reply(
          `<b>Pending Tasks</b>\n\n${items}\n\n<i>Tasks run autonomously in the background.</i>`,
          { parse_mode: "HTML" }
        );
      } catch (e) {
        logError(e, "/tasks");
        await ctx.reply("Something went wrong. Please try again.");
      }
      return;
    }

    // /schedule [list] — view active scheduled tasks with cancel buttons
    if (text.trim() === "/schedule" || text.trim().toLowerCase().startsWith("/schedule list")) {
      try {
        const rows = supabase.getManageableScheduledTasks(user.id) || [];
        if (!rows.length) {
          await ctx.reply(
            "No schedules. Create one by messaging: Schedule [task] for [time]"
          );
          return;
        }

        const formatNextRun = (trigger_at: string | null): string => {
          if (!trigger_at) return "Not set";
          try {
            const d = new Date(trigger_at);
            return d.toLocaleString("en-US", {
              weekday: "short", month: "short", day: "numeric",
              hour: "numeric", minute: "2-digit", hour12: true,
            });
          } catch {
            return trigger_at;
          }
        };

        const lines: string[] = [`<b>Schedules (${rows.length})</b>\n`];
        const buttons: { text: string; callback_data: string }[][] = [];

        rows.forEach((row: any, i: number) => {
          const isPaused = row.status === "paused";
          lines.push(
            `${i + 1}. <b>${row.title}</b>${isPaused ? " ⏸ <i>(paused)</i>" : ""}\n` +
            `   Next: ${isPaused ? "—" : formatNextRun(row.trigger_at)}` +
            (row.recurrence ? `\n   Recurs: ${row.recurrence}` : "")
          );
          // Per-task row: toggle pause/resume + cancel
          buttons.push([
            isPaused
              ? { text: `▶️ Resume #${i + 1}`, callback_data: `resume_schedule:${row.id}` }
              : { text: `⏸ Pause #${i + 1}`, callback_data: `pause_schedule:${row.id}` },
            { text: `🗑 Cancel #${i + 1}`, callback_data: `cancel_schedule:${row.id}` },
          ]);
        });

        await ctx.reply(lines.join("\n"), {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: buttons },
        });
      } catch (e) {
        logError(e, "/schedule");
        await ctx.reply("Something went wrong. Please try again.");
      }
      return;
    }

    // /usage — show AI spend summary
    if (text.trim() === "/usage") {
      try {
        const summary = supabase.getCostSummary(user.id);
        const fmt = (n: number) => `$${n.toFixed(2)}`;
        let msg = `<b>Usage Summary</b>\n\nToday: ${fmt(summary.today)}\nThis month: ${fmt(summary.month)}\nAll time: ${fmt(summary.allTime)}`;
        if (summary.topAgents.length > 0) {
          const agentLines = summary.topAgents
            .map((a: any) => `• ${a.agent_slug.charAt(0).toUpperCase() + a.agent_slug.slice(1)} — ${fmt(a.total_cost)}`)
            .join("\n");
          msg += `\n\n<b>Top agents this month:</b>\n${agentLines}`;
        }
        await ctx.reply(msg, { parse_mode: "HTML" });
      } catch (e: any) {
        logError(e, "/usage");
        await ctx.reply("Something went wrong. Please try again.");
      }
      return;
    }

    // /settings autopilot — configure auto-approval rules
    if (text.startsWith("/settings ")) {
      const settingsParts = text.trim().split(/\s+/);
      if (settingsParts[1] === "autopilot") {
        const subCmd = settingsParts[2]?.toLowerCase();

        if (subCmd === "list") {
          const rules = supabase.getApprovalRules(user.id);
          if (rules.length === 0) {
            await ctx.reply("No autopilot rules set. All tasks require manual approval.");
          } else {
            const lines = rules.map((r: any) => {
              const agents = r.agent_slugs?.length ? ` (agents: ${r.agent_slugs.join(", ")})` : "";
              const limit = r.limit_usd != null ? ` up to $${r.limit_usd}` : "";
              return `• ${r.category}: ${r.auto_approve ? `auto-approve${limit}` : "require approval"}${agents}`;
            });
            await ctx.reply(`Autopilot rules:\n${lines.join("\n")}`);
          }
          return;
        }

        if (subCmd === "off") {
          supabase.setApprovalRules(user.id, []);
          await ctx.reply("Autopilot off. All tasks will require manual approval.");
          return;
        }

        // /settings autopilot <category> [limit_usd]
        // e.g. /settings autopilot social_post
        //      /settings autopilot ad_spend 50
        const validCategories = ["social_post", "email", "ad_spend", "code_deploy", "seo", "research", "general", "*"];
        if (subCmd && validCategories.includes(subCmd)) {
          const limitUsd = settingsParts[3] ? parseFloat(settingsParts[3]) : undefined;
          const rules = supabase.getApprovalRules(user.id);
          const idx = rules.findIndex((r: any) => r.category === subCmd);
          const newRule: any = {
            category: subCmd,
            auto_approve: true,
            ...(limitUsd != null && !isNaN(limitUsd) ? { limit_usd: limitUsd } : {}),
          };
          if (idx >= 0) {
            rules[idx] = newRule;
          } else {
            rules.push(newRule);
          }
          supabase.setApprovalRules(user.id, rules);
          const limitLine = newRule.limit_usd != null ? ` (up to $${newRule.limit_usd})` : "";
          await ctx.reply(`Autopilot on for category "${subCmd}"${limitLine}. Tasks in this category will be auto-approved.`);
          return;
        }

        await ctx.reply(
          "Usage:\n" +
          "/settings autopilot list — show rules\n" +
          "/settings autopilot off — disable all auto-approvals\n" +
          "/settings autopilot <category> [limit_usd] — enable auto-approve\n\n" +
          "Categories: social_post, email, ad_spend, code_deploy, seo, research, general, *"
        );
        return;
      }

      // /settings access @username <level> — cross-user assistant access
      if (settingsParts[1] === "access") {
        const targetArg = settingsParts[2]; // e.g. "@alice"
        const level = settingsParts[3]?.toLowerCase(); // tasks-only | tasks+goals | full-summary | none
        const validLevels = ["none", "tasks-only", "tasks+goals", "full-summary"];

        if (!targetArg || !level) {
          await ctx.reply(
            "Usage: /settings access @username <level>\n\n" +
            "Levels:\n" +
            "• tasks-only — they can see your active tasks\n" +
            "• tasks+goals — they can see your tasks and goals\n" +
            "• full-summary — they can see your recent activity and tasks\n" +
            "• none — revoke access"
          );
          return;
        }

        if (!validLevels.includes(level)) {
          await ctx.reply(`Invalid level. Choose: ${validLevels.join(", ")}`);
          return;
        }

        const targetName = targetArg.startsWith("@") ? targetArg.slice(1) : targetArg;
        const allUsers = supabase.getAllActiveUsers();
        const target = allUsers.find(
          (u: any) => u.name?.toLowerCase() === targetName.toLowerCase() ||
                      u.telegram_id === targetName
        );

        if (!target) {
          await ctx.reply(`User @${targetName} not found.`);
          return;
        }

        supabase.setAccessGrant(user.id, target.id, level);
        if (level === "none") {
          await ctx.reply(`Access revoked — @${target.name} can no longer see your context.`);
        } else {
          await ctx.reply(`Access granted — @${target.name} can now see your context at level: ${level}.`);
        }
        return;
      }

      // /settings role <job_role> — set your job role for tailored briefings
      if (settingsParts[1] === "role") {
        const jobRole = settingsParts.slice(2).join("_").toLowerCase().replace(/\s+/g, "_");
        if (!jobRole) {
          await ctx.reply("Usage: /settings role <role>\nExamples: developer, account_manager, designer, marketer, founder");
          return;
        }
        supabase.setJobRole(user.id, jobRole);
        await ctx.reply(`Role set to: ${jobRole}. Morning briefings and check-ins will be tailored to your role.`);
        return;
      }
    }

    // /codebase — register, list, or remove codebases for dev tasks
    if (text.startsWith("/codebase")) {
      const parts = text.trim().split(/\s+/);
      const sub = parts[1];

      if (sub === "add") {
        const name = parts[2];
        const location = parts[3];
        if (!name || !location) {
          await ctx.reply("Usage: /codebase add &lt;name&gt; &lt;git-url-or-local-path&gt;", { parse_mode: "HTML" });
          return;
        }
        const isLocal = location.startsWith("/") || location.startsWith("~");
        const id = supabase.addProject(user.id, {
          name,
          repoUrl: isLocal ? undefined : location,
          localPath: isLocal ? location : undefined,
        });
        await ctx.reply(`Registered codebase <b>${name}</b>\nID: <code>${id}</code>`, { parse_mode: "HTML" });

      } else if (sub === "list") {
        const projects = supabase.getProjects(user.id);
        if (projects.length === 0) {
          await ctx.reply("No codebases registered. Use /codebase add &lt;name&gt; &lt;url&gt;", { parse_mode: "HTML" });
        } else {
          const lines = projects.map(p => {
            const src = p.localPath ?? p.repoUrl ?? "no source";
            const date = new Date(p.createdAt * 1000).toLocaleDateString();
            return `• <b>${p.name}</b> — ${src} (added ${date})`;
          });
          await ctx.reply(`<b>Registered Codebases:</b>\n${lines.join("\n")}`, { parse_mode: "HTML" });
        }

      } else if (sub === "remove") {
        const name = parts[2];
        if (!name) {
          await ctx.reply("Usage: /codebase remove &lt;name&gt;", { parse_mode: "HTML" });
          return;
        }
        const project = supabase.getProjectByName(user.id, name);
        if (!project) {
          await ctx.reply(`No codebase named "${name}" found.`);
        } else {
          supabase.removeProject(user.id, project.id);
          await ctx.reply(`Removed codebase <b>${name}</b>`, { parse_mode: "HTML" });
        }

      } else {
        await ctx.reply(
          "<b>Codebase commands:</b>\n/codebase add &lt;name&gt; &lt;url&gt;\n/codebase list\n/codebase remove &lt;name&gt;",
          { parse_mode: "HTML" }
        );
      }
      return;
    }

    // /devtask — queue a dev task on a registered codebase
    if (text.startsWith("/devtask")) {
      const description = text.replace("/devtask", "").trim();
      const projects = supabase.getProjects(user.id);

      if (projects.length === 0) {
        await ctx.reply("No codebases registered. Use /codebase add &lt;name&gt; &lt;url&gt;", { parse_mode: "HTML" });
        return;
      }

      if (projects.length === 1 && description) {
        const taskId = supabase.createDevTask(user.id, projects[0].id, description);
        await ctx.reply(
          `📋 Dev task queued on <b>${projects[0].name}</b>\nID: <code>${taskId}</code>\nI'll start working shortly.`,
          { parse_mode: "HTML" }
        );
        return;
      }

      // Multiple projects or no description — show picker
      const inline_keyboard = projects.map(p => [{
        text: p.name,
        callback_data: `devtask_pick:${p.id}:${encodeURIComponent(description || "")}`
      }]);
      await ctx.reply(
        description ? `Which codebase for: "${description}"?` : "Which codebase?",
        { reply_markup: { inline_keyboard } }
      );
      return;
    }

    // Handle admin commands (Telegram only — uses ctx.reply for rich formatting)
    if (text.startsWith("/") && user.role === "admin" && msg.channelType === "telegram") {
      const handled = await handleAdminCommand(ctx._raw || ctx, text, user);
      if (handled) return;
    }

    // /board <question> — convene executive board meeting
    if (text.startsWith("/board ") && boardModule) {
      const question = text.substring(7).trim();
      if (!question) {
        await ctx.reply("Usage: /board <strategic question>");
        return;
      }
      await ctx.replyWithChatAction("typing");
      await saveMessage("user", text, user.id, undefined, msg.channelType);
      boardModule.conveneBoard(question, user.id, msg.channelChatId).catch((err: Error) => {
        console.error("[board] Error convening board:", err);
        ctx.reply("Failed to convene board meeting. Check logs for details.");
      });
      return;
    }

    // Check for provider force-routing prefix: /claude <msg> or /gemini <msg>
    const providerOverride = parseProviderPrefix(text);
    if (providerOverride) {
      (ctx as any)._forceProvider = providerOverride.provider;
      // Use the message without the prefix
      const actualText = providerOverride.message;

      await ctx.replyWithChatAction("typing");
      await saveMessage("user", actualText, user.id, whatsappMeta || undefined, msg.channelType);

      if (contactContext && msg.channelType === "whatsapp") {
        (ctx as any)._whatsappContactContext = contactContext;
      }

      orchestrate(ctx._raw || ctx, actualText, user, supabase, getSessionKey(user.id, msg.channelType), msg.channelType);
      return;
    }

    await ctx.replyWithChatAction("typing");
    await saveMessage("user", text, user.id, whatsappMeta || undefined, msg.channelType);

    // For WhatsApp contact messages, inject contact context into the orchestration
    if (contactContext && msg.channelType === "whatsapp") {
      (ctx as any)._whatsappContactContext = contactContext;
    }

    orchestrate(ctx._raw || ctx, text, user, supabase, getSessionKey(user.id, msg.channelType), msg.channelType);
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

      const voiceSessionKey = getSessionKey(user!.id, msg.channelType);
      runTask(ctx, `Voice: ${transcription.substring(0, 40)}`, async () => {
        const [relevantContext, memoryContext, sessionSummary, taskContext, scheduleContext] = await Promise.all([
          getRelevantContext(supabase, transcription, user!.id),
          getMemoryContext(supabase, user!.id),
          getSessionSummaryContext(supabase, user!.id, voiceSessionKey),
          getTaskContext(supabase, user!.id),
          getScheduleContext(supabase, user!.id, user!.timezone),
        ]);
        const recentHistory = await getRecentHistory(supabase, user!.id, sessionSummary ? 5 : 12);
        const { systemPrompt: voiceSysPrompt, userPrompt: voiceUserPrompt } = buildPrompt(
          user!,
          `[Voice message transcribed]: ${transcription}`,
          relevantContext,
          memoryContext,
          recentHistory,
          taskContext,
          scheduleContext,
          { sessionSummary: sessionSummary || undefined }
        );
        return {
          prompt: voiceUserPrompt,
          systemPrompt: voiceSysPrompt,
          hint: transcription,
        };
      }, {
        postProcess: (raw) => processMemoryIntents(supabase, raw, user!.id, user!.timezone),
        userId: user!.id,
        sessionKey: voiceSessionKey,
        userMessage: transcription,
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

      const imageSessionKey = getSessionKey(user!.id, msg.channelType);
      runTask(ctx, `Image: ${caption.substring(0, 40)}`, async () => {
        const [memoryContext, sessionSummary, taskContext, scheduleContext] = await Promise.all([
          getMemoryContext(supabase, user!.id),
          getSessionSummaryContext(supabase, user!.id, imageSessionKey),
          getTaskContext(supabase, user!.id),
          getScheduleContext(supabase, user!.id, user!.timezone),
        ]);
        const recentHistory = await getRecentHistory(supabase, user!.id, sessionSummary ? 5 : 12);
        const contextPrefix = [memoryContext, taskContext, scheduleContext, sessionSummary, recentHistory].filter(Boolean).join("\n\n");
        const prompt = memoryMode
          ? buildMemoryExtractionPrompt(filePath, `image_${fileId}.jpg`, caption)
          : (contextPrefix ? contextPrefix + "\n\n" : "") + `[Image: ${filePath}]\n\n${caption}`;
        return { prompt, hint: caption };
      }, {
        postProcess: async (raw) => {
          setTimeout(() => unlink(filePath).catch(() => {}), 10 * 60 * 1000);
          return processMemoryIntents(supabase, raw, user!.id, user!.timezone);
        },
        userId: user!.id,
        sessionKey: imageSessionKey,
        userMessage: caption,
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

      // Knowledge-base ingestion — caption like "add to knowledge", "remember this file",
      // "add to team knowledge", "for lex's knowledge". Ingests the buffer directly.
      const { parseKbCaption } = await import("./knowledge.ts");
      const kbIntent = parseKbCaption(caption);
      if (kbIntent.wants) {
        try {
          const { ingestDocument } = await import("./knowledge.ts");
          const { sourceTypeFromName } = await import("./text-chunk.ts");
          const sourceType = sourceTypeFromName(rawName);
          const isText = sourceType === "md" || sourceType === "txt";
          const r = await ingestDocument({
            db: supabase,
            userId: user.id,
            scope: kbIntent.scope,
            agentSlug: kbIntent.agentSlug,
            title: rawName,
            source: `telegram:${msg.channelMessageId}`,
            sourceType,
            bytes: isText ? undefined : msg.document.buffer,
            text: isText ? msg.document.buffer.toString("utf8") : undefined,
          });
          const where = kbIntent.scope === "agent" ? `${kbIntent.agentSlug}'s` : kbIntent.scope;
          await ctx.reply(
            r.status === "ready"
              ? `📚 Added *${rawName}* to ${where} knowledge (${r.chunkCount} chunks). I'll use it automatically and cite it.`
              : `Couldn't add that to knowledge: ${r.error || "no extractable text"}`,
            { parse_mode: "Markdown" }
          );
        } catch (e) {
          console.error("[kb] telegram ingest error:", e);
          await ctx.reply("Couldn't add that to knowledge.");
        }
        await unlink(filePath).catch(() => {});
        return;
      }

      const memoryMode = isMemoryIntent(caption);
      await saveMessage("user", `[Document: ${msg.document.filename}]: ${caption}`, user.id, undefined, msg.channelType);

      const docSessionKey = getSessionKey(user!.id, msg.channelType);
      runTask(ctx, `Doc: ${msg.document.filename}`, async () => {
        const [memoryContext, sessionSummary, taskContext, scheduleContext] = await Promise.all([
          getMemoryContext(supabase, user!.id),
          getSessionSummaryContext(supabase, user!.id, docSessionKey),
          getTaskContext(supabase, user!.id),
          getScheduleContext(supabase, user!.id, user!.timezone),
        ]);
        const recentHistory = await getRecentHistory(supabase, user!.id, sessionSummary ? 5 : 12);
        const contextPrefix = [memoryContext, taskContext, scheduleContext, sessionSummary, recentHistory].filter(Boolean).join("\n\n");
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
        userId: user!.id,
        sessionKey: docSessionKey,
        userMessage: caption,
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
  options?: { ghlLocationId?: string; contactContext?: string; teamContext?: string; sessionSummary?: string }
): { systemPrompt: string; userPrompt: string } {
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

  const tRecentHistory = recentHistory ? truncateSection(recentHistory, budgets.recentHistory) : undefined;
  const tMemoryContext = memoryContext ? truncateSection(memoryContext, budgets.memoryContext) : undefined;
  const tRelevantContext = relevantContext ? truncateSection(relevantContext, budgets.relevantContext) : undefined;
  const tTaskContext = taskContext ? truncateSection(taskContext, budgets.taskContext) : undefined;
  const tScheduleContext = scheduleContext ? truncateSection(scheduleContext, budgets.scheduleContext) : undefined;

  const ghlLocationId = options?.ghlLocationId || ghlLocationCache.get(user.id);
  const contactContext = options?.contactContext;

  // ── STABLE SYSTEM PROMPT ──
  // Sent via --system-prompt so the Anthropic backend can cache it across calls.
  // Must NOT include: current time, session summary, relevant context, recent history, or the user message.
  const sysParts: string[] = [
    _botIdentity
      ? `You are ${_botName}, an AI assistant. ${_botIdentity}\nRespond via messaging — keep responses concise and conversational.`
      : `You are ${_botName}, a personal AI assistant responding via messaging. Keep responses concise and conversational.`,
  ];

  // WhatsApp contact context — override identity when responding on behalf of user
  if (contactContext) {
    sysParts.push(contactContext);
  } else {
    sysParts.push(`You are speaking with ${user.name}.`);
  }

  // Cap profile_text to 2000 chars — large profiles waste tokens on every call
  if (user.profile_text) {
    const profileText = user.profile_text.length > 2000
      ? user.profile_text.slice(0, 2000) + "\n[...profile truncated]"
      : user.profile_text;
    sysParts.push(`\nProfile:\n${profileText}`);
  }

  if (tMemoryContext) sysParts.push(`\n${tMemoryContext}`);
  if (tTaskContext) sysParts.push(`\n${tTaskContext}`);
  if (tScheduleContext) sysParts.push(`\n${tScheduleContext}`);

  // Team context
  const teamContext = options?.teamContext;
  if (teamContext) {
    sysParts.push(`\n${teamContext}`);
  } else if (user.team_id) {
    try {
      const teammates = supabase.getTeamRoster(user.team_id);
      const others = teammates.filter((t: any) => t.id !== user.id);
      if (others.length > 0) {
        const rosterLines = others.map((t: any) => `- ${t.name} (${t.timezone})`).join("\n");
        sysParts.push(`\nTEAM MEMBERS:\n${rosterLines}`);
      }
    } catch { /* ignore if team data unavailable */ }
  }

  // Cross-user access grants
  try {
    const grants = supabase.getGrantedUsers(user.id);
    for (const grant of grants) {
      const grantor = supabase.getUserById(grant.grantor_user_id);
      if (!grantor) continue;
      const grantorLines: string[] = [`Shared context from ${grantor.name} (access: ${grant.level}):`];

      if (grant.level === "tasks-only" || grant.level === "tasks+goals" || grant.level === "full-summary") {
        const tasks = supabase.getActiveTasks(grant.grantor_user_id);
        if (tasks.length > 0) {
          grantorLines.push(`  Tasks: ${tasks.slice(0, 5).map((t: any) => t.description || t.content).join("; ")}`);
        }
      }
      if (grant.level === "tasks+goals" || grant.level === "full-summary") {
        const goals = supabase.getActiveGoals(grant.grantor_user_id);
        if (goals.length > 0) {
          grantorLines.push(`  Goals: ${goals.slice(0, 3).map((g: any) => g.content).join("; ")}`);
        }
      }
      if (grant.level === "full-summary") {
        const recent = supabase.getRecentMessages(grant.grantor_user_id, 5);
        if (recent.length > 0) {
          const summary = recent.slice(0, 5)
            .map((m: any) => `[${m.role}]: ${m.content.substring(0, 80)}`)
            .join(" | ");
          grantorLines.push(`  Recent: ${summary}`);
        }
      }

      if (grantorLines.length > 1) {
        sysParts.push(`\n${grantorLines.join("\n")}`);
      }
    }
  } catch { /* ignore if grants unavailable */ }

  // Tag documentation — always include at all tiers for consistent cache key
  sysParts.push(
    "\nMEMORY TAGS (auto-processed, hidden from user):" +
      "\n[REMEMBER: fact] — durable facts (identity, business, preferences, patterns). Skip if it won't matter in 30 days." +
      "\n[SHARE: fact] — team-visible. Only when user explicitly says to share." +
      "\n[GOAL: text | DEADLINE: date] / [DONE: search text]" +
      "\nNEVER remember: one-time events, calendar items, transient tasks, conversations, system details. Use calendar for events."
  );

  sysParts.push(
    "\nTASK TAGS: [TASK: Agent | desc] [TASK_START: text] [TASK_DONE: text | result] [TASK_BLOCKED: text | reason] [TASK_CANCEL: text]"
  );

  sysParts.push(
    "\nSCHEDULING:" +
      "\n[SCHEDULE: title | datetime | instructions] [SCHEDULE: ... | RECUR: rule] [SCHEDULE: ... | RECUR: rule | IF: condition]" +
      "\n[SCHEDULE_CANCEL: title] — delete. [SCHEDULE_PAUSE: title] — pause (keeps it). [SCHEDULE_RESUME: title] — reactivate a paused task." +
      "\n[SCHEDULE_EDIT: title | TIME: datetime] and/or [| INSTRUCTIONS: new text] and/or [| RECUR: rule] — change an existing task." +
      "\nDatetime: ISO (2026-02-21T15:00:00) or relative (+30m, +2h, +1d). Match tasks by their title text." +
      "\nRECUR: daily:HH:MM | weekly:DAY:HH:MM | weekdays:HH:MM | interval:SECONDS" +
      "\nUse these when " + user.name + " asks to create, delete, pause, resume, reschedule, or change a scheduled task. Proactively schedule follow-ups when useful."
  );

  sysParts.push(
    "\nRESPONSE RULES:" +
      "\n• Casual, clean, result-focused. No file paths, no internal steps, no bash commands in output." +
      "\n• Send files via /telegram-file-sender. Generated images/files MUST be sent this way." +
      "\n• [BUTTONS: A | B | C] for quick choices (max 6, short labels). Hidden tag — user sees buttons only." +
      "\n• Handle multiple requests in parallel." +
      "\n" +
      "\nHONESTY PROTOCOL:" +
      "\n• NEVER report work as complete unless you verified output exists (ls/stat confirms)." +
      "\n• If a tool call fails, tell the user immediately — do not pretend it succeeded." +
      "\n• If a task is partially complete, say exactly what succeeded and what failed." +
      "\n• NEVER fabricate: file paths, line counts, build results, URLs, API responses, or data." +
      "\n• NEVER invent facts not in your context — say \"I don't have that info\" instead." +
      "\n• NEVER claim to remember something unless it appears in the FACTS or GOALS sections above." +
      "\n• NEVER describe what a tool would do — actually run it and report the real output." +
      "\n• When building projects: ls the output directory before saying it's ready." +
      "\n" +
      "\nPERMISSIONS:" +
      "\n• If you encounter EACCES/EPERM, ask: \"I need permission to [action]. Can you grant access?\"" +
      "\n• Before creating directories outside the workspace, confirm with the user first." +
      "\n• Never silently skip steps due to permission errors."
  );

  // Capabilities and skills — always include (cached, so no cost penalty for non-tool messages)
  sysParts.push(
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
      "\n• Square: Orders, payments, catalog. Configure locations in config/profile.md." +
      "\n  Reports: all locations + combined total. Writes: ask which location first." +
      "\n• GHL (CRM): Contacts, calendars, opportunities, conversations, templates, blog, social, invoices." +
      (ghlLocationId ? ` Location: ${ghlLocationId}.` : "") +
      " Cannot create pipelines/forms/funnels/workflows. Confirm before modifying." +
      "\n• Cloudflare: DNS, Workers. Task Scheduler: bun run " + PROJECT_ROOT + "/src/scheduler.ts list|create" +
      "\n• File System & Terminal: Full access." +
      "\nAlways confirm before consequential actions (sending emails, calls, modifying contacts)."
  );

  sysParts.push(
    "\nSKILLS:" +
      "\n/ai-video-creator, /book-formatter, /canvas-design, /competitive-ads-extractor," +
      "\n/content-architect, /content-research-writer, /customer-support, /docx," +
      "\n/email-marketing, /file-organizer, /ghostwriter, /image-gen," +
      "\n/lead-research-assistant, /md-to-docx, /meta-ads-manager, /notebooklm," +
      "\n/pdf, /platform-maker, /pptx, /reviews-testimonials," +
      "\n/social-media-manager, /voice-extractor, /xlsx," +
      "\n/skill-creator, /telegram-file-sender"
  );

  sysParts.push(
    "\nSELF-IMPROVEMENT — SKILL CREATION:" +
      "\nCreate a new skill (via /skill-creator) ONLY when ALL of the following are true:" +
      "\n  ✓ The task is complex, multi-step, or requires specific external tools/APIs/templates" +
      "\n  ✓ A skill would meaningfully reduce time or errors on future runs" +
      "\n  ✓ The workflow is not trivially answerable by reasoning alone" +
      "\nAND one of these triggers applies:" +
      "\n  TRIGGER A — You are about to do a task with no existing skill for it AND it clears the bar above." +
      "\n  TRIGGER B — The same non-trivial workflow has been done 2+ times." +
      "\nDO NOT create skills for:" +
      "\n  ✗ Simple Q&A, summaries, rewrites, translations, calculations — Claude handles these natively" +
      "\n  ✗ One-off or highly specific requests unlikely to recur" +
      "\n  ✗ Anything a single direct prompt to Haiku/Sonnet handles cleanly in one shot" +
      "\nProcess (when threshold is met):" +
      "\n  a. Invoke /skill-creator to design and write the SKILL.md" +
      "\n  b. Save the skill to .claude/skills/<slug>/SKILL.md" +
      "\n  c. Tell the user: \"I created /skill-name because [reason]. Using it now.\"" +
      "\n  d. Log in CHANGELOG.md with trigger: self-learning" +
      "\n• Also use [REMEMBER:] for durable facts, [GOAL:]/[DONE:] for tracking." +
      "\n• Proactively identify and automate manual workflows."
  );

  if (user.role === "admin") {
    sysParts.push(
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
        "\n0. Ensure clean state before branching:" +
        "\n   a. Stash any uncommitted changes: `git -C " + PROJECT_ROOT + " stash --include-untracked` (only if working tree is dirty)" +
        "\n   b. Pull latest production: `git -C " + PROJECT_ROOT + " checkout production && git -C " + PROJECT_ROOT + " pull origin production`" +
        "\n   c. Pull latest main: `git -C " + PROJECT_ROOT + " checkout main && git -C " + PROJECT_ROOT + " pull origin main`" +
        "\n1. Create a feature branch from production: `git -C " + PROJECT_ROOT + " checkout -b self-edit/<short-slug> production`" +
        "\n2. Read the relevant file(s) to understand the current code" +
        "\n3. Make the change using your file editing tools" +
        "\n4. Log the change in CHANGELOG.md (see format below)" +
        "\n5. PRE-COMMIT VALIDATION: run `bun build --no-bundle <changed-files>` to catch syntax errors before committing. Fix any errors before proceeding." +
        "\n6. Commit: `git -C " + PROJECT_ROOT + " add -A && git -C " + PROJECT_ROOT + " commit -m \"self-edit: <description>\"`" +
        "\n7. TWO-TIER CHECK:" +
        "\n   - If ANY changed file is a core file (relay.ts, orchestrator.ts, planner.ts, voice-server.ts, agent-router.ts):" +
        "\n     Send `git diff main..self-edit/<slug>` to " + user.name + " on Telegram and WAIT for explicit approval before merging." +
        "\n   - For agent/skill files (.claude/agents/*.md, .claude/skills/*) → auto-merge without asking." +
        "\n8. Merge to main and push: `git -C " + PROJECT_ROOT + " checkout main && git -C " + PROJECT_ROOT + " merge self-edit/<short-slug> && git -C " + PROJECT_ROOT + " push origin main`" +
        "\n9. Merge to production and push: `git -C " + PROJECT_ROOT + " checkout production && git -C " + PROJECT_ROOT + " merge main && git -C " + PROJECT_ROOT + " push origin production`" +
        "\n10. Install dependencies: `bun install --cwd " + PROJECT_ROOT + "`" +
        "\n11. Restart ALL services — platform-aware:" +
        "\n    macOS: `launchctl unload ~/Library/LaunchAgents/com.nova.<svc>.plist && launchctl load ~/Library/LaunchAgents/com.nova.<svc>.plist` for core, voice-server, dashboard" +
        "\n    Linux: `sudo systemctl restart nova-relay nova-voice nova-dashboard`" +
        "\n12. CRASH WATCHDOG: wait 30 seconds, then check all services are running." +
        "\n    If any crashed → auto-revert (`git -C " + PROJECT_ROOT + " revert HEAD && git -C " + PROJECT_ROOT + " push origin production`), restart again, and alert " + user.name + "." +
        "\n13. CANARY WINDOW: keep the self-edit branch for 10 minutes instead of deleting immediately. Schedule delayed cleanup: `sleep 600 && git -C " + PROJECT_ROOT + " branch -d self-edit/<short-slug>`" +
        "\n14. Tell " + user.name + " what you changed, confirm all services restarted successfully, and report health status." +
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
        "\n1. SKILL CREATION — create only when the task clears this bar:" +
        "\n   REQUIRED: complex/multi-step, involves external tools/APIs/templates, not trivially answerable by reasoning alone." +
        "\n   DO NOT create skills for: summaries, rewrites, Q&A, translations, calculations, one-off requests." +
        "\n   TRIGGER A — Starting a task with no skill for it AND it clears the bar above." +
        "\n   TRIGGER B — Same non-trivial workflow done 2+ times." +
        "\n   Process:" +
        "\n   - Invoke /skill-creator to design and write the SKILL.md" +
        "\n   - Save to .claude/skills/<slug>/SKILL.md" +
        "\n   - Tell " + user.name + ": \"I created /[skill-name] because [reason]. Using it now.\"" +
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
        "\n• ALWAYS validate syntax with `bun build --no-bundle` before committing — never commit code that doesn't compile" +
        "\n• ALWAYS run `bun install` and restart ALL services (relay + voice + dashboard) after merging to production — not just relay" +
        "\n• For core files (relay.ts, orchestrator.ts, planner.ts, voice-server.ts, agent-router.ts), send the diff to " + user.name + " via Telegram and wait for explicit approval before merging" +
        "\n• After restarting, wait 30 seconds and verify all services are healthy — if any crashed, auto-revert the commit and restart" +
        "\n• Keep self-edit branches for 10 minutes after merge (canary window) before deleting" +
        "\n• NEVER modify .env or credentials files" +
        "\n• NEVER delete files without asking " + user.name + " first" +
        "\n• For agent/skill files: you may edit freely but always log it" +
        "\n• If something breaks, tell " + user.name + " and offer to revert: `git -C " + PROJECT_ROOT + " revert HEAD`" +
        "\n• Max 5 self-initiated changes per day without explicit user request (prevents runaway self-modification)"
    );
  }

  const systemPrompt = sysParts.join("\n");

  // ── VOLATILE USER PROMPT ──
  // Changes on every message: current time, session state, semantic results, history, message.
  const userParts: string[] = [`Current time: ${timeStr}`];
  if (options?.sessionSummary) userParts.push(`\n${options.sessionSummary}`);
  if (tRelevantContext) userParts.push(`\n${tRelevantContext}`);
  if (tRecentHistory) userParts.push(`\n${tRecentHistory}`);
  userParts.push(`\nUser: ${userMessage}`);

  const userPrompt = userParts.join("\n");
  console.log(`[prompt] system=${systemPrompt.length}c volatile=${userPrompt.length}c (~${Math.round((systemPrompt.length + userPrompt.length) / 4)} total tokens)`);

  return { systemPrompt, userPrompt };
}

// ============================================================
// ADMIN COMMANDS
// ============================================================

async function handleAdminCommand(ctx: Context, text: string, user: NovaUser): Promise<boolean> {

  const parts = text.trim().split(/\s+/);
  const command = parts[0].toLowerCase();

  if (command === "/adduser" || command === "/removeuser" || command === "/listusers") {
    const dashUrl = process.env.DASHBOARD_PUBLIC_URL || "";
    await ctx.reply(dashUrl ? `Manage users in the dashboard: ${dashUrl}/account` : "User management is in the Nova web dashboard.");
    return true;
  }

  if (command === "/invite") {
    const roleArg = (parts[1] || "member").toLowerCase();
    const role: "member" | "admin" = roleArg === "admin" ? "admin" : "member";
    const code = supabase.createPairingCode(user.id, role, 24 * 60);
    const botUsername = (ctx as any).me?.username || process.env.TELEGRAM_BOT_USERNAME || "the Nova bot";
    const handle = botUsername.startsWith("@") || botUsername.includes(" ") ? botUsername : `@${botUsername}`;
    await ctx.reply(
      `Invite code created (role: ${role}).\n\n` +
      `Code: ${code}\nExpires in 24 hours.\n\n` +
      `Forward this to your teammate:\n\n` +
      `"You've been invited to Nova — message ${handle} and send this code: ${code}"`
    );
    return true;
  }

  if (command === "/proposals") {
    // Reflective learning loop: list pending skill ideas with Approve / Reject buttons.
    const proposals = supabase.getPendingProposals(user.id);
    if (!proposals.length) {
      await ctx.reply("No skill ideas to review right now.");
      return true;
    }
    const esc = (s: string) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    for (const p of proposals) {
      const kindLabel = p.kind === "memory" ? "memory" : "skill";
      const rationale = (p.rationale || "").trim();
      const lines = [
        `💡 <b>${esc(p.title)}</b> <i>(${kindLabel})</i>`,
        p.description ? esc(p.description) : "",
        rationale ? `\n<i>${esc(rationale.slice(0, 300))}</i>` : "",
      ].filter(Boolean);
      await ctx.reply(lines.join("\n"), {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Approve", callback_data: `prop:${p.id}:approve` },
            { text: "❌ Reject", callback_data: `prop:${p.id}:reject` },
          ]],
        },
      });
    }
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

    // Memory usage (process RSS)
    const mem = process.memoryUsage();
    const rssM = (mem.rss / 1048576).toFixed(0);
    const heapUsedM = (mem.heapUsed / 1048576).toFixed(0);
    const heapTotalM = (mem.heapTotal / 1048576).toFixed(0);

    // Disk space
    let diskLine = "";
    try {
      const dfProc = spawn(["df", "-h", NOVA_DIR], { stdout: "pipe", stderr: "pipe" });
      const dfOut = await new Response(dfProc.stdout).text();
      await dfProc.exited;
      const dfLines = dfOut.trim().split("\n");
      if (dfLines.length >= 2) {
        const parts = dfLines[1].split(/\s+/);
        // parts: [filesystem, size, used, avail, use%, mount]
        diskLine = `Disk: ${parts[2]} / ${parts[1]} used (${parts[4]})`;
      }
    } catch {}

    // Data directory size
    let dataLine = "";
    try {
      const duProc = spawn(["du", "-sh", NOVA_DIR], { stdout: "pipe", stderr: "pipe" });
      const duOut = await new Response(duProc.stdout).text();
      await duProc.exited;
      const dataSize = duOut.trim().split(/\s+/)[0];
      dataLine = `\nNova data: ${dataSize}`;
    } catch {}

    // AI Providers
    const providerNames = getAvailableProviderNames();
    const providerLine = providerNames.length > 0
      ? `\nProviders: ${providerNames.join(", ")}`
      : "";

    const statusMsg = `<b>Nova System Status</b>

<b>Uptime</b>: ${uptimeH}h ${uptimeM}m
<b>Slots</b>: ${slotsLine}
<b>Queue</b>: ${queueLine}${tasksBlock}

<b>Usage</b> (this session)
Calls: ${usage.callsTotal} (${successRate}% success)
Avg duration: ${avgDur}s${costLine}${rlLine}${approvalsLine}${waLine}${providerLine}
${modelLines ? `\n<b>Models</b>\n${modelLines}` : ""}
<b>Resources</b>
Memory: ${rssM}MB RSS (heap: ${heapUsedM}/${heapTotalM}MB)
${diskLine}${dataLine}

<i>Full dashboard: ${process.env.DASHBOARD_URL || "configured in DASHBOARD_URL"}</i>`;

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

  if (command === "/schedules") {
    const dashUrl = process.env.DASHBOARD_PUBLIC_URL || "";
    await ctx.reply(dashUrl ? `Manage scheduled tasks: ${dashUrl}/schedules` : "Scheduled tasks are in the Nova web dashboard.");
    return true;
  }

  if (command === "/agents") {
    const dashUrl = process.env.DASHBOARD_PUBLIC_URL || "";
    await ctx.reply(dashUrl ? `Browse agents in the dashboard: ${dashUrl}/` : "Agents are in the Nova web dashboard.");
    return true;
  }

  // /budget — show spend summary or set rules
  if (command === "/budget") {
    const sub = parts[1]?.toLowerCase();
    if (!sub || sub === "summary") {
      try {
        const summary = getBudgetSummary(supabase, user.id);
        await ctx.reply(formatBudgetSummary(summary), { parse_mode: "HTML" });
      } catch (e: any) {
        await ctx.reply(`Budget summary error: ${e.message}`);
      }
    } else if (sub === "set" && parts.length >= 5) {
      // /budget set <agent|global> <category|any> <daily_limit> [monthly_limit]
      const agentSlug = parts[2] === "global" ? null : parts[2];
      const category = parts[3] === "any" ? null : parts[3];
      const dailyLimit = parseFloat(parts[4]);
      const monthlyLimit = parts[5] ? parseFloat(parts[5]) : null;
      if (isNaN(dailyLimit)) {
        await ctx.reply("Usage: /budget set <agent|global> <category|any> <daily_limit_usd> [monthly_limit_usd]");
      } else {
        try {
          supabase.upsertBudgetRule({
            user_id: user.id,
            agent_slug: agentSlug,
            category: category,
            daily_limit: dailyLimit,
            monthly_limit: monthlyLimit,
            auto_approve_under: dailyLimit * 0.1,
          });
          const label = `${agentSlug || "global"}/${category || "any"}`;
          await ctx.reply(`✓ Budget rule set for ${label}: $${dailyLimit}/day${monthlyLimit ? `, $${monthlyLimit}/mo` : ""}`);
        } catch (e: any) {
          await ctx.reply(`Error setting budget rule: ${e.message}`);
        }
      }
    } else {
      await ctx.reply("Usage:\n/budget summary\n/budget set <agent|global> <category|any> <daily_limit_usd> [monthly_limit_usd]");
    }
    return true;
  }

  // /goals — trigger a goal engine review now
  if (command === "/goals") {
    const sub = parts[1]?.toLowerCase();
    if (sub === "check") {
      await ctx.reply("Running goal engine review...");
      try {
        await runGoalEngineOnce();
        await ctx.reply("Goal review complete. Check active tasks for any dispatched work.");
      } catch (e: any) {
        await ctx.reply(`Goal review error: ${e.message}`);
      }
    } else {
      // Show current goals
      try {
        const goals = supabase.getGoals ? supabase.getGoals(user.id) : [];
        if (!goals || goals.length === 0) {
          await ctx.reply("No active goals. Set goals with: [GOAL: your goal text | DEADLINE: YYYY-MM-DD]");
        } else {
          const lines = goals.map((g: any) => {
            const notes = JSON.parse(g.progress_notes || "[]");
            const lastNote = notes.length > 0 ? notes[notes.length - 1]?.note : "";
            return `• ${g.content.slice(0, 80)}${g.deadline ? ` (by ${g.deadline})` : ""}${lastNote ? `\n  ↳ ${lastNote.slice(0, 60)}` : ""}`;
          }).join("\n");
          await ctx.reply(`<b>Active Goals</b>\n\n${lines}\n\n/goals check — trigger review now`, { parse_mode: "HTML" });
        }
      } catch (e: any) {
        await ctx.reply(`Error fetching goals: ${e.message}`);
      }
    }
    return true;
  }

  // /project — manage named projects
  if (command === "/project") {
    const sub = parts[1]?.toLowerCase();
    if (!sub || sub === "list") {
      try {
        const list = listProjects(supabase, user.id);
        await ctx.reply(list);
      } catch (e: any) {
        await ctx.reply(`Error listing projects: ${e.message}`);
      }
    } else if (sub === "view" && parts[2]) {
      const projectName = parts.slice(2).join(" ");
      try {
        const brief = getProjectBrief(supabase, user.id, projectName);
        await ctx.reply(brief, { parse_mode: "HTML" });
      } catch (e: any) {
        await ctx.reply(`Error: ${e.message}`);
      }
    } else if (sub === "new" && parts[2]) {
      const name = parts.slice(2).join(" ");
      try {
        const projectId = createProject(supabase, user.id, name);
        await ctx.reply(`✓ Project created: ${name} (ID: ${projectId.slice(0, 8)})\n\nAgents can now log artifacts and decisions to this project.`);
      } catch (e: any) {
        await ctx.reply(`Error creating project: ${e.message}`);
      }
    } else {
      await ctx.reply("Usage:\n/project list\n/project view <name>\n/project new <name>");
    }
    return true;
  }

  // /webhook — manage webhook triggers
  if (command === "/webhook") {
    const sub = parts[1]?.toLowerCase();
    if (!sub || sub === "list") {
      try {
        const triggers = supabase.listWebhookTriggers ? supabase.listWebhookTriggers(user.id) : [];
        if (!triggers || triggers.length === 0) {
          await ctx.reply("No webhook triggers configured.\n\nCreate one:\n/webhook create <id> <agent> \"<task template>\"");
        } else {
          const lines = triggers.map((t: any) =>
            `• <b>${t.webhook_id}</b> → ${t.agent_slug}\n  ${t.task_template.slice(0, 60)}`
          ).join("\n\n");
          await ctx.reply(`<b>Webhook Triggers</b>\n\n${lines}`, { parse_mode: "HTML" });
        }
      } catch (e: any) {
        await ctx.reply(`Error listing webhooks: ${e.message}`);
      }
    } else if (sub === "create" && parts.length >= 4) {
      // /webhook create <webhook_id> <agent_slug> <task_template>
      const webhookId = parts[2];
      const agentSlug = parts[3];
      const taskTemplate = parts.slice(4).join(" ");
      if (!taskTemplate) {
        await ctx.reply('Usage: /webhook create <id> <agent> "<task template with {{field}} placeholders>"');
      } else {
        try {
          const secret = generateWebhookSecret();
          supabase.upsertWebhookTrigger({
            user_id: user.id,
            name: webhookId,
            source: "external",
            secret,
            pipeline: JSON.stringify({ agentSlug, taskTemplate }),
          });
          const baseUrl = process.env.WEBHOOK_BASE_URL || '';
          await ctx.reply(
            `✓ Webhook created\n\n` +
            `<b>URL:</b> ${baseUrl}/webhook/${user.id}/${webhookId}\n` +
            `<b>Secret:</b> <code>${secret}</code>\n\n` +
            `Send POST with JSON body + header:\n<code>X-Nova-Signature: sha256=&lt;hmac&gt;</code>`,
            { parse_mode: "HTML" }
          );
        } catch (e: any) {
          await ctx.reply(`Error creating webhook: ${e.message}`);
        }
      }
    } else if (sub === "delete" && parts[2]) {
      const webhookId = parts[2];
      try {
        supabase.deleteWebhookTrigger(user.id, webhookId);
        await ctx.reply(`✓ Webhook ${webhookId} deleted.`);
      } catch (e: any) {
        await ctx.reply(`Error deleting webhook: ${e.message}`);
      }
    } else {
      await ctx.reply("Usage:\n/webhook list\n/webhook create <id> <agent> \"<template>\"\n/webhook delete <id>");
    }
    return true;
  }

  // /zoom — Zoom recording search and ingest
  if (command === "/zoom") {
    const args = parts.slice(1);
    const sub = args[0]?.toLowerCase();
    if (sub === "search") {
      const query = args.slice(1).join(" ").trim();
      if (!query) {
        await ctx.reply("Usage: /zoom search <keywords>\nExample: /zoom search client proposal");
        return true;
      }
      await ctx.reply(`Searching Zoom recordings for "<b>${query}</b>"...`, { parse_mode: "HTML" });
      try {
        const matches = await searchZoomRecordings(query);
        if (!matches.length) {
          await ctx.reply(`No recordings found matching "<b>${query}</b>" in the last 30 days.`, { parse_mode: "HTML" });
          return true;
        }
        const { InlineKeyboard } = await import("grammy");
        const keyboard = new InlineKeyboard();
        const lines: string[] = [`Found <b>${matches.length}</b> recording(s) matching "<b>${query}</b>":\n`];
        matches.forEach((m, i) => {
          const date = new Date(m.start_time).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
          lines.push(`${i + 1}. ${m.topic} — ${date} (${m.duration}m)`);
          zoomSearchCache.set(m.uuid, m);
          keyboard.text(`${i + 1}. ${m.topic.slice(0, 28)} (${date})`, `zoom_pick:${m.uuid}:${user.id}`).row();
        });
        await ctx.reply(lines.join("\n"), { reply_markup: keyboard, parse_mode: "HTML" });
      } catch (e: any) {
        await ctx.reply(`Search failed: ${e.message}`);
      }
    } else {
      await ctx.reply(
        "<b>/zoom search &lt;keywords&gt;</b> — find a recording and add it to Nova's brain\n\nExample: /zoom search client proposal",
        { parse_mode: "HTML" }
      );
    }
    return true;
  }

  // /reputation — show agent performance report
  if (command === "/reputation") {
    try {
      const report = getWeeklyReputationReport(supabase);
      await ctx.reply(report, { parse_mode: "HTML" });
    } catch (e: any) {
      await ctx.reply(`Error fetching reputation data: ${e.message}`);
    }
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
// AI PROVIDER REGISTRATION
// ============================================================

const claudeProvider = new ClaudeProvider();
registerProvider(claudeProvider);

const geminiProvider = new GeminiProvider();
registerProvider(geminiProvider);

const codexProvider = new CodexProvider();
registerProvider(codexProvider);

for (const profile of loadProviderProfiles()) {
  registerProvider(new OpenAICompatibleProvider(profile));
}

// Check which providers are actually available
(async () => {
  for (const p of getAllProviders()) {
    const available = await p.isAvailable();
    console.log(`  ${available ? "+" : "-"} AI Provider: ${p.name} ${available ? "(available)" : "(not installed)"}`);
  }
})();

// ── Memory summarizer ──
// Wire haiku into the memory module so long facts/goals are AI-summarized
// before being stored. Short content skips the AI call entirely.
initMemorySummarizer(async (prompt: string) => callAI(prompt, "haiku" as any));
initSessionSummarizer(async (prompt: string, model: string) => callAI(prompt, model as any));

// Wire call transcript processor (haiku for extraction, sonnet for Notion + task execution)
initCallProcessor({
  callAI: (prompt, tier, userId, hint) => callAI(prompt, tier as any, userId, hint),
  sendAlert: sendUserAlert,
});

// ============================================================
// ORCHESTRATOR INIT
// ============================================================

// Thin wrapper so planner/orchestrator can pass systemPrompt without knowing callAI's full signature
function callAIForAgents(prompt: string, model?: string, userId?: string, hint?: string, systemPrompt?: string): Promise<string> {
  return callAI(prompt, model as any, userId, hint, undefined, undefined, undefined, systemPrompt);
}

initOrchestrator({
  callClaude: callAIForAgents,
  buildPrompt,
  runTask,
  saveMessage,
  sendResponseWithVoice,
  sendTelegramFile: sendFile,
  novaDir: NOVA_DIR,
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
// AGENT DELEGATION POLLER — executes COO-dispatched agent tasks
// ============================================================

/**
 * Polls Supabase for delegations the COO has assigned to specialist agents
 * and executes them here on the relay node where all MCP tools are available.
 * Results are written back to the delegations table so the COO's monitor can see them.
 */
function startAgentDelegationPoller(comms: any): void {
  const POLL_MS = 15_000;
  const _active = new Set<string>();

  const poll = async () => {
    try {
      const agentSlugs = getAllAgents().map((a: any) => a.slug);
      if (agentSlugs.length === 0) return;

      const delegations = await comms.pollAgentDelegations(agentSlugs);

      for (const delegation of delegations) {
        if (_active.has(delegation.id)) continue;
        _active.add(delegation.id);

        (async () => {
          const agentSlug = delegation.assigned_agent!;
          // Strip parent tag from description for cleaner agent prompt
          const taskDesc = delegation.task_description
            .replace(/^\[ParentDelegation:[^\]]+\]\s*/, "")
            .trim();
          try {
            await comms.claimDelegation(delegation.id);

            const baseContext = [
              `You are executing a delegated task assigned by the COO.`,
              ``,
              `Task: ${taskDesc}`,
              ``,
              `Complete this task thoroughly. Produce concrete deliverables, not descriptions.`,
              `Tag any output files or generated content as: [ARTIFACT: type | value]`,
            ].join("\n");

            const { systemPrompt: agentSysPrompt, userPrompt: agentUserPrompt } = buildAgentPrompt(agentSlug, taskDesc, baseContext, undefined, "prepare");
            // Pass user_id so callAI loads the right MCP config + mcp2cli instructions
            const result = await callAI(agentUserPrompt, "standard", delegation.user_id, agentSlug, undefined, undefined, undefined, agentSysPrompt || undefined);

            const artifactsFn = (text: string) => {
              const found: Array<{ type: string; value: string }> = [];
              const re = /\[ARTIFACT:\s*([^|]+?)\s*\|\s*(.+?)\s*\]/g;
              let m: RegExpExecArray | null;
              while ((m = re.exec(text)) !== null) found.push({ type: m[1].trim(), value: m[2].trim() });
              return found;
            };

            await comms.completeDelegation(delegation.id, result, artifactsFn(result));
            recordSubtaskAction(delegation.user_id, "execute", {
              description: taskDesc, agent: agentSlug, success: true, artifacts: artifactsFn(result),
            });
            console.log(`[agent-dispatcher] Completed delegation ${delegation.id} (${agentSlug})`);
          } catch (err) {
            await comms.failDelegation(delegation.id, String(err));
            recordSubtaskAction(delegation.user_id, "execute", {
              description: taskDesc, agent: agentSlug, success: false,
            });
            console.error(`[agent-dispatcher] Failed delegation ${delegation.id}:`, err);
          } finally {
            _active.delete(delegation.id);
          }
        })();
      }
    } catch (err) {
      console.error("[agent-dispatcher] Poll error:", err);
    }
    setTimeout(poll, POLL_MS);
  };

  setTimeout(poll, 5_000);
  console.log("[agent-dispatcher] Started — polling for agent delegations every 15s");
}

// ============================================================
// EXECUTIVE BOARD (optional — requires Supabase)
// ============================================================

const { isBoardConfigured: _isBoardConfigured } = await import("./board-config.ts");
if (_isBoardConfigured()) {
  try {
    const { ExecComms } = await import("./exec-comms.ts");
    const { initBoard, conveneBoard, handleBoardDecision, startBoardPoller } = await import("./board.ts");
    const { initExecutionEngine, createProjectFromDecision } = await import("./execution-engine.ts");

    const novaComms = new ExecComms("nova");

    initExecutionEngine({
      callAI: (prompt, tier?, hint?) => callAI(prompt, tier as any, undefined, hint),
      comms: novaComms,
      sendMessage: async (chatId, text) => {
        const bot = telegramAdapter?.getBot();
        if (!bot) return;
        await bot.api.sendMessage(Number(chatId), text).catch(() => {});
      },
    });

    initBoard({
      callAI,
      comms: novaComms,
      sendMessage: async (chatId, text, keyboard) => {
        const bot = telegramAdapter?.getBot();
        if (!bot) return;
        const html = markdownToTelegramHTML(text);
        await bot.api.sendMessage(Number(chatId), html, {
          parse_mode: "HTML",
          ...(keyboard ? { reply_markup: keyboard } : {}),
        }).catch(async () => {
          await bot.api.sendMessage(Number(chatId), text, keyboard ? { reply_markup: keyboard } : {});
        });
      },
      onDecision: async (sessionId, decision, userId) => {
        const projectId = await createProjectFromDecision(sessionId, decision, userId);
        if (projectId) {
          console.log(`[board] Project created: ${projectId} for decision: ${decision.slice(0, 60)}`);
        }
      },
    });

    boardModule = {
      conveneBoard: (q, userId, chatId) => conveneBoard(q, userId, chatId).then(() => undefined),
      handleBoardDecision,
    };
    await novaComms.registerNode(process.env.NODE_HOST);
    startBoardPoller();

    // Agent delegation poller — picks up delegations the COO dispatched to specialist agents
    // and executes them here on the relay node where MCP tools are fully available.
    startAgentDelegationPoller(novaComms);

    console.log("[board] Executive board system initialized");
  } catch (err) {
    console.warn("[board] Executive board not available:", (err as Error).message);
  }
}

// ============================================================
// HEARTBEAT — In-process proactive check-in loop
// ============================================================

if (supabase) {
  startHeartbeat({
    db: supabase,
    callClaude: callAI,
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
// NEW AUTONOMOUS SERVICES
// ============================================================

// In-memory cache of Zoom search results for inline button callbacks
// uuid → ZoomMeeting (bounded: max 5 per search, overwritten on next search)
const zoomSearchCache = new Map<string, ZoomMeeting>();

// Helper: send an alert to a user through their preferred channel
async function sendUserAlert(userId: string, message: string): Promise<void> {
  try {
    const user = supabase.getUserById(userId);
    if (!user) return;
    const adapter = channels.getTelegram() || channels.getAll()[0];
    if (!adapter) return;
    const chatId = user.telegram_id || user.channelChatId;
    if (!chatId) return;
    await adapter.send(String(chatId), { text: message });
  } catch {}
}

// Helper: dispatch a task autonomously (inserts to DB + returns taskId)
async function dispatchAutonomousTask(
  userId: string,
  agentSlug: string,
  taskDescription: string,
  createdBy = "nova",
): Promise<string | null> {
  try {
    const taskId = supabase.insertTask({
      agent: agentSlug,
      description: taskDescription,
      status: "pending",
      user_id: userId,
      created_by: createdBy,
    });
    emit({
      type: "agent.dispatched",
      level: "info",
      userId,
      agentSlug,
      data: { message: `Autonomous task dispatched: ${taskDescription.slice(0, 80)}`, taskId, module: "relay" },
    });
    return taskId;
  } catch (err) {
    emit({ type: "error", level: "warn", data: { message: `dispatchAutonomousTask failed: ${err}`, module: "relay" } });
    return null;
  }
}

// Wrap callAI for service injection (simple 2-arg form services expect)
const callAIForServices = async (prompt: string, tier?: string, _hint?: string): Promise<string> => {
  return callAI(prompt, (tier as any) || "fast");
};

// Initialize and start Goal Engine
initGoalEngine({
  callAI: callAIForServices,
  sendAlert: sendUserAlert,
  dispatchTask: dispatchAutonomousTask,
});
startGoalEngine().catch((err) =>
  emit({ type: "error", level: "error", data: { message: `Goal engine start failed: ${err}`, module: "goal-engine" } })
);

// Initialize and start Predictive Scheduler
initPredictiveScheduler({
  callAI: callAIForServices,
  dispatchTask: dispatchAutonomousTask,
});
startPredictiveScheduler().catch((err) =>
  emit({ type: "error", level: "error", data: { message: `Predictive scheduler start failed: ${err}`, module: "predictive-scheduler" } })
);

// Start webhook ingestion server on port 3036
const WEBHOOK_PORT = parseInt(process.env.NOVA_WEBHOOK_PORT || "3036");
startWebhookServer(
  WEBHOOK_PORT,
  supabase,
  async (userId, agentSlug, taskDescription, _metadata) => {
    return dispatchAutonomousTask(userId, agentSlug, taskDescription, "webhook");
  },
  (userId, transcript, meta) => processCallTranscript(userId, transcript, meta),
);
console.log(`[webhook] Ingestion server on port ${WEBHOOK_PORT}`);

// Automation poller — drives non-push automation sources (metric probes today)
startAutomationPoller(supabase, async (userId, agentSlug, taskDescription) =>
  dispatchAutonomousTask(userId, agentSlug, taskDescription, "automation"));

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
] as const;
for (const [feature, active] of configStatus) {
  console.log(`  ${active ? "+" : "-"} ${feature}: ${active ? "enabled" : "DISABLED (missing config)"}`);
}
// Database is always available with local SQLite

// Load config/identity.md for bot persona injection
try {
  const identityPath = join(PROJECT_ROOT, "config", "identity.md");
  _botIdentity = await readFile(identityPath, "utf-8");
  console.log(`[identity] Loaded identity.md (${_botIdentity.length} chars) — bot name: ${_botName}`);
} catch {
  console.log("[identity] No config/identity.md found, using default Nova identity");
}

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


// Initialize event bus for structured observability
initEventBus({ db: supabase, digestIntervalMs: 15 * 60 * 1000 });
startStallDetection();

// Memwright memory service health check (non-blocking)
memwright.health().then(ok => {
  if (ok) {
    console.log("[memwright] Connected");
  } else {
    console.warn("[memwright] Service unavailable — memory context degraded. Start with: uvicorn agent_memory.api:app --port 8765");
  }
});

// Daily data retention cleanup (logs: 30d, cost_tracking: 90d)
setInterval(() => {
  try {
    const result = supabase.runRetentionCleanup();
    if (result.logsDeleted > 0 || result.costDeleted > 0) {
      emit({ type: "system.health", level: "info", data: { message: `Retention cleanup: ${result.logsDeleted} logs, ${result.costDeleted} cost records deleted`, module: "db" } });
    }
  } catch (err) {
    emit({ type: "error", level: "error", data: { message: "Retention cleanup failed", module: "db", error: String(err) } });
  }
}, 24 * 60 * 60 * 1000);
// Run once at startup (delayed 30s to let system settle)
setTimeout(() => { try { supabase.runRetentionCleanup(); } catch {} }, 30_000);

// Start all channel adapters
await channels.startAll();

// Restore existing WhatsApp sessions (per-user, auto-reconnect)
await whatsappManager.restoreConnectedSessions();

// Internal WhatsApp webhook listener (Kapso posts here directly)
const WA_WEBHOOK_PORT = parseInt(process.env.WA_WEBHOOK_PORT || "3035");
Bun.serve({
  port: WA_WEBHOOK_PORT,
  fetch: async (req) => {
    if (req.method === "POST" && new URL(req.url).pathname === "/webhook/kapso") {
      const body = await req.json().catch(() => null);
      if (!body) return new Response(JSON.stringify({ error: "invalid" }), { status: 400 });
      const phoneNumberId = body.phone_number_id
        || body.data?.[0]?.phone_number_id
        || body.message?.kapso?.phone_number_id
        || body.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
      if (phoneNumberId) {
        whatsappManager.routeWebhook(phoneNumberId, body).catch((e: any) =>
          console.error("[kapso-webhook]", e));
      }
      return new Response(JSON.stringify({ status: "ok" }));
    }
    return new Response("Not found", { status: 404 });
  },
});
console.log(`[wa-webhook] Internal listener on port ${WA_WEBHOOK_PORT}`);

console.log("All channels started! Users are managed via the 'users' table in the local DB.");

// Wire admin notifier for crash alerts
const adminUserId = process.env.TELEGRAM_USER_ID;
if (adminUserId && telegramAdapter) {
  const bot = telegramAdapter.getBot();
  if (bot) {
    setAdminNotifier(async (msg) => {
      try {
        await bot.api.sendMessage(adminUserId, msg);
      } catch {}
    });
  }
}

// Start health monitor — polls /health every 2 min, alerts after 3 consecutive failures
startHealthMonitor();

// Start knowledge-folder watcher — auto-ingests files dropped in ~/.nova/knowledge/
startKbWatcher();

// Start dev task dispatcher — polls for pending dev tasks every 30s
if (telegramAdapter) {
  const tgBot = telegramAdapter.getBot();
  if (tgBot) {
    startDevTaskDispatcher(async (userId: string, text: string) => {
      const user = supabase.getUserById(userId);
      if (user?.telegram_id) {
        await tgBot.api.sendMessage(user.telegram_id, text, { parse_mode: "Markdown" }).catch(() => {});
      }
    });
  }
}

// CS/SDR Mode — start if any CS channel env var is configured
if (
  process.env.CS_TELEGRAM_BOT_TOKEN ||
  process.env.META_VERIFY_TOKEN ||
  process.env.CS_WIDGET_PORT
) {
  startCsRouter(async (text: string) => {
    // Notify the owner via their private Telegram DM
    const ownerId = process.env.TELEGRAM_USER_ID;
    if (ownerId && telegramAdapter) {
      try {
        const bot = telegramAdapter.getBot();
        if (bot) {
          await bot.api.sendMessage(Number(ownerId), text, { parse_mode: 'HTML' });
        }
      } catch (err) {
        console.error('[relay] Failed to notify owner of CS escalation:', err);
      }
    }
  });
}

// Notify admin users that Nova is back online (via Telegram if available)
// Also recover any pending approvals that survived the restart
if (telegramAdapter) {
  try {
    const admins = supabase.getUsersByRole("admin");
    if (admins?.length) {
      const adminIds = admins.map((a: any) => a.telegram_id).filter(Boolean);

      // Debounce: only notify once per 5 minutes to avoid spam during crash loops
      const ONLINE_STAMP = join(NOVA_DIR, "last-online-notified");
      const MIN_GAP_MS = 5 * 60 * 1000;
      let lastNotified = 0;
      try { lastNotified = parseInt(await readFile(ONLINE_STAMP, "utf-8")) || 0; } catch {}
      if (Date.now() - lastNotified > MIN_GAP_MS) {
        telegramAdapter.notifyAdmins(adminIds, "Nova is back online.");
        await writeFile(ONLINE_STAMP, String(Date.now())).catch(() => {});
      }

      // Recover pending approvals for each admin user
      for (const admin of admins) {
        if (admin.id) {
          await recoverPendingApprovals(supabase, admin.id);
        }
      }

      // Warn if SDK credit pool is > 75% used (crosses $150 of the $200/mo pool)
      try {
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
        const mtdEntries = supabase.getCostEntries({ since: monthStart });
        const mtdClaudeCost = (mtdEntries || [])
          .filter((r: any) => r.provider === "claude")
          .reduce((s: number, r: any) => s + (r.cost_usd || 0), 0);
        if (mtdClaudeCost >= 150) {
          const pct = Math.round((mtdClaudeCost / 200) * 10) / 10;
          const msg = `SDK credit pool at ${pct}% — $${mtdClaudeCost.toFixed(2)} of $200 used this month.`;
          for (const adminId of adminIds) {
            await telegramAdapter!.send(String(adminId), { text: msg }).catch(() => {});
          }
        }
      } catch { /* non-critical */ }

      // Check CLI provider auth status; send OAuth URL to admin if re-auth needed
      checkCliAuth(async (message) => {
        for (const adminId of adminIds) {
          await telegramAdapter!.send(String(adminId), { text: message }).catch(() => {});
        }
      }).catch(() => {});
    }
  } catch {}
}
