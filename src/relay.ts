/**
 * Claude Code Telegram Relay
 *
 * Minimal relay that connects Telegram to Claude Code CLI.
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
import {
  processMemoryIntents,
  getMemoryContext,
  getRelevantContext,
} from "./memory.ts";
import { textToSpeech, isTTSEnabled } from "./tts.ts";
import { toggleVoiceResponses, loadSettings } from "./settings.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || "";
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");

// Directories
const TEMP_DIR = join(RELAY_DIR, "temp");
const UPLOADS_DIR = join(RELAY_DIR, "uploads");

// Session tracking for conversation continuity
const SESSION_FILE = join(RELAY_DIR, "session.json");

interface SessionState {
  sessionId: string | null;
  lastActivity: string;
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================

async function loadSession(): Promise<SessionState> {
  try {
    const content = await readFile(SESSION_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return { sessionId: null, lastActivity: new Date().toISOString() };
  }
}

async function saveSession(state: SessionState): Promise<void> {
  await writeFile(SESSION_FILE, JSON.stringify(state, null, 2));
}

let session = await loadSession();

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

async function saveMessage(
  role: string,
  content: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from("messages").insert({
      role,
      content,
      channel: "telegram",
      metadata: metadata || {},
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
// SECURITY: Only respond to authorized user
// ============================================================

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id.toString();

  // If ALLOWED_USER_ID is set, enforce it
  if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
    console.log(`Unauthorized: ${userId}`);
    await ctx.reply("This bot is private.");
    return;
  }

  await next();
});

// ============================================================
// INLINE BUTTON CALLBACKS
// ============================================================

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;

  // Handle button presses — format is "btn:Label Text"
  if (data.startsWith("btn:")) {
    const selection = data.substring(4);
    console.log(`Button pressed: ${selection}`);

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
    await saveMessage("user", selection);

    await ctx.replyWithChatAction("typing");

    runTask(ctx, `Button: ${selection.substring(0, 40)}`, async () => {
      const [relevantContext, memoryContext] = await Promise.all([
        getRelevantContext(supabase, selection),
        getMemoryContext(supabase),
      ]);
      return {
        prompt: buildPrompt(
          `[Button selected in response to a question]: ${selection}`,
          relevantContext,
          memoryContext
        ),
        resume: true,
      };
    }, {
      postProcess: (raw) => processMemoryIntents(supabase, raw),
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

async function callClaude(
  prompt: string,
  options?: { resume?: boolean; imagePath?: string }
): Promise<string> {
  const args = [CLAUDE_PATH, "-p", prompt];

  // Only resume if no other tasks are running (avoid session conflicts)
  if (options?.resume && session.sessionId && activeTasks.size === 0) {
    args.push("--resume", session.sessionId);
  }

  args.push("--output-format", "text", "--permission-mode", "bypassPermissions");

  console.log(`Calling Claude: ${prompt.substring(0, 50)}...`);

  try {
    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR || undefined,
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

    // Extract session ID from output if present (for --resume)
    const sessionMatch = output.match(/Session ID: ([a-f0-9-]+)/i);
    if (sessionMatch) {
      session.sessionId = sessionMatch[1];
      session.lastActivity = new Date().toISOString();
      await saveSession(session);
    }

    return output.trim();
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
  buildTask: () => Promise<{ prompt: string; resume: boolean }>,
  opts?: { postProcess?: (response: string) => Promise<string>; forceAudio?: boolean }
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
      const { prompt, resume } = await buildTask();
      const rawResponse = await callClaude(prompt, { resume });

      const response = opts?.postProcess
        ? await opts.postProcess(rawResponse)
        : rawResponse;

      await saveMessage("assistant", response);
      await sendResponseWithVoice(ctx, response, opts?.forceAudio);
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
  console.log(`Message: ${text.substring(0, 50)}...`);

  // Handle /voice toggle command — enables "always voice" mode (e.g., when user can't read)
  if (text.trim().toLowerCase() === "/voice") {
    if (!isTTSEnabled()) {
      await ctx.reply(
        "Voice responses are not set up yet. Add ELEVENLABS_API_KEY to .env to enable."
      );
      return;
    }
    const enabled = await toggleVoiceResponses();
    await ctx.reply(
      enabled
        ? "Voice mode on. I'll send audio with every reply until you turn it off."
        : "Voice mode off. I'll only send audio when you send me a voice message."
    );
    return;
  }

  await ctx.replyWithChatAction("typing");
  await saveMessage("user", text);

  runTask(ctx, text.substring(0, 50), async () => {
    const [relevantContext, memoryContext] = await Promise.all([
      getRelevantContext(supabase, text),
      getMemoryContext(supabase),
    ]);
    return {
      prompt: buildPrompt(text, relevantContext, memoryContext),
      resume: true,
    };
  }, {
    postProcess: (raw) => processMemoryIntents(supabase, raw),
  });
});

// Voice messages
bot.on("message:voice", async (ctx) => {
  const voice = ctx.message.voice;
  console.log(`Voice message: ${voice.duration}s`);
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

    await saveMessage("user", `[Voice ${voice.duration}s]: ${transcription}`);

    runTask(ctx, `Voice: ${transcription.substring(0, 40)}`, async () => {
      const [relevantContext, memoryContext] = await Promise.all([
        getRelevantContext(supabase, transcription),
        getMemoryContext(supabase),
      ]);
      return {
        prompt: buildPrompt(
          `[Voice message transcribed]: ${transcription}`,
          relevantContext,
          memoryContext
        ),
        resume: true,
      };
    }, {
      postProcess: (raw) => processMemoryIntents(supabase, raw),
      forceAudio: true,
    });
  } catch (error) {
    console.error("Voice error:", error);
    await ctx.reply("Could not process voice message. Check logs for details.");
  }
});

// Photos/Images
bot.on("message:photo", async (ctx) => {
  console.log("Image received");
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
    await saveMessage("user", `[Image]: ${caption}`);

    runTask(ctx, `Image: ${caption.substring(0, 40)}`, async () => {
      return {
        prompt: `[Image: ${filePath}]\n\n${caption}`,
        resume: true,
      };
    }, {
      postProcess: async (raw) => {
        // Delayed cleanup — keep image for 10 minutes to allow follow-up questions
        setTimeout(() => unlink(filePath).catch(() => {}), 10 * 60 * 1000);
        return processMemoryIntents(supabase, raw);
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
  console.log(`Document: ${doc.file_name}`);
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
    await saveMessage("user", `[Document: ${doc.file_name}]: ${caption}`);

    runTask(ctx, `Doc: ${doc.file_name}`, async () => {
      return {
        prompt: `[File: ${filePath}]\n\n${caption}`,
        resume: true,
      };
    }, {
      postProcess: async (raw) => {
        await unlink(filePath).catch(() => {});
        return processMemoryIntents(supabase, raw);
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

// Load profile once at startup
let profileContext = "";
try {
  profileContext = await readFile(join(PROJECT_ROOT, "config", "profile.md"), "utf-8");
} catch {
  // No profile yet — that's fine
}

const USER_NAME = process.env.USER_NAME || "";
const USER_TIMEZONE = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

function buildPrompt(
  userMessage: string,
  relevantContext?: string,
  memoryContext?: string
): string {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: USER_TIMEZONE,
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

  if (USER_NAME) parts.push(`You are speaking with ${USER_NAME}.`);
  parts.push(`Current time: ${timeStr}`);
  if (profileContext) parts.push(`\nProfile:\n${profileContext}`);
  if (memoryContext) parts.push(`\n${memoryContext}`);
  if (relevantContext) parts.push(`\n${relevantContext}`);

  parts.push(
    "\nMEMORY MANAGEMENT:" +
      "\nWhen the user shares something worth remembering, sets goals, or completes goals, " +
      "include these tags in your response (they are processed automatically and hidden from the user):" +
      "\n[REMEMBER: fact to store]" +
      "\n[GOAL: goal text | DEADLINE: optional date]" +
      "\n[DONE: search text for completed goal]"
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
      "\n• Phone Calls & SMS (Twilio + ElevenLabs): Make voice calls and send text messages." +
      `\n  - DJ's phone: ${process.env.USER_PHONE || "+18636047056"}. Use this when DJ says "call me", "text me", or when something is urgent enough to warrant a call.` +
      `\n  - SMS: Run \`bun run ${PROJECT_ROOT}/src/twilio.ts sms "${process.env.USER_PHONE || "+18636047056"}" "message"\`` +
      `\n  - Call: Run \`bun run ${PROJECT_ROOT}/src/twilio.ts call "${process.env.USER_PHONE || "+18636047056"}" "detailed context about why you're calling and what to discuss"\`` +
      "\n  - Calls connect via Twilio, with Nova's voice powered by ElevenLabs. Nova will have a multi-turn voice conversation with DJ on the phone." +
      "\n  - The call context you provide becomes Nova's briefing for the call. Include ALL relevant details, memory, and context so Nova can have an informed conversation." +
      "\n  - Nova authenticates DJ with a PIN before discussing anything." +
      "\n  - PROACTIVE CALLS: If something is genuinely urgent (time-sensitive deadline, important update DJ needs to act on NOW), you should proactively call DJ rather than waiting for him to check Telegram." +
      "\n  - You can also call/text other numbers if DJ asks you to." +
      "\n• Square: Query orders and transactions by date range, view payment history, check account balances, create payment links, manage customers and catalog items." +
      "\n  - LOCATIONS: Open Source Mind (Main) ID: LA50ZWAK48MD8 | Zaarvy AI ID: LNCSX2ST6EKCY" +
      "\n  - REPORTS/QUERIES: Always include BOTH locations and show results per-location plus a combined total." +
      "\n  - WRITE OPERATIONS (create payment links, create payments, etc.): Always ask " + USER_NAME + " which location to use BEFORE executing." +
      "\n• Cloudflare: Manage DNS records (create/update/delete subdomains and records), deploy and manage Cloudflare Workers." +
      "\n• Task Scheduler: Create, list, and manage recurring scheduled tasks." +
      `\n  - List tasks: \`bun run ${PROJECT_ROOT}/src/scheduler.ts list\`` +
      `\n  - Create: \`bun run ${PROJECT_ROOT}/src/scheduler.ts create "<name>" "<schedule>" "<command>"\`` +
      `\n  - Delete: \`bun run ${PROJECT_ROOT}/src/scheduler.ts delete "<name>"\`` +
      `\n  - Run now: \`bun run ${PROJECT_ROOT}/src/scheduler.ts run-once "<name>"\`` +
      "\n  - Schedule formats: daily:HH:MM, weekdays:HH:MM, weekly:DAY:HH:MM (0=Sun), interval:SECONDS, hourly:MM" +
      `\n  - Example: \`bun run ${PROJECT_ROOT}/src/scheduler.ts create "weekly-metrics" "weekly:1:09:00" "bun run examples/smart-checkin.ts"\`` +
      "\n  - Use this when " + USER_NAME + " asks for recurring reminders, periodic reports, or scheduled checks." +
      "\n• File System: You can read, write, and manage files on the user's computer." +
      "\n• Terminal: You can run any shell command the user needs." +
      "\n" +
      "\nUse the right tool for the job. If the user asks to send an email, use Gmail. If they ask to check their schedule, use Calendar. " +
      "If they ask to call or text someone, use Twilio. Always confirm before taking consequential actions (sending emails, making calls, etc.)." +
      "\n" +
      "\nRESPONSE PROTOCOL:" +
      "\n" + USER_NAME + " can send you multiple requests at once — you handle them in parallel." +
      "\nJust do the work and deliver results. Keep responses focused and actionable." +
      "\nWhen a task involves creating a file that " + USER_NAME + " needs, use the /telegram-file-sender skill to send it directly." +
      "\n" +
      "\nINLINE BUTTONS — Use buttons when asking for confirmation, selection, or quick input:" +
      "\nWhen you need " + USER_NAME + " to choose between options, confirm an action, or approve something, " +
      "add a button tag at the end of your message:" +
      "\n  [BUTTONS: Option A | Option B | Option C]" +
      "\nThis renders as tappable buttons in Telegram — much faster than typing." +
      "\nExamples:" +
      "\n  - Confirming an action: 'Ready to send the email?' [BUTTONS: Send it | Cancel]" +
      "\n  - Choosing a location: 'Which Square location?' [BUTTONS: Open Source Mind | Zaarvy AI | Both]" +
      "\n  - Yes/No: 'Should I proceed?' [BUTTONS: Yes | No]" +
      "\n  - Multiple options: 'Which format?' [BUTTONS: PDF | DOCX | PPTX | XLSX]" +
      "\nKeep labels short (1-3 words). Max 6 buttons. The tag is hidden from the user — they only see the buttons." +
      "\nUse buttons whenever you would otherwise ask " + USER_NAME + " to type a simple choice."
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
      "\n• /skill-creator — Create new skills to extend your own capabilities. Use this when " + USER_NAME + " asks you to create a skill, or when you detect a recurring task that should become one." +
      "\n• /telegram-file-sender — Send files as document attachments via Telegram. Use when " + USER_NAME + " asks you to send, share, or deliver any file."
  );

  parts.push(
    "\nSELF-IMPROVEMENT — You learn and evolve over time:" +
      "\nYou can improve yourself by detecting patterns and creating reusable skills." +
      "\n" +
      "\n• PATTERN DETECTION: When you notice " + USER_NAME + " repeatedly asks you to do the same kind of task " +
      "(e.g., 'research X and summarize', 'format data as Y', 'draft email in Z style'), note the pattern." +
      "\n• SKILL CREATION: When you detect a recurring workflow or " + USER_NAME + " asks you to create a skill, " +
      "use the /skill-creator skill to build it. Skills are your preferred way to package repeatable workflows — " +
      "they're more powerful than raw slash commands and include proper structure, tool access, and documentation." +
      "\n• PROFILE UPDATES: When you learn new preferences, habits, or context about " + USER_NAME + " that would help future interactions, " +
      "update `config/profile.md` to reflect this. Examples: communication preferences, common contacts, project names, recurring meetings." +
      "\n• MEMORY TAGS: Continue using [REMEMBER: ...] tags for facts and context. Use [GOAL: ...] and [DONE: ...] for goal tracking." +
      "\n• PROACTIVE SUGGESTIONS: If you see an opportunity to automate something " + USER_NAME + " does manually, suggest creating a skill for it."
  );

  parts.push(`\nUser: ${userMessage}`);

  return parts.join("\n");
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
  forceAudio: boolean = false
): Promise<void> {
  // Parse any inline buttons from the response
  const { text, keyboard } = parseButtons(response);

  // Send text (with keyboard if present)
  if (keyboard) {
    await sendResponseWithButtons(ctx, text, keyboard);
  } else {
    await sendResponse(ctx, text);
  }

  // Send voice only when:
  // 1. forceAudio = true (user sent a voice message, so reply with voice)
  // 2. /voice toggle is on (user said they can't read / wants all voice)
  if (isTTSEnabled()) {
    const settings = await loadSettings();
    if (forceAudio || settings.voiceResponses) {
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
// START
// ============================================================

console.log("Starting Claude Telegram Relay...");
console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
console.log(`Project directory: ${PROJECT_DIR || "(relay working directory)"}`);

bot.start({
  onStart: () => {
    console.log("Bot is running!");
  },
});
