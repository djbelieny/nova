#!/usr/bin/env bun
/**
 * Nova Command Center Dashboard
 *
 * Retro CRT-style monitoring dashboard for the Nova AI assistant.
 * Serves on port 3033, auto-refreshes via polling, no build step.
 *
 * Run: bun run src/dashboard.ts
 */

import "dotenv/config";
import { readFile, readdir, stat, writeFile, mkdir, unlink } from "fs/promises";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { getDb, type Database } from "./db.ts";
import { createSSEStream, getActiveAgents, getSSEConnectionCount, initEventBus, emit } from "./events.ts";
import { orchestrate, initOrchestrator, type WebContext } from "./orchestrator.ts";
import { transcribe } from "./transcribe.ts";
import { ClaudeProvider } from "./providers/claude.ts";
import { registerProvider, getProvider } from "./ai-provider.ts";
import { ExecComms } from "./exec-comms.ts";
import { initBoard, conveneBoard, startBoardPoller } from "./board.ts";

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = dirname(dirname(__filename));
const PORT = 3033;
const NOVA_DIR = process.env.NOVA_DIR || process.env.RELAY_DIR || join(process.env.HOME || "~", ".nova");
const LOGS_DIR = join(PROJECT_ROOT, "logs");

// Database (local SQLite)
const supabase: Database = getDb();

const startTime = Date.now();

// Initialize event bus so SSE listeners are registered
initEventBus({ db: supabase });

// Initialize AI provider and orchestrator for dashboard chat
const claudeProvider = new ClaudeProvider();
registerProvider(claudeProvider);

async function dashboardCallAI(prompt: string, model?: any, userId?: string): Promise<string> {
  const provider = getProvider("claude");
  if (!provider) throw new Error("No AI provider available");
  const result = await provider.call(prompt, { tier: model || "standard" });
  return result.text;
}

function dashboardBuildPrompt(user: any, userMessage: string): string {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: user.timezone || "UTC",
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

  return `You are Nova, a multi-agent AI assistant. Current time: ${timeStr}.

## User Message
${userMessage}`;
}

initOrchestrator({
  callClaude: dashboardCallAI,
  buildPrompt: dashboardBuildPrompt,
  runTask: (ctx, desc, buildTask, opts) => {
    // Mirror relay.ts runTask: build → call AI → postProcess → reply
    (async () => {
      try {
        emit({ type: "agent.start", level: "info", userId: opts?.userId, data: { description: desc } });

        const { prompt, model, hint } = await buildTask();

        // Sentinel prompts from orchestrator (e.g. __NOT_REVISION__) skip AI call
        const isSentinel = prompt.startsWith("__") && prompt.endsWith("__");
        const rawResponse = isSentinel ? prompt : await dashboardCallAI(prompt, model, opts?.userId);

        const response = opts?.postProcess ? await opts.postProcess(rawResponse) : rawResponse;

        // Orchestrator handled internally (e.g. chained to orchestrateMain)
        if (response === "__SKIP__") return;

        // Save and send the response
        if (opts?.userId) {
          supabase.saveMessage({ role: "assistant", content: response, user_id: opts.userId, channel: "web" });
        }
        await (ctx as any).reply(response);

        emit({ type: "agent.end", level: "info", userId: opts?.userId, data: { description: desc } });
      } catch (e: any) {
        console.error(`[dashboard] runTask error (${desc}):`, e.message);
        emit({ type: "agent.error", level: "error", userId: opts?.userId, data: { description: desc, error: e.message } });
        try { await (ctx as any).reply(`Error: ${e.message}`); } catch {}
      }
    })();
  },
  saveMessage: async (role, content, userId) => {
    supabase.saveMessage({ role, content, user_id: userId, channel: "web" });
  },
  sendResponseWithVoice: async (ctx, response) => {
    // Web uses ctx.reply which emits chat.reply SSE events
    await (ctx as any).reply(response);
  },
  sendTelegramFile: async () => { /* no-op for web */ },
  sendMessageToChat: async () => { /* no-op for web */ },
  novaDir: NOVA_DIR,
  supabase,
});

// ============================================================
// BOARD MODULE — executive board meetings via Supabase
// ============================================================

let _boardAvailable = false;

if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  try {
    const comms = new ExecComms("nova");
    initBoard({
      callAI: dashboardCallAI,
      comms,
      sendMessage: async (chatId: string | number, text: string) => {
        // Route board messages back to the web chat — persist + SSE
        const userId = String(chatId).replace("web-", "");
        supabase.saveMessage({ role: "assistant", content: text, user_id: userId, channel: "web" });
        emit({ type: "chat.reply", level: "info", data: { messageId: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`, text, userId }, userId });
      },
    });
    comms.registerNode(process.env.NODE_HOST || "dashboard").catch(() => {});
    startBoardPoller();
    _boardAvailable = true;
    console.log("[dashboard] Board module initialized");
  } catch (e: any) {
    console.warn("[dashboard] Board module failed to initialize:", e.message);
  }
}

// ============================================================
// AUTH — cookie-based session login
// ============================================================

const DASHBOARD_USER = process.env.DASHBOARD_USER || "admin";
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || "";
const DASHBOARD_BASE = process.env.DASHBOARD_BASE ?? "/dashboard";
const COOKIE_PATH = DASHBOARD_BASE || "/";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-memory session store (survives for container lifetime)
const sessions = new Map<string, { user: string; expiresAt: number }>();

// Rate limiting — 120 req/min per session
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(sessionId: string): boolean {
  const now = Date.now();
  let bucket = rateLimitBuckets.get(sessionId);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitBuckets.set(sessionId, bucket);
  }
  bucket.count++;
  return bucket.count <= RATE_LIMIT_MAX;
}

function getSessionIdFromRequest(req: Request): string | null {
  const cookie = req.headers.get("cookie") || "";
  const match = cookie.match(/nova_session=([a-f0-9]+)/);
  return match ? match[1] : null;
}

// Periodic cleanup of expired sessions and rate limit buckets
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt < now) sessions.delete(id);
  }
  for (const [id, bucket] of rateLimitBuckets) {
    if (bucket.resetAt < now) rateLimitBuckets.delete(id);
  }
}, 30 * 60 * 1000); // every 30 min

function generateSessionId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function isAuthenticated(req: Request): boolean | "no_password" {
  if (!DASHBOARD_PASS) return "no_password"; // No password set = show warning
  const cookie = req.headers.get("cookie") || "";
  const match = cookie.match(/nova_session=([a-f0-9]+)/);
  if (!match) return false;
  const session = sessions.get(match[1]);
  if (!session || session.expiresAt < Date.now()) {
    if (match[1]) sessions.delete(match[1]);
    return false;
  }
  return true;
}

function noPasswordWarningPage(): Response {
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Nova — Dashboard Disabled</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0a0a0f;
      color: rgba(255,255,255,0.95);
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .warning-box {
      border: 1px solid rgba(255,200,0,0.3);
      padding: 2.5rem;
      width: 420px;
      background: rgba(255,200,0,0.05);
      border-radius: 14px;
      text-align: center;
    }
    h1 { font-size: 1.4rem; margin-bottom: 1rem; color: #fbbf24; }
    p { font-size: 0.95rem; line-height: 1.6; color: rgba(255,255,255,0.7); }
    code { background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px; font-size: 0.9rem; }
  </style>
</head>
<body>
  <div class="warning-box">
    <h1>Dashboard Disabled</h1>
    <p>Set <code>DASHBOARD_PASS</code> in your <code>.env</code> file to enable the dashboard.</p>
  </div>
</body>
</html>`;
  return new Response(html, { status: 403, headers: { "Content-Type": "text/html" } });
}

function loginPage(error?: string): Response {
  const errorHtml = error ? `<div class="error">${error}</div>` : "";
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Nova — Login</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0a0a0f;
      color: rgba(255,255,255,0.95);
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .login-box {
      border: 1px solid rgba(255,255,255,0.10);
      padding: 2.5rem;
      width: 380px;
      background: rgba(255,255,255,0.055);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-radius: 14px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.3);
    }
    .login-logo {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      margin-bottom: 2rem;
    }
    .login-logo-badge {
      width: 40px;
      height: 40px;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.2rem;
      font-weight: 700;
      color: #fff;
    }
    .login-logo-text {
      font-size: 1.5rem;
      font-weight: 700;
      color: rgba(255,255,255,0.95);
    }
    label { display: block; margin-bottom: 0.3rem; font-size: 0.8rem; color: rgba(255,255,255,0.4); text-transform: uppercase; letter-spacing: 0.5px; }
    input {
      width: 100%;
      padding: 0.7rem 0.9rem;
      background: rgba(255,255,255,0.055);
      border: 1px solid rgba(255,255,255,0.10);
      color: rgba(255,255,255,0.95);
      font-family: inherit;
      font-size: 0.95rem;
      margin-bottom: 1.2rem;
      outline: none;
      border-radius: 8px;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    input:focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,0.2); }
    button {
      width: 100%;
      padding: 0.75rem;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      border: none;
      color: #fff;
      font-family: inherit;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      text-transform: uppercase;
      letter-spacing: 1px;
      border-radius: 8px;
      transition: opacity 0.2s, transform 0.1s;
    }
    button:hover { opacity: 0.9; }
    button:active { transform: scale(0.98); }
    .error {
      background: rgba(239,68,68,0.1);
      border: 1px solid rgba(239,68,68,0.3);
      color: #ef4444;
      padding: 0.6rem;
      margin-bottom: 1rem;
      text-align: center;
      font-size: 0.85rem;
      border-radius: 8px;
    }
  </style>
</head>
<body>
  <div class="login-box">
    <div class="login-logo"><div class="login-logo-badge">N</div><div class="login-logo-text">Nova</div></div>
    ${errorHtml}
    <form method="POST" action="${DASHBOARD_BASE}/login">
      <label>USERNAME</label>
      <input type="text" name="username" autocomplete="username" required autofocus>
      <label>PASSWORD</label>
      <input type="password" name="password" autocomplete="current-password" required>
      <button type="submit">ACCESS</button>
    </form>
  </div>
</body>
</html>`;
  return new Response(html, {
    status: 401,
    headers: { "Content-Type": "text/html" },
  });
}

async function handleLogin(req: Request): Promise<Response> {
  const body = await req.text();
  const params = new URLSearchParams(body);
  const username = params.get("username") || "";
  const password = params.get("password") || "";

  if (username === DASHBOARD_USER && password === DASHBOARD_PASS) {
    const sessionId = generateSessionId();
    sessions.set(sessionId, { user: username, expiresAt: Date.now() + SESSION_TTL_MS });
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${DASHBOARD_BASE}/`,
        "Set-Cookie": `nova_session=${sessionId}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=86400; Secure`,
      },
    });
  }

  return loginPage("Invalid credentials");
}

function handleLogout(): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${DASHBOARD_BASE}/`,
      "Set-Cookie": `nova_session=; Path=${COOKIE_PATH}; HttpOnly; Max-Age=0`,
    },
  });
}

// ============================================================
// HELPERS
// ============================================================

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "http://localhost:3033" },
  });
}

async function dirSize(dirPath: string): Promise<number> {
  let total = 0;
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dirPath, entry.name);
      if (entry.isFile()) {
        const s = await stat(full);
        total += s.size;
      }
    }
  } catch {}
  return total;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

// ============================================================
// API HANDLERS
// ============================================================

async function getStatus(): Promise<unknown> {
  const isMac = process.platform === "darwin";

  const services = isMac
    ? [
        { name: "relay", label: "Nova Core", unit: "com.nova.core" },
        { name: "voice-server", label: "Voice Server", unit: "com.nova.voice-server" },
        { name: "smart-checkin", label: "Smart Check-in", unit: "com.nova.smart-checkin" },
        { name: "morning-briefing", label: "Morning Briefing", unit: "com.nova.morning-briefing" },
        { name: "dashboard", label: "Dashboard", unit: "com.nova.dashboard" },
      ]
    : [
        { name: "relay", label: "Nova Core", unit: "nova-relay" },
        { name: "voice", label: "Voice Server", unit: "nova-voice" },
        { name: "dashboard", label: "Dashboard", unit: "nova-dashboard" },
        { name: "miniapp", label: "Mini App", unit: "nova-miniapp" },
        { name: "caddy", label: "Caddy (HTTPS)", unit: "caddy" },
        { name: "cron", label: "Scheduler (cron)", unit: "cron" },
      ];

  const results = [];

  if (isMac) {
    for (const svc of services) {
      try {
        const proc = Bun.spawn(["launchctl", "list", svc.unit], { stdout: "pipe", stderr: "pipe" });
        const out = await new Response(proc.stdout).text();
        const exitCode = await proc.exited;

        if (exitCode === 0) {
          const pidMatch = out.match(/"PID"\s*=\s*(\d+)/);
          const statusMatch = out.match(/"LastExitStatus"\s*=\s*(\d+)/);
          const pid = pidMatch ? parseInt(pidMatch[1]) : null;
          const lastExit = statusMatch ? parseInt(statusMatch[1]) : 0;
          results.push({ name: svc.name, label: svc.label, status: pid ? "running" : lastExit === 0 ? "idle" : "error", pid, lastExitCode: lastExit });
        } else {
          results.push({ name: svc.name, label: svc.label, status: "not_installed", pid: null, lastExitCode: null });
        }
      } catch {
        results.push({ name: svc.name, label: svc.label, status: "unknown", pid: null, lastExitCode: null });
      }
    }
  } else {
    // Linux — use systemctl
    for (const svc of services) {
      try {
        const proc = Bun.spawn(["systemctl", "show", svc.unit, "--property=ActiveState,MainPID"], { stdout: "pipe", stderr: "pipe" });
        const out = await new Response(proc.stdout).text();
        await proc.exited;

        const activeMatch = out.match(/ActiveState=(\w+)/);
        const pidMatch = out.match(/MainPID=(\d+)/);
        const active = activeMatch?.[1] || "unknown";
        const pid = pidMatch ? parseInt(pidMatch[1]) : null;

        results.push({
          name: svc.name,
          label: svc.label,
          status: active === "active" ? "running" : active === "inactive" ? "idle" : active === "failed" ? "error" : active,
          pid: pid && pid > 0 ? pid : null,
          lastExitCode: null,
        });
      } catch {
        results.push({ name: svc.name, label: svc.label, status: "unknown", pid: null, lastExitCode: null });
      }
    }
  }

  return { services: results, uptime: Math.floor((Date.now() - startTime) / 1000) };
}

async function getUsers(): Promise<unknown> {
  try {
    const data = supabase.getAllActiveUsers();
    return { users: data || [] };
  } catch (e: any) {
    return { users: [], error: e.message };
  }
}

async function getMessages(limit: number, userId?: string): Promise<unknown> {
  try {
    const data = supabase.getMessagesFiltered({ limit, userId });
    return { messages: data || [] };
  } catch (e: any) {
    return { messages: [], error: e.message };
  }
}

async function getMemory(type: string, userId?: string): Promise<unknown> {
  try {
    const data = supabase.getMemoryFiltered({ type, userId });
    return { memory: data || [] };
  } catch (e: any) {
    return { memory: [], error: e.message };
  }
}

async function getMetrics(userId?: string): Promise<unknown> {
  try {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const dayCount = supabase.countMessages({ userId, since: oneDayAgo });
    const weekCount = supabase.countMessages({ userId, since: oneWeekAgo });
    const dayMsgs = supabase.getMessagesFiltered({ userId, since: oneDayAgo, limit: 10000, order: "asc" });

    // Hourly breakdown for last 24h
    const hourly: Record<number, number> = {};
    for (let i = 0; i < 24; i++) hourly[i] = 0;
    const channelCounts: Record<string, number> = {};
    const roleCounts: Record<string, number> = {};

    for (const msg of dayMsgs) {
      const h = new Date(msg.created_at).getHours();
      hourly[h] = (hourly[h] || 0) + 1;
      channelCounts[msg.channel || "unknown"] = (channelCounts[msg.channel || "unknown"] || 0) + 1;
      roleCounts[msg.role || "unknown"] = (roleCounts[msg.role || "unknown"] || 0) + 1;
    }

    return {
      today: dayCount,
      thisWeek: weekCount,
      hourly,
      byChannel: channelCounts,
      byRole: roleCounts,
    };
  } catch (e: any) {
    return { error: e.message };
  }
}

async function getLogs(service: string, lines: number): Promise<unknown> {
  try {
    const logFiles: { name: string; content: string }[] = [];
    const entries = await readdir(LOGS_DIR).catch(() => []);

    for (const entry of entries) {
      if (!entry.endsWith(".log")) continue;
      if (service !== "all" && !entry.includes(service)) continue;

      const content = await readFile(join(LOGS_DIR, entry), "utf-8").catch(() => "");
      const logLines = content.split("\n").filter(Boolean);
      const tail = logLines.slice(-lines);
      logFiles.push({ name: entry, content: tail.join("\n") });
    }

    return { logs: logFiles };
  } catch (e: any) {
    return { logs: [], error: e.message };
  }
}

async function getTasks(): Promise<unknown> {
  const isMac = process.platform === "darwin";
  const results = [];

  if (isMac) {
    const services = [
      { name: "smart-checkin", label: "Smart Check-in" },
      { name: "morning-briefing", label: "Morning Briefing" },
    ];

    for (const svc of services) {
      const plistPath = join(process.env.HOME || "~", "Library", "LaunchAgents", `com.nova.${svc.name}.plist`);
      try {
        const content = await readFile(plistPath, "utf-8");
        const calendarMatch = content.match(/<key>StartCalendarInterval<\/key>[\s\S]*?<dict>([\s\S]*?)<\/dict>/);
        let schedule = "unknown";
        if (calendarMatch) {
          const hourMatch = calendarMatch[1].match(/<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/);
          const minMatch = calendarMatch[1].match(/<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/);
          if (hourMatch && minMatch) {
            schedule = `Daily at ${hourMatch[1].padStart(2, "0")}:${minMatch[1].padStart(2, "0")}`;
          }
        }
        const intervalMatch = content.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/);
        if (intervalMatch) {
          const secs = parseInt(intervalMatch[1]);
          if (secs >= 3600) schedule = `Every ${Math.round(secs / 3600)}h`;
          else if (secs >= 60) schedule = `Every ${Math.round(secs / 60)}m`;
          else schedule = `Every ${secs}s`;
        }
        results.push({ name: svc.name, label: svc.label, schedule, installed: true });
      } catch {
        results.push({ name: svc.name, label: svc.label, schedule: "not installed", installed: false });
      }
    }
  } else {
    // Linux — read crontab
    try {
      const content = await readFile("/etc/cron.d/nova", "utf-8");
      const lines = content.split("\n").filter(l => l.trim() && !l.startsWith("#") && !l.startsWith("SHELL") && !l.startsWith("PATH"));
      for (const line of lines) {
        const match = line.match(/^([\d*,\/\s]+)\s+nova\s+.*bun run (\S+)/);
        if (match) {
          const cron = match[1].trim();
          const script = match[2].replace("services/", "").replace(".ts", "");
          results.push({ name: script, label: script.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()), schedule: cron, installed: true });
        }
      }
    } catch {
      results.push({ name: "cron", label: "Cron", schedule: "not found", installed: false });
    }
  }

  // Also check scheduler.ts tasks (with timeout to prevent hanging)
  try {
    const proc = Bun.spawn(["bun", "run", join(PROJECT_ROOT, "src/scheduler.ts"), "list"], {
      stdout: "pipe", stderr: "pipe", cwd: PROJECT_ROOT,
    });
    const timeout = new Promise<string>((_, reject) =>
      setTimeout(() => { proc.kill(); reject(new Error("timeout")); }, 5000)
    );
    const out = await Promise.race([new Response(proc.stdout).text(), timeout]);
    await proc.exited;
    if (out.trim()) {
      results.push({ name: "scheduler", label: "Task Scheduler", schedule: "see output", installed: true, output: out.trim() });
    }
  } catch {}

  return { tasks: results };
}

async function getResources(): Promise<unknown> {
  const uploadsDir = join(NOVA_DIR, "uploads");
  const tempDir = join(NOVA_DIR, "temp");

  const [uploadsSize, tempSize, logsSize] = await Promise.all([
    dirSize(uploadsDir),
    dirSize(tempDir),
    dirSize(LOGS_DIR),
  ]);

  // Process stats
  let processes: { name: string; pid: number; cpu: string; mem: string }[] = [];
  try {
    const proc = Bun.spawn(["ps", "aux"], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;

    const lines = out.split("\n");
    for (const line of lines) {
      if (line.includes("relay.ts") || line.includes("voice-server.ts") || line.includes("dashboard.ts") || line.includes("smart-checkin") || line.includes("morning-briefing")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 11) {
          processes.push({
            name: line.includes("relay.ts") ? "relay" : line.includes("voice-server") ? "voice" : line.includes("dashboard") ? "dashboard" : line.includes("smart-checkin") ? "checkin" : "briefing",
            pid: parseInt(parts[1]),
            cpu: parts[2] + "%",
            mem: parts[3] + "%",
          });
        }
      }
    }
  } catch {}

  return {
    disk: {
      uploads: { size: uploadsSize, formatted: formatBytes(uploadsSize) },
      temp: { size: tempSize, formatted: formatBytes(tempSize) },
      logs: { size: logsSize, formatted: formatBytes(logsSize) },
    },
    processes,
  };
}

async function getVoice(userId?: string): Promise<unknown> {
  try {
    const data = supabase.getMessagesFiltered({ channel: "phone", userId, limit: 20 });
    return { calls: data || [] };
  } catch (e: any) {
    return { calls: [], error: e.message };
  }
}

async function getSkills(): Promise<unknown> {
  // MCP integrations
  const mcpIntegrations: { name: string; type: string }[] = [];
  try {
    const mcpConfig = JSON.parse(await readFile(join(PROJECT_ROOT, ".mcp.json"), "utf-8"));
    for (const [name] of Object.entries(mcpConfig.mcpServers || {})) {
      mcpIntegrations.push({ name, type: "mcp" });
    }
  } catch {}

  // Skills from .claude/skills
  const skills: { name: string; description: string }[] = [];
  try {
    const skillsDir = join(PROJECT_ROOT, ".claude", "skills");
    const entries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        try {
          const md = await readFile(join(skillsDir, entry.name, "skill.md"), "utf-8");
          const descMatch = md.match(/^#\s*(.+)/m);
          skills.push({ name: entry.name, description: descMatch?.[1] || entry.name });
        } catch {
          skills.push({ name: entry.name, description: entry.name });
        }
      }
    }
  } catch {}

  return { mcp: mcpIntegrations, skills };
}

async function getCosts(userId?: string): Promise<unknown> {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const dailyData = supabase.getCostEntries({ since: todayStart, userId, order: "asc" });
    const monthlyData = supabase.getCostEntries({ since: monthStart, userId, order: "asc" });
    const lifetimeData = supabase.getCostEntries({ userId, order: "asc" });

    // Aggregate by model
    function aggregateByModel(rows: any[]): Record<string, { cost: number; input_tokens: number; output_tokens: number; count: number }> {
      const result: Record<string, { cost: number; input_tokens: number; output_tokens: number; count: number }> = {};
      for (const r of rows || []) {
        const m = r.model || "unknown";
        if (!result[m]) result[m] = { cost: 0, input_tokens: 0, output_tokens: 0, count: 0 };
        result[m].cost += r.cost_usd || 0;
        result[m].input_tokens += r.input_tokens || 0;
        result[m].output_tokens += r.output_tokens || 0;
        result[m].count++;
      }
      return result;
    }

    // Aggregate by provider
    function aggregateByProvider(rows: any[]): Record<string, { cost: number; count: number; input_tokens: number; output_tokens: number }> {
      const result: Record<string, { cost: number; count: number; input_tokens: number; output_tokens: number }> = {};
      for (const r of rows || []) {
        const p = r.provider || "claude";
        if (!result[p]) result[p] = { cost: 0, count: 0, input_tokens: 0, output_tokens: 0 };
        result[p].cost += r.cost_usd || 0;
        result[p].count++;
        result[p].input_tokens += r.input_tokens || 0;
        result[p].output_tokens += r.output_tokens || 0;
      }
      return result;
    }

    // Hourly breakdown by provider for chart
    const hourlyByProvider: Record<string, Record<number, number>> = {};
    for (const r of dailyData || []) {
      const p = r.provider || "claude";
      const h = new Date(r.created_at).getHours();
      if (!hourlyByProvider[p]) hourlyByProvider[p] = {};
      hourlyByProvider[p][h] = (hourlyByProvider[p][h] || 0) + (r.cost_usd || 0);
    }

    // Daily breakdown by provider for chart
    const dailyByProvider: Record<string, Record<number, number>> = {};
    for (const r of monthlyData || []) {
      const p = r.provider || "claude";
      const d = new Date(r.created_at).getDate();
      if (!dailyByProvider[p]) dailyByProvider[p] = {};
      dailyByProvider[p][d] = (dailyByProvider[p][d] || 0) + (r.cost_usd || 0);
    }

    // Lifetime breakdown by month by provider for chart (YYYY-MM)
    const monthlyByProvider: Record<string, Record<string, number>> = {};
    for (const r of lifetimeData || []) {
      const p = r.provider || "claude";
      const dt = new Date(r.created_at);
      const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
      if (!monthlyByProvider[p]) monthlyByProvider[p] = {};
      monthlyByProvider[p][key] = (monthlyByProvider[p][key] || 0) + (r.cost_usd || 0);
    }

    return {
      daily: {
        byModel: aggregateByModel(dailyData),
        byProvider: aggregateByProvider(dailyData),
        hourlyChart: hourlyByProvider,
      },
      monthly: {
        byModel: aggregateByModel(monthlyData),
        byProvider: aggregateByProvider(monthlyData),
        dailyChart: dailyByProvider,
      },
      lifetime: {
        byModel: aggregateByModel(lifetimeData),
        byProvider: aggregateByProvider(lifetimeData),
        monthlyChart: monthlyByProvider,
      },
      totalDaily: (dailyData || []).reduce((s: number, r: any) => s + (r.cost_usd || 0), 0),
      totalMonthly: (monthlyData || []).reduce((s: number, r: any) => s + (r.cost_usd || 0), 0),
      totalLifetime: (lifetimeData || []).reduce((s: number, r: any) => s + (r.cost_usd || 0), 0),
    };
  } catch (e: any) {
    return { error: e.message };
  }
}

async function getUsageByUser(): Promise<unknown> {
  try {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    // Get all users
    const users = supabase.getAllActiveUsers();
    if (!users || !users.length) return { users: [] };

    // Fetch messages and costs (synchronous with SQLite)
    const dayMsgs = supabase.getMessagesFiltered({ since: oneDayAgo, limit: 100000 });
    const weekMsgs = supabase.getMessagesFiltered({ since: oneWeekAgo, limit: 100000 });
    const monthCosts = supabase.getCostEntries({ since: monthStart });

    // Count per user
    function countBy(rows: any[]): Record<string, number> {
      const m: Record<string, number> = {};
      for (const r of rows || []) m[r.user_id] = (m[r.user_id] || 0) + 1;
      return m;
    }

    const dayMsgCount = countBy(dayMsgs);
    const weekMsgCount = countBy(weekMsgs);

    // Per-user per-provider cost aggregation
    const userProviderCosts: Record<string, Record<string, number>> = {};
    const userTotalCosts: Record<string, number> = {};
    const providerTotals: Record<string, number> = {};

    for (const r of monthCosts || []) {
      const uid = r.user_id;
      const provider = r.provider || "claude";
      const cost = r.cost_usd || 0;

      if (!userProviderCosts[uid]) userProviderCosts[uid] = {};
      userProviderCosts[uid][provider] = (userProviderCosts[uid][provider] || 0) + cost;
      userTotalCosts[uid] = (userTotalCosts[uid] || 0) + cost;
      providerTotals[provider] = (providerTotals[provider] || 0) + cost;
    }

    // Collect all providers seen
    const allProviders = [...new Set((monthCosts || []).map((r: any) => r.provider || "claude"))].sort();

    // Totals
    const totals = {
      msgs24h: (dayMsgs || []).length,
      msgs7d: (weekMsgs || []).length,
      costMonth: (monthCosts || []).reduce((s: number, r: any) => s + (r.cost_usd || 0), 0),
      byProvider: providerTotals,
    };

    const result = users.map((u: any) => ({
      id: u.id,
      name: u.name,
      role: u.role,
      active: u.active,
      msgs24h: dayMsgCount[u.id] || 0,
      msgs7d: weekMsgCount[u.id] || 0,
      costMonth: userTotalCosts[u.id] || 0,
      byProvider: userProviderCosts[u.id] || {},
    }));

    return { users: result, totals, providers: allProviders };
  } catch (e: any) {
    return { error: e.message };
  }
}

async function getAgentTasks(userId?: string): Promise<unknown> {
  try {
    const data = supabase.getAgentTasksRecent({ userId });
    return { tasks: data || [] };
  } catch (e: any) {
    return { tasks: [], error: e.message };
  }
}

async function getApprovals(userId?: string): Promise<unknown> {
  try {
    const data = supabase.getPendingApprovals(userId || "");
    return { approvals: data || [] };
  } catch (e: any) {
    return { approvals: [], error: e.message };
  }
}

async function resolveApproval(id: string, action: string, feedback?: string): Promise<unknown> {
  try {
    const statusMap: any = { approve: "approved", cancel: "cancelled", revise: "revised" };
    const status = statusMap[action];
    if (!status) throw new Error("Invalid action");
    
    supabase.updateApprovalStatus(id, status, feedback || null);
    
    // Note: The actual execution of approved tasks is handled by the orchestrator polling
    // or by the bot process if it receives an event.
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

async function getAllMemory(userId?: string): Promise<unknown> {
  try {
    // getMemoryForDashboard returns 100 recent entries across all types
    const data = supabase.getMemoryForDashboard({ userId });
    return { memory: data || [] };
  } catch (e: any) {
    return { memory: [], error: e.message };
  }
}

async function deleteMemory(id: string): Promise<unknown> {
  try {
    supabase.deleteMemoryEntries([id]);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

async function updateMemory(id: string, updates: any): Promise<unknown> {
  try {
    // We need a generic updateMemory method in Database class
    supabase.updateMemory(id, updates);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

async function getLlmTraces(userId?: string, limit = 50): Promise<unknown> {
  try {
    let sql = `SELECT * FROM llm_traces`;
    const params: any[] = [];
    if (userId) {
      sql += ` WHERE user_id = ?`;
      params.push(userId);
    }
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);
    const rows = supabase.raw.query(sql).all(...params);
    return { traces: rows || [] };
  } catch (e: any) {
    return { traces: [], error: e.message };
  }
}

async function handleChat(req: Request): Promise<Response> {
  try {
    const body = await req.json();
    const { text, content, userId, attachments } = body;
    const messageText = text || content;  // frontend sends "content", accept both
    if (!messageText && (!attachments || !attachments.length)) throw new Error("Empty message");

    const user = supabase.getUserById(userId);
    if (!user) throw new Error("User not found");

    // Build WebContext for orchestrator
    const ctx: WebContext = {
      userId: user.id,
      chatId: `web-${user.id}`,
      reply: async (replyText: string, options?: any) => {
        // Send reply back via event bus so UI can see it live
        const messageId = `msg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        emit({ type: "chat.reply", level: "info", data: { messageId, text: replyText, userId: user.id, options }, userId: user.id });
        return { message_id: messageId };
      }
    };

    // Inject attachments if any (would need coordination with how orchestrator handles them)
    if (attachments && attachments.length > 0) {
      (ctx as any)._webAttachments = attachments;
    }

    // Save user message
    supabase.saveMessage({ role: "user", content: messageText, user_id: userId, channel: "web" });

    // Handle /board command — convene executive board meeting
    if (messageText.startsWith("/board ") && _boardAvailable) {
      const question = messageText.substring(7).trim();
      if (!question) {
        await ctx.reply("Usage: /board <strategic question>");
      } else {
        conveneBoard(question, user.id, ctx.chatId).catch((err: Error) => {
          console.error("[dashboard] Board error:", err);
          ctx.reply("Failed to convene board meeting. Check logs.");
        });
      }
      return jsonResponse({ success: true });
    }

    // Normal orchestration (async — response comes via SSE)
    orchestrate(ctx as any, messageText, user, supabase);

    return jsonResponse({ success: true });
  } catch (e: any) {
    return jsonResponse({ success: false, error: e.message }, 400);
  }
}

async function handleUpload(req: Request): Promise<Response> {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File;
    const userId = formData.get("userId") as string;
    if (!file || !userId) throw new Error("Missing file or userId");

    const uploadsDir = join(NOVA_DIR, "uploads");
    await mkdir(uploadsDir, { recursive: true });

    const fileName = `${Date.now()}-${basename(file.name)}`;
    const filePath = join(uploadsDir, fileName);
    await writeFile(filePath, Buffer.from(await file.arrayBuffer()));

    return jsonResponse({ success: true, fileName, filePath, originalName: file.name });
  } catch (e: any) {
    return jsonResponse({ success: false, error: e.message }, 400);
  }
}

async function handleTranscribe(req: Request): Promise<Response> {
  try {
    const formData = await req.formData();
    const audioFile = formData.get("audio") as File;
    if (!audioFile) throw new Error("Missing audio file");

    const tempPath = join(NOVA_DIR, "temp", `voice-${Date.now()}.webm`);
    await mkdir(join(NOVA_DIR, "temp"), { recursive: true });
    await writeFile(tempPath, Buffer.from(await audioFile.arrayBuffer()));

    const text = await transcribe(tempPath);
    await unlink(tempPath).catch(() => {});

    return jsonResponse({ success: true, text });
  } catch (e: any) {
    return jsonResponse({ success: false, error: e.message }, 400);
  }
}

// ============================================================
// EXECUTIVE & AGENT CATALOG HANDLERS
// ============================================================

const EXEC_ROSTER = [
  { role: "ceo", name: "CEO", provider: "Claude", persona: "Jeff Bezos", color: "#f59e0b", agents: ["athena", "oracle", "tesseract"] },
  { role: "cfo", name: "CFO", provider: "Gemini", persona: "Patrick Campbell", color: "#22c55e", agents: ["digit", "flux"] },
  { role: "cmo", name: "CMO", provider: "Gemini", persona: "Seth Godin", color: "#ec4899", agents: ["pixel", "kai", "aura", "nexus"] },
  { role: "cto", name: "CTO", provider: "Codex", persona: "Werner Vogels", color: "#06b6d4", agents: ["architect", "cipher", "rift", "joule"] },
  { role: "coo", name: "COO", provider: "Claude", persona: "Operations", color: "#8b5cf6", agents: ["zen"] },
  { role: "research", name: "Research", provider: "Gemini", persona: "Ben Thompson", color: "#3b82f6", agents: ["oracle", "magnus", "cyra"] },
  { role: "critic", name: "Critic", provider: "Claude", persona: "Charlie Munger", color: "#ef4444", agents: [] },
];

async function getAgentCatalog(): Promise<unknown> {
  try {
    const { getAllAgents, loadAgents } = await import("./agent-router.ts");
    let agents = getAllAgents();
    if (agents.length === 0) {
      await loadAgents(); // Dashboard process needs to load agents explicitly
      agents = getAllAgents();
    }
    if (agents.length === 0) throw new Error("No agents loaded");
    return {
      agents: agents.map(a => ({
        slug: a.slug,
        name: a.name,
        description: a.description,
      })),
    };
  } catch (e: any) {
    // Fallback static roster if agent-router not available
    const AGENT_ROSTER = [
      { slug: "helios", name: "Helios", description: "Paid advertising" },
      { slug: "pixel", name: "Pixel", description: "Social media" },
      { slug: "kai", name: "Kai", description: "Content writing" },
      { slug: "orion", name: "Orion", description: "Email marketing" },
      { slug: "morpheus", name: "Morpheus", description: "Video content" },
      { slug: "architect", name: "Architect", description: "Web development" },
      { slug: "athena", name: "Athena", description: "Business strategy" },
      { slug: "digit", name: "Digit", description: "Data analytics" },
      { slug: "echo", name: "Echo", description: "Customer support" },
      { slug: "flux", name: "Flux", description: "Funnel engineering" },
      { slug: "quill", name: "Quill", description: "Grant writing" },
      { slug: "lex", name: "Lex", description: "Legal & compliance" },
      { slug: "helia", name: "Helia", description: "Public relations" },
      { slug: "bridge", name: "Bridge", description: "Partnerships" },
      { slug: "oracle", name: "Oracle", description: "Trend forecasting" },
      { slug: "cipher", name: "Cipher", description: "Data science" },
      { slug: "rift", name: "Rift", description: "Cybersecurity" },
      { slug: "joule", name: "Joule", description: "Workflow automation" },
      { slug: "nexus", name: "Nexus", description: "Community building" },
      { slug: "aura", name: "Aura", description: "Brand voice" },
      { slug: "zen", name: "Zen", description: "Productivity" },
      { slug: "tesseract", name: "Tesseract", description: "Systems thinking" },
      { slug: "magnus", name: "Magnus", description: "SEO" },
      { slug: "cyra", name: "Cyra", description: "Website optimization" },
    ];
    return { agents: AGENT_ROSTER };
  }
}

async function getExecutives(): Promise<unknown> {
  return { executives: EXEC_ROSTER };
}

async function getRecentBoardSessions(): Promise<unknown> {
  try {
    const rows = supabase.shared.db.query(
      `SELECT * FROM logs WHERE event LIKE 'board.%' ORDER BY created_at DESC LIMIT 20`
    ).all();
    return { sessions: rows };
  } catch {
    return { sessions: [] };
  }
}

async function getActiveDelegations(): Promise<unknown> {
  try {
    const rows = supabase.shared.db.query(
      `SELECT * FROM logs WHERE event = 'exec.delegation' ORDER BY created_at DESC LIMIT 20`
    ).all();
    return { delegations: rows };
  } catch {
    return { delegations: [] };
  }
}

// ============================================================
// OBSERVABILITY HANDLERS
// ============================================================

async function getActivity(since: string | null, limit: number): Promise<any[]> {
  const conditions: string[] = [];
  const params: any[] = [];
  if (since) {
    conditions.push("created_at > ?");
    params.push(since);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return supabase.shared.db.query(
    `SELECT id, created_at, level, event, message, metadata, user_id FROM logs ${where} ORDER BY created_at DESC LIMIT ?`
  ).all(...params, limit) as any[];
}

async function getTrace(requestId: string): Promise<any[]> {
  // Escape LIKE wildcards to prevent pattern injection
  const escaped = requestId.replace(/[%_\\]/g, (c) => `\\${c}`);
  return supabase.shared.db.query(
    `SELECT id, created_at, level, event, message, metadata, user_id FROM logs WHERE metadata LIKE ? ESCAPE '\\' ORDER BY created_at ASC`
  ).all(`%"requestId":"${escaped}"%`) as any[];
}

async function getCostBreakdown(period: string, groupBy: string): Promise<any[]> {
  // Whitelist values to prevent SQL injection
  const dayOffsets: Record<string, string> = { week: "-7 days", month: "-30 days", day: "-1 day" };
  const offset = dayOffsets[period] || "-1 day";
  const groupCol = groupBy === "provider" ? "provider" : "model";
  return supabase.shared.db.query(
    `SELECT ${groupCol} as group_key, COUNT(*) as calls, SUM(cost_usd) as total_cost, SUM(input_tokens) as total_input, SUM(output_tokens) as total_output FROM cost_tracking WHERE created_at > datetime('now', ?) GROUP BY ${groupCol} ORDER BY total_cost DESC`
  ).all(offset) as any[];
}

// ============================================================
// HTML DASHBOARD
// ============================================================

function renderDashboard(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>NOVA — EAGLE EYE</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #06060b;
    --surface: rgba(255,255,255,0.04);
    --glass: rgba(255,255,255,0.055);
    --glass-border: rgba(255,255,255,0.10);
    --glass-hover: rgba(255,255,255,0.08);
    --indigo: #6366f1;
    --violet: #8b5cf6;
    --teal: #06b6d4;
    --success: #22c55e;
    --warning: #f59e0b;
    --error: #ef4444;
    --pink: #ec4899;
    --blue: #3b82f6;
    --text: rgba(255,255,255,0.92);
    --text-secondary: rgba(255,255,255,0.6);
    --text-dim: rgba(255,255,255,0.3);
    --ceo: #f59e0b;
    --cfo: #22c55e;
    --cmo: #ec4899;
    --cto: #06b6d4;
    --coo: #8b5cf6;
    --research: #3b82f6;
    --critic: #ef4444;
  }

  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    background: var(--bg);
    color: var(--text);
    font-size: 13px;
    line-height: 1.5;
    height: 100vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  @keyframes pulse-dot { 0%,100% { box-shadow: 0 0 0 0 rgba(34,197,94,0.4); } 50% { box-shadow: 0 0 0 6px rgba(34,197,94,0); } }
  @keyframes pulse-glow { 0%,100% { filter: drop-shadow(0 0 4px currentColor); } 50% { filter: drop-shadow(0 0 12px currentColor); } }
  @keyframes fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
  /* SVG orbital keyframes removed — replaced by Three.js 3D sphere */
  @keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
  .blink { animation: blink 1.5s infinite; }

  /* === HEADER === */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 20px;
    border-bottom: 1px solid var(--glass-border);
    background: var(--glass);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    flex-shrink: 0;
    z-index: 100;
  }
  .logo { display: flex; align-items: center; gap: 10px; }
  .logo-badge {
    width: 32px; height: 32px;
    background: linear-gradient(135deg, var(--indigo), var(--violet));
    border-radius: 8px;
    display: flex; align-items: center; justify-content: center;
    font-size: 0.9rem; font-weight: 700; color: #fff;
  }
  .logo-title { font-size: 1.1rem; font-weight: 700; }
  .logo-subtitle { font-size: 0.65rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 2px; }
  .header-info { display: flex; align-items: center; gap: 16px; color: var(--text-dim); font-size: 11px; }
  .header-info .live-dot {
    display: inline-block; width: 7px; height: 7px; border-radius: 50%;
    background: var(--success); margin-right: 4px; animation: pulse-dot 2s infinite;
  }
  .sse-badge {
    padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 600;
    background: rgba(34,197,94,0.15); color: var(--success); border: 1px solid rgba(34,197,94,0.3);
  }
  .sse-badge.disconnected { background: rgba(239,68,68,0.15); color: var(--error); border-color: rgba(239,68,68,0.3); }
  .header-controls { display: flex; align-items: center; gap: 8px; }
  .header-controls select {
    background: rgba(255,255,255,0.055); color: var(--text); border: 1px solid var(--glass-border);
    padding: 4px 8px; font-family: inherit; font-size: 11px; border-radius: 6px;
  }
  .header-controls select:focus { outline: none; border-color: var(--indigo); }

  /* === MAIN 3-COLUMN LAYOUT === */
  .main-layout {
    display: grid;
    grid-template-columns: 260px 1fr 280px;
    flex: 1;
    overflow: hidden;
    min-height: 0;
  }

  /* === LEFT SIDEBAR — EXECUTIVE BOARD === */
  .sidebar-left {
    border-right: 1px solid var(--glass-border);
    background: var(--surface);
    overflow-y: auto;
    padding: 12px;
  }
  .sidebar-left::-webkit-scrollbar { width: 3px; }
  .sidebar-left::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }
  .section-title {
    font-size: 10px; text-transform: uppercase; letter-spacing: 1.5px;
    color: var(--text-dim); font-weight: 600; margin-bottom: 10px;
    display: flex; align-items: center; gap: 6px;
  }
  .exec-card {
    background: var(--glass); border: 1px solid var(--glass-border);
    border-radius: 10px; padding: 10px 12px; margin-bottom: 8px;
    cursor: pointer; transition: background 0.2s, border-color 0.2s;
    position: relative; overflow: hidden;
  }
  .exec-card:hover { background: var(--glass-hover); }
  .exec-card .exec-accent {
    position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
  }
  .exec-card-header { display: flex; align-items: center; gap: 8px; margin-left: 6px; }
  .exec-role-badge {
    font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;
  }
  .exec-provider {
    font-size: 9px; padding: 1px 6px; border-radius: 8px;
    background: rgba(255,255,255,0.06); color: var(--text-dim);
    margin-left: auto;
  }
  .exec-persona { font-size: 10px; color: var(--text-dim); margin-left: 6px; margin-top: 2px; }
  .exec-agents {
    display: flex; flex-wrap: wrap; gap: 3px; margin-top: 6px; margin-left: 6px;
  }
  .exec-agent-tag {
    font-size: 9px; padding: 1px 5px; border-radius: 4px;
    background: rgba(255,255,255,0.05); color: var(--text-dim);
  }
  .exec-stats { display: flex; gap: 12px; margin-top: 6px; margin-left: 6px; }
  .exec-stat { font-size: 10px; color: var(--text-dim); }
  .exec-stat-val { font-weight: 600; }

  /* === CENTER STAGE — ORBITAL VIZ === */
  .center-stage {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    position: relative;
    overflow: hidden;
    background: radial-gradient(ellipse at center, rgba(99,102,241,0.03) 0%, transparent 70%);
  }
  .orbital-container {
    width: 100%; height: 100%;
    position: relative;
  }
  #orbital-canvas {
    width: 100%; height: 100%;
    display: block;
    cursor: grab;
  }
  #orbital-canvas:active {
    cursor: grabbing;
  }

  /* Center stats overlay */
  .center-stats {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
    text-align: center; pointer-events: none; z-index: 5;
  }
  .center-stats .nova-label { font-size: 14px; font-weight: 700; color: var(--indigo); letter-spacing: 3px; }
  .center-stats .stat-row { font-size: 10px; color: var(--text-dim); margin-top: 2px; }
  .center-stats .stat-val { color: var(--text-secondary); font-weight: 600; }

  /* === RIGHT SIDEBAR — EVENTS + STATUS === */
  .sidebar-right {
    border-left: 1px solid var(--glass-border);
    background: var(--surface);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .event-stream {
    flex: 1; overflow-y: auto; padding: 8px 10px;
    font-family: 'JetBrains Mono', monospace; font-size: 10px;
  }
  .event-stream::-webkit-scrollbar { width: 3px; }
  .event-stream::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }
  .event-entry {
    padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.03);
    animation: fade-in 0.3s ease;
  }
  .event-time { color: var(--text-dim); }
  .event-type { font-weight: 600; }
  .event-msg { color: var(--text-secondary); word-break: break-word; }
  .event-filter-bar {
    display: flex; gap: 4px; padding: 8px 10px; border-bottom: 1px solid var(--glass-border);
    flex-shrink: 0;
  }
  .event-filter-btn {
    font-size: 9px; padding: 2px 8px; border-radius: 10px;
    background: none; border: 1px solid var(--glass-border);
    color: var(--text-dim); cursor: pointer; font-family: inherit;
    text-transform: uppercase; letter-spacing: 0.5px;
  }
  .event-filter-btn.active { background: var(--indigo); color: #fff; border-color: var(--indigo); }

  /* Right sidebar panels */
  .right-panel {
    padding: 10px; border-top: 1px solid var(--glass-border);
    flex-shrink: 0;
  }
  .right-panel .section-title { margin-bottom: 6px; }
  .mini-stat-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 6px;
  }
  .mini-stat {
    background: var(--glass); border: 1px solid var(--glass-border);
    border-radius: 8px; padding: 8px; text-align: center;
  }
  .mini-stat-label { font-size: 9px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; }
  .mini-stat-value { font-size: 16px; font-weight: 700; color: var(--indigo); }
  .mini-stat-value.green { color: var(--success); }
  .mini-stat-value.amber { color: var(--warning); }
  .mini-stat-value.cyan { color: var(--teal); }

  /* Active agents compact list */
  .active-agent-item {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 0; font-size: 11px;
  }
  .active-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--success); animation: pulse-dot 2s infinite;
    flex-shrink: 0;
  }
  .active-agent-name { color: var(--teal); font-weight: 600; flex: 1; }
  .active-agent-time { color: var(--text-dim); font-size: 10px; }

  /* === BOTTOM DOCK === */
  .bottom-dock {
    border-top: 1px solid var(--glass-border);
    background: rgba(6,6,11,0.95);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    flex-shrink: 0;
    z-index: 50;
    transition: height 0.3s ease;
    display: flex;
    flex-direction: column;
  }
  .bottom-dock.collapsed { height: 36px; overflow: hidden; }
  .bottom-dock.expanded { height: 45vh; }
  .dock-tabs {
    display: flex; align-items: center; gap: 2px;
    padding: 0 12px; height: 36px; flex-shrink: 0;
    border-bottom: 1px solid var(--glass-border);
    cursor: pointer;
  }
  .dock-tab {
    padding: 6px 14px; font-size: 10px; text-transform: uppercase;
    letter-spacing: 0.8px; color: var(--text-dim);
    background: none; border: none; cursor: pointer;
    font-family: inherit; font-weight: 600; border-radius: 6px 6px 0 0;
    transition: color 0.2s, background 0.2s;
  }
  .dock-tab:hover { color: var(--text-secondary); }
  .dock-tab.active { color: var(--indigo); background: rgba(99,102,241,0.1); }
  .dock-toggle {
    margin-left: auto; background: none; border: none; color: var(--text-dim);
    cursor: pointer; font-size: 14px; padding: 4px 8px;
  }
  .dock-content {
    flex: 1; overflow-y: auto; padding: 12px;
  }
  .dock-content::-webkit-scrollbar { width: 4px; }
  .dock-content::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }

  /* Dock panel reusable styles */
  .dock-panel { display: none; }
  .dock-panel.active { display: block; }

  /* Tables in dock */
  .data-table { width: 100%; font-size: 12px; border-collapse: collapse; }
  .data-table th {
    text-align: left; color: var(--text-dim); font-size: 10px;
    text-transform: uppercase; letter-spacing: 0.5px;
    padding: 6px 8px; border-bottom: 1px solid var(--glass-border);
    position: sticky; top: 0; background: var(--bg);
  }
  .data-table td { padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,0.04); }
  .data-table tr:hover td { background: rgba(255,255,255,0.02); }

  .msg-role {
    display: inline-block; padding: 1px 6px; font-size: 9px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.5px; border-radius: 3px;
  }
  .msg-role.user { color: #fff; background: var(--teal); }
  .msg-role.assistant { color: #fff; background: var(--indigo); }
  .msg-role.system { color: #fff; background: var(--warning); }

  .tabs { display: flex; gap: 3px; margin-bottom: 8px; flex-wrap: wrap; }
  .tab {
    padding: 4px 12px; cursor: pointer; font-size: 10px; color: var(--text-dim);
    border: none; background: none; font-family: inherit;
    text-transform: uppercase; letter-spacing: 0.5px; border-radius: 16px;
    transition: color 0.2s, background 0.2s;
  }
  .tab:hover { color: var(--text-secondary); background: rgba(255,255,255,0.05); }
  .tab.active { color: #fff; background: var(--indigo); }

  .metric-row { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
  .metric-label { color: var(--text-dim); }
  .metric-value { color: var(--indigo); font-weight: 600; }

  .cost-summary { display: flex; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
  .cost-card {
    flex: 1; min-width: 140px; background: var(--glass); border: 1px solid var(--glass-border);
    padding: 10px; text-align: center; border-radius: 10px;
  }
  .cost-card-label { font-size: 9px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 2px; }
  .cost-card-value { font-size: 20px; font-weight: 700; color: var(--indigo); }
  .cost-card-value.amber { color: var(--warning); }
  .cost-card-value.cyan { color: var(--teal); }

  .cost-model-table { width: 100%; font-size: 11px; border-collapse: collapse; margin-top: 6px; }
  .cost-model-table th { text-align: left; color: var(--text-dim); font-size: 9px; text-transform: uppercase; padding: 4px 6px; border-bottom: 1px solid var(--glass-border); }
  .cost-model-table td { padding: 4px 6px; border-bottom: 1px solid rgba(255,255,255,0.04); }
  .cost-model-table td.cost-val { color: var(--indigo); font-weight: 700; text-align: right; }

  .stacked-bar-chart { display: flex; align-items: flex-end; gap: 2px; height: 70px; margin-top: 6px; }
  .stacked-bar { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; min-height: 1px; position: relative; }
  .stacked-bar-segment { width: 100%; min-height: 0; transition: height 0.3s; opacity: 0.8; }
  .stacked-bar-segment:hover { opacity: 1; }
  .bar-label { position: absolute; bottom: -14px; left: 50%; transform: translateX(-50%); font-size: 8px; color: var(--text-dim); white-space: nowrap; }
  .cost-legend { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; font-size: 10px; }
  .cost-legend-item { display: flex; align-items: center; gap: 4px; }
  .cost-legend-dot { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }

  .cost-section { margin-bottom: 16px; }
  .cost-section-title { font-size: 10px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; padding-bottom: 3px; border-bottom: 1px solid var(--glass-border); }
  .cost-chart-container { display: flex; gap: 12px; flex-wrap: wrap; }
  .cost-chart-block { flex: 1; min-width: 260px; }

  .bar-chart { display: flex; align-items: flex-end; gap: 2px; height: 50px; margin-top: 8px; }
  .bar { flex: 1; background: linear-gradient(to top, var(--indigo), var(--violet)); min-height: 1px; position: relative; opacity: 0.7; border-radius: 2px 2px 0 0; }
  .bar:hover { opacity: 1; }

  .log-content { font-family: 'JetBrains Mono', monospace; font-size: 10px; line-height: 1.5; white-space: pre-wrap; word-break: break-all; color: var(--text-dim); }
  .log-file-name { color: var(--warning); font-size: 10px; margin: 6px 0 3px; padding: 3px 0; border-bottom: 1px solid var(--glass-border); }

  .resource-bar-container { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .resource-label { width: 70px; font-size: 10px; color: var(--text-dim); }
  .resource-bar { flex: 1; height: 10px; background: rgba(255,255,255,0.05); border: 1px solid var(--glass-border); overflow: hidden; border-radius: 5px; }
  .resource-bar-fill { height: 100%; background: linear-gradient(90deg, var(--indigo), var(--violet)); border-radius: 5px; }
  .resource-value { width: 70px; font-size: 10px; color: var(--indigo); text-align: right; }

  .service-card {
    display: flex; align-items: center; gap: 8px; padding: 6px 8px;
    border: 1px solid var(--glass-border); margin-bottom: 4px;
    background: rgba(255,255,255,0.03); border-radius: 6px;
  }
  .status-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .status-dot.running { background: var(--success); box-shadow: 0 0 6px var(--success); }
  .status-dot.error { background: var(--error); box-shadow: 0 0 6px var(--error); }
  .status-dot.idle { background: var(--warning); }
  .status-dot.not_installed, .status-dot.unknown { background: var(--text-dim); }
  .service-name { flex: 1; color: var(--text); font-size: 12px; }
  .service-meta { font-size: 10px; color: var(--text-dim); }

  .mem-type {
    display: inline-block; padding: 1px 6px; font-size: 9px; font-weight: 600;
    text-transform: uppercase; margin-right: 4px; border-radius: 3px;
  }
  .mem-type.fact { color: #fff; background: var(--teal); }
  .mem-type.goal { color: #fff; background: var(--warning); }
  .mem-type.completed_goal { color: #fff; background: var(--success); }
  .mem-type.preference { color: #fff; background: var(--violet); }

  .filter-row { display: flex; gap: 6px; margin-bottom: 6px; }
  select, input[type="text"] {
    background: rgba(255,255,255,0.055); color: var(--text); border: 1px solid var(--glass-border);
    padding: 4px 8px; font-family: inherit; font-size: 11px; border-radius: 6px;
  }
  select:focus, input[type="text"]:focus { outline: none; border-color: var(--indigo); }

  .chat-bubble {
    max-width: 80%;
    padding: 8px 12px;
    border-radius: 12px;
    font-size: 13px;
    line-height: 1.4;
    position: relative;
    word-break: break-word;
  }
  .chat-bubble.user {
    align-self: flex-end;
    background: var(--indigo);
    color: #fff;
    border-bottom-right-radius: 2px;
  }
  .chat-bubble.assistant {
    align-self: flex-start;
    background: var(--glass);
    border: 1px solid var(--glass-border);
    color: var(--text);
    border-bottom-left-radius: 2px;
  }
  .chat-attachment {
    background: rgba(255,255,255,0.05);
    border: 1px solid var(--glass-border);
    border-radius: 4px;
    padding: 2px 6px;
    font-size: 10px;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .chat-attachment button {
    background: none; border: none; color: var(--error); cursor: pointer; padding: 0 2px;
  }

  /* Responsive */
  @media (max-width: 1100px) {
    .main-layout { grid-template-columns: 1fr; }
    .sidebar-left, .sidebar-right { display: none; }
    .bottom-dock.expanded { height: 60vh; }
  }
</style>
<script src="https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js"></script>
</head>
<body>

<!-- HEADER -->
<div class="header">
  <div class="logo">
    <div class="logo-badge">N</div>
    <div><div class="logo-title">Nova</div><div class="logo-subtitle">Eagle Eye</div></div>
  </div>
  <div class="header-info">
    <span><span class="live-dot"></span>Live</span>
    <span id="header-time"></span>
    <span>Up: <span id="header-uptime">--</span></span>
    <span class="sse-badge" id="sse-badge">SSE</span>
  </div>
  <div class="header-controls">
    <select id="user-selector"><option value="">All Users</option></select>
  </div>
</div>

<!-- MAIN 3-COLUMN LAYOUT -->
<div class="main-layout">

  <!-- LEFT SIDEBAR: EXECUTIVE BOARD -->
  <div class="sidebar-left">
    <div class="section-title">Executive Board</div>
    <div id="exec-panel">
      <div style="color:var(--text-dim);font-size:11px">Loading...</div>
    </div>
    <div style="margin-top:16px">
      <div class="section-title">System Status</div>
      <div id="status-panel">
        <div style="color:var(--text-dim);font-size:11px">Loading...</div>
      </div>
    </div>
  </div>

  <!-- CENTER: ORBITAL VISUALIZATION -->
  <div class="center-stage">
    <div class="center-stats">
      <div class="nova-label">NOVA</div>
      <div class="stat-row">Agents: <span class="stat-val" id="stat-agents">24</span></div>
      <div class="stat-row">Active: <span class="stat-val" id="stat-active">0</span></div>
      <div class="stat-row">Today: $<span class="stat-val" id="stat-cost">0.00</span></div>
    </div>
    <div class="orbital-container" id="orbital-container">
      <canvas id="orbital-canvas"></canvas>
    </div>
  </div>

  <!-- RIGHT SIDEBAR: EVENTS + STATUS -->
  <div class="sidebar-right">
    <div class="event-filter-bar">
      <button class="event-filter-btn active" data-filter="all">All</button>
      <button class="event-filter-btn" data-filter="agent">Agents</button>
      <button class="event-filter-btn" data-filter="exec">Execs</button>
      <button class="event-filter-btn" data-filter="error">Errors</button>
    </div>
    <div class="event-stream" id="event-stream">
      <div style="color:var(--text-dim)">Connecting...</div>
    </div>
    <div class="right-panel">
      <div class="section-title">Active Agents</div>
      <div id="active-agents-compact" style="max-height:120px;overflow-y:auto">
        <div style="color:var(--text-dim);font-size:10px">None</div>
      </div>
    </div>
    <div class="right-panel">
      <div class="mini-stat-grid">
        <div class="mini-stat"><div class="mini-stat-label">Today</div><div class="mini-stat-value" id="cost-today">$0</div></div>
        <div class="mini-stat"><div class="mini-stat-label">Month</div><div class="mini-stat-value amber" id="cost-month">$0</div></div>
        <div class="mini-stat"><div class="mini-stat-label">Msgs 24h</div><div class="mini-stat-value cyan" id="msgs-today">0</div></div>
        <div class="mini-stat"><div class="mini-stat-label">SSE</div><div class="mini-stat-value green" id="sse-count">0</div></div>
      </div>
    </div>
  </div>

</div>

<!-- BOTTOM DOCK -->
<div class="bottom-dock collapsed" id="bottom-dock">
  <div class="dock-tabs">
    <button class="dock-tab active" data-panel="chat-dock">Chat</button>
    <button class="dock-tab" data-panel="messages-dock">History</button>
    <button class="dock-tab" data-panel="agent-tasks-dock">Agent Tasks</button>
    <button class="dock-tab" data-panel="costs-dock">Costs</button>
    <button class="dock-tab" data-panel="approvals-dock">Approvals</button>
    <button class="dock-tab" data-panel="memory-dock">Memory</button>
    <button class="dock-tab" data-panel="traces-dock">Traces</button>
    <button class="dock-tab" data-panel="logs-dock">Logs</button>
    <button class="dock-tab" data-panel="resources-dock">Resources</button>
    <button class="dock-tab" data-panel="skills-dock">Skills</button>
    <button class="dock-toggle" id="dock-toggle">&#9650;</button>
  </div>
  <div class="dock-content">
    <div class="dock-panel active" id="chat-dock">
      <div id="chat-messages" style="height: calc(45vh - 120px); overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px;">
        <div style="color: var(--text-dim); text-align: center; margin-top: 20px;">Select a user to start chatting</div>
      </div>
      <div id="chat-input-container" style="border-top: 1px solid var(--glass-border); padding: 10px; display: flex; align-items: flex-end; gap: 8px;">
        <div style="flex: 1; position: relative;">
          <textarea id="chat-input" placeholder="Type a message or paste an image..." style="width: 100%; background: var(--glass); border: 1px solid var(--glass-border); border-radius: 8px; color: var(--text); padding: 8px 12px; font-family: inherit; font-size: 13px; resize: none; min-height: 40px; max-height: 150px; outline: none;"></textarea>
          <div id="chat-attachments" style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px;"></div>
        </div>
        <button id="chat-upload-btn" class="event-filter-btn" title="Upload File" style="padding: 8px;"><u style="text-decoration: none;">📎</u></button>
        <button id="chat-voice-btn" class="event-filter-btn" title="Record Voice" style="padding: 8px;"><u style="text-decoration: none;">🎙️</u></button>
        <button id="chat-send-btn" class="event-filter-btn" style="background: var(--indigo); color: #fff; padding: 8px 16px; border-color: var(--indigo);">Send</button>
      </div>
      <input type="file" id="chat-file-input" style="display: none;" multiple>
    </div>
    <div class="dock-panel" id="messages-dock"></div>
    <div class="dock-panel" id="agent-tasks-dock"></div>
    <div class="dock-panel" id="costs-dock"></div>
    <div class="dock-panel" id="approvals-dock"></div>
    <div class="dock-panel" id="memory-dock"></div>
    <div class="dock-panel" id="traces-dock"></div>
    <div class="dock-panel" id="logs-dock"></div>
    <div class="dock-panel" id="resources-dock"></div>
    <div class="dock-panel" id="skills-dock"></div>
  </div>
</div>

<script>
const BASE = '${DASHBOARD_BASE}';
const $ = (id) => document.getElementById(id);
const esc = (s) => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
function timeAgo(ts) { const s=Math.floor((Date.now()-new Date(ts).getTime())/1000); if(s<60) return s+'s'; if(s<3600) return Math.floor(s/60)+'m'; if(s<86400) return Math.floor(s/3600)+'h'; return Math.floor(s/86400)+'d'; }
function fmtUptime(sec) { const d=Math.floor(sec/86400),h=Math.floor((sec%86400)/3600),m=Math.floor((sec%3600)/60); if(d>0) return d+'d '+h+'h'; if(h>0) return h+'h '+m+'m'; return m+'m'; }

// Clock
setInterval(() => {
  $('header-time').textContent = new Date().toLocaleString('en-US',{weekday:'short',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'});
}, 1000);

let selectedUserId = '';
function userParam() { return selectedUserId ? '&user_id=' + selectedUserId : ''; }

// ==== EXEC COLORS MAP ====
const EXEC_COLORS = { ceo:'#f59e0b', cfo:'#22c55e', cmo:'#ec4899', cto:'#06b6d4', coo:'#8b5cf6', research:'#3b82f6', critic:'#ef4444' };

// ==== 3D SPHERE VISUALIZATION (Three.js) ====
let orbitalAgents = [];
let orbitalExecs = [];
let activeAgentSlugs = new Set();

// Three.js state
let scene3d, camera3d, renderer3d;
let nodeMap3d = new Map();       // key -> { mesh, label }
let activeParticles3d = [];
let activeGlows3d = new Map();
let animFrameId3d;
let isDragging3d = false, prevMouse3d = {x:0,y:0};
let rot3d = {x:0.3,y:0}, rotTarget3d = {x:0.3,y:0}, zoom3d = 5.5;
const INNER_R = 1.4, OUTER_R = 2.9;
const MAX_PARTICLES = 60;

// Shared geometries for performance
let execGeo, agentGeo, particleGeo;

function hashColor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  const hue = Math.abs(h) % 360;
  return 'hsl(' + hue + ', 60%, 55%)';
}
function hashColorThree(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return new THREE.Color().setHSL((Math.abs(h) % 360) / 360, 0.6, 0.55);
}

function fibSpherePoint(index, total, radius) {
  const phi = Math.acos(1 - 2 * (index + 0.5) / total);
  const theta = Math.PI * (1 + Math.sqrt(5)) * index;
  return new THREE.Vector3(
    radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta)
  );
}

function makeTextSprite(text, color, fontSize) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  c.width = 256; c.height = 64;
  ctx.font = (fontSize || 24) + 'px Inter, system-ui, sans-serif';
  ctx.fillStyle = color || '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.6, 0.15, 1);
  return sprite;
}

function initOrbitalScene() {
  const container = $('orbital-container');
  const canvas = $('orbital-canvas');
  if (!container || !canvas || typeof THREE === 'undefined') return;

  const w = container.clientWidth || 600;
  const h = container.clientHeight || 600;

  scene3d = new THREE.Scene();
  camera3d = new THREE.PerspectiveCamera(55, w / h, 0.1, 100);
  camera3d.position.set(0, 1.5, zoom3d);

  renderer3d = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer3d.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer3d.setSize(w, h);
  renderer3d.setClearColor(0x000000, 0);

  // Lighting
  scene3d.add(new THREE.AmbientLight(0x404060, 0.6));
  const pointLight = new THREE.PointLight(0x6366f1, 2, 20);
  scene3d.add(pointLight);

  // Shared geometries
  execGeo = new THREE.SphereGeometry(0.1, 16, 16);
  agentGeo = new THREE.SphereGeometry(0.06, 12, 12);
  particleGeo = new THREE.SphereGeometry(0.025, 8, 8);

  // Wireframe reference spheres
  const wireMat = new THREE.MeshBasicMaterial({ color: 0x6366f1, wireframe: true, opacity: 0.04, transparent: true });
  scene3d.add(new THREE.Mesh(new THREE.SphereGeometry(INNER_R, 24, 24), wireMat));
  scene3d.add(new THREE.Mesh(new THREE.SphereGeometry(OUTER_R, 32, 32), wireMat.clone()));

  // Drag controls
  canvas.addEventListener('pointerdown', function(e) { isDragging3d = true; prevMouse3d = {x:e.clientX, y:e.clientY}; });
  canvas.addEventListener('pointermove', function(e) {
    if (!isDragging3d) return;
    rotTarget3d.y += (e.clientX - prevMouse3d.x) * 0.005;
    rotTarget3d.x += (e.clientY - prevMouse3d.y) * 0.005;
    rotTarget3d.x = Math.max(-1.2, Math.min(1.2, rotTarget3d.x));
    prevMouse3d = {x:e.clientX, y:e.clientY};
  });
  canvas.addEventListener('pointerup', function() { isDragging3d = false; });
  canvas.addEventListener('pointerleave', function() { isDragging3d = false; });
  canvas.addEventListener('wheel', function(e) {
    zoom3d = Math.max(2.5, Math.min(9, zoom3d + e.deltaY * 0.005));
    e.preventDefault();
  }, { passive: false });

  // Resize handler
  window.addEventListener('resize', function() {
    if (!renderer3d || !container) return;
    const nw = container.clientWidth, nh = container.clientHeight;
    camera3d.aspect = nw / nh;
    camera3d.updateProjectionMatrix();
    renderer3d.setSize(nw, nh);
  });

  // Start render loop
  function animate() {
    animFrameId3d = requestAnimationFrame(animate);
    if (!isDragging3d) rotTarget3d.y += 0.0008;
    rot3d.x += (rotTarget3d.x - rot3d.x) * 0.06;
    rot3d.y += (rotTarget3d.y - rot3d.y) * 0.06;
    camera3d.position.x = zoom3d * Math.sin(rot3d.y) * Math.cos(rot3d.x);
    camera3d.position.y = zoom3d * Math.sin(rot3d.x);
    camera3d.position.z = zoom3d * Math.cos(rot3d.y) * Math.cos(rot3d.x);
    camera3d.lookAt(0, 0, 0);

    // Animate particles
    for (let i = activeParticles3d.length - 1; i >= 0; i--) {
      const p = activeParticles3d[i];
      p.progress += p.speed;
      if (p.progress >= 1) {
        scene3d.remove(p.mesh);
        if (p.trail) scene3d.remove(p.trail);
        activeParticles3d.splice(i, 1);
      } else {
        const pos = p.curve.getPoint(p.progress);
        p.mesh.position.copy(pos);
        p.mesh.material.opacity = p.progress < 0.1 ? p.progress * 10 : (p.progress > 0.85 ? (1 - p.progress) * 6.6 : 1);
        p.mesh.scale.setScalar(0.8 + 0.4 * Math.sin(p.progress * Math.PI));
      }
    }

    // Pulse active glows
    const t = Date.now() * 0.003;
    activeGlows3d.forEach(function(glow, key) {
      const entry = nodeMap3d.get(key);
      if (entry) {
        entry.mesh.material.emissiveIntensity = 0.6 + 0.5 * Math.sin(t + glow.phase);
        entry.mesh.scale.setScalar(1 + 0.15 * Math.sin(t * 1.5 + glow.phase));
      }
    });

    renderer3d.render(scene3d, camera3d);
  }
  animate();
}

function drawOrbital() {
  if (!scene3d) return;

  // Clear previous nodes
  nodeMap3d.forEach(function(entry) {
    if (entry.mesh) scene3d.remove(entry.mesh);
    if (entry.label) scene3d.remove(entry.label);
  });
  nodeMap3d.clear();

  // Remove old connection lines
  scene3d.children = scene3d.children.filter(function(c) { return !c.userData.isConnection; });

  // Exec nodes (inner sphere)
  orbitalExecs.forEach(function(exec, i) {
    const pos = fibSpherePoint(i, orbitalExecs.length, INNER_R);
    const color = new THREE.Color(EXEC_COLORS[exec.role] || '#888');
    const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.4, transparent: true, opacity: 0.9 });
    const mesh = new THREE.Mesh(execGeo, mat);
    mesh.position.copy(pos);
    scene3d.add(mesh);

    const label = makeTextSprite(exec.name, EXEC_COLORS[exec.role] || '#888', 26);
    label.position.copy(pos).multiplyScalar(1.15);
    scene3d.add(label);

    exec._pos3d = pos;
    nodeMap3d.set('exec-' + exec.role, { mesh, label });
  });

  // Agent nodes (outer sphere)
  orbitalAgents.forEach(function(agent, i) {
    const pos = fibSpherePoint(i, orbitalAgents.length, OUTER_R);
    const color = hashColorThree(agent.slug);
    const isActive = activeAgentSlugs.has(agent.slug);
    const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: isActive ? 0.6 : 0.2, transparent: true, opacity: isActive ? 1 : 0.45 });
    const mesh = new THREE.Mesh(agentGeo, mat);
    mesh.position.copy(pos);
    if (isActive) mesh.scale.setScalar(1.4);
    scene3d.add(mesh);

    const label = makeTextSprite(agent.name, '#' + color.getHexString(), 20);
    label.position.copy(pos).multiplyScalar(1.08);
    label.scale.set(0.45, 0.11, 1);
    scene3d.add(label);

    agent._pos3d = pos;
    nodeMap3d.set(agent.slug, { mesh, label });
  });

  // Connection arcs (exec → agent)
  const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, opacity: 0.06, transparent: true });
  for (const exec of orbitalExecs) {
    if (!exec._pos3d) continue;
    for (const slug of (exec.agents || [])) {
      const agent = orbitalAgents.find(function(a) { return a.slug === slug; });
      if (!agent || !agent._pos3d) continue;
      const mid = exec._pos3d.clone().add(agent._pos3d).multiplyScalar(0.5);
      mid.multiplyScalar(1.15); // push outward
      const curve = new THREE.QuadraticBezierCurve3(exec._pos3d, mid, agent._pos3d);
      const pts = curve.getPoints(20);
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const line = new THREE.Line(geo, lineMat.clone());
      line.userData.isConnection = true;
      line.userData.execRole = exec.role;
      line.userData.agentSlug = slug;
      scene3d.add(line);
    }
  }
}

function updateNodeActivity() {
  for (const agent of orbitalAgents) {
    const entry = nodeMap3d.get(agent.slug);
    if (!entry) continue;
    const isActive = activeAgentSlugs.has(agent.slug);
    entry.mesh.material.opacity = isActive ? 1 : 0.45;
    entry.mesh.material.emissiveIntensity = isActive ? 0.6 : 0.2;
    entry.mesh.scale.setScalar(isActive ? 1.4 : 1);
  }
}

async function loadOrbitalData() {
  try {
    const [agentRes, execRes] = await Promise.all([
      fetch(BASE + '/api/agents/catalog').then(r => r.json()),
      fetch(BASE + '/api/executives').then(r => r.json())
    ]);
    orbitalExecs = (execRes.executives || []).map(function(e, i, arr) {
      e._angle = (2 * Math.PI * i / arr.length) - Math.PI / 2;
      return e;
    });
    orbitalAgents = (agentRes.agents || []).map(function(a, i, arr) {
      a._angle = (2 * Math.PI * i / arr.length) - Math.PI / 2;
      return a;
    });
    $('stat-agents').textContent = orbitalAgents.length;
    if (!scene3d) initOrbitalScene();
    drawOrbital();
  } catch(e) { console.error('Orbital load error:', e); }
}

// ==== EXEC PANEL ====
async function loadExecPanel() {
  try {
    const r = await fetch(BASE + '/api/executives');
    const d = await r.json();
    let html = '';
    for (const exec of (d.executives || [])) {
      const color = EXEC_COLORS[exec.role] || '#888';
      html += '<div class="exec-card" data-role="'+exec.role+'">';
      html += '<div class="exec-accent" style="background:'+color+'"></div>';
      html += '<div class="exec-card-header">';
      html += '<span class="exec-role-badge" style="color:'+color+'">'+esc(exec.name)+'</span>';
      html += '<span class="exec-provider">'+esc(exec.provider)+'</span>';
      html += '</div>';
      html += '<div class="exec-persona">'+esc(exec.persona)+'</div>';
      if (exec.agents && exec.agents.length) {
        html += '<div class="exec-agents">';
        for (const a of exec.agents) {
          html += '<span class="exec-agent-tag">'+esc(a)+'</span>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
    $('exec-panel').innerHTML = html || '<div style="color:var(--text-dim)">No executives</div>';
  } catch(e) { $('exec-panel').innerHTML = '<div style="color:var(--error)">Error</div>'; }
}

// ==== STATUS ====
async function loadStatus() {
  try {
    const r = await fetch(BASE + '/api/status');
    const d = await r.json();
    $('header-uptime').textContent = fmtUptime(d.uptime);
    let html = '';
    for (const s of d.services) {
      html += '<div class="service-card">'
        + '<div class="status-dot ' + s.status + '"></div>'
        + '<span class="service-name">' + esc(s.label) + '</span>'
        + '<span class="service-meta">' + (s.pid ? 'PID ' + s.pid : s.status.replace('_',' ')) + '</span></div>';
    }
    $('status-panel').innerHTML = html || '<div style="color:var(--text-dim)">No services</div>';
  } catch(e) { $('status-panel').innerHTML = '<div style="color:var(--error)">Error</div>'; }
}

// ==== ACTIVE AGENTS ====
async function loadActiveAgents() {
  try {
    const r = await fetch(BASE + '/api/agents/active');
    const agents = await r.json();
    activeAgentSlugs.clear();

    if (!Array.isArray(agents) || agents.length === 0) {
      $('active-agents-compact').innerHTML = '<div style="color:var(--text-dim);font-size:10px">None running</div>';
      $('stat-active').textContent = '0';
      updateNodeActivity();
      return;
    }

    $('stat-active').textContent = agents.length;
    let html = '';
    for (const a of agents) {
      const elapsed = a.elapsedMs < 60000 ? Math.round(a.elapsedMs/1000)+'s' : Math.round(a.elapsedMs/60000)+'m';
      html += '<div class="active-agent-item">'
        + '<div class="active-dot"></div>'
        + '<span class="active-agent-name">' + esc(a.key) + '</span>'
        + '<span class="active-agent-time">' + elapsed + '</span></div>';
      const slug = a.key.split('-')[0].toLowerCase();
      activeAgentSlugs.add(slug);
      activeAgentSlugs.add(a.key);
    }
    $('active-agents-compact').innerHTML = html;
    updateNodeActivity();
  } catch(e) { $('active-agents-compact').innerHTML = '<div style="color:var(--error);font-size:10px">Error</div>'; }
}

// ==== EVENT STREAM (SSE) ====
let activityEvents = [];
const MAX_EVENTS = 200;
let eventFilter = 'all';
let sseConnected = false;
let eventStreamPinned = false;

function matchesFilter(ev) {
  if (eventFilter === 'all') return true;
  const type = ev.type || ev.event || '';
  if (eventFilter === 'agent') return type.startsWith('agent.');
  if (eventFilter === 'exec') return type.startsWith('exec.') || type.startsWith('board.');
  if (eventFilter === 'error') return ev.level === 'error' || ev.level === 'warn';
  return true;
}

const EVENT_COLORS = { error:'var(--error)', warn:'var(--warning)', info:'var(--teal)', debug:'var(--text-dim)' };
const TYPE_ICONS = {
  'message.received':'\\u2709', 'agent.dispatched':'\\u26A1', 'agent.completed':'\\u2714',
  'board.convened':'\\u{1F3DB}', 'board.decision':'\\u2696', 'exec.delegation':'\\u27A1',
  'error':'\\u26D4', 'cost.tracked':'\\u{1F4B0}', 'task.created':'\\u{1F4CB}',
  'approval.requested':'\\u{1F6A8}', 'approval.resolved':'\\u2705'
};

function renderEventEntry(ev) {
  if (!matchesFilter(ev)) return '';
  const color = EVENT_COLORS[ev.level] || 'var(--teal)';
  const ts = ev.timestamp || ev.created_at || '';
  const short = ts ? new Date(ts).toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '';
  const msg = esc(ev.data?.message || ev.message || '');
  const evType = ev.type || ev.event || '';
  const icon = TYPE_ICONS[evType] || '\\u25CF';
  return '<div class="event-entry" data-type="'+esc(evType)+'" data-agent="'+esc(ev.agentSlug||'')+'" data-exec="'+esc(ev.execRole||'')+'">'
    + '<span class="event-time">' + short + '</span> '
    + '<span class="event-type" style="color:'+color+'">'+icon+' '+esc(evType)+'</span> '
    + '<span class="event-msg">' + msg + '</span>'
    + '</div>';
}

function renderEventStream() {
  const panel = $('event-stream');
  const wasAtBottom = !eventStreamPinned && (panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 30);
  const filtered = activityEvents.filter(matchesFilter);
  if (filtered.length === 0) {
    panel.innerHTML = '<div style="color:var(--text-dim)">No events</div>';
    return;
  }
  panel.innerHTML = filtered.map(renderEventEntry).join('');
  if (wasAtBottom) panel.scrollTop = panel.scrollHeight;
}

function addEvent(ev) {
  activityEvents.push(ev);
  if (activityEvents.length > MAX_EVENTS) activityEvents.shift();
  renderEventStream();
  // Flash orbital node
  flashOrbitalNode(ev);
}

// ==== 3D NODE EFFECTS ====

function pulseNode3d(key, color) {
  const entry = nodeMap3d.get(key);
  if (!entry) return;
  entry.mesh.material.emissiveIntensity = 1.5;
  entry.mesh.material.opacity = 1;
  entry.mesh.scale.setScalar(1.8);

  if (activeGlows3d.has(key)) clearTimeout(activeGlows3d.get(key).timeout);
  const timeout = setTimeout(function() {
    if (!entry.mesh) return;
    entry.mesh.scale.setScalar(key.startsWith('exec-') ? 1 : (activeAgentSlugs.has(key) ? 1.4 : 1));
    entry.mesh.material.emissiveIntensity = key.startsWith('exec-') ? 0.4 : 0.2;
    if (!activeAgentSlugs.has(key) && !key.startsWith('exec-')) entry.mesh.material.opacity = 0.45;
    activeGlows3d.delete(key);
  }, 8000);
  activeGlows3d.set(key, { timeout, phase: Math.random() * Math.PI * 2 });
}

function spawnFlowParticle(fromKey, toKey, color) {
  if (!scene3d || activeParticles3d.length >= MAX_PARTICLES) return;
  const fromEntry = nodeMap3d.get(fromKey);
  const toEntry = nodeMap3d.get(toKey);
  if (!fromEntry || !toEntry) return;

  const start = fromEntry.mesh.position.clone();
  const end = toEntry.mesh.position.clone();
  const mid = start.clone().add(end).multiplyScalar(0.5).multiplyScalar(1.2);
  const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
  const mat = new THREE.MeshBasicMaterial({ color: color || 0x6366f1, transparent: true, opacity: 0.9 });
  const mesh = new THREE.Mesh(particleGeo, mat);
  scene3d.add(mesh);
  activeParticles3d.push({ mesh, curve, progress: 0, speed: 0.012 + Math.random() * 0.008 });
}

function flashOrbitalNode(ev) {
  if (!scene3d) return;
  const type = ev.type || ev.event || '';
  const slug = ev.agentSlug || ev.data?.agentSlug || '';
  const execRole = ev.execRole || ev.data?.execRole || '';

  if (slug && nodeMap3d.has(slug)) {
    pulseNode3d(slug, hashColorThree(slug));
    // Spawn particle from connected exec to this agent
    const exec = orbitalExecs.find(function(e) { return (e.agents || []).includes(slug); });
    if (exec) {
      const c = new THREE.Color(EXEC_COLORS[exec.role] || '#888');
      spawnFlowParticle('exec-' + exec.role, slug, c);
    }
  }
  if (execRole && nodeMap3d.has('exec-' + execRole)) {
    pulseNode3d('exec-' + execRole, new THREE.Color(EXEC_COLORS[execRole] || '#888'));
  }
  // Board events: light up all execs and spawn particles between them
  if (type.startsWith('board.')) {
    orbitalExecs.forEach(function(exec) {
      pulseNode3d('exec-' + exec.role, new THREE.Color(EXEC_COLORS[exec.role] || '#888'));
    });
    // Particle from one random exec to another to show communication
    if (orbitalExecs.length > 1) {
      const a = Math.floor(Math.random() * orbitalExecs.length);
      let b = (a + 1 + Math.floor(Math.random() * (orbitalExecs.length - 1))) % orbitalExecs.length;
      spawnFlowParticle('exec-' + orbitalExecs[a].role, 'exec-' + orbitalExecs[b].role, new THREE.Color(0x6366f1));
    }
  }
  // Delegation: particle from exec to agent
  if (type === 'exec.delegation' && execRole) {
    const targetSlug = ev.data?.agentSlug || ev.data?.agent;
    if (targetSlug && nodeMap3d.has(targetSlug)) {
      spawnFlowParticle('exec-' + execRole, targetSlug, new THREE.Color(EXEC_COLORS[execRole] || '#888'));
    }
  }
}

// Pin detection
$('event-stream').addEventListener('scroll', function() {
  const el = this;
  eventStreamPinned = (el.scrollTop + el.clientHeight < el.scrollHeight - 50);
});

// Filter buttons
document.querySelectorAll('.event-filter-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.event-filter-btn').forEach(b => b.classList.remove('active'));
    this.classList.add('active');
    eventFilter = this.dataset.filter;
    renderEventStream();
  });
});

// Activity polling — dashboard runs as separate process, so poll the shared DB
function normalizeEvent(ev) {
  // DB rows have event/metadata/user_id; normalize to type/data/userId/agentSlug/execRole
  if (ev.event && !ev.type) ev.type = ev.event;
  if (ev.user_id && !ev.userId) ev.userId = ev.user_id;
  if (ev.metadata && !ev.data) {
    try { ev.data = typeof ev.metadata === 'string' ? JSON.parse(ev.metadata) : ev.metadata; } catch {}
  }
  // Extract agentSlug and execRole from data (stored inside metadata JSON by events.ts)
  if (ev.data) {
    if (ev.data.agentSlug && !ev.agentSlug) ev.agentSlug = ev.data.agentSlug;
    if (ev.data.execRole && !ev.execRole) ev.execRole = ev.data.execRole;
  }
  return ev;
}

async function loadActivityPoll() {
  try {
    const lastTs = activityEvents.length > 0 ? activityEvents[activityEvents.length-1].created_at : null;
    const params = lastTs ? '?since=' + encodeURIComponent(lastTs) + '&limit=50' : '?limit=50';
    const r = await fetch(BASE + '/api/activity' + params);
    const data = await r.json();
    if (Array.isArray(data) && data.length > 0) {
      const newEvents = lastTs ? data.reverse() : data.reverse();
      for (const ev of newEvents) addEvent(normalizeEvent(ev));
      if (!sseConnected) {
        sseConnected = true;
        $('sse-badge').textContent = 'LIVE';
        $('sse-badge').classList.remove('disconnected');
      }
    }
  } catch {
    sseConnected = false;
    $('sse-badge').textContent = 'OFFLINE';
    $('sse-badge').classList.add('disconnected');
  }
}

// Initial load + start polling
(async function() {
  try {
    const r = await fetch(BASE + '/api/activity?limit=50');
    const data = await r.json();
    if (Array.isArray(data)) {
      activityEvents = data.reverse().map(normalizeEvent);
      renderEventStream();
      sseConnected = true;
      $('sse-badge').textContent = 'LIVE';
      $('sse-badge').classList.remove('disconnected');
    }
  } catch {}
  // Poll every 3s for near-real-time updates
  setInterval(loadActivityPoll, 3000);
})();

// ==== BOTTOM DOCK ====
const dock = $('bottom-dock');
const dockToggle = $('dock-toggle');
let dockExpanded = false;
let activeDockPanel = 'chat-dock';
let dockPanelsLoaded = {};

dockToggle.addEventListener('click', function(e) {
  e.stopPropagation();
  dockExpanded = !dockExpanded;
  dock.classList.toggle('collapsed', !dockExpanded);
  dock.classList.toggle('expanded', dockExpanded);
  dockToggle.innerHTML = dockExpanded ? '&#9660;' : '&#9650;';
  if (dockExpanded && !dockPanelsLoaded[activeDockPanel]) loadDockPanel(activeDockPanel);
});

document.querySelectorAll('.dock-tab').forEach(tab => {
  tab.addEventListener('click', function() {
    const panel = this.dataset.panel;
    if (!panel) return;
    document.querySelectorAll('.dock-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.dock-panel').forEach(p => p.classList.remove('active'));
    this.classList.add('active');
    $(panel).classList.add('active');
    activeDockPanel = panel;
    if (!dockExpanded) {
      dockExpanded = true;
      dock.classList.remove('collapsed');
      dock.classList.add('expanded');
      dockToggle.innerHTML = '&#9660;';
    }
    if (!dockPanelsLoaded[panel]) loadDockPanel(panel);
  });
});

function loadDockPanel(panel) {
  dockPanelsLoaded[panel] = true;
  switch(panel) {
    case 'chat-dock': loadChat(); break;
    case 'messages-dock': loadMessages(); break;
    case 'agent-tasks-dock': loadAgentTasks(); break;
    case 'costs-dock': loadCosts(); break;
    case 'approvals-dock': loadApprovals(); break;
    case 'memory-dock': loadMemory(); break;
    case 'traces-dock': loadTraces(); break;
    case 'logs-dock': loadLogs(); break;
    case 'resources-dock': loadResources(); break;
    case 'skills-dock': loadSkills(); break;
  }
}

// ==== DOCK PANEL LOADERS ====

// Chat
let chatAttachments = [];

function renderChatMessage(m) {
  const container = $('chat-messages');
  const div = document.createElement('div');
  div.className = 'chat-bubble ' + m.role;
  div.innerHTML = esc(m.content).replace(/\\n/g, '<br>');
  if (m.messageId) div.id = m.messageId;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

async function loadChat() {
  if (!selectedUserId) {
    $('chat-messages').innerHTML = '<div style="color: var(--text-dim); text-align: center; margin-top: 20px;">Select a user to start chatting</div>';
    return;
  }
  try {
    const r = await fetch(BASE + '/api/messages?limit=20' + userParam());
    const d = await r.json();
    $('chat-messages').innerHTML = '';
    if (!d.messages.length) {
      $('chat-messages').innerHTML = '<div style="color: var(--text-dim); text-align: center; margin-top: 20px;">No messages yet. Say hi!</div>';
    } else {
      d.messages.reverse().forEach(renderChatMessage);
    }
  } catch(e) { $('chat-messages').innerHTML = '<div style="color:var(--error)">Error loading chat</div>'; }
}

async function sendChatMessage() {
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text && !chatAttachments.length) return;
  if (!selectedUserId) { alert('Select a user first'); return; }

  const msg = { role: 'user', content: text, userId: selectedUserId, attachments: chatAttachments };
  renderChatMessage(msg);
  input.value = '';
  input.style.height = '40px';
  chatAttachments = [];
  renderAttachments();

  try {
    const r = await fetch(BASE + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg)
    });
    const d = await r.json();
    if (!d.success) alert('Error: ' + d.error);
  } catch(e) { alert('Error sending message'); }
}

function renderAttachments() {
  const container = $('chat-attachments');
  container.innerHTML = chatAttachments.map((a, i) => 
    '<div class="chat-attachment"><span>' + esc(a.originalName) + '</span><button onclick="removeAttachment('+i+')">×</button></div>'
  ).join('');
}

function removeAttachment(i) {
  chatAttachments.splice(i, 1);
  renderAttachments();
}

async function uploadFile(file) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('userId', selectedUserId);
  try {
    const r = await fetch(BASE + '/api/upload', { method: 'POST', body: formData });
    const d = await r.json();
    if (d.success) {
      chatAttachments.push(d);
      renderAttachments();
    }
  } catch(e) { alert('Upload failed'); }
}

// Event Listeners for Chat
$('chat-send-btn').addEventListener('click', sendChatMessage);
$('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

// Auto-resize textarea
$('chat-input').addEventListener('input', function() {
  this.style.height = '40px';
  this.style.height = (this.scrollHeight) + 'px';
});

// Paste handling
$('chat-input').addEventListener('paste', async (e) => {
  const items = (e.clipboardData || e.originalEvent.clipboardData).items;
  for (const item of items) {
    if (item.kind === 'file') {
      const file = item.getAsFile();
      uploadFile(file);
    }
  }
});

// Upload button
$('chat-upload-btn').addEventListener('click', () => $('chat-file-input').click());
$('chat-file-input').addEventListener('change', (e) => {
  for (const file of e.target.files) uploadFile(file);
});

// Voice recording
let mediaRecorder;
let audioChunks = [];
$('chat-voice-btn').addEventListener('click', async function() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    this.style.color = '';
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];
    mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
    mediaRecorder.onstop = async () => {
      const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
      const formData = new FormData();
      formData.append('audio', audioBlob);
      $('chat-input').placeholder = 'Transcribing...';
      try {
        const r = await fetch(BASE + '/api/transcribe', { method: 'POST', body: formData });
        const d = await r.json();
        if (d.success) {
          $('chat-input').value += ' ' + d.text;
          $('chat-input').dispatchEvent(new Event('input'));
        }
      } catch(e) {}
      $('chat-input').placeholder = 'Type a message...';
    };
    mediaRecorder.start();
    this.style.color = 'var(--error)';
  } catch(e) { alert('Microphone access denied'); }
});

// Listen for live updates via SSE polling
// We need to update loadActivityPoll to handle chat events
const originalAddEvent = addEvent;
addEvent = function(ev) {
  originalAddEvent(ev);
  if (ev.type === 'chat.reply' && ev.userId === selectedUserId) {
    renderChatMessage({ role: 'assistant', content: ev.data.text, messageId: ev.data.messageId });
  }
  if (ev.type === 'chat.update' && ev.userId === selectedUserId) {
    const el = $(ev.data.messageId);
    if (el) el.innerHTML = esc(ev.data.text).replace(/\\n/g, '<br>');
  }
};

// Messages
async function loadMessages() {
  try {
    const r = await fetch(BASE + '/api/messages?limit=50' + userParam());
    const d = await r.json();
    if (!d.messages.length) { $('messages-dock').innerHTML = '<div style="color:var(--text-dim)">No messages yet</div>'; return; }
    let html = '<table class="data-table"><tr><th>Time</th><th>Role</th><th>Channel</th><th>Content</th></tr>';
    for (const m of d.messages) {
      html += '<tr><td style="white-space:nowrap;color:var(--text-dim);font-size:10px">' + timeAgo(m.created_at) + '</td>'
        + '<td><span class="msg-role ' + m.role + '">' + esc(m.role) + '</span></td>'
        + '<td style="color:var(--text-dim);font-size:10px">' + esc(m.channel || '') + '</td>'
        + '<td style="color:var(--text-secondary);max-width:500px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc((m.content||'').substring(0,200)) + '</td></tr>';
    }
    html += '</table>';
    $('messages-dock').innerHTML = html;
  } catch(e) { $('messages-dock').innerHTML = '<div style="color:var(--error)">Error: ' + esc(e.message) + '</div>'; }
}

// Agent Tasks
let agentTaskFilter = 'all';
async function loadAgentTasks() {
  try {
    const r = await fetch(BASE + '/api/agent-tasks' + (selectedUserId ? '?user_id='+selectedUserId : ''));
    const d = await r.json();
    let html = '<div class="tabs">';
    for (const t of ['all','pending','in_progress','done','blocked','cancelled']) {
      const label = t==='in_progress'?'active':t;
      html += '<button class="tab'+(agentTaskFilter===t?' active':'')+'" onclick="agentTaskFilter=\\''+t+'\\';loadAgentTasks()">'+label+'</button>';
    }
    html += '</div>';
    const tasks = (d.tasks||[]).filter(t => agentTaskFilter==='all' || t.status===agentTaskFilter);
    if (!tasks.length) {
      html += '<div style="color:var(--text-dim)">No '+(agentTaskFilter==='all'?'':agentTaskFilter+' ')+'tasks</div>';
    } else {
      html += '<table class="data-table"><tr><th>Agent</th><th>Task</th><th>Status</th><th>Result</th><th>Updated</th></tr>';
      for (const t of tasks) {
        const sc = {in_progress:'var(--success)',blocked:'var(--warning)',done:'var(--teal)',pending:'var(--text-dim)',cancelled:'var(--text-dim)'};
        const color = sc[t.status]||'var(--text-dim)';
        html += '<tr><td style="color:var(--teal)">'+esc(t.agent)+'</td>'
          +'<td>'+esc((t.description||'').substring(0,80))+'</td>'
          +'<td style="color:'+color+';font-weight:700;text-transform:uppercase;font-size:10px">'+esc(t.status)+'</td>'
          +'<td style="color:var(--text-dim);font-size:11px">'+esc((t.result||'—').substring(0,60))+'</td>'
          +'<td style="color:var(--text-dim);font-size:10px;white-space:nowrap">'+timeAgo(t.updated_at)+'</td></tr>';
      }
      html += '</table>';
    }
    $('agent-tasks-dock').innerHTML = html;
  } catch(e) { $('agent-tasks-dock').innerHTML = '<div style="color:var(--error)">Error</div>'; }
}

// Costs
const PROVIDER_COLORS = {claude:'#6366f1',openai:'#06b6d4',groq:'#f59e0b',elevenlabs:'#8b5cf6',ultravox:'#ef4444',fal:'#ec4899',heygen:'#06b6d4',gemini:'#22c55e'};
const FALLBACK_COLORS = ['#22c55e','#f59e0b','#06b6d4','#8b5cf6','#ef4444','#ec4899','#eab308'];
function getProviderColor(name) { return PROVIDER_COLORS[name]||FALLBACK_COLORS[Object.keys(PROVIDER_COLORS).length%FALLBACK_COLORS.length]; }
function getSeriesColor(idx) { return Object.values(PROVIDER_COLORS).concat(FALLBACK_COLORS)[idx%12]; }

function renderProviderTable(byProvider) {
  const providers = Object.entries(byProvider||{}).sort((a,b) => b[1].cost-a[1].cost);
  if (!providers.length) return '<div style="color:var(--text-dim);font-size:10px">No data</div>';
  let html = '<table class="cost-model-table"><tr><th>Provider</th><th>Calls</th><th style="text-align:right">In Tok</th><th style="text-align:right">Out Tok</th><th style="text-align:right">Cost</th></tr>';
  for (const [p,d] of providers) {
    html += '<tr><td style="color:'+getProviderColor(p)+';font-weight:700;text-transform:uppercase">'+esc(p)+'</td><td>'+d.count+'</td><td style="text-align:right">'+(d.input_tokens||0).toLocaleString()+'</td><td style="text-align:right">'+(d.output_tokens||0).toLocaleString()+'</td><td class="cost-val">$'+d.cost.toFixed(4)+'</td></tr>';
  }
  return html+'</table>';
}

function renderModelTable(byModel) {
  const models = Object.entries(byModel||{}).sort((a,b) => b[1].cost-a[1].cost);
  if (!models.length) return '';
  let html = '<table class="cost-model-table"><tr><th>Model</th><th>Calls</th><th style="text-align:right">Cost</th></tr>';
  for (const [m,d] of models) {
    html += '<tr><td style="color:var(--teal)">'+esc(m.replace(/^claude-/,'').replace(/-\\d{8}$/,''))+'</td><td>'+d.count+'</td><td class="cost-val">$'+d.cost.toFixed(4)+'</td></tr>';
  }
  return html+'</table>';
}

function renderStackedChart(chartData, labelFn, maxBuckets) {
  const series = Object.keys(chartData||{});
  if (!series.length) return '';
  const allKeys = new Set();
  for (const s of series) for (const k of Object.keys(chartData[s])) allKeys.add(k);
  let buckets = Array.from(allKeys).sort();
  if (maxBuckets && buckets.length > maxBuckets) buckets = buckets.slice(-maxBuckets);
  let maxVal = 0;
  for (const b of buckets) { let sum=0; for (const s of series) sum+=(chartData[s][b]||0); if(sum>maxVal) maxVal=sum; }
  if (maxVal===0) maxVal=1;
  let html = '<div class="stacked-bar-chart">';
  for (let i=0; i<buckets.length; i++) {
    const b=buckets[i]; let total=0;
    for (const s of series) total+=(chartData[s][b]||0);
    html += '<div class="stacked-bar" style="height:100%" title="'+labelFn(b)+': $'+total.toFixed(4)+'">';
    for (let si=0; si<series.length; si++) {
      const val=chartData[series[si]][b]||0; const pct=(val/maxVal)*100;
      const color=getProviderColor(series[si])||getSeriesColor(si);
      if(pct>0) html+='<div class="stacked-bar-segment" style="height:'+pct+'%;background:'+color+'" title="'+series[si]+': $'+val.toFixed(4)+'"></div>';
    }
    const showLabel=buckets.length<=12||(i%Math.ceil(buckets.length/12)===0);
    if(showLabel) html+='<span class="bar-label">'+labelFn(b)+'</span>';
    html+='</div>';
  }
  html += '</div><div class="cost-legend">';
  for (let si=0; si<series.length; si++) {
    const color=getProviderColor(series[si])||getSeriesColor(si);
    html+='<div class="cost-legend-item"><div class="cost-legend-dot" style="background:'+color+'"></div><span>'+esc(series[si])+'</span></div>';
  }
  return html+'</div>';
}

async function loadCosts() {
  try {
    const r = await fetch(BASE + '/api/costs' + (selectedUserId ? '?user_id='+selectedUserId : ''));
    const d = await r.json();
    if (d.error) { $('costs-dock').innerHTML = '<div style="color:var(--text-dim)">'+esc(d.error)+'</div>'; return; }

    // Update sidebar mini stats
    $('cost-today').textContent = '$'+(d.totalDaily||0).toFixed(2);
    $('cost-month').textContent = '$'+(d.totalMonthly||0).toFixed(0);
    $('stat-cost').textContent = (d.totalDaily||0).toFixed(2);

    let html = '<div class="cost-summary">';
    html += '<div class="cost-card"><div class="cost-card-label">Today</div><div class="cost-card-value">$'+(d.totalDaily||0).toFixed(4)+'</div></div>';
    html += '<div class="cost-card"><div class="cost-card-label">Month</div><div class="cost-card-value amber">$'+(d.totalMonthly||0).toFixed(2)+'</div></div>';
    html += '<div class="cost-card"><div class="cost-card-label">Lifetime</div><div class="cost-card-value cyan">$'+(d.totalLifetime||0).toFixed(2)+'</div></div>';
    html += '</div>';

    // Provider summary cards
    if (d.monthly.byProvider && Object.keys(d.monthly.byProvider).length) {
      html += '<div class="cost-summary">';
      for (const [prov, pdata] of Object.entries(d.monthly.byProvider).sort((a,b)=>b[1].cost-a[1].cost)) {
        const c = getProviderColor(prov);
        html += '<div class="cost-card" style="border-color:'+c+'40"><div class="cost-card-label" style="color:'+c+'">'+esc(prov.toUpperCase())+'</div><div class="cost-card-value" style="color:'+c+';font-size:16px">$'+pdata.cost.toFixed(2)+'</div><div style="font-size:9px;color:var(--text-dim)">'+pdata.count+' calls</div></div>';
      }
      html += '</div>';
    }

    // Today section
    html += '<div class="cost-section"><div class="cost-section-title">Today — Hourly</div><div class="cost-chart-container"><div class="cost-chart-block">';
    html += renderStackedChart(d.daily.hourlyChart, h => h+':00', 24);
    html += '</div><div class="cost-chart-block">';
    html += renderProviderTable(d.daily.byProvider);
    html += renderModelTable(d.daily.byModel);
    html += '</div></div></div>';

    // Month section
    html += '<div class="cost-section"><div class="cost-section-title">Month — Daily</div><div class="cost-chart-container"><div class="cost-chart-block">';
    html += renderStackedChart(d.monthly.dailyChart, day => 'Day '+day, 31);
    html += '</div><div class="cost-chart-block">';
    html += renderProviderTable(d.monthly.byProvider);
    html += '</div></div></div>';

    // Lifetime section
    html += '<div class="cost-section"><div class="cost-section-title">Lifetime — Monthly</div><div class="cost-chart-container"><div class="cost-chart-block">';
    html += renderStackedChart(d.lifetime.monthlyChart, m => m, 24);
    html += '</div><div class="cost-chart-block">';
    html += renderProviderTable(d.lifetime.byProvider);
    html += '</div></div></div>';

    $('costs-dock').innerHTML = html;
  } catch(e) { $('costs-dock').innerHTML = '<div style="color:var(--error)">Error</div>'; }
}

// Approvals
async function loadApprovals() {
  try {
    const r = await fetch(BASE + '/api/approvals' + userParam());
    const d = await r.json();
    if (!d.approvals.length) { $('approvals-dock').innerHTML = '<div style="color:var(--text-dim)">No pending approvals</div>'; return; }
    let html = '<table class="data-table"><tr><th>Task</th><th>Workflow</th><th>Actions</th></tr>';
    for (const a of d.approvals) {
      html += '<tr><td>' + esc((a.original_text||'').substring(0,100)) + '</td>'
        + '<td>' + esc(a.workflow_type || 'generic') + '</td>'
        + '<td><button class="event-filter-btn" style="color:var(--success)" onclick="resolveApp(\\''+a.id+'\\', \\'approve\\')">Approve</button> '
        + '<button class="event-filter-btn" style="color:var(--warning)" onclick="resolveApp(\\''+a.id+'\\', \\'revise\\')">Revise</button> '
        + '<button class="event-filter-btn" style="color:var(--error)" onclick="resolveApp(\\''+a.id+'\\', \\'cancel\\')">Cancel</button></td></tr>';
    }
    html += '</table>';
    $('approvals-dock').innerHTML = html;
  } catch(e) { $('approvals-dock').innerHTML = '<div style="color:var(--error)">Error</div>'; }
}

async function resolveApp(id, action) {
  let feedback = '';
  if (action === 'revise') feedback = prompt('Enter your revision feedback:');
  if (action === 'revise' && !feedback) return;
  try {
    const r = await fetch(BASE + '/api/approvals/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action, feedback })
    });
    const d = await r.json();
    if (d.success) loadApprovals();
    else alert('Error: ' + d.error);
  } catch(e) { alert('Error: ' + e.message); }
}

// Memory
let memoryType = 'all';
async function loadMemory() {
  try {
    const r = await fetch(BASE + '/api/memory?type=' + memoryType + userParam());
    const d = await r.json();
    let html = '<div class="tabs">';
    for (const t of ['all','fact','goal','completed_goal','preference']) {
      html += '<button class="tab'+(memoryType===t?' active':'')+'" onclick="memoryType=\\''+t+'\\';loadMemory()">'+t.replace('_',' ')+'</button>';
    }
    html += '</div>';
    if (!d.memory.length) { html += '<div style="color:var(--text-dim)">No entries</div>'; }
    else {
      html += '<table class="data-table"><tr><th>Type</th><th>Content</th><th>Weight</th><th>Actions</th></tr>';
      for (const m of d.memory) {
        html += '<tr><td><span class="mem-type '+m.type+'">'+esc(m.type)+'</span></td>'
          + '<td style="color:var(--text-secondary)">' + esc(m.content) + '</td>'
          + '<td style="color:var(--text-dim)">' + (m.weight || 1.0).toFixed(1) + '</td>'
          + '<td><button class="event-filter-btn" onclick="deleteMem(\\''+m.id+'\\')">Del</button></td></tr>';
      }
      html += '</table>';
    }
    $('memory-dock').innerHTML = html;
  } catch(e) { $('memory-dock').innerHTML = '<div style="color:var(--error)">Error</div>'; }
}

async function deleteMem(id) {
  if (!confirm('Delete this memory?')) return;
  try {
    const r = await fetch(BASE + '/api/memory/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    const d = await r.json();
    if (d.success) loadMemory();
  } catch(e) { alert('Error'); }
}

// Traces
async function loadTraces() {
  try {
    const r = await fetch(BASE + '/api/traces' + userParam());
    const d = await r.json();
    if (!d.traces.length) { $('traces-dock').innerHTML = '<div style="color:var(--text-dim)">No traces</div>'; return; }
    let html = '<table class="data-table"><tr><th>Time</th><th>Provider</th><th>Model</th><th>Prompt</th><th>Response</th></tr>';
    for (const t of d.traces) {
      html += '<tr><td style="white-space:nowrap;font-size:10px">' + timeAgo(t.created_at) + '</td>'
        + '<td style="color:var(--indigo)">' + esc(t.provider) + '</td>'
        + '<td style="color:var(--teal);font-size:10px">' + esc(t.model) + '</td>'
        + '<td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-dim)">' + esc(t.prompt) + '</td>'
        + '<td style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary)">' + esc(t.response) + '</td></tr>';
    }
    html += '</table>';
    $('traces-dock').innerHTML = html;
  } catch(e) { $('traces-dock').innerHTML = '<div style="color:var(--error)">Error</div>'; }
}

// Logs
async function loadLogs() {
  try {
    let html = '<div class="filter-row"><select id="log-service-dock" onchange="loadLogs()">'
      + '<option value="all">All</option><option value="relay">Core</option>'
      + '<option value="voice-server">Voice</option><option value="dashboard">Dashboard</option></select></div>';
    const svc = document.getElementById('log-service-dock')?.value || 'all';
    const r = await fetch(BASE + '/api/logs?service='+svc+'&lines=80');
    const d = await r.json();
    if (!d.logs.length) { html += '<div style="color:var(--text-dim)">No logs</div>'; }
    else {
      for (const f of d.logs) {
        html += '<div class="log-file-name">// '+esc(f.name)+'</div><div class="log-content">'+esc(f.content||'(empty)')+'</div>';
      }
    }
    $('logs-dock').innerHTML = html;
  } catch(e) { $('logs-dock').innerHTML = '<div style="color:var(--error)">Error</div>'; }
}

// Resources
async function loadResources() {
  try {
    const r = await fetch(BASE + '/api/resources');
    const d = await r.json();
    const maxDisk = Math.max(1, d.disk.uploads.size, d.disk.temp.size, d.disk.logs.size);
    let html = '';
    for (const [label,info] of [['uploads',d.disk.uploads],['temp',d.disk.temp],['logs',d.disk.logs]]) {
      const pct = Math.min(100,(info.size/Math.max(maxDisk,1))*100);
      html += '<div class="resource-bar-container"><span class="resource-label">'+label+'</span>'
        + '<div class="resource-bar"><div class="resource-bar-fill" style="width:'+pct+'%"></div></div>'
        + '<span class="resource-value">'+info.formatted+'</span></div>';
    }
    if (d.processes && d.processes.length) {
      html += '<table class="data-table" style="margin-top:8px"><tr><th>Service</th><th>PID</th><th>CPU</th><th>MEM</th></tr>';
      for (const p of d.processes) html += '<tr><td>'+esc(p.name)+'</td><td>'+p.pid+'</td><td>'+esc(p.cpu)+'</td><td>'+esc(p.mem)+'</td></tr>';
      html += '</table>';
    }
    $('resources-dock').innerHTML = html;
  } catch(e) { $('resources-dock').innerHTML = '<div style="color:var(--error)">Error</div>'; }
}

// Skills
async function loadSkills() {
  try {
    const r = await fetch(BASE + '/api/skills');
    const d = await r.json();
    let html = '';
    if (d.mcp && d.mcp.length) {
      html += '<div style="color:var(--warning);font-size:10px;margin-bottom:4px;text-transform:uppercase;letter-spacing:1px">MCP Integrations</div>';
      html += '<table class="data-table"><tr><th>Name</th><th>Type</th></tr>';
      for (const m of d.mcp) html += '<tr><td style="color:var(--teal)">'+esc(m.name)+'</td><td>'+esc(m.type)+'</td></tr>';
      html += '</table>';
    }
    if (d.skills && d.skills.length) {
      html += '<div style="color:var(--warning);font-size:10px;margin:10px 0 4px;text-transform:uppercase;letter-spacing:1px">Skills</div>';
      html += '<table class="data-table"><tr><th>Name</th><th>Description</th></tr>';
      for (const s of d.skills) html += '<tr><td style="color:var(--indigo)">'+esc(s.name)+'</td><td>'+esc(s.description)+'</td></tr>';
      html += '</table>';
    }
    if (!html) html = '<div style="color:var(--text-dim)">No skills found</div>';
    $('skills-dock').innerHTML = html;
  } catch(e) { $('skills-dock').innerHTML = '<div style="color:var(--error)">Error</div>'; }
}

// Metrics (for sidebar stats)
async function loadMetrics() {
  try {
    const r = await fetch(BASE + '/api/metrics' + (selectedUserId ? '?user_id='+selectedUserId : ''));
    const d = await r.json();
    $('msgs-today').textContent = d.today || 0;
  } catch {}
}

// User selector
async function loadUsers() {
  try {
    const r = await fetch(BASE + '/api/users');
    const d = await r.json();
    const sel = $('user-selector');
    sel.innerHTML = '<option value="">All Users</option>';
    for (const u of (d.users||[])) {
      sel.innerHTML += '<option value="'+u.id+'">'+esc(u.name)+'</option>';
    }
    sel.value = selectedUserId;
  } catch {}
}

$('user-selector').addEventListener('change', function() {
  selectedUserId = this.value;
  loadMetrics(); loadCosts();
  if (dockPanelsLoaded['chat-dock']) loadChat();
  if (dockPanelsLoaded['messages-dock']) loadMessages();
  if (dockPanelsLoaded['agent-tasks-dock']) loadAgentTasks();
  if (dockPanelsLoaded['memory-dock']) loadMemory();
});

// ==== INIT ====
loadUsers();
loadOrbitalData();
loadExecPanel();
loadStatus();
loadActiveAgents();
loadMetrics();
loadCosts();
loadChat(); // Load chat by default for the first user if any

// ==== INTERVALS ====
setInterval(loadStatus, 10000);
setInterval(loadActiveAgents, 5000);
setInterval(loadMetrics, 30000);
setInterval(loadCosts, 30000);
setInterval(() => { if(dockPanelsLoaded['chat-dock']) loadChat(); }, 30000); // Background refresh for history
setInterval(() => { if(dockPanelsLoaded['messages-dock']) loadMessages(); }, 15000);
setInterval(() => { if(dockPanelsLoaded['agent-tasks-dock']) loadAgentTasks(); }, 15000);
setInterval(() => { if(dockPanelsLoaded['memory-dock']) loadMemory(); }, 30000);
setInterval(() => { if(dockPanelsLoaded['logs-dock']) loadLogs(); }, 15000);
setInterval(() => { if(dockPanelsLoaded['resources-dock']) loadResources(); }, 20000);
setInterval(() => { if(dockPanelsLoaded['skills-dock']) loadSkills(); }, 60000);
</script>
</body>
</html>`;
}


// ============================================================
// SERVER
// ============================================================

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // Health check (no auth required)
    if (path === "/health") {
      return jsonResponse({ status: "ok", service: "nova-dashboard", uptime: Math.floor((Date.now() - startTime) / 1000) });
    }

    // Login/logout routes
    if (path === "/login" && req.method === "POST") {
      return handleLogin(req);
    }
    if (path === "/logout") {
      return handleLogout();
    }

    // Auth gate — everything below requires login
    const authResult = isAuthenticated(req);
    if (authResult === "no_password") {
      return noPasswordWarningPage();
    }
    if (!authResult) {
      return loginPage();
    }

    // Rate limit API requests
    if (path.startsWith("/api/")) {
      const sid = getSessionIdFromRequest(req);
      if (sid && !checkRateLimit(sid)) {
        return jsonResponse({ error: "Rate limit exceeded" }, 429);
      }
    }

    // Dashboard HTML
    if (path === "/") {
      return new Response(renderDashboard(), {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'",
        },
      });
    }

    // API routes
    const userId = url.searchParams.get("user_id") || undefined;

    if (path === "/api/users") return jsonResponse(await getUsers());
    if (path === "/api/status") return jsonResponse(await getStatus());
    if (path === "/api/messages") {
      const limit = parseInt(url.searchParams.get("limit") || "50");
      return jsonResponse(await getMessages(Math.min(limit, 200), userId));
    }
    if (path === "/api/memory") {
      const type = url.searchParams.get("type") || "all";
      return jsonResponse(await getMemory(type, userId));
    }
    if (path === "/api/metrics") return jsonResponse(await getMetrics(userId));
    if (path === "/api/logs") {
      const service = url.searchParams.get("service") || "all";
      const lines = parseInt(url.searchParams.get("lines") || "100");
      return jsonResponse(await getLogs(service, Math.min(lines, 500)));
    }
    if (path === "/api/tasks") return jsonResponse(await getTasks());
    if (path === "/api/costs") return jsonResponse(await getCosts(userId));
    if (path === "/api/usage-by-user") return jsonResponse(await getUsageByUser());
    if (path === "/api/agent-tasks") return jsonResponse(await getAgentTasks(userId));
    if (path === "/api/resources") return jsonResponse(await getResources());
    if (path === "/api/voice") return jsonResponse(await getVoice(userId));
    if (path === "/api/skills") return jsonResponse(await getSkills());

    // Approvals
    if (path === "/api/approvals") return jsonResponse(await getApprovals(userId));
    if (path === "/api/approvals/resolve" && req.method === "POST") {
      const body = await req.json();
      return jsonResponse(await resolveApproval(body.id, body.action, body.feedback));
    }

    // Memory Management
    if (path === "/api/memory/all") return jsonResponse(await getAllMemory(userId));
    if (path === "/api/memory/delete" && req.method === "POST") {
      const body = await req.json();
      return jsonResponse(await deleteMemory(body.id));
    }
    if (path === "/api/memory/update" && req.method === "POST") {
      const body = await req.json();
      return jsonResponse(await updateMemory(body.id, body.updates));
    }

    // LLM Traces
    if (path === "/api/traces") return jsonResponse(await getLlmTraces(userId));

    // Chat UI
    if (path === "/api/chat" && req.method === "POST") return handleChat(req);
    if (path === "/api/upload" && req.method === "POST") return handleUpload(req);
    if (path === "/api/transcribe" && req.method === "POST") return handleTranscribe(req);

    // Activity feed — recent events from logs table
    if (path === "/api/activity") {
      const since = url.searchParams.get("since");
      const limit = parseInt(url.searchParams.get("limit") || "50");
      return jsonResponse(await getActivity(since, Math.min(limit, 200)));
    }

    // SSE stream for real-time events
    if (path === "/api/activity/stream") {
      const stream = createSSEStream();
      if (!stream) return jsonResponse({ error: "Max SSE connections reached" }, 429);
      return stream;
    }

    // Active agents
    if (path === "/api/agents/active") {
      return jsonResponse(getActiveAgents());
    }

    // Request trace — all events for a specific requestId
    if (path === "/api/trace") {
      const requestId = url.searchParams.get("requestId");
      if (!requestId) return jsonResponse({ error: "requestId required" }, 400);
      return jsonResponse(await getTrace(requestId));
    }

    // Cost breakdown with groupBy
    if (path === "/api/costs/breakdown") {
      const period = url.searchParams.get("period") || "day";
      const groupBy = url.searchParams.get("groupBy") || "model";
      return jsonResponse(await getCostBreakdown(period, groupBy));
    }

    // Agent catalog
    if (path === "/api/agents/catalog") {
      return jsonResponse(await getAgentCatalog());
    }

    // Executives
    if (path === "/api/executives") {
      return jsonResponse(await getExecutives());
    }

    // Board sessions
    if (path === "/api/board/recent") {
      return jsonResponse(await getRecentBoardSessions());
    }

    // Active delegations
    if (path === "/api/delegations/active") {
      return jsonResponse(await getActiveDelegations());
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Nova Command Center running on http://localhost:${PORT}`);
console.log("Routes:");
console.log("  GET  /              — Dashboard UI");
console.log("  GET  /health        — Health check");
console.log("  GET  /api/users     — User list");
console.log("  GET  /api/status    — Service status");
console.log("  GET  /api/messages  — Recent messages");
console.log("  GET  /api/memory    — Memory entries");
console.log("  GET  /api/metrics   — Performance metrics");
console.log("  GET  /api/logs      — Log viewer");
console.log("  GET  /api/tasks     — Scheduled tasks");
console.log("  GET  /api/costs      — API cost tracking");
console.log("  GET  /api/usage-by-user — Per-user usage breakdown");
console.log("  GET  /api/agent-tasks — Agent task tracking");
console.log("  GET  /api/resources — System resources");
console.log("  GET  /api/voice     — Voice call activity");
console.log("  GET  /api/skills    — Skills & integrations");
console.log("  GET  /api/activity   — Activity feed");
console.log("  GET  /api/activity/stream — SSE real-time events");
console.log("  GET  /api/agents/active — Active agents");
console.log("  GET  /api/trace      — Request trace");
console.log("  GET  /api/costs/breakdown — Cost breakdown");
console.log("  GET  /api/agents/catalog — Agent catalog");
console.log("  GET  /api/executives — Executive roster");
console.log("  GET  /api/board/recent — Recent board sessions");
console.log("  GET  /api/delegations/active — Active delegations");
