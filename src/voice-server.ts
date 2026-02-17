#!/usr/bin/env bun
/**
 * Voice Server — Twilio + ElevenLabs + Claude
 *
 * Standalone HTTP server that handles voice calls via Twilio webhooks.
 * Twilio captures speech, Claude generates responses, ElevenLabs converts to audio.
 *
 * Run: bun run src/voice-server.ts
 */

import "dotenv/config";
import { spawn } from "bun";
import { readFile, unlink, mkdir } from "fs/promises";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { createHmac, timingSafeEqual } from "crypto";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { textToSpeech } from "./tts.ts";

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = dirname(dirname(__filename));

// ============================================================
// CONFIGURATION
// ============================================================

const PORT = parseInt(process.env.VOICE_SERVER_PORT || "80");
const VOICE_SERVER_URL = process.env.VOICE_SERVER_URL || "https://nova.1osm.com";
const FALLBACK_PIN = process.env.USER_PIN || "852185";
const FALLBACK_PHONE = process.env.USER_PHONE || "+18636047056";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || "";
const FALLBACK_USER_NAME = process.env.USER_NAME || "DJ";
const FALLBACK_USER_TIMEZONE = process.env.USER_TIMEZONE || "America/New_York";
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".nova");
const CALL_CONTEXTS_DIR = join(RELAY_DIR, "call-contexts");

// Audio files stored in /tmp with cleanup
const AUDIO_DIR = "/tmp/nova-voice-audio";

// Supabase (optional)
const supabase: SupabaseClient | null =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

// ============================================================
// MULTI-USER: Resolve caller by phone number
// ============================================================

interface CallUser {
  id: string;
  name: string;
  phone: string;
  pin: string;
  timezone: string;
  telegram_id: string;
  profile_text: string;
}

const phoneUserCache = new Map<string, CallUser | null>();

async function resolveUserByPhone(phone: string): Promise<CallUser | null> {
  const cached = phoneUserCache.get(phone);
  if (cached !== undefined) return cached;

  if (!supabase) {
    // Fallback to env vars for single-user mode
    if (phone === FALLBACK_PHONE) {
      const fallback: CallUser = {
        id: "",
        name: FALLBACK_USER_NAME,
        phone: FALLBACK_PHONE,
        pin: FALLBACK_PIN,
        timezone: FALLBACK_USER_TIMEZONE,
        telegram_id: process.env.TELEGRAM_USER_ID || "",
        profile_text: "",
      };
      phoneUserCache.set(phone, fallback);
      return fallback;
    }
    phoneUserCache.set(phone, null);
    return null;
  }

  try {
    const { data, error } = await supabase.rpc("get_user_by_phone", { p_phone: phone });
    if (error || !data?.length) {
      phoneUserCache.set(phone, null);
      return null;
    }
    const row = data[0];
    const user: CallUser = {
      id: row.id,
      name: row.name,
      phone: row.phone || "",
      pin: row.pin || "",
      timezone: row.timezone || "UTC",
      telegram_id: row.telegram_id || "",
      profile_text: row.profile_text || "",
    };
    phoneUserCache.set(phone, user);
    return user;
  } catch (error) {
    console.error("Phone user resolution error:", error);
    phoneUserCache.set(phone, null);
    return null;
  }
}

// ============================================================
// SECURITY
// ============================================================

// Twilio webhook signature verification
function verifyTwilioSignature(url: string, params: Record<string, string>, signature: string): boolean {
  if (!TWILIO_AUTH_TOKEN) return false;

  // Build the data string: URL + sorted params concatenated
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }

  const expected = createHmac("sha1", TWILIO_AUTH_TOKEN).update(data).digest("base64");

  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Audio file access tokens — short-lived HMAC tokens so only Twilio can fetch audio
const AUDIO_TOKEN_SECRET = process.env.AUDIO_TOKEN_SECRET || crypto.randomUUID();

function generateAudioToken(audioId: string): string {
  return createHmac("sha256", AUDIO_TOKEN_SECRET).update(audioId).digest("hex").substring(0, 16);
}

function verifyAudioToken(audioId: string, token: string): boolean {
  const expected = generateAudioToken(audioId);
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    return false;
  }
}

function audioUrl(id: string): string {
  return `${VOICE_SERVER_URL}/audio/${id}?token=${generateAudioToken(id)}`;
}

// Global PIN rate limiting — prevents brute force across multiple calls
const pinRateLimit = {
  failedAttempts: 0,
  lastFailure: 0,
  lockedUntil: 0,
};

const PIN_LOCKOUT_DURATION = 5 * 60 * 1000; // 5 min lockout after too many failures
const PIN_MAX_GLOBAL_FAILURES = 6; // 6 failures across all calls → lockout

function isPinLocked(): boolean {
  if (pinRateLimit.lockedUntil > Date.now()) return true;
  // Reset counter after 10 minutes of no failures
  if (Date.now() - pinRateLimit.lastFailure > 10 * 60 * 1000) {
    pinRateLimit.failedAttempts = 0;
  }
  return false;
}

function recordPinFailure(): void {
  pinRateLimit.failedAttempts++;
  pinRateLimit.lastFailure = Date.now();
  if (pinRateLimit.failedAttempts >= PIN_MAX_GLOBAL_FAILURES) {
    pinRateLimit.lockedUntil = Date.now() + PIN_LOCKOUT_DURATION;
    console.warn(`PIN LOCKED OUT until ${new Date(pinRateLimit.lockedUntil).toISOString()} after ${pinRateLimit.failedAttempts} failures`);
  }
}

function recordPinSuccess(): void {
  pinRateLimit.failedAttempts = 0;
  pinRateLimit.lockedUntil = 0;
}

// Sanitize speech transcription to prevent prompt injection
function sanitizeSpeechInput(text: string): string {
  // Strip patterns that could manipulate memory system
  let sanitized = text
    .replace(/\[REMEMBER:[^\]]*\]/gi, "")
    .replace(/\[GOAL:[^\]]*\]/gi, "")
    .replace(/\[DONE:[^\]]*\]/gi, "")
    // Strip system/assistant role injection attempts
    .replace(/^(system|assistant|human)\s*:/gim, "")
    // Strip XML/HTML tags that could interfere with TwiML or prompts
    .replace(/<[^>]*>/g, "");
  return sanitized.trim();
}

// ============================================================
// IN-MEMORY STATE
// ============================================================

// Per-call conversation history
interface CallState {
  turns: { role: string; content: string }[];
  authenticated: boolean;
  pinAttempts: number;
  context?: string; // For outgoing calls
  createdAt: number;
  lastActivity: number;
  user?: CallUser; // Resolved caller
}

const activeCalls = new Map<string, CallState>();

// TTL cleanup — evict stale call states every 5 minutes
const CALL_STATE_MAX_AGE = 30 * 60 * 1000; // 30 minutes max
const CALL_STATE_IDLE_TIMEOUT = 10 * 60 * 1000; // 10 min idle

setInterval(() => {
  const now = Date.now();
  let evicted = 0;
  for (const [callSid, state] of activeCalls) {
    if (now - state.createdAt > CALL_STATE_MAX_AGE || now - state.lastActivity > CALL_STATE_IDLE_TIMEOUT) {
      if (state.authenticated && state.turns.length > 0) {
        const snapshot = { ...state, turns: [...state.turns] };
        processPostCallTasks(callSid, snapshot).catch(() => {});
      }
      activeCalls.delete(callSid);
      evicted++;
    }
  }
  if (evicted > 0) console.log(`TTL cleanup: evicted ${evicted} stale call state(s)`);
}, 5 * 60 * 1000);

// ============================================================
// HELPERS
// ============================================================

await mkdir(AUDIO_DIR, { recursive: true });
await mkdir(CALL_CONTEXTS_DIR, { recursive: true });

async function loadProfile(): Promise<string> {
  try {
    return await readFile(join(PROJECT_ROOT, "config", "profile.md"), "utf-8");
  } catch {
    return "";
  }
}

const profile = await loadProfile();

function getTimeStr(timezone?: string): string {
  return new Date().toLocaleString("en-US", {
    timeZone: timezone || FALLBACK_USER_TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildVoiceSystemPrompt(callContext?: string, callUser?: CallUser): string {
  const userName = callUser?.name || FALLBACK_USER_NAME;
  const userTimezone = callUser?.timezone || FALLBACK_USER_TIMEZONE;
  const userProfile = callUser?.profile_text || profile;
  return `You are Nova, ${userName}'s personal AI assistant, on a live phone call.

VOICE CALL PROTOCOL:
- You are on a real-time voice call — speak naturally and conversationally
- Keep responses concise — this is a phone call, not a text chat
- Match ${userName}'s casual, no-fluff communication style
- If you don't understand something, ask them to repeat

NUMBERS & FORMATTING FOR SPEECH:
- Phone numbers: read digit by digit with pauses (e.g., "8-6-3, 6-0-4, 7-0-5-6")
- Dates: full spoken form (e.g., "February fifteenth, twenty twenty-six")
- Times: natural speech (e.g., "ten thirty AM")
- URLs: spell out clearly (e.g., "google dot com slash calendar")
- Never use markdown, asterisks, bullet points, or other text formatting — this is speech

${callContext ? `CONTEXT FOR THIS CALL:\n${callContext}\n` : ""}
CURRENT TIME: ${getTimeStr(userTimezone)}

${userProfile ? `ABOUT ${userName}:\n${userProfile}` : ""}

YOUR INTEGRATIONS — what you actually have access to (via Telegram, not during this call):
- Gmail & Google Calendar: Read, search, draft, send emails. View, create, update calendar events.
- Notion: Search pages, read content, create and update pages and databases.
- Zoom: Create, update, delete meetings. Get details and recordings.
- Web Browser (Playwright): Navigate URLs, take screenshots, fill forms, click buttons.
- Web Search: Built-in web search for current events and information.
- Apple Notes: Read and create notes.
- Apple Contacts: Search and look up contacts (synced via iCloud).
- Phone Calls & SMS (Twilio): Make calls and send texts.
- Square: Query orders/transactions, view payments, check balances, create payment links. Locations: Open Source Mind (LA50ZWAK48MD8) and Zaarvy AI (LNCSX2ST6EKCY). Reports cover both locations; write operations require confirming the location first.
- Cloudflare: Manage DNS records (create subdomains, update records), deploy and manage Workers.
- Task Scheduler: Create recurring scheduled tasks (daily, weekly, hourly, interval-based).
- File System & Terminal: Read, write, manage files and run shell commands.

IMPORTANT: Only mention integrations listed above. Do NOT make up or assume integrations you don't have (no Netlify, no Slack, no Trello, etc.). If ${userName} asks about something not listed, say you don't have that one set up.

During this phone call, you cannot execute these tools directly — but you WILL execute them automatically after the call ends.

TASK TRACKING:
When ${userName} asks you to do something actionable (send an email, check calendar, look something up, create a Notion page, etc.), acknowledge it and confirm you'll handle it after the call. These tasks are automatically extracted from the conversation transcript when the call ends and executed.
- If ${userName} says something is URGENT, acknowledge the urgency. Urgent tasks get priority execution and ${userName} will be notified via SMS and follow-up call if needed.
- You don't need to use special tags — just have a natural conversation. The system extracts tasks from the full transcript.

SKILLS — You also have specialized skills available (via Telegram, not during the call):
- Design creation (posters, visual art)
- Competitor ad analysis
- Content research & writing with citations
- Document creation/editing (Word, PDF, PowerPoint, spreadsheets)
- File organization and cleanup
- Book ghostwriting from transcriptions
- Lead research for business development
- SaaS platform generation
- Google NotebookLM queries
If ${userName} mentions needing any of these, note it as a task to handle after the call.

SELF-IMPROVEMENT:
You learn from every interaction. If ${userName} describes a recurring task or workflow during the call, or asks you to create a skill, note it as a task. After the call, you'll use /skill-creator to build reusable skills that automate repetitive workflows.

PERSONALITY:
- You're Nova — confident, direct, helpful
- Brief and casual by default, more detail when needed
- You're ${userName}'s trusted assistant — act like it`;
}

async function callClaude(prompt: string): Promise<string> {
  const args = [CLAUDE_PATH, "-p", prompt, "--output-format", "text", "--permission-mode", "bypassPermissions"];

  try {
    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      // Run from the relay project dir so Claude picks up .mcp.json (Google Workspace, Notion, etc.)
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        CLAUDECODE: undefined,
        // Pass PROJECT_DIR so Claude can still access user's files
        PROJECT_DIR: PROJECT_DIR || undefined,
      },
    });

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error("Claude error:", stderr);
      return "I'm having trouble thinking right now. Can you say that again?";
    }

    return output.trim();
  } catch (error) {
    console.error("Claude spawn error:", error);
    return "I'm having trouble processing that. Let me try again.";
  }
}

async function generateAudio(text: string): Promise<string | null> {
  const audio = await textToSpeech(text);
  if (!audio) return null;

  const id = crypto.randomUUID();
  const filePath = join(AUDIO_DIR, `${id}.mp3`);
  await Bun.write(filePath, audio);

  // Cleanup after 60 seconds
  setTimeout(() => unlink(filePath).catch(() => {}), 60_000);

  return id;
}

async function saveCallMessage(role: string, content: string, callSid?: string, userId?: string): Promise<void> {
  if (!supabase) return;
  try {
    const row: Record<string, any> = {
      role,
      content,
      channel: "phone",
      metadata: { callSid },
    };
    if (userId) row.user_id = userId;
    await supabase.from("messages").insert(row);
  } catch (error) {
    console.error("Supabase save error:", error);
  }
}

// ============================================================
// TELEGRAM & SMS (direct API for post-call notifications)
// ============================================================

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID || "";
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || "";

async function sendTelegramNotification(text: string, chatId?: string): Promise<void> {
  const targetChatId = chatId || TELEGRAM_USER_ID;
  if (!TELEGRAM_BOT_TOKEN || !targetChatId) {
    console.error("Telegram not configured — skipping notification");
    return;
  }
  try {
    // Split long messages (Telegram 4096 char limit)
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= 4000) { chunks.push(remaining); break; }
      let i = remaining.lastIndexOf("\n\n", 4000);
      if (i === -1) i = remaining.lastIndexOf("\n", 4000);
      if (i === -1) i = 4000;
      chunks.push(remaining.substring(0, i));
      remaining = remaining.substring(i).trim();
    }
    for (const chunk of chunks) {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: targetChatId, text: chunk }),
      });
    }
  } catch (error) {
    console.error("Telegram send error:", error);
  }
}

async function sendSMS(text: string, toPhone?: string): Promise<void> {
  const targetPhone = toPhone || FALLBACK_PHONE;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER || !targetPhone) {
    console.error("Twilio not configured — skipping SMS");
    return;
  }
  try {
    const auth = "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: targetPhone, From: TWILIO_PHONE_NUMBER, Body: text }),
    });
  } catch (error) {
    console.error("SMS send error:", error);
  }
}

async function makeFollowUpCall(context: string, toPhone?: string): Promise<void> {
  const targetPhone = toPhone || FALLBACK_PHONE;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER || !targetPhone) return;
  try {
    const auth = "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls.json`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        To: targetPhone,
        From: TWILIO_PHONE_NUMBER,
        Url: `${VOICE_SERVER_URL}/voice/outgoing`,
        Method: "POST",
        StatusCallback: `${VOICE_SERVER_URL}/voice/status`,
        StatusCallbackMethod: "POST",
      }),
    });
    const data = await resp.json();
    if (data.sid) {
      // Save context for the follow-up call
      await mkdir(CALL_CONTEXTS_DIR, { recursive: true });
      const contextPath = join(CALL_CONTEXTS_DIR, `${data.sid}.json`);
      await Bun.write(contextPath, JSON.stringify({ context, to: targetPhone, timestamp: new Date().toISOString() }));
      console.log(`Follow-up call initiated: ${data.sid}`);
    }
  } catch (error) {
    console.error("Follow-up call error:", error);
  }
}

// Track urgent task acknowledgments
const pendingUrgentAcks = new Map<string, ReturnType<typeof setTimeout>>();

// ============================================================
// POST-CALL TASK PROCESSING
// ============================================================

interface ExtractedTask {
  task: string;
  urgent: boolean;
}

async function extractTasksFromTranscript(turns: { role: string; content: string }[], userName: string): Promise<ExtractedTask[]> {
  const transcript = turns
    .map((t) => `${t.role === "user" ? userName : "Nova"}: ${t.content}`)
    .join("\n");

  const prompt = `Analyze this phone call transcript between ${userName} and Nova (AI assistant).

Extract ALL actionable tasks that ${userName} asked Nova to do. These are things Nova agreed to handle after the call — things that require using tools (email, calendar, Notion, web search, etc.).

Do NOT include:
- Things already discussed/resolved during the call
- General conversation or opinions
- Things ${userName} said they would do themselves

For each task, determine if it was marked as URGENT by ${userName} (they explicitly said it's urgent, time-sensitive, needs to happen right away, etc.).

Return ONLY a JSON array. No other text. Example:
[{"task": "Send email to John about the meeting tomorrow", "urgent": false}, {"task": "Check Google Calendar for Friday availability", "urgent": true}]

If there are no actionable tasks, return: []

TRANSCRIPT:
${transcript}`;

  const response = await callClaude(prompt);

  try {
    // Extract JSON from response (Claude might wrap it in markdown)
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    return JSON.parse(jsonMatch[0]);
  } catch (error) {
    console.error("Task extraction parse error:", error, "Response:", response);
    return [];
  }
}

async function executeTask(task: ExtractedTask, userName: string): Promise<string> {
  const prompt = `You are Nova, ${userName}'s AI assistant. ${userName} asked you to do the following during a phone call. Now execute it using your available tools.

TASK: ${task.task}
${task.urgent ? "PRIORITY: URGENT — handle this immediately and thoroughly." : ""}

Execute the task and return a brief summary of what you did and the result. Be concise — this will be sent as a notification to ${userName}.`;

  return await callClaude(prompt);
}

async function processPostCallTasks(callSid: string, state: CallState): Promise<void> {
  if (state.turns.length === 0) return;

  const userName = state.user?.name || FALLBACK_USER_NAME;
  const userTelegramId = state.user?.telegram_id || TELEGRAM_USER_ID;
  const userPhone = state.user?.phone || FALLBACK_PHONE;
  const userId = state.user?.id;

  console.log(`Processing post-call tasks for ${callSid} (${state.turns.length} turns, user: ${userName})`);

  const tasks = await extractTasksFromTranscript(state.turns, userName);

  if (tasks.length === 0) {
    console.log(`No tasks extracted from call ${callSid}`);
    return;
  }

  console.log(`Extracted ${tasks.length} task(s) from call ${callSid}:`, tasks.map(t => t.task));

  await sendTelegramNotification(`📞 Call ended — working on ${tasks.length} task${tasks.length > 1 ? "s" : ""} from our conversation...`, userTelegramId);

  for (const task of tasks) {
    console.log(`Executing task: "${task.task}" (urgent: ${task.urgent})`);

    try {
      const result = await executeTask(task, userName);
      const label = task.urgent ? "🚨 URGENT TASK COMPLETE" : "✅ Task complete";
      const message = `${label}\n\nTask: ${task.task}\n\nResult: ${result}`;

      // Always send to Telegram
      await sendTelegramNotification(message, userTelegramId);
      await saveCallMessage("assistant", `[Post-call task]: ${task.task}\n[Result]: ${result}`, callSid, userId);

      // Urgent tasks: also SMS + 15-min follow-up call if no ack
      if (task.urgent) {
        const smsText = `URGENT task done: ${task.task}\n\nResult: ${result.substring(0, 300)}${result.length > 300 ? "..." : ""}\n\nReply OK to acknowledge.`;
        await sendSMS(smsText, userPhone);
        console.log(`Urgent SMS sent for task: "${task.task}"`);

        // Set 15-min timer for follow-up call
        const ackKey = `${callSid}-${task.task.substring(0, 50)}`;
        const timer = setTimeout(async () => {
          pendingUrgentAcks.delete(ackKey);
          console.log(`No ack for urgent task after 15 min, calling ${userName}: "${task.task}"`);
          await makeFollowUpCall(
            `You completed an urgent task for ${userName} 15 minutes ago but they haven't acknowledged it. ` +
            `Task: ${task.task}\nResult: ${result}\n\n` +
            `Call them to make sure they saw the update and check if they need anything else.`,
            userPhone
          );
        }, 15 * 60 * 1000);

        pendingUrgentAcks.set(ackKey, timer);
      }
    } catch (error) {
      console.error(`Task execution error for "${task.task}":`, error);
      await sendTelegramNotification(`❌ Failed to complete task: ${task.task}\n\nError: ${error}`, userTelegramId);
    }
  }
}

function getCallState(callSid: string): CallState {
  if (!activeCalls.has(callSid)) {
    activeCalls.set(callSid, {
      turns: [],
      authenticated: false,
      pinAttempts: 0,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    });
  }
  const state = activeCalls.get(callSid)!;
  state.lastActivity = Date.now();
  return state;
}

function parseFormBody(body: string): Record<string, string> {
  const params = new URLSearchParams(body);
  const result: Record<string, string> = {};
  for (const [key, value] of params) {
    result[key] = value;
  }
  return result;
}

function twiml(content: string): Response {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Response>${content}</Response>`,
    { headers: { "Content-Type": "application/xml" } }
  );
}

function gatherSpeech(actionUrl: string, prompt: string, options?: { numDigits?: number; timeout?: number; redirectUrl?: string }): string {
  const escaped = prompt.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const timeout = options?.timeout || 10;
  const numDigits = options?.numDigits ? ` numDigits="${options.numDigits}"` : "";
  const redirect = options?.redirectUrl ? `<Redirect method="POST">${options.redirectUrl}</Redirect>` : "";
  return `<Gather input="speech dtmf" action="${actionUrl}" method="POST" timeout="${timeout}" speechTimeout="auto"${numDigits}><Say voice="Polly.Joanna">${escaped}</Say></Gather>${redirect}`;
}

async function gatherWithAudio(actionUrl: string, text: string, options?: { numDigits?: number; timeout?: number; redirectUrl?: string }): Promise<string> {
  const timeout = options?.timeout || 10;
  const numDigits = options?.numDigits ? ` numDigits="${options.numDigits}"` : "";
  const redirect = options?.redirectUrl ? `<Redirect method="POST">${options.redirectUrl}</Redirect>` : "";
  const audioId = await generateAudio(text);
  if (audioId) {
    return `<Gather input="speech dtmf" action="${actionUrl}" method="POST" timeout="${timeout}" speechTimeout="auto"${numDigits}><Play>${audioUrl(audioId)}</Play></Gather>${redirect}`;
  }
  // Fallback to Twilio TTS
  return gatherSpeech(actionUrl, text, options);
}

async function playAndGather(actionUrl: string, text: string): Promise<string> {
  // Conversation gathers redirect back to gather on timeout so the call stays alive
  return await gatherWithAudio(actionUrl, text, { redirectUrl: `${VOICE_SERVER_URL}/voice/gather` });
}

// ============================================================
// ROUTE HANDLERS
// ============================================================

async function handleIncoming(body: string): Promise<Response> {
  const params = parseFormBody(body);
  const callSid = params.CallSid || "unknown";
  const from = params.From || "unknown";

  console.log(`Incoming call from ${from} (${callSid})`);
  const state = getCallState(callSid);

  // Resolve caller by phone number
  const callUser = await resolveUserByPhone(from);
  if (callUser) {
    state.user = callUser;
    console.log(`Caller identified: ${callUser.name}`);
  } else {
    console.log(`Unknown caller: ${from}`);
  }

  // If the user has no PIN set, skip PIN verification
  if (callUser && !callUser.pin) {
    state.authenticated = true;
    console.log(`Call ${callSid} auto-authenticated (no PIN set for ${callUser.name})`);
    const gather = await playAndGather(`${VOICE_SERVER_URL}/voice/gather`, "Hey, it's Nova. What's up?");
    return twiml(gather);
  }

  const greeting = await gatherWithAudio(
    `${VOICE_SERVER_URL}/voice/pin`,
    "Hey, it's Nova. Before we get into it, I need your PIN to verify it's you.",
    { numDigits: 6, timeout: 15, redirectUrl: `${VOICE_SERVER_URL}/voice/pin` }
  );

  return twiml(greeting);
}

async function handleOutgoing(body: string): Promise<Response> {
  const params = parseFormBody(body);
  const callSid = params.CallSid || "unknown";
  const to = params.To || "unknown";

  console.log(`Outgoing call connected to ${to} (${callSid})`);
  const state = getCallState(callSid);

  // Resolve the callee by phone number
  const callUser = await resolveUserByPhone(to);
  if (callUser) {
    state.user = callUser;
    console.log(`Callee identified: ${callUser.name}`);
  }

  // Load call context if available
  try {
    // Validate callSid format to prevent path traversal
    if (!callSid.match(/^[A-Za-z0-9]+$/)) throw new Error("Invalid call SID");
    const contextPath = join(CALL_CONTEXTS_DIR, basename(`${callSid}.json`));
    const contextData = JSON.parse(await readFile(contextPath, "utf-8"));
    state.context = contextData.context;
    // Clean up context file
    setTimeout(() => unlink(contextPath).catch(() => {}), 5_000);
  } catch {
    // No context file — that's fine
  }

  // If the user has no PIN set, skip PIN verification
  if (callUser && !callUser.pin) {
    state.authenticated = true;
    console.log(`Call ${callSid} auto-authenticated (no PIN set for ${callUser.name})`);
    const welcomeText = state.context
      ? "Hey, it's Nova. I was actually calling about something — let me tell you what's up."
      : "Hey, it's Nova. What's up?";
    const gather = await playAndGather(`${VOICE_SERVER_URL}/voice/gather`, welcomeText);
    return twiml(gather);
  }

  const greeting = await gatherWithAudio(
    `${VOICE_SERVER_URL}/voice/pin`,
    "Hey, it's Nova. I need your PIN real quick before we talk.",
    { numDigits: 6, timeout: 15 }
  );

  return twiml(greeting);
}

async function handlePin(body: string): Promise<Response> {
  const params = parseFormBody(body);
  const callSid = params.CallSid || "unknown";
  const speechResult = params.SpeechResult || "";
  const digits = params.Digits || "";
  const state = getCallState(callSid);

  // Global PIN rate limit — reject if locked out
  if (isPinLocked()) {
    console.warn(`PIN locked out — rejecting call ${callSid}`);
    return twiml(`<Say voice="Polly.Joanna">Authentication is temporarily locked. Try again later.</Say><Hangup/>`);
  }

  // Check PIN from either speech or DTMF
  const input = digits || speechResult.replace(/\D/g, "");
  console.log(`PIN attempt for ${callSid}: digits=${digits ? "yes" : "no"} parsed_length=${input.length}`);

  state.pinAttempts++;

  // Determine the correct PIN for this caller
  const expectedPin = state.user?.pin || FALLBACK_PIN;
  const callerName = state.user?.name || FALLBACK_USER_NAME;

  if (input === expectedPin) {
    state.authenticated = true;
    recordPinSuccess();
    console.log(`Call ${callSid} authenticated (${callerName})`);

    const welcomeText = state.context
      ? "You're good. I was actually calling about something — let me tell you what's up."
      : "You're good. What's up?";

    const gather = await playAndGather(`${VOICE_SERVER_URL}/voice/gather`, welcomeText);

    // If there's outgoing call context, add the initial Claude response
    if (state.context) {
      // Generate an opening based on context
      const prompt = buildVoiceSystemPrompt(state.context, state.user) +
        `\n\nYou just called ${callerName} and they've been authenticated. Open the conversation naturally — explain why you're calling based on the context above. Be brief and direct.`;
      const response = await callClaude(prompt);
      state.turns.push({ role: "assistant", content: response });
      await saveCallMessage("assistant", response, callSid, state.user?.id);

      const contextGather = await playAndGather(`${VOICE_SERVER_URL}/voice/gather`, response);
      return twiml(contextGather);
    }

    return twiml(gather);
  }

  recordPinFailure();

  if (state.pinAttempts >= 3) {
    console.log(`Call ${callSid} failed authentication after 3 attempts`);
    const audioId = await generateAudio("I can't verify your identity. I'll have to end this call.");
    if (audioId) {
      return twiml(`<Play>${audioUrl(audioId)}</Play><Hangup/>`);
    }
    return twiml(`<Say voice="Polly.Joanna">I can't verify your identity. I'll have to end this call.</Say><Hangup/>`);
  }

  const retryGather = await gatherWithAudio(
    `${VOICE_SERVER_URL}/voice/pin`,
    "That's not right. Try again.",
    { numDigits: 6, timeout: 15, redirectUrl: `${VOICE_SERVER_URL}/voice/pin` }
  );

  return twiml(retryGather);
}

async function handleGather(body: string): Promise<Response> {
  const params = parseFormBody(body);
  const callSid = params.CallSid || "unknown";
  const speechResult = params.SpeechResult || "";
  const state = getCallState(callSid);

  if (!state.authenticated) {
    return twiml(`<Say voice="Polly.Joanna">Authentication required.</Say><Hangup/>`);
  }

  if (!speechResult.trim()) {
    // No speech detected — re-gather
    const gather = await playAndGather(
      `${VOICE_SERVER_URL}/voice/gather`,
      "I didn't catch that. Can you say that again?"
    );
    return twiml(gather);
  }

  const sanitizedSpeech = sanitizeSpeechInput(speechResult);
  console.log(`Call ${callSid} speech: "${sanitizedSpeech}"`);
  state.turns.push({ role: "user", content: sanitizedSpeech });
  const userId = state.user?.id;
  await saveCallMessage("user", `[Phone call]: ${sanitizedSpeech}`, callSid, userId);

  // Check for hang-up intents
  const lowerSpeech = sanitizedSpeech.toLowerCase();
  if (
    lowerSpeech.includes("goodbye") ||
    lowerSpeech.includes("hang up") ||
    lowerSpeech.includes("end the call") ||
    lowerSpeech.includes("that's all") ||
    lowerSpeech.includes("talk to you later") ||
    lowerSpeech.includes("bye nova")
  ) {
    const goodbyeText = "Alright, I'll get started on anything we discussed. Talk to you later. Bye!";
    await saveCallMessage("assistant", goodbyeText, callSid, userId);
    const audioId = await generateAudio(goodbyeText);

    // Trigger post-call processing (non-blocking)
    const callState = { ...state, turns: [...state.turns] };
    activeCalls.delete(callSid);
    processPostCallTasks(callSid, callState).catch((err) =>
      console.error(`Post-call processing error for ${callSid}:`, err)
    );

    if (audioId) {
      return twiml(`<Play>${audioUrl(audioId)}</Play><Hangup/>`);
    }
    return twiml(`<Say voice="Polly.Joanna">${goodbyeText}</Say><Hangup/>`);
  }

  // Build conversation prompt with full turn history
  const userName = state.user?.name || FALLBACK_USER_NAME;
  const turnHistory = state.turns
    .map((t) => `${t.role === "user" ? userName : "Nova"}: ${t.content}`)
    .join("\n");

  const prompt = buildVoiceSystemPrompt(state.context, state.user) +
    `\n\nCONVERSATION SO FAR:\n${turnHistory}\n\nRespond to ${userName}'s latest message. Be concise — this is a phone call.`;

  const response = await callClaude(prompt);
  state.turns.push({ role: "assistant", content: response });
  await saveCallMessage("assistant", `[Phone call]: ${response}`, callSid, userId);

  const gather = await playAndGather(`${VOICE_SERVER_URL}/voice/gather`, response);
  return twiml(gather);
}

async function handleStatus(body: string): Promise<Response> {
  const params = parseFormBody(body);
  const callSid = params.CallSid || "unknown";
  const callStatus = params.CallStatus || "";

  console.log(`Call status update: ${callSid} → ${callStatus}`);

  // Clean up failed calls
  if (["no-answer", "busy", "failed", "canceled"].includes(callStatus)) {
    activeCalls.delete(callSid);
    return new Response("OK");
  }

  // When call completes, process any remaining tasks if we still have state
  // (handles cases where user hangs up without saying goodbye)
  if (callStatus === "completed" && activeCalls.has(callSid)) {
    const state = activeCalls.get(callSid)!;
    if (state.turns.length > 0 && state.authenticated) {
      const callState = { ...state, turns: [...state.turns] };
      activeCalls.delete(callSid);
      processPostCallTasks(callSid, callState).catch((err) =>
        console.error(`Post-call processing error for ${callSid}:`, err)
      );
    } else {
      activeCalls.delete(callSid);
    }
  }

  return new Response("OK");
}

const SMS_ACK_KEYWORDS = new Set(["ok", "okay", "got it", "ack", "acknowledged", "👍", "yes", "done", "thanks"]);

async function handleSmsIncoming(body: string): Promise<Response> {
  const params = parseFormBody(body);
  const from = params.From || "";

  // SECURITY: Only process SMS from known users' phone numbers.
  // All other senders are silently ignored — no response, no processing.
  const smsUser = await resolveUserByPhone(from);
  if (!smsUser) {
    console.log(`SMS rejected: unauthorized sender ${from}`);
    return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`, {
      headers: { "Content-Type": "application/xml" },
    });
  }

  // Only match exact known ack keywords — never pass raw SMS content to Claude or any LLM.
  // This prevents prompt injection via SMS text.
  const smsBody = (params.Body || "").trim().toLowerCase();

  if (SMS_ACK_KEYWORDS.has(smsBody)) {
    let cleared = 0;
    for (const [key, timer] of pendingUrgentAcks) {
      clearTimeout(timer);
      pendingUrgentAcks.delete(key);
      cleared++;
    }
    if (cleared > 0) {
      console.log(`Urgent ack received from ${smsUser.name}, cleared ${cleared} pending follow-up(s)`);
    }
  } else {
    // Unrecognized SMS from authorized user — log but do not process content.
    // SMS conversations are handled by the Telegram relay, not this server.
    console.log(`SMS from ${smsUser.name} ignored (not an ack keyword)`);
  }

  // Always return empty TwiML — never echo or process SMS content
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`, {
    headers: { "Content-Type": "application/xml" },
  });
}

function handleAudio(id: string): Response {
  const filePath = join(AUDIO_DIR, `${id}.mp3`);
  const file = Bun.file(filePath);

  return new Response(file, {
    headers: { "Content-Type": "audio/mpeg" },
  });
}

// ============================================================
// SERVER
// ============================================================

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // Health check
    if (path === "/health" && req.method === "GET") {
      return new Response(JSON.stringify({ status: "ok", service: "nova-voice" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Audio files — require signed token
    if (path.startsWith("/audio/") && req.method === "GET") {
      const id = path.replace("/audio/", "");
      if (!id.match(/^[a-f0-9-]+$/)) {
        return new Response("Not found", { status: 404 });
      }
      const token = url.searchParams.get("token") || "";
      if (!verifyAudioToken(id, token)) {
        return new Response("Unauthorized", { status: 401 });
      }
      return handleAudio(id);
    }

    // Twilio webhooks (POST with form data)
    if (req.method === "POST") {
      const body = await req.text();

      // Verify Twilio signature on all webhook endpoints
      const twilioRoutes = ["/voice/incoming", "/voice/outgoing", "/voice/pin", "/voice/gather", "/voice/status", "/sms/incoming"];
      if (twilioRoutes.includes(path)) {
        const signature = req.headers.get("X-Twilio-Signature") || "";
        const params = parseFormBody(body);
        const requestUrl = `${VOICE_SERVER_URL}${path}`;

        if (TWILIO_AUTH_TOKEN && !verifyTwilioSignature(requestUrl, params, signature)) {
          console.warn(`Rejected request to ${path}: invalid Twilio signature`);
          return new Response("Forbidden", { status: 403 });
        }
      }

      if (path === "/voice/incoming") return handleIncoming(body);
      if (path === "/voice/outgoing") return handleOutgoing(body);
      if (path === "/voice/pin") return handlePin(body);
      if (path === "/voice/gather") return handleGather(body);
      if (path === "/voice/status") return handleStatus(body);
      if (path === "/sms/incoming") return handleSmsIncoming(body);
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Nova Voice Server running on port ${PORT}`);
console.log(`Public URL: ${VOICE_SERVER_URL}`);
console.log(`Routes:`);
console.log(`  POST /voice/incoming             — Twilio incoming call webhook`);
console.log(`  POST /voice/outgoing             — Twilio outgoing call webhook`);
console.log(`  POST /voice/pin                  — PIN authentication`);
console.log(`  POST /voice/gather    — Speech input handler`);
console.log(`  POST /voice/status    — Twilio call status callback`);
console.log(`  POST /sms/incoming    — SMS acknowledgment handler`);
console.log(`  GET  /audio/:id       — Serve generated audio`);
console.log(`  GET  /health          — Health check`);
