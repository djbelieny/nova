/**
 * Executive Node — Independent entry point for distributed exec VPS
 *
 * Each executive runs on its own VPS with its own Telegram bot,
 * AI API key, and full copy of all 24 agents.
 *
 * Usage: bun run src/executive-node.ts --role ceo
 * With custom env: bun run --env-file=.env.ceo src/executive-node.ts --role ceo
 */

import { Bot } from "grammy";
import type { Context } from "grammy";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { existsSync } from "fs";
import { ExecComms } from "./exec-comms.ts";
import { loadAgents, getAgentCatalog } from "./agent-router.ts";
import { isMcp2cliAvailable, buildMcp2cliInstructions, loadProjectMcpConfig } from "./mcp2cli.ts";
import {
  type ModelTier,
  type AIProviderResult,
  registerProvider,
  getProvider,
  getDefaultProvider,
  setDefaultProvider,
} from "./ai-provider.ts";
import { ClaudeProvider } from "./providers/claude.ts";
import { GeminiProvider } from "./providers/gemini.ts";
import { CodexProvider } from "./providers/codex.ts";
import { selectProvider } from "./ai-router.ts";
import { handleExecMessage, initExecHandler } from "./executive-handler.ts";
import { initCooPipeline, startCooPipeline } from "./coo-pipeline.ts";
import {
  initExecutionEngine,
  startProjectMonitor,
  recoverInProgressDelegations,
} from "./execution-engine.ts";
import {
  initGroupChat,
  handleGroupMessage,
  registerOwnMessage,
  updateGroupRoster,
} from "./group-chat.ts";
import {
  markdownToTelegramHTML,
  cleanResponseForUser,
} from "./channels/telegram.ts";
import { emit, initEventBus } from "./events.ts";
import { getDb } from "./db.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

// ============================================================
// VALID ROLES
// ============================================================

const VALID_ROLES = ["ceo", "cfo", "cmo", "cto", "coo", "research", "critic"] as const;
type ExecRole = (typeof VALID_ROLES)[number];

// ============================================================
// PARSE ROLE FROM ARGS / ENV
// ============================================================

const roleArg =
  process.argv.find((a) => a.startsWith("--role="))?.split("=")[1] ||
  process.argv[process.argv.indexOf("--role") + 1] ||
  process.env.EXEC_ROLE;

if (!roleArg) {
  console.error("[exec-node] Missing role. Use --role=ceo or set EXEC_ROLE env var.");
  console.error(`  Valid roles: ${VALID_ROLES.join(", ")}`);
  process.exit(1);
}

const role = roleArg.toLowerCase() as ExecRole;

if (!VALID_ROLES.includes(role)) {
  console.error(`[exec-node] Invalid role "${roleArg}". Valid roles: ${VALID_ROLES.join(", ")}`);
  process.exit(1);
}

// ============================================================
// VALIDATE REQUIRED ENV VARS
// ============================================================

const EXEC_BOT_TOKEN = process.env.EXEC_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const EXEC_AI_PROVIDER = (process.env.EXEC_AI_PROVIDER || "claude").toLowerCase();
const ALLOWED_USERS = (process.env.TELEGRAM_USER_ID || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);
const USER_TELEGRAM_USERNAME = process.env.TELEGRAM_USERNAME || "";

const missing: string[] = [];
if (!EXEC_BOT_TOKEN) missing.push("EXEC_BOT_TOKEN");
if (!SUPABASE_URL) missing.push("SUPABASE_URL");
if (!SUPABASE_ANON_KEY) missing.push("SUPABASE_ANON_KEY");

// Claude uses CLI auth locally (no API key needed); Gemini/Codex need keys
const providerKeyMap: Record<string, string> = {
  gemini: "GEMINI_API_KEY",
  codex: "CODEX_API_KEY",
};
const requiredKey = providerKeyMap[EXEC_AI_PROVIDER];
if (requiredKey && !process.env[requiredKey]) {
  missing.push(requiredKey);
}
if (EXEC_AI_PROVIDER === "claude" && !process.env.ANTHROPIC_API_KEY) {
  console.warn("[exec-node] ANTHROPIC_API_KEY not set — using Claude CLI auth (local only)");
}

if (missing.length > 0) {
  console.error(`[exec-node] Missing required env vars: ${missing.join(", ")}`);
  process.exit(1);
}

// ============================================================
// EXECUTIVE DEFINITION
// ============================================================

interface ExecDef {
  name: string;
  description: string;
  prompt: string;
  role: string;
}

async function loadExecDef(execRole: string): Promise<ExecDef> {
  const filePath = join(PROJECT_ROOT, ".claude", "agents", "executives", `${execRole}.md`);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (e) {
    throw new Error(
      `Could not load executive definition at ${filePath}. ` +
        `Make sure .claude/agents/executives/${execRole}.md exists.`
    );
  }

  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) {
    throw new Error(`Invalid exec definition for "${execRole}": missing YAML frontmatter`);
  }

  const fm = fmMatch[1];
  const body = fmMatch[2].trim();
  const name = fm.match(/name:\s*(.+)/)?.[1]?.trim() || execRole;
  const description = fm.match(/description:\s*(.+)/)?.[1]?.trim() || "";

  return { name, description, prompt: body, role: execRole };
}

// ============================================================
// AI PROVIDER SETUP
// ============================================================

function initProviders(): void {
  // Register all available providers
  // Claude uses CLI auth (always available locally, needs ANTHROPIC_API_KEY on remote VPS)
  registerProvider(new ClaudeProvider());
  if (process.env.GEMINI_API_KEY) {
    registerProvider(new GeminiProvider());
  }
  if (process.env.CODEX_API_KEY) {
    registerProvider(new CodexProvider());
  }

  // Set the exec's preferred provider as default
  try {
    setDefaultProvider(EXEC_AI_PROVIDER);
  } catch {
    console.warn(
      `[exec-node] Could not set "${EXEC_AI_PROVIDER}" as default provider. ` +
        `Falling back to first available.`
    );
  }
}

// ============================================================
// EXECUTIVE MCP SERVER MAPPING
// Only execs that actively research get MCP servers.
// Others receive briefings from Research or delegate via COO.
// browserbase dropped — uses npx (heavy), rarely needed.
// ============================================================

const EXEC_MCP_SERVERS: Record<string, string[]> = {
  research: ["exa", "tavily", "firecrawl"],  // primary researcher
  cto:      ["exa", "tavily"],               // occasional tech research
  cmo:      ["exa", "tavily"],               // occasional market research
  critic:   [],  // analyzes contributions, doesn't need live search
  ceo:      [],  // strategizes from briefings, not live data
  cfo:      [],  // internal data analysis
  coo:      [],  // delegates only
};

let _execMcpConfigPath: string | undefined;
let _execUseMcp2cli = false;

/**
 * Generate a focused MCP config for this exec role (only research servers).
 * Called once at startup.
 */
async function initExecMcpConfig(execRole: string): Promise<void> {
  const servers = EXEC_MCP_SERVERS[execRole] || [];
  if (servers.length === 0) {
    emit({ type: "exec.message", level: "info", execRole: execRole, data: { message: `No MCP servers for ${execRole}`, module: "exec-node" } });
    return;
  }

  // Check mcp2cli availability first
  _execUseMcp2cli = process.env.MCP2CLI_ENABLED !== "false" && (await isMcp2cliAvailable());
  if (_execUseMcp2cli) {
    emit({ type: "exec.message", level: "info", execRole: execRole, data: { message: `mcp2cli available — ${execRole} will use Bash-based tool access for: ${servers.join(", ")}`, module: "exec-node" } });
    return; // No need for MCP config file — tools accessed via mcp2cli
  }

  // Fallback: generate a filtered MCP config file with only the exec's servers
  try {
    const globalMcpPath = join(PROJECT_ROOT, ".mcp.nova.json");
    if (!existsSync(globalMcpPath)) return;

    const raw = await readFile(globalMcpPath, "utf-8");
    const globalConfig = JSON.parse(raw);
    const allServers = globalConfig.mcpServers || {};
    const filtered: Record<string, any> = {};

    for (const name of servers) {
      if (allServers[name]) {
        // Resolve ${VAR} env placeholders
        const serverConfig = JSON.parse(
          JSON.stringify(allServers[name]).replace(/\$\{(\w+)\}/g, (_, v) => process.env[v] || "")
        );
        filtered[name] = serverConfig;
      }
    }

    if (Object.keys(filtered).length === 0) return;

    const configDir = join(process.env.HOME || "/tmp", ".nova", "exec");
    await mkdir(configDir, { recursive: true });
    _execMcpConfigPath = join(configDir, `mcp-${execRole}.json`);
    await writeFile(_execMcpConfigPath, JSON.stringify({ mcpServers: filtered }, null, 2));
    emit({ type: "exec.message", level: "info", execRole: execRole, data: { message: `MCP config for ${execRole}: ${Object.keys(filtered).join(", ")} → ${_execMcpConfigPath}`, module: "exec-node" } });
  } catch (err) {
    console.warn(`[exec-node] Failed to generate exec MCP config:`, err);
  }
}

// ============================================================
// callAI — AI call for exec nodes, with optional MCP access
// ============================================================

export async function callAI(
  prompt: string,
  opts: { tier?: ModelTier; hint?: string; outputFormat?: "json" | "text" } = {}
): Promise<string> {
  const tier = opts.tier || "standard";

  // Use smart routing with fallback
  const route = selectProvider({
    tier,
    hint: opts.hint,
    forceProvider: EXEC_AI_PROVIDER,
  });

  try {
    const result = await route.provider.call({
      prompt,
      model: route.model,
      outputFormat: opts.outputFormat || "text",
      mcpConfigPath: _execUseMcp2cli ? undefined : _execMcpConfigPath,
      useMcp2cli: _execUseMcp2cli && !!EXEC_MCP_SERVERS[role]?.length,
    });
    return result.text;
  } catch (err) {
    // Fallback: try default provider if the routed one fails
    const fallback = getDefaultProvider();
    if (fallback.name !== route.provider.name) {
      console.warn(
        `[exec-node] ${route.provider.name} failed, falling back to ${fallback.name}`
      );
      const fallbackModel = fallback.mapModelTier(tier);
      const result = await fallback.call({
        prompt,
        model: fallbackModel,
        outputFormat: opts.outputFormat || "text",
        mcpConfigPath: _execUseMcp2cli ? undefined : _execMcpConfigPath,
        useMcp2cli: _execUseMcp2cli && !!EXEC_MCP_SERVERS[role]?.length,
      });
      return result.text;
    }
    throw err;
  }
}

// ============================================================
// PROMPT BUILDER
// ============================================================

function buildPrompt(
  execDef: ExecDef,
  userMessage: string,
  context?: { decisionHistory?: string; agentCatalog?: string }
): string {
  const sections: string[] = [];

  const timeStr = new Date().toLocaleString("en-US", {
    timeZone: "UTC",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  sections.push(`# Executive Persona: ${execDef.name}\n\n${execDef.prompt}`);
  sections.push(`Current time: ${timeStr} UTC`);

  // Inject research tool instructions for execs with MCP access
  const execServers = EXEC_MCP_SERVERS[execDef.role] || [];
  if (execServers.length > 0 && _execUseMcp2cli) {
    const mcpConfig = loadProjectMcpConfig(PROJECT_ROOT);
    const instructions = buildMcp2cliInstructions(execServers, mcpConfig);
    if (instructions) {
      sections.push(`## Research Tools\n\nYou have direct access to research tools via Bash commands. Use these to gather real data, search the web, and verify facts — don't just reason from memory.\n\n${instructions}`);
    }
  } else if (execServers.length > 0 && _execMcpConfigPath) {
    sections.push(`## Research Tools\n\nYou have direct access to research MCP servers: ${execServers.join(", ")}. Use them to search the web, gather data, and verify facts when analyzing questions.`);
  }

  if (context?.agentCatalog) {
    sections.push(`## Available Agents\n\n${context.agentCatalog}`);
  }

  if (context?.decisionHistory) {
    sections.push(`## Recent Decision History\n\n${context.decisionHistory}`);
  }

  sections.push(`## User Message\n\n${userMessage}`);

  return sections.join("\n\n---\n\n");
}

// ============================================================
// TELEGRAM BOT SETUP
// ============================================================

function isAllowedUser(ctx: Context): boolean {
  if (ALLOWED_USERS.length === 0) return true; // no restriction if not configured
  const userId = ctx.from?.id?.toString();
  return userId ? ALLOWED_USERS.includes(userId) : false;
}

// ============================================================
// MAIN STARTUP
// ============================================================

async function main() {
  // Initialize event bus so events are persisted to shared.db logs table
  initEventBus({ db: getDb() });

  emit({ type: "exec.message", level: "info", execRole: role, data: { message: `Starting executive node: ${role.toUpperCase()}`, module: "exec-node" } });
  emit({ type: "exec.message", level: "info", execRole: role, data: { message: `AI provider: ${EXEC_AI_PROVIDER}`, module: "exec-node" } });

  // 1. Load executive definition
  const execDef = await loadExecDef(role);
  emit({ type: "exec.message", level: "info", execRole: role, data: { message: `Loaded executive: ${execDef.name} — ${execDef.description}`, module: "exec-node" } });

  // 2. Initialize AI providers
  initProviders();
  emit({ type: "exec.message", level: "info", execRole: role, data: { message: "AI providers initialized", module: "exec-node" } });

  // 2b. Initialize MCP config for research-capable execs
  await initExecMcpConfig(role);

  // 3. Load all 24 agents
  await loadAgents();
  const agentCatalog = getAgentCatalog();

  // 4. Initialize Supabase comms
  const comms = new ExecComms(role, SUPABASE_URL!, SUPABASE_ANON_KEY!);
  emit({ type: "exec.message", level: "info", execRole: role, data: { message: "Supabase comms initialized", module: "exec-node" } });

  // 5. Register node (bot username filled after bot.api.getMe below)
  const nodeHost = process.env.NODE_HOST || "localhost";

  // 6. Initialize executive handler
  // sendMessage will be set after bot is created (see below)
  let botSendMessage: (chatId: string | number, text: string) => Promise<void> = async () => {};
  initExecHandler({
    callAI,
    comms,
    execDef,
    sendMessage: (chatId, text) => botSendMessage(chatId, text),
  });

  // 7. Set up Telegram bot
  const bot = new Bot(EXEC_BOT_TOKEN!);

  // Get bot info (username) for group chat @mention detection
  const botInfo = await bot.api.getMe();
  const botUsername = botInfo.username || `${role}_bot`;
  emit({ type: "exec.message", level: "info", execRole: role, data: { message: `Bot username: @${botUsername}`, module: "exec-node" } });

  // Register node with bot username so other execs can discover @handles
  await comms.registerNode(nodeHost, { botUsername, execName: execDef.name });
  emit({ type: "exec.message", level: "info", execRole: role, data: { message: `Node registered: ${nodeHost}`, module: "exec-node" } });

  // Wire up sendMessage now that bot exists
  botSendMessage = async (chatId: string | number, text: string) => {
    const html = markdownToTelegramHTML(text);
    await bot.api.sendMessage(Number(chatId), html, { parse_mode: "HTML" }).catch(async () => {
      await bot.api.sendMessage(Number(chatId), text);
    });
  };

  // 7b. Initialize group chat module
  initGroupChat({
    callAI: (prompt, tier?, hint?) => callAI(prompt, { tier: (tier as ModelTier) || "fast", hint }),
    comms,
    config: {
      role,
      execName: execDef.name,
      botUsername,
      userTelegramUsername: USER_TELEGRAM_USERNAME || undefined,
    },
    execPrompt: execDef.prompt,
  });

  // Fetch exec roster so group chat knows all @usernames
  try {
    const roster = await comms.getExecRoster();
    updateGroupRoster(roster);
    emit({ type: "exec.message", level: "info", execRole: role, data: { message: `Group chat initialized (roster: ${roster.length} execs)`, module: "exec-node" } });
  } catch {
    emit({ type: "exec.message", level: "warn", execRole: role, data: { message: "Group chat initialized (roster fetch failed — will retry)", module: "exec-node" } });
  }

  // Log all updates for debugging group chat delivery
  bot.use(async (ctx, next) => {
    if (ctx.chat && (ctx.chat.type === "group" || ctx.chat.type === "supergroup")) {
      console.log(`[exec-node:${role}] Group update: type=${ctx.updateType} chat=${ctx.chat.id} from=${ctx.from?.username || ctx.from?.id}`);
    }
    await next();
  });

  bot.on("message:text", async (ctx) => {
    const chatType = ctx.chat.type;
    const isGroup = chatType === "group" || chatType === "supergroup";

    // Skip messages from this bot itself (in groups, bot receives its own messages)
    if (ctx.from.id === botInfo.id) return;

    // In groups, allow all messages (no auth check — the group itself is the boundary)
    // In DMs, enforce user allowlist
    if (!isGroup && !isAllowedUser(ctx)) {
      await ctx.reply("Unauthorized. This bot is restricted to authorized users.");
      return;
    }

    const userId = ctx.from.id.toString();
    const text = ctx.message.text;

    if (isGroup) {
      console.log(`[exec-node:${role}] Group message from ${ctx.from.first_name}: "${text.slice(0, 100)}"`);
    }

    // ── GROUP CHAT ──
    if (isGroup) {
      try {
        // Build GroupMessage from Telegram context
        const replyMsg = ctx.message.reply_to_message;
        const groupMsg = {
          messageId: ctx.message.message_id,
          chatId: ctx.chat.id,
          fromUserId: userId,
          fromName: ctx.from.first_name + (ctx.from.last_name ? ` ${ctx.from.last_name}` : ""),
          text,
          replyToMessageId: replyMsg?.message_id,
          replyToText: replyMsg && "text" in replyMsg ? replyMsg.text : undefined,
          replyToFrom: replyMsg?.from?.username || replyMsg?.from?.first_name,
        };

        const result = await handleGroupMessage(groupMsg);
        if (!result) return; // This exec stays silent

        // Apply stagger delay then respond
        await new Promise((resolve) => setTimeout(resolve, result.delay));

        // Send as reply to the triggering message
        const cleaned = cleanResponseForUser(result.response);
        const html = markdownToTelegramHTML(cleaned);
        const chunks = chunkMessage(html, 4000);

        for (const chunk of chunks) {
          try {
            const sent = await ctx.api.sendMessage(ctx.chat.id, chunk, {
              parse_mode: "HTML",
              reply_parameters: { message_id: result.replyToMessageId },
            });
            registerOwnMessage(sent.message_id);
          } catch {
            const sent = await ctx.api.sendMessage(ctx.chat.id, cleaned.slice(0, 4000), {
              reply_parameters: { message_id: result.replyToMessageId },
            });
            registerOwnMessage(sent.message_id);
          }
        }

        // Record in exec_messages so other execs (not in the group) can see
        await comms.sendBrief(
          null,
          "group-chat",
          `[${role.toUpperCase()} in group]: ${cleaned.slice(0, 500)}`,
        ).catch(() => {});
      } catch (err) {
        console.error(`[exec-node] Group chat error:`, err);
      }
      return;
    }

    // ── DIRECT MESSAGE ──
    try {
      await ctx.replyWithChatAction("typing");
      const response = await handleExecMessage(
        text,
        { id: userId, name: ctx.from.first_name },
        ctx.chat.id,
      );

      const cleaned = cleanResponseForUser(response);
      const html = markdownToTelegramHTML(cleaned);

      // Send in chunks if too long (Telegram 4096 char limit)
      const chunks = chunkMessage(html, 4000);
      for (const chunk of chunks) {
        try {
          await ctx.reply(chunk, { parse_mode: "HTML" });
        } catch {
          // Fallback to plain text if HTML parsing fails
          await ctx.reply(cleaned.slice(0, 4000));
        }
      }
    } catch (err) {
      emit({ type: "error", level: "error", execRole: role, data: { message: "Error handling message", module: "exec-node", error: String(err) } });
      await ctx.reply("An error occurred processing your message. Please try again.");
    }
  });

  // 8. Start polling loops
  let lastPollTime = Date.now();
  let activeTasks: string[] = [];
  let running = true;

  // Get the exec's chat ID for sending proactive messages
  let execChatId: string | null = null;

  // Track the group chat config so we can update it dynamically
  const groupChatConfig = {
    role,
    execName: execDef.name,
    botUsername,
    userTelegramUsername: USER_TELEGRAM_USERNAME || undefined,
  };

  bot.on("message", (ctx) => {
    // Capture the chat ID from the first DM we receive
    if (!execChatId && isAllowedUser(ctx) && ctx.chat.type === "private") {
      execChatId = ctx.chat.id.toString();
    }
    // Capture user's Telegram username for @mentioning in group chat
    if (isAllowedUser(ctx) && ctx.from?.username && !groupChatConfig.userTelegramUsername) {
      groupChatConfig.userTelegramUsername = ctx.from.username;
      initGroupChat({
        callAI: (prompt, tier?, hint?) => callAI(prompt, { tier: (tier as ModelTier) || "fast", hint }),
        comms,
        config: groupChatConfig,
        execPrompt: execDef.prompt,
      });
    }
  });

  // Message poller — check for messages from other execs / board
  const messagePollInterval = setInterval(async () => {
    if (!running || !execChatId) return;
    try {
      const messages = await comms.pollMessages(lastPollTime);
      lastPollTime = Date.now();
      for (const msg of messages) {
        const formatted = `<b>[${msg.from}]</b>\n${markdownToTelegramHTML(msg.content)}`;
        const chunks = chunkMessage(formatted, 4000);
        for (const chunk of chunks) {
          try {
            await bot.api.sendMessage(execChatId, chunk, { parse_mode: "HTML" });
          } catch {
            await bot.api.sendMessage(execChatId, `[${msg.from}]\n${msg.content}`);
          }
        }
      }
    } catch (err) {
      emit({ type: "error", level: "error", execRole: role, data: { message: "Message poll error", module: "exec-node", error: String(err) } });
    }
  }, 3000);

  // Board session poller — contribute to board discussions
  // COO delegates only and doesn't participate in board analysis.
  // Stagger poll start per role so execs don't all spawn AI processes simultaneously.
  const BOARD_CONTRIBUTING_ROLES = new Set(["ceo", "cfo", "cmo", "cto", "research", "critic"]);
  const BOARD_ROLE_DELAY: Record<string, number> = {
    research: 0, ceo: 10_000, cfo: 20_000, cmo: 30_000, cto: 40_000, critic: 50_000,
  };
  const boardSessionsInProgress = new Set<string>();
  const boardPollTick = async () => {
    if (!running) return;
    try {
      const sessions = await comms.getPendingSessions();
      for (const session of sessions) {
        // Skip sessions already being processed (prevents duplicate claude spawns)
        if (boardSessionsInProgress.has(session.id)) continue;
        boardSessionsInProgress.add(session.id);

        // Also check if we already contributed (e.g. from a previous restart)
        try {
          const existing = await comms.getContributions(session.id);
          if (existing.some(c => c.role === role)) {
            // Already contributed — skip
            continue;
          }
        } catch {}

        // Process contribution async but don't block the poller
        (async () => {
          try {
            const prompt = buildPrompt(execDef, session.question, {
              agentCatalog,
              decisionHistory: session.consensus ?? session.decision_rationale ?? undefined,
            });
            const contribution = await callAI(prompt, { tier: "standard" });
            await comms.submitContribution(session.id, contribution);

            // Notify the exec about the board session
            if (execChatId) {
              const notice = `<b>Board Session:</b> ${session.question}\n\n<i>Contribution submitted.</i>`;
              try {
                await bot.api.sendMessage(execChatId, notice, { parse_mode: "HTML" });
              } catch {
                await bot.api.sendMessage(
                  execChatId,
                  `Board Session: ${session.question}\nContribution submitted.`
                );
              }
            }
          } catch (err) {
            emit({ type: "error", level: "error", execRole: role, data: { message: `Board contribution error for session ${session.id}`, module: "exec-node", error: String(err) } });
          }
        })();
      }
    } catch (err) {
      emit({ type: "error", level: "error", execRole: role, data: { message: "Board session poll error", module: "exec-node", error: String(err) } });
    }
  };
  // Staggered start, then poll every 15s (only for contributing roles)
  let boardPollInterval: ReturnType<typeof setInterval> | null = null;
  if (BOARD_CONTRIBUTING_ROLES.has(role)) {
    const roleDelay = BOARD_ROLE_DELAY[role] ?? 0;
    setTimeout(() => {
      boardPollTick();
      boardPollInterval = setInterval(boardPollTick, 15_000);
    }, roleDelay);
  }

  // COO-only: delegation pipeline + project execution engine
  if (role === "coo") {
    const cooCallAI = (prompt: string, tier?: string, hint?: string) =>
      callAI(prompt, { tier: (tier as ModelTier) || "standard", hint });

    const cooSendMessage = async (chatId: string | number, text: string) => {
      const target = chatId || execChatId;
      if (!target) return;
      try {
        await bot.api.sendMessage(Number(target), text);
      } catch {
        // best-effort notification
      }
    };

    initCooPipeline({ callAI: cooCallAI, comms, sendMessage: cooSendMessage });
    startCooPipeline();

    initExecutionEngine({ callAI: cooCallAI, comms, sendMessage: cooSendMessage });
    startProjectMonitor();

    // Recover any in-flight delegations from before restart
    recoverInProgressDelegations().catch((err) =>
      emit({ type: "error", level: "warn", execRole: role, data: { message: "Recovery failed", module: "exec-node", error: String(err) } })
    );

    emit({ type: "exec.delegation", level: "info", execRole: role, data: { message: "COO pipeline and execution engine started", module: "exec-node" } });
  }

  // Heartbeat — report liveness + refresh roster
  const heartbeatInterval = setInterval(async () => {
    if (!running) return;
    try {
      await comms.heartbeat(activeTasks.length);
      // Refresh roster so group chat stays current with who's online
      const roster = await comms.getExecRoster();
      updateGroupRoster(roster);
    } catch (err) {
      emit({ type: "exec.heartbeat", level: "debug", execRole: role, data: { message: "Heartbeat error", module: "exec-node", error: String(err) } });
    }
  }, 30_000);

  // 9. Graceful shutdown
  async function shutdown(signal: string) {
    if (!running) return;
    running = false;
    emit({ type: "exec.message", level: "info", execRole: role, data: { message: `${signal} received. Shutting down ${execDef.name}...`, module: "exec-node" } });

    clearInterval(messagePollInterval);
    if (boardPollInterval) clearInterval(boardPollInterval);
    clearInterval(heartbeatInterval);

    try {
      await comms.deregisterNode();
      emit({ type: "exec.message", level: "info", execRole: role, data: { message: "Node deregistered", module: "exec-node" } });
    } catch (err) {
      emit({ type: "error", level: "error", execRole: role, data: { message: "Error deregistering node", module: "exec-node", error: String(err) } });
    }

    bot.stop();
    emit({ type: "exec.message", level: "info", execRole: role, data: { message: `${execDef.name} shut down cleanly`, module: "exec-node" } });
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // 10. Start bot
  emit({ type: "exec.message", level: "info", execRole: role, data: { message: `${execDef.name} (${role.toUpperCase()}) is online and polling`, module: "exec-node" } });
  bot.start();
}

// ============================================================
// HELPERS
// ============================================================

function chunkMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to break at a newline
    let breakIdx = remaining.lastIndexOf("\n", maxLen);
    if (breakIdx < maxLen * 0.3) {
      // No good newline break, try space
      breakIdx = remaining.lastIndexOf(" ", maxLen);
    }
    if (breakIdx < maxLen * 0.3) {
      // No good break point, hard cut
      breakIdx = maxLen;
    }

    chunks.push(remaining.slice(0, breakIdx));
    remaining = remaining.slice(breakIdx).trimStart();
  }

  return chunks;
}

// ============================================================
// EXPORTS
// ============================================================

export { buildPrompt, loadExecDef, type ExecDef, type ExecRole, VALID_ROLES };

// ============================================================
// RUN
// ============================================================

main().catch((err) => {
  console.error(`[exec-node] Fatal error:`, err);
  process.exit(1);
});
