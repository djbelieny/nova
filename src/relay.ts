/**
 * Nova — Personal AI Assistant
 *
 * Relay that connects Telegram to Claude Code CLI.
 * Customize this for your own needs.
 *
 * Run: bun run src/relay.ts
 */

import { Bot, Context, InputFile, InlineKeyboard } from "grammy";
import { spawn } from "bun";
import { writeFile, mkdir, readFile, unlink } from "fs/promises";
import { join, dirname, basename, resolve } from "path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { transcribe } from "./transcribe.ts";
import { trackCost } from "./cost-tracker.ts";
import {
  processMemoryIntents,
  getMemoryContext,
  getRelevantContext,
  getRecentHistory,
  getTaskContext,
} from "./memory.ts";
import { textToSpeech, isTTSEnabled } from "./tts.ts";
import { toggleVoiceResponses, loadSettings } from "./settings.ts";
import { orchestrate, initOrchestrator } from "./orchestrator.ts";

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

    await writeFile(LOCK_FILE, process.pid.toString());
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
process.on("SIGINT", async () => {
  await releaseLock();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await releaseLock();
  process.exit(0);
});

// ============================================================
// SETUP
// ============================================================

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set!");
  console.log("\nTo set up:");
  console.log("1. Message @BotFather on Telegram");
  console.log("2. Create a new bot with /newbot");
  console.log("3. Copy the token to .env");
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

const userCache = new Map<string, NovaUser>();

async function resolveUser(telegramId: string): Promise<NovaUser | null> {
  // Check cache first
  const cached = userCache.get(telegramId);
  if (cached) return cached;

  if (!supabase) return null;

  try {
    const { data, error } = await supabase.rpc("get_user_by_telegram_id", {
      p_telegram_id: telegramId,
    });

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

    userCache.set(telegramId, user);
    return user;
  } catch (error) {
    console.error("User resolution error:", error);
    return null;
  }
}

function invalidateUserCache(telegramId?: string): void {
  if (telegramId) {
    userCache.delete(telegramId);
  } else {
    userCache.clear();
  }
}

async function saveMessage(
  role: string,
  content: string,
  userId: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from("messages").insert({
      role,
      content,
      channel: "telegram",
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

const bot = new Bot(BOT_TOKEN);

// ============================================================
// SECURITY: User resolution middleware (multi-user)
// ============================================================

bot.use(async (ctx, next) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await resolveUser(telegramId);
  if (!user) {
    console.log(`Unauthorized: ${telegramId}`);
    await ctx.reply("This bot is private. Ask the admin to add you.");
    return;
  }

  (ctx as any).novaUser = user;
  await next();
});

// ============================================================
// INLINE BUTTON CALLBACKS
// ============================================================

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const user = (ctx as any).novaUser as NovaUser;

  // Handle button presses — format is "btn:Label Text"
  if (data.startsWith("btn:")) {
    const selection = data.substring(4);
    console.log(`Button pressed by ${user.name}: ${selection}`);

    // Acknowledge the button press immediately
    await ctx.answerCallbackQuery({ text: `Got it: ${selection}` });

    // Update the original message to show the selection (remove buttons)
    try {
      const originalText = ctx.callbackQuery.message?.text || "";
      await ctx.editMessageText(`${originalText}\n\n>> ${selection}`, {
        reply_markup: undefined,
      });
    } catch {}

    // Process the button selection as a new user message
    await saveMessage("user", selection, user.id);

    await ctx.replyWithChatAction("typing");

    runTask(ctx, `Button: ${selection.substring(0, 40)}`, async () => {
      const [relevantContext, memoryContext, recentHistory, taskContext] = await Promise.all([
        getRelevantContext(supabase, selection, user.id),
        getMemoryContext(supabase, user.id),
        getRecentHistory(supabase, user.id),
        getTaskContext(supabase, user.id),
      ]);
      return {
        prompt: buildPrompt(
          user,
          `[Button selected in response to a question]: ${selection}`,
          relevantContext,
          memoryContext,
          recentHistory,
          taskContext
        ),
      };
    }, {
      postProcess: (raw) => processMemoryIntents(supabase, raw, user.id),
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

async function callClaude(prompt: string): Promise<string> {
  const args = [CLAUDE_PATH, "-p", prompt, "--output-format", "json", "--permission-mode", "bypassPermissions"];

  console.log(`Calling Claude: ${prompt.substring(0, 50)}...`);

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

    if (exitCode !== 0) {
      console.error("Claude error:", stderr);
      return `Error: ${stderr || "Claude exited with code " + exitCode}`;
    }

    // Parse JSON response to extract cost data
    try {
      const json = JSON.parse(output.trim());
      const result = typeof json.result === "string" ? json.result : output.trim();

      // Extract model from various possible locations in the JSON response
      const model = json.model
        || json.metadata?.model
        || (typeof json.result === "object" && json.result?.model)
        || process.env.ANTHROPIC_MODEL
        || "claude-sonnet-4-5";

      // Log cost data if available
      if (json.usage) {
        trackCost({
          provider: "claude",
          model,
          input_tokens: json.usage?.input_tokens || 0,
          output_tokens: json.usage?.output_tokens || 0,
          cache_read_tokens: json.usage?.cache_read_input_tokens || 0,
          cache_creation_tokens: json.usage?.cache_creation_input_tokens || 0,
          cost_usd: json.cost_usd || json.total_cost_usd || 0,
          duration_ms: json.duration_ms || 0,
          session_id: json.session_id || undefined,
        });
      }

      return result;
    } catch {
      // If JSON parsing fails, return raw output
      return output.trim();
    }
  } catch (error) {
    console.error("Spawn error:", error);
    return `Error: Could not run Claude CLI`;
  }
}

/**
 * Run a Claude task asynchronously — sends typing indicator, handles long-running
 * tasks with progress updates, and delivers the result when done.
 * Does NOT block the message handler, so Nova can work on multiple tasks at once.
 */
function runTask(
  ctx: Context,
  taskDescription: string,
  buildTask: () => Promise<{ prompt: string }>,
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

  // Notify after 30 seconds that the task is still running
  const progressTimer = setTimeout(async () => {
    if (activeTasks.has(taskId)) {
      task.notified = true;
      const otherTasks = activeTasks.size - 1;
      const msg = otherTasks > 0
        ? `Still working on this (+ ${otherTasks} other task${otherTasks > 1 ? "s" : ""} in progress). I'll send the result when it's ready.`
        : "Still working on this — it's a bigger task. I'll send the result when it's ready.";
      await ctx.reply(msg).catch(() => {});
    }
  }, 30_000);

  // Fire and forget — run the task asynchronously
  (async () => {
    try {
      const { prompt } = await buildTask();
      const rawResponse = await callClaude(prompt);

      const response = opts?.postProcess
        ? await opts.postProcess(rawResponse)
        : rawResponse;

      // Orchestrator handled the response internally — skip sending
      if (response === "__SKIP__") return;

      const userId = opts?.userId || ((ctx as any).novaUser as NovaUser)?.id;
      if (userId) {
        await saveMessage("assistant", response, userId);
      }
      await sendResponseWithVoice(ctx, response, userId);
    } catch (error) {
      console.error(`Task ${taskId} error:`, error);
      await ctx.reply("Something went wrong processing that. Check logs for details.").catch(() => {});
    } finally {
      clearTimeout(progressTimer);
      clearInterval(typingInterval);
      activeTasks.delete(taskId);
    }
  })();
}

// ============================================================
// MESSAGE HANDLERS
// ============================================================

// Text messages
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  const user = (ctx as any).novaUser as NovaUser;
  console.log(`Message from ${user.name}: ${text.substring(0, 50)}...`);

  // Handle /voice toggle command
  if (text.trim().toLowerCase() === "/voice") {
    if (!isTTSEnabled()) {
      await ctx.reply(
        "Voice responses are not set up yet. Add ELEVENLABS_API_KEY to .env to enable."
      );
      return;
    }
    const enabled = await toggleVoiceResponses(supabase, user.id);
    await ctx.reply(
      enabled
        ? "Voice mode on. I'll send audio with every reply until you turn it off."
        : "Voice mode off. I'll only send audio when you send me a voice message."
    );
    return;
  }

  // Handle admin commands
  if (text.startsWith("/") && user.role === "admin") {
    const handled = await handleAdminCommand(ctx, text, user);
    if (handled) return;
  }

  await ctx.replyWithChatAction("typing");
  await saveMessage("user", text, user.id);

  orchestrate(ctx, text, user, supabase);
});

// Voice messages
bot.on("message:voice", async (ctx) => {
  const voice = ctx.message.voice;
  const user = (ctx as any).novaUser as NovaUser;
  console.log(`Voice message from ${user.name}: ${voice.duration}s`);
  await ctx.replyWithChatAction("typing");

  if (!process.env.VOICE_PROVIDER) {
    await ctx.reply(
      "Voice transcription is not set up yet. " +
        "Run the setup again and choose a voice provider (Groq or local Whisper)."
    );
    return;
  }

  try {
    const file = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());

    const transcription = await transcribe(buffer);
    if (!transcription) {
      await ctx.reply("Could not transcribe voice message.");
      return;
    }

    await saveMessage("user", `[Voice ${voice.duration}s]: ${transcription}`, user.id);

    runTask(ctx, `Voice: ${transcription.substring(0, 40)}`, async () => {
      const [relevantContext, memoryContext, recentHistory, taskContext] = await Promise.all([
        getRelevantContext(supabase, transcription, user.id),
        getMemoryContext(supabase, user.id),
        getRecentHistory(supabase, user.id),
        getTaskContext(supabase, user.id),
      ]);
      return {
        prompt: buildPrompt(
          user,
          `[Voice message transcribed]: ${transcription}`,
          relevantContext,
          memoryContext,
          recentHistory,
          taskContext
        ),
      };
    }, {
      postProcess: (raw) => processMemoryIntents(supabase, raw, user.id),
    });
  } catch (error) {
    console.error("Voice error:", error);
    await ctx.reply("Could not process voice message. Check logs for details.");
  }
});

// Photos/Images
bot.on("message:photo", async (ctx) => {
  const user = (ctx as any).novaUser as NovaUser;
  console.log(`Image received from ${user.name}`);
  await ctx.replyWithChatAction("typing");

  try {
    // Get highest resolution photo
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);

    // Download the image
    const timestamp = Date.now();
    const filePath = join(UPLOADS_DIR, `image_${timestamp}.jpg`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    const caption = ctx.message.caption || "Analyze this image.";
    const memoryMode = isMemoryIntent(caption);
    await saveMessage("user", `[Image]: ${caption}`, user.id);

    runTask(ctx, `Image: ${caption.substring(0, 40)}`, async () => {
      const [memoryContext, recentHistory, taskContext] = await Promise.all([
        getMemoryContext(supabase, user.id),
        getRecentHistory(supabase, user.id),
        getTaskContext(supabase, user.id),
      ]);
      const contextPrefix = [memoryContext, taskContext, recentHistory].filter(Boolean).join("\n\n");
      const prompt = memoryMode
        ? buildMemoryExtractionPrompt(filePath, `image_${timestamp}.jpg`, caption)
        : (contextPrefix ? contextPrefix + "\n\n" : "") + `[Image: ${filePath}]\n\n${caption}`;
      return { prompt };
    }, {
      postProcess: async (raw) => {
        // Delayed cleanup — keep image for 10 minutes to allow follow-up questions
        setTimeout(() => unlink(filePath).catch(() => {}), 10 * 60 * 1000);
        return processMemoryIntents(supabase, raw, user.id);
      },
    });
  } catch (error) {
    console.error("Image error:", error);
    await ctx.reply("Could not process image.");
  }
});

// Documents
bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  const user = (ctx as any).novaUser as NovaUser;
  console.log(`Document from ${user.name}: ${doc.file_name}`);
  await ctx.replyWithChatAction("typing");

  try {
    const file = await ctx.getFile();
    const timestamp = Date.now();
    // Sanitize filename to prevent path traversal
    const rawName = doc.file_name || `file_${timestamp}`;
    const safeName = basename(rawName).replace(/[^a-zA-Z0-9._-]/g, "_").substring(0, 100);
    const filePath = join(UPLOADS_DIR, `${timestamp}_${safeName}`);
    // Verify path is within UPLOADS_DIR
    if (!resolve(filePath).startsWith(resolve(UPLOADS_DIR))) {
      await ctx.reply("Invalid file name.");
      return;
    }

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    const caption = ctx.message.caption || `Analyze: ${doc.file_name}`;
    const memoryMode = isMemoryIntent(caption);
    await saveMessage("user", `[Document: ${doc.file_name}]: ${caption}`, user.id);

    runTask(ctx, `Doc: ${doc.file_name}`, async () => {
      const [memoryContext, recentHistory, taskContext] = await Promise.all([
        getMemoryContext(supabase, user.id),
        getRecentHistory(supabase, user.id),
        getTaskContext(supabase, user.id),
      ]);
      const contextPrefix = [memoryContext, taskContext, recentHistory].filter(Boolean).join("\n\n");
      const prompt = memoryMode
        ? buildMemoryExtractionPrompt(filePath, doc.file_name || "document", caption)
        : (contextPrefix ? contextPrefix + "\n\n" : "") + `[File: ${filePath}]\n\n${caption}`;
      return { prompt };
    }, {
      postProcess: async (raw) => {
        // Delay cleanup for memory ingestion — Claude may need the file longer
        const delay = memoryMode ? 2 * 60 * 1000 : 0;
        if (delay > 0) {
          setTimeout(() => unlink(filePath).catch(() => {}), delay);
        } else {
          await unlink(filePath).catch(() => {});
        }
        return processMemoryIntents(supabase, raw, user.id);
      },
    });
  } catch (error) {
    console.error("Document error:", error);
    await ctx.reply("Could not process document.");
  }
});

// ============================================================
// HELPERS
// ============================================================

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

function buildPrompt(
  user: NovaUser,
  userMessage: string,
  relevantContext?: string,
  memoryContext?: string,
  recentHistory?: string,
  taskContext?: string
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

  const parts = [
    "You are a personal AI assistant responding via Telegram. Keep responses concise and conversational.",
  ];

  parts.push(`You are speaking with ${user.name}.`);
  parts.push(`Current time: ${timeStr}`);
  if (user.profile_text) parts.push(`\nProfile:\n${user.profile_text}`);
  if (memoryContext) parts.push(`\n${memoryContext}`);
  if (taskContext) parts.push(`\n${taskContext}`);
  if (recentHistory) parts.push(`\n${recentHistory}`);
  if (relevantContext) parts.push(`\n${relevantContext}`);

  parts.push(
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

  parts.push(
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

  parts.push(`\nUser: ${userMessage}`);

  return parts.join("\n");
}

// ============================================================
// ADMIN COMMANDS
// ============================================================

async function handleAdminCommand(ctx: Context, text: string, user: NovaUser): Promise<boolean> {
  if (!supabase) return false;

  const parts = text.trim().split(/\s+/);
  const command = parts[0].toLowerCase();

  if (command === "/adduser") {
    // /adduser <telegram_id> <name> [timezone] [pin]
    const telegramId = parts[1];
    const name = parts[2];
    const timezone = parts[3] || "UTC";
    const pin = parts[4] || null;

    if (!telegramId || !name) {
      await ctx.reply("Usage: /adduser <telegram_id> <name> [timezone] [pin]");
      return true;
    }

    try {
      const row: Record<string, any> = {
        telegram_id: telegramId,
        name,
        timezone,
        role: "member",
      };
      if (pin) row.pin = pin;
      const { error } = await supabase.from("users").insert(row);

      if (error) {
        await ctx.reply(`Failed to add user: ${error.message}`);
      } else {
        invalidateUserCache();
        await ctx.reply(`Added ${name} (${telegramId}) with timezone ${timezone}.`);
      }
    } catch (e: any) {
      await ctx.reply(`Error: ${e.message}`);
    }
    return true;
  }

  if (command === "/removeuser") {
    // /removeuser <telegram_id>
    const telegramId = parts[1];
    if (!telegramId) {
      await ctx.reply("Usage: /removeuser <telegram_id>");
      return true;
    }

    try {
      const { error } = await supabase
        .from("users")
        .update({ active: false, updated_at: new Date().toISOString() })
        .eq("telegram_id", telegramId);

      if (error) {
        await ctx.reply(`Failed to remove user: ${error.message}`);
      } else {
        invalidateUserCache(telegramId);
        await ctx.reply(`Deactivated user ${telegramId}.`);
      }
    } catch (e: any) {
      await ctx.reply(`Error: ${e.message}`);
    }
    return true;
  }

  if (command === "/listusers") {
    try {
      const { data, error } = await supabase
        .from("users")
        .select("telegram_id, name, role, timezone, active")
        .order("created_at");

      if (error || !data?.length) {
        await ctx.reply("No users found.");
        return true;
      }

      const lines = data.map(
        (u: any) =>
          `${u.active ? "●" : "○"} ${u.name} (${u.telegram_id}) — ${u.role}, ${u.timezone}`
      );
      await ctx.reply("Users:\n" + lines.join("\n"));
    } catch (e: any) {
      await ctx.reply(`Error: ${e.message}`);
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

  // Not an admin command — fall through to normal handling
  return false;
}

async function sendResponse(ctx: Context, response: string): Promise<void> {
  // Telegram has a 4096 character limit
  const MAX_LENGTH = 4000;

  if (response.length <= MAX_LENGTH) {
    await ctx.reply(response);
    return;
  }

  // Split long responses
  const chunks = [];
  let remaining = response;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a natural boundary
    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = MAX_LENGTH;

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
}

/**
 * Parse inline button markup from Claude's response.
 * Format: [BUTTONS: Label 1 | Label 2 | Label 3]
 * Each label becomes an inline keyboard button.
 * Returns { text: cleaned response, keyboard: InlineKeyboard | null }
 */
function parseButtons(response: string): { text: string; keyboard: InlineKeyboard | null } {
  const buttonPattern = /\[BUTTONS:\s*(.+?)\]/g;
  let keyboard: InlineKeyboard | null = null;
  let text = response;

  const matches = [...response.matchAll(buttonPattern)];
  if (matches.length > 0) {
    // Use the last button block found
    const match = matches[matches.length - 1];
    const labels = match[1].split("|").map((l) => l.trim()).filter(Boolean);

    if (labels.length > 0) {
      keyboard = new InlineKeyboard();
      // Up to 3 buttons per row
      for (let i = 0; i < labels.length; i++) {
        keyboard.text(labels[i], `btn:${labels[i]}`);
        if ((i + 1) % 3 === 0 && i < labels.length - 1) {
          keyboard.row();
        }
      }
    }

    // Remove all button tags from the text
    text = response.replace(buttonPattern, "").trim();
  }

  return { text, keyboard };
}

async function sendResponseWithVoice(
  ctx: Context,
  response: string,
  userId?: string
): Promise<void> {
  // Parse any inline buttons from the response
  const { text, keyboard } = parseButtons(response);

  // Send text (with keyboard if present)
  if (keyboard) {
    await sendResponseWithButtons(ctx, text, keyboard);
  } else {
    await sendResponse(ctx, text);
  }

  // Send voice ONLY when /voice toggle is on (user explicitly wants all replies as audio).
  if (isTTSEnabled()) {
    const settings = await loadSettings(supabase, userId);
    if (settings.voiceResponses) {
      const audio = await textToSpeech(text);
      if (audio) {
        await ctx.replyWithVoice(new InputFile(audio, "response.ogg"));
      }
    }
  }
}

async function sendResponseWithButtons(
  ctx: Context,
  response: string,
  keyboard: InlineKeyboard
): Promise<void> {
  const MAX_LENGTH = 4000;

  if (response.length <= MAX_LENGTH) {
    await ctx.reply(response, { reply_markup: keyboard });
    return;
  }

  // For long responses, split and put buttons on the last chunk
  const chunks: string[] = [];
  let remaining = response;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
    if (splitIndex === -1 || splitIndex < MAX_LENGTH / 2) {
      splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
    }
    if (splitIndex === -1 || splitIndex < MAX_LENGTH / 2) {
      splitIndex = MAX_LENGTH;
    }
    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  for (let i = 0; i < chunks.length; i++) {
    if (i === chunks.length - 1) {
      await ctx.reply(chunks[i], { reply_markup: keyboard });
    } else {
      await ctx.reply(chunks[i]);
    }
  }
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
});

// ============================================================
// START
// ============================================================

console.log("Starting Nova (multi-user mode)...");
console.log(`Project directory: ${PROJECT_DIR || "(relay working directory)"}`);

bot.start({
  onStart: () => {
    console.log("Bot is running! Users are managed via the 'users' table in Supabase.");
  },
});
