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
import { registerProvider, getProvider, setDefaultProvider, getDefaultProvider } from "./ai-provider.ts";
import {
  readConfigProfiles,
  loadProviderProfiles,
  upsertProviderProfile,
  removeProviderProfile,
  validateProfile,
  providerConfigPath,
} from "./provider-registry.ts";
import { ExecComms } from "./exec-comms.ts";
import { isBoardConfigured } from "./board-config.ts";
import { initBoard, conveneBoard, startBoardPoller } from "./board.ts";
import { notifyAdmin, setAdminNotifier, logError } from "./error-handler.ts";
import { groupTicketsByColumn, TICKET_COLUMNS } from "./ticket-board.ts";
import { handleTicketApproval } from "../services/ticket-worker.ts";
import { sendTicketEmail } from "./resend-client.ts";
import { verifyLogin } from "./web-auth.ts";
import { handleWorkboardApi, renderWorkboard, renderWorkboardIndex } from "./dashboard-workboards.ts";

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = dirname(dirname(__filename));
const PORT = 3033;
// Only start the server / pollers when run directly (systemd entrypoint).
// When imported (e.g. by scripts/check-inline-js.ts) these side effects are skipped.
const RUN_SERVER = import.meta.main;
const NOVA_DIR = process.env.NOVA_DIR || process.env.RELAY_DIR || join(process.env.HOME || "~", ".nova");
const LOGS_DIR = join(PROJECT_ROOT, "logs");

// Database (local SQLite)
const supabase: Database = getDb();

// Wire admin notifier so alert notifications reach Telegram
const _botToken = process.env.TELEGRAM_BOT_TOKEN;
const _adminChatId = process.env.TELEGRAM_USER_ID || process.env.ADMIN_CHAT_ID;
if (_botToken && _adminChatId) {
  setAdminNotifier(async (msg: string) => {
    await fetch(`https://api.telegram.org/bot${_botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: _adminChatId, text: msg }),
    });
  });
}

const startTime = Date.now();

// ============================================================
// ALERT RULES — in-memory config with Telegram notifications
// ============================================================

const DEFAULT_ALERT_RULES = {
  cost_daily_threshold_usd: 10,   // alert if daily cost > $10
  error_rate_threshold_pct: 20,   // alert if error rate > 20% in last hour
  message_lag_seconds: 600,       // alert if no messages processed in 10 min
};
let alertRules = { ...DEFAULT_ALERT_RULES };
let lastLagAlertAt = 0;
const LAG_ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

async function checkAlertRules(): Promise<void> {
  try {
    // 1. Daily cost check
    const today = new Date().toISOString().slice(0, 10);
    const costRow = supabase.raw
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_tracking WHERE date(created_at) = ?")
      .get(today) as { total: number } | undefined;
    const dailyCost = costRow?.total ?? 0;
    if (dailyCost > alertRules.cost_daily_threshold_usd) {
      await notifyAdmin(`[Nova Alert] Daily cost spike: $${dailyCost.toFixed(4)} exceeds threshold of $${alertRules.cost_daily_threshold_usd}`);
    }

    // 2. Error rate check (last hour)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const totalRow = supabase.raw
      .prepare("SELECT COUNT(*) as cnt FROM logs WHERE created_at >= ?")
      .get(oneHourAgo) as { cnt: number } | undefined;
    const errorRow = supabase.raw
      .prepare("SELECT COUNT(*) as cnt FROM logs WHERE level = 'error' AND created_at >= ?")
      .get(oneHourAgo) as { cnt: number } | undefined;
    const total = totalRow?.cnt ?? 0;
    const errors = errorRow?.cnt ?? 0;
    if (total > 0) {
      const errorPct = (errors / total) * 100;
      if (errorPct > alertRules.error_rate_threshold_pct) {
        await notifyAdmin(`[Nova Alert] High error rate: ${errorPct.toFixed(1)}% (${errors}/${total} events in last hour) exceeds threshold of ${alertRules.error_rate_threshold_pct}%`);
      }
    }

    // 3. Pending work check — only alert when there's actual stale actionable work,
    // not just because the user hasn't sent a message recently.
    const nowET = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const etHour = nowET.getHours();
    const inQuietHours = etHour >= 0 && etHour < 8;
    if (!inQuietHours && Date.now() - lastLagAlertAt > LAG_ALERT_COOLDOWN_MS) {
      const users = supabase.getAllActiveUsers();
      const pendingItems: string[] = [];

      for (const user of users) {
        try {
          const udb = supabase.getUserRaw(user.id);

          // Approvals waiting > 1 hour
          const staleApprovals = udb.query(`
            SELECT COUNT(*) as cnt FROM pending_approvals
            WHERE status = 'pending' AND expires_at > datetime('now')
              AND created_at <= datetime('now', '-1 hour')
          `).get() as { cnt: number };
          if (staleApprovals.cnt > 0) {
            pendingItems.push(`${staleApprovals.cnt} approval(s) awaiting response`);
          }

          // Agent tasks stuck in_progress > 2 hours
          const stuckTasks = udb.query(`
            SELECT COUNT(*) as cnt FROM agent_tasks
            WHERE status = 'in_progress' AND updated_at <= datetime('now', '-2 hours')
          `).get() as { cnt: number };
          if (stuckTasks.cnt > 0) {
            pendingItems.push(`${stuckTasks.cnt} task(s) stuck in progress > 2h`);
          }

          // Scheduled tasks due but never run (missed by scheduler)
          const missedScheduled = udb.query(`
            SELECT COUNT(*) as cnt FROM scheduled_tasks
            WHERE status = 'active' AND trigger_at <= datetime('now', '-15 minutes')
              AND last_run_at IS NULL
          `).get() as { cnt: number };
          if (missedScheduled.cnt > 0) {
            pendingItems.push(`${missedScheduled.cnt} scheduled task(s) missed`);
          }
        } catch {}
      }

      if (pendingItems.length > 0) {
        lastLagAlertAt = Date.now();
        await notifyAdmin(`[Nova Alert] Pending work needs attention:\n• ${pendingItems.join("\n• ")}`);
      }
    }
  } catch (e: any) {
    console.error("[dashboard] checkAlertRules error:", e.message);
  }
}

if (RUN_SERVER && process.env.NODE_ENV !== "test") {
  setInterval(checkAlertRules, 5 * 60 * 1000); // every 5 minutes
}

// Initialize event bus so SSE listeners are registered
initEventBus({ db: supabase });

// Initialize AI provider and orchestrator for dashboard chat
const claudeProvider = new ClaudeProvider();
registerProvider(claudeProvider);

async function dashboardCallAI(prompt: string, model?: any, userId?: string): Promise<string> {
  const provider = getProvider("claude");
  if (!provider) throw new Error("No AI provider available");
  const result = await provider.call({ prompt, model: model || "standard" });
  return result.text;
}

function dashboardBuildPrompt(user: any, userMessage: string): { systemPrompt: string; userPrompt: string } {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: user.timezone || "UTC",
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

  const systemPrompt = "You are Nova, a multi-agent AI assistant.";

  const userPrompt = `Current time: ${timeStr}.

## User Message
${userMessage}`;

  return { systemPrompt, userPrompt };
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

if (RUN_SERVER && isBoardConfigured()) {
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
const DASHBOARD_PASS = process.env.DASHBOARD_PASS;
if (!DASHBOARD_PASS) {
  console.error("[dashboard] DASHBOARD_PASS is not set — dashboard login is disabled for security. Set DASHBOARD_PASS in .env to enable it.");
}
// Refuse to expose an unauthenticated dashboard: without a password, bind loopback-only
// regardless of what the environment otherwise implies. An explicit DASHBOARD_HOST always wins.
export function computeBindHost(env: Record<string, string | undefined>): string | undefined {
  if (env.DASHBOARD_HOST) return env.DASHBOARD_HOST;      // explicit override always wins
  if (!env.DASHBOARD_PASS) return "127.0.0.1";            // no password → loopback only
  return undefined;                                        // authenticated → all interfaces (Bun default)
}
const BIND_HOST: string | undefined = computeBindHost(process.env);
if (!DASHBOARD_PASS && !process.env.DASHBOARD_HOST) {
  console.warn("[security] Dashboard has no DASHBOARD_PASS — binding to 127.0.0.1 (loopback) to avoid exposing it unauthenticated. Set DASHBOARD_PASS to serve on all interfaces.");
}
// The loopback fallback above only fires when DASHBOARD_HOST is unset. If an operator explicitly
// sets DASHBOARD_HOST to a non-loopback address with no password, that case is otherwise silent —
// the dashboard runs as its own process, so relay's startup warnings never fire here.
if (!DASHBOARD_PASS && BIND_HOST && !/^(127\.|localhost|::1|0:0:0:0:0:0:0:1)/.test(BIND_HOST)) {
  console.warn(`[security] Dashboard is bound to ${BIND_HOST} with no DASHBOARD_PASS — it is reachable UNAUTHENTICATED. Set DASHBOARD_PASS, or bind DASHBOARD_HOST to 127.0.0.1.`);
}
const DASHBOARD_BASE = process.env.DASHBOARD_BASE ?? "/dashboard";
const COOKIE_PATH = "/"; // Always root path so cookie works across /dashboard, /kanban, etc.
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-memory session store (survives for container lifetime)
const sessions = new Map<string, { userId: string; role: string; expiresAt: number }>();

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

// Login brute-force protection — 5 attempts per 15 minutes per IP
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

function checkLoginRateLimit(ip: string): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const record = loginAttempts.get(ip);

  if (!record || now > record.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return { allowed: true, retryAfterMs: 0 };
  }

  if (record.count >= LOGIN_MAX_ATTEMPTS) {
    return { allowed: false, retryAfterMs: record.resetAt - now };
  }

  record.count++;
  return { allowed: true, retryAfterMs: 0 };
}

function resetLoginRateLimit(ip: string): void {
  loginAttempts.delete(ip);
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
  for (const [ip, record] of loginAttempts.entries()) {
    if (now > record.resetAt) loginAttempts.delete(ip);
  }
}, 30 * 60 * 1000); // every 30 min

function generateSessionId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function getSessionUser(req: Request): { userId: string; role: string } | null {
  const cookie = req.headers.get("cookie") || "";
  const match = cookie.match(/nova_session=([a-f0-9]+)/);
  if (!match) return null;
  const session = sessions.get(match[1]);
  if (!session || session.expiresAt < Date.now()) {
    if (match[1]) sessions.delete(match[1]);
    return null;
  }
  return { userId: session.userId, role: session.role };
}

function isAuthenticated(req: Request): boolean | "no_password" {
  if (!DASHBOARD_PASS) return "no_password"; // No password set = show warning
  return getSessionUser(req) !== null;
}

/** Pure helper — true when a session role string is "admin". Exported for unit testing. */
export function isAdminRole(role: string | undefined): boolean {
  return role === "admin";
}

/** Returns the role string if it is a valid WhatsApp contact role, otherwise null. */
export function validateContactRole(role: string): string | null {
  const VALID_ROLES = ["allowed", "blocked", "vip"];
  return VALID_ROLES.includes(role) ? role : null;
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

function loginPage(error?: string, returnTo?: string): Response {
  const errorHtml = error ? `<div class="error">${error}</div>` : "";
  const returnField = returnTo && returnTo !== "/" ? `<input type="hidden" name="returnTo" value="${returnTo.replace(/"/g, "&quot;")}">` : "";
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
      ${returnField}
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
    status: 200,
    headers: { "Content-Type": "text/html" },
  });
}

async function handleLogin(req: Request): Promise<Response> {
  if (!DASHBOARD_PASS) {
    return new Response("Dashboard login not configured", { status: 503 });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  const rateCheck = checkLoginRateLimit(ip);
  if (!rateCheck.allowed) {
    const retryAfterSec = Math.ceil(rateCheck.retryAfterMs / 1000);
    return new Response("Too many login attempts. Try again later.", {
      status: 429,
      headers: { "Retry-After": String(retryAfterSec) },
    });
  }

  const body = await req.text();
  const params = new URLSearchParams(body);
  const username = params.get("username") || "";
  const password = params.get("password") || "";

  const auth = await verifyLogin(supabase, username, password);
  if (auth) {
    resetLoginRateLimit(ip);
    const sessionId = generateSessionId();
    sessions.set(sessionId, { userId: auth.userId, role: auth.role, expiresAt: Date.now() + SESSION_TTL_MS });
    const isSecure = req.url.startsWith("https") || req.headers.get("x-forwarded-proto") === "https";
    const securePart = isSecure ? "; Secure" : "";
    const rawReturnTo = params.get("returnTo") || "";
    const safePath = auth.mustChange ? "/account" : (rawReturnTo.startsWith("/") && !rawReturnTo.startsWith("//") ? rawReturnTo : "/");
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${DASHBOARD_BASE}${safePath === "/" ? "/" : safePath}`,
        "Set-Cookie": `nova_session=${sessionId}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=86400${securePart}`,
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

export async function changeOwnPassword(userId: string, currentPw: string, newPw: string): Promise<{ ok: boolean; error?: string }> {
  const { hashPassword, verifyPassword } = await import("./web-auth.ts");
  if (!newPw || newPw.length < 8) return { ok: false, error: "New password must be at least 8 characters" };
  const user = supabase.getUserById(userId);
  if (!user) return { ok: false, error: "User not found" };
  if (user.password_hash && !(await verifyPassword(currentPw, user.password_hash))) {
    return { ok: false, error: "Current password is incorrect" };
  }
  supabase.setUserPassword(userId, await hashPassword(newPw), false);
  return { ok: true };
}

// ============================================================
// ADMIN USER MANAGEMENT
// ============================================================

function genTempPassword(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(9)), b => b.toString(36).padStart(2, "0")).join("").slice(0, 14);
}

export async function adminCreateUser(opts: { name: string; username: string; telegram_id: string; role: string }): Promise<{ ok: boolean; tempPassword?: string; userId?: string; error?: string }> {
  const { hashPassword } = await import("./web-auth.ts");
  if (!opts.username || !opts.name || !opts.telegram_id) return { ok: false, error: "name, username, telegram_id required" };
  if (supabase.getUserByUsername(opts.username)) return { ok: false, error: "username already taken" };
  const userId = supabase.upsertUser({ telegram_id: opts.telegram_id, name: opts.name, role: opts.role === "admin" ? "admin" : "member" }).id;
  supabase.setUsername(userId, opts.username);
  const tempPassword = genTempPassword();
  supabase.setUserPassword(userId, await hashPassword(tempPassword), true);
  return { ok: true, tempPassword, userId };
}

export async function adminResetPassword(userId: string): Promise<{ ok: boolean; tempPassword?: string }> {
  const { hashPassword } = await import("./web-auth.ts");
  const user = supabase.getUserById(userId);
  if (!user) return { ok: false };
  const tempPassword = genTempPassword();
  supabase.setUserPassword(userId, await hashPassword(tempPassword), true);
  return { ok: true, tempPassword };
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
    const mcpConfig = JSON.parse(await readFile(join(PROJECT_ROOT, ".mcp.nova.json"), "utf-8"));
    for (const [name] of Object.entries(mcpConfig.mcpServers || {})) {
      mcpIntegrations.push({ name, type: "cli" });
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

async function getLearnedSkillsHandler(userId: string): Promise<unknown> {
  try {
    const skills = supabase.getLearnedSkills(userId);
    return { skills: skills || [] };
  } catch (e: any) {
    return { skills: [], error: e.message };
  }
}

async function deleteLearnedSkillHandler(userId: string, slug: string): Promise<unknown> {
  try {
    // Fetch skill first to get skill_path for file deletion
    const skills = supabase.getLearnedSkills(userId);
    const skill = skills.find((s: any) => s.slug === slug);

    supabase.deleteLearnedSkill(userId, slug);

    // Remove skill .md file if it exists
    if (skill && skill.skill_path) {
      try {
        const { unlinkSync } = await import("fs");
        unlinkSync(skill.skill_path);
      } catch {
        // File may not exist — not fatal
      }
    }

    return { success: true };
  } catch (e: any) {
    return { error: e.message };
  }
}

async function getTaskHistoryHandler(userId: string): Promise<unknown> {
  try {
    const parents = supabase.getParentTasks(userId);
    if (parents.length === 0) return { tasks: [] };

    const parentIds = parents.map((t: any) => t.id);
    const subtasks = supabase.getSubtasksByParentIds(parentIds);

    const totalMap: Record<string, number> = {};
    const doneMap: Record<string, number> = {};
    for (const st of subtasks || []) {
      const pid = st.parent_task_id;
      totalMap[pid] = (totalMap[pid] || 0) + 1;
      const ns = (st.status || "").toLowerCase();
      if (ns === "done" || ns === "completed") {
        doneMap[pid] = (doneMap[pid] || 0) + 1;
      }
    }

    const tasks = parents.map((t: any) => ({
      ...t,
      subtask_total: totalMap[t.id] || 0,
      subtask_done: doneMap[t.id] || 0,
    }));

    const activeStatuses = ["in_progress", "running", "executing", "pending", "blocked"];
    tasks.sort((a: any, b: any) => {
      const aActive = activeStatuses.includes((a.status || "").toLowerCase()) ? 0 : 1;
      const bActive = activeStatuses.includes((b.status || "").toLowerCase()) ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

    return { tasks };
  } catch (e: any) {
    return { tasks: [], error: e.message };
  }
}

async function getTaskDetailHandler(userId: string, taskId: string): Promise<unknown> {
  try {
    const task = supabase.getTaskById(taskId, userId);
    if (!task) return { error: "Task not found" };

    const subtasks = supabase.getSubtasksByParentIds([taskId]);
    const allTaskIds = [taskId, ...(subtasks || []).map((s: any) => s.id)];
    const artifacts = supabase.getArtifactsByTaskIds(allTaskIds);

    return { task, subtasks: subtasks || [], artifacts: artifacts || [] };
  } catch (e: any) {
    return { error: e.message };
  }
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

    // Cache and pool metrics (Claude subscription SDK pool: $200/month)
    const SDK_POOL_LIMIT_USD = 200;
    const claudeMonthly = (monthlyData || []).filter((r: any) => r.provider === "claude");
    const mtdClaudeCost = claudeMonthly.reduce((s: number, r: any) => s + (r.cost_usd || 0), 0);
    const cacheReadTokensMtd = claudeMonthly.reduce((s: number, r: any) => s + (r.cache_read_tokens || 0), 0);
    const cacheCreationTokensMtd = claudeMonthly.reduce((s: number, r: any) => s + (r.cache_creation_tokens || 0), 0);
    const totalInputTokensMtd = claudeMonthly.reduce((s: number, r: any) => s + (r.input_tokens || 0), 0);
    // Savings = tokens served from cache × (full input price − cache read price) / 1M
    const cacheSavingsUsd = (cacheReadTokensMtd * (3.0 - 0.30)) / 1_000_000;
    const cacheHitRatePct = totalInputTokensMtd > 0
      ? Math.round((cacheReadTokensMtd / totalInputTokensMtd) * 1000) / 10
      : 0;

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
      sdkPool: {
        limit_usd: SDK_POOL_LIMIT_USD,
        used_usd: Math.round(mtdClaudeCost * 10000) / 10000,
        used_pct: Math.round((mtdClaudeCost / SDK_POOL_LIMIT_USD) * 1000) / 10,
        cache_read_tokens_mtd: cacheReadTokensMtd,
        cache_creation_tokens_mtd: cacheCreationTokensMtd,
        total_input_tokens_mtd: totalInputTokensMtd,
        cache_savings_usd_estimated: Math.round(cacheSavingsUsd * 10000) / 10000,
        cache_hit_rate_pct: cacheHitRatePct,
      },
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

async function resolveApproval(id: string, action: string, feedback?: string, userId?: string): Promise<unknown> {
  try {
    const statusMap: any = { approve: "approved", cancel: "cancelled", revise: "revised" };
    const status = statusMap[action];
    if (!status) throw new Error("Invalid action");

    supabase.updateApprovalStatus(id, status, feedback || null, userId);

    // Note: The actual execution of approved tasks is handled by the orchestrator polling
    // or by the bot process if it receives an event.
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ── Governance control plane ────────────────────────────────────────────────

export async function getAutonomyView(userId: string): Promise<unknown> {
  try {
    return { grants: supabase.listAutonomyGrants(userId) };
  } catch (e: any) {
    return { grants: [], error: e.message };
  }
}

export async function setAutonomyGrantView(userId: string, body: any): Promise<unknown> {
  try {
    const agent = String(body?.agent || "").trim().toLowerCase();
    const actionType = String(body?.action_type || body?.actionType || "").trim();
    if (!agent || !actionType) return { error: "agent and action_type are required" };
    const level = Number(body?.level);
    if (!Number.isInteger(level) || level < 0 || level > 3) {
      return { error: "level must be an integer 0-3" };
    }
    const capAction = normalizeCap(body?.spend_cap_action ?? body?.spendCapAction);
    const capDaily = normalizeCap(body?.spend_cap_daily ?? body?.spendCapDaily);
    if (capAction === "invalid" || capDaily === "invalid") {
      return { error: "spend caps must be non-negative numbers" };
    }
    const grant = supabase.setAutonomyGrant(userId, {
      agent,
      action_type: actionType,
      level,
      spend_cap_action: capAction,
      spend_cap_daily: capDaily,
    });
    return { ok: true, grant };
  } catch (e: any) {
    return { error: e.message };
  }
}

function normalizeCap(v: unknown): number | null | "invalid" {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return "invalid";
  return n;
}

export async function getBudgetsView(userId: string): Promise<unknown> {
  try {
    const summary = supabase.getCostSummary(userId);
    const dailyCap = envNum("NOVA_DAILY_BUDGET_USD");
    const monthlyCap = envNum("NOVA_MONTHLY_BUDGET_USD");

    // Per-agent spend today from the action ledger (consequential actions).
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const grants = safe(() => supabase.listAutonomyGrants(userId), []);
    const actions = safe(() => supabase.getActions(userId, { limit: 500 }), []);
    const spendByAgent: Record<string, number> = {};
    for (const a of actions) {
      if (a.created_at && new Date(a.created_at) < todayStart) continue;
      spendByAgent[a.agent] = (spendByAgent[a.agent] || 0) + (a.cost_usd || 0);
    }
    const perAgent = grants
      .filter((g: any) => g.spend_cap_daily != null)
      .map((g: any) => ({
        agent: g.agent,
        action_type: g.action_type,
        cap_daily: g.spend_cap_daily,
        spent_today: spendByAgent[g.agent] || 0,
      }));

    return {
      budgets: {
        today: summary.today,
        month: summary.month,
        allTime: summary.allTime,
        dailyCap,
        monthlyCap,
        dailyRemaining: dailyCap != null ? Math.max(0, dailyCap - summary.today) : null,
        monthlyRemaining: monthlyCap != null ? Math.max(0, monthlyCap - summary.month) : null,
        topAgents: summary.topAgents,
        perAgent,
      },
    };
  } catch (e: any) {
    return { budgets: null, error: e.message };
  }
}

export async function getGoalsView(userId: string): Promise<unknown> {
  try {
    const rows = supabase.getGoals(userId);
    const goals = rows.map((g: any) => {
      let notes: any[] = [];
      try {
        notes = JSON.parse(g.progress_notes || "[]");
      } catch {
        notes = [];
      }
      return {
        id: g.id,
        content: g.content,
        deadline: g.deadline || null,
        priority: g.priority ?? 0,
        created_at: g.created_at,
        last_reviewed_at: g.last_reviewed_at || null,
        progress_notes: notes.slice(-5),
        progress_count: notes.length,
      };
    });
    return { goals };
  } catch (e: any) {
    return { goals: [], error: e.message };
  }
}

function envNum(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
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

// ============================================================
// PROFILE HELPERS (ported from miniapp.ts, session-userId only)
// ============================================================

/** Pure allowlist filter for profile field updates. Exported for unit testing. */
export function updateProfileFields(fields: Record<string, any>): Record<string, any> {
  const allowed = ["name", "timezone", "phone", "ai_provider"];
  const updates: Record<string, any> = {};
  for (const key of allowed) {
    if (fields[key] !== undefined) updates[key] = fields[key];
  }
  return updates;
}

export function safeUserProjection(user: Record<string, any> | null | undefined): Record<string, any> | null {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    timezone: user.timezone,
    phone: user.phone,
    ai_provider: user.ai_provider,
    role: user.role,
    preferences: user.preferences,
  };
}

async function getProfile(userId: string): Promise<unknown> {
  try {
    const user = supabase.getUserById(userId);
    const prefs = user?.preferences || {};
    // Safe projection — never leak password_hash, username, must_change_password, or tokens.
    const safeUser = user ? {
      id: user.id, name: user.name, timezone: user.timezone, phone: user.phone,
      ai_provider: user.ai_provider, role: user.role, preferences: user.preferences,
    } : null;
    return {
      user: safeUser,
      preferences: {
        voice_responses: prefs.voice_responses ?? false,
        auto_approve: prefs.auto_approve ?? false,
        notification_style: prefs.notification_style ?? "normal",
        language: prefs.language ?? "en",
      },
      error: null,
    };
  } catch (e: any) {
    return { error: e.message };
  }
}

async function updateProfile(userId: string, fields: Record<string, any>): Promise<unknown> {
  try {
    const updates = updateProfileFields(fields);
    if (Object.keys(updates).length === 0) return { error: "No valid fields to update" };
    const user = supabase.updateUser(userId, updates);
    return { user: safeUserProjection(user) };
  } catch (e: any) {
    return { error: e.message };
  }
}

async function updatePreferences(userId: string, fields: Record<string, any>): Promise<unknown> {
  try {
    const allowed = ["voice_responses", "notification_style", "language", "auto_approve"];
    const updates: Record<string, any> = {};
    for (const key of allowed) {
      if (fields[key] !== undefined) updates[key] = fields[key];
    }
    if (Object.keys(updates).length === 0) return { error: "No valid fields to update" };
    for (const [key, value] of Object.entries(updates)) {
      supabase.updateUserPreference(userId, key, value);
    }
    const user = supabase.getUserById(userId);
    return { preferences: user?.preferences || updates };
  } catch (e: any) {
    return { error: e.message };
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

    const audioBuffer = Buffer.from(await audioFile.arrayBuffer());
    const text = await transcribe(audioBuffer);

    return jsonResponse({ success: true, text });
  } catch (e: any) {
    return jsonResponse({ success: false, error: e.message }, 400);
  }
}

// ============================================================
// SCHEDULES HANDLERS (ported from miniapp.ts, session-userId only)
// ============================================================

async function getSchedules(userId: string): Promise<unknown> {
  try {
    const data = supabase.getScheduledTasks(userId);
    return { schedules: data || [] };
  } catch (e: any) {
    return { schedules: [], error: e.message };
  }
}

async function cancelSchedule(userId: string, scheduleId: string): Promise<unknown> {
  try {
    supabase.updateScheduledTask(scheduleId, { status: "cancelled" }, userId);
    return { success: true };
  } catch (e: any) {
    return { error: e.message };
  }
}

async function createSchedule(userId: string, body: Record<string, any>): Promise<unknown> {
  const { title, instructions, trigger_at, recur_rule } = body;
  if (!title || !instructions) return { error: "title and instructions are required" };
  try {
    const id = supabase.insertScheduledTask({
      user_id: userId,
      created_by: "user",
      title,
      instructions,
      trigger_at: trigger_at || null,
      recurrence: recur_rule || null,
    });
    return { success: true, id };
  } catch (e: any) {
    return { error: e.message };
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
    const rows = supabase.sharedDb.db.query(
      `SELECT * FROM logs WHERE event LIKE 'board.%' ORDER BY created_at DESC LIMIT 20`
    ).all();
    return { sessions: rows };
  } catch {
    return { sessions: [] };
  }
}

async function getActiveDelegations(): Promise<unknown> {
  try {
    const rows = supabase.sharedDb.db.query(
      `SELECT * FROM logs WHERE event = 'exec.delegation' ORDER BY created_at DESC LIMIT 20`
    ).all();
    return { delegations: rows };
  } catch {
    return { delegations: [] };
  }
}

// ============================================================
// SUPPORT TICKET KANBAN
// ============================================================

function ticketOperatorId(): string {
  return process.env.TICKET_OPERATOR_USER_ID || "";
}

async function getTicketBoardData(): Promise<unknown> {
  const op = ticketOperatorId();
  const dryRun = (process.env.TICKET_DEPLOY_DRYRUN || "true") === "true";
  if (!op) return { columns: groupTicketsByColumn([]).columns, columnMeta: TICKET_COLUMNS, operator: false, dryRun, count: 0 };
  try {
    const tickets = supabase.getRecentSupportTickets(op, 200) as any[];
    const { columns } = groupTicketsByColumn(tickets);
    return { columns, columnMeta: TICKET_COLUMNS, operator: true, dryRun, count: tickets.length };
  } catch (e: any) {
    return { columns: groupTicketsByColumn([]).columns, columnMeta: TICKET_COLUMNS, operator: true, dryRun, count: 0, error: e.message };
  }
}

async function actOnTicket(id: string, action: "approve" | "reject"): Promise<unknown> {
  const op = ticketOperatorId();
  if (!op) return { success: false, error: "TICKET_OPERATOR_USER_ID not configured" };
  const ticket = supabase.getSupportTicket(op, id);
  if (!ticket) return { success: false, error: "ticket not found" };
  if (ticket.status !== "awaiting_approval") return { success: false, error: `ticket is '${ticket.status}', not awaiting approval` };
  const dryRun = (process.env.TICKET_DEPLOY_DRYRUN || "true") === "true";
  try {
    await handleTicketApproval(supabase, op, id, action, { sendEmail: sendTicketEmail, dryRun });
    const updated = supabase.getSupportTicket(op, id);
    return { success: true, status: updated?.status ?? null, dryRun };
  } catch (e: any) {
    logError(e, "dashboard:ticket-approval");
    return { success: false, error: e.message };
  }
}

export function renderTicketBoard(): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nova — Support Tickets</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#06060b;--glass:rgba(255,255,255,.05);--border:rgba(255,255,255,.10);--text:rgba(255,255,255,.92);--dim:rgba(255,255,255,.55);--indigo:#6366f1;--amber:#f59e0b;--green:#22c55e;--red:#ef4444;--slate:#6b7280}
  body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);padding:18px;min-height:100vh}
  header{display:flex;align-items:center;gap:14px;margin-bottom:16px}
  header h1{font-size:18px;font-weight:700}
  a.back{color:var(--dim);text-decoration:none;font-size:13px}
  .pill{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--border)}
  .pill.dry{background:rgba(245,158,11,.15);color:var(--amber);border-color:rgba(245,158,11,.3)}
  .pill.live{background:rgba(34,197,94,.15);color:var(--green);border-color:rgba(34,197,94,.3)}
  .board{display:grid;grid-template-columns:repeat(5,minmax(220px,1fr));gap:12px;align-items:start}
  .col{background:var(--glass);border:1px solid var(--border);border-radius:12px;padding:10px;min-height:120px}
  .col h2{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin-bottom:10px;display:flex;justify-content:space-between}
  .col h2 .cnt{color:var(--text)}
  .card{background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:9px;padding:10px;margin-bottom:9px;cursor:pointer;transition:border-color .15s}
  .card:hover{border-color:rgba(255,255,255,.22)}
  .card .subj{font-size:13px;font-weight:600;line-height:1.3;margin-bottom:5px}
  .card .meta{font-size:11px;color:var(--dim);display:flex;flex-wrap:wrap;gap:6px;align-items:center}
  .badge{font-size:10px;padding:1px 6px;border-radius:6px;border:1px solid var(--border)}
  .badge.sev-high,.badge.sev-urgent{color:var(--red);border-color:rgba(239,68,68,.4)}
  .badge.sev-normal{color:var(--dim)}
  .detail{margin-top:9px;padding-top:9px;border-top:1px solid var(--border);font-size:11px;color:var(--dim);display:none}
  .detail.open{display:block}
  .detail pre{background:#000;border:1px solid var(--border);border-radius:6px;padding:7px;margin:5px 0;font-family:'JetBrains Mono',monospace;font-size:10.5px;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow:auto}
  .detail .err{color:var(--red)}
  .actions{display:flex;gap:7px;margin-top:9px}
  .btn{flex:1;font-size:12px;font-weight:600;padding:7px;border-radius:7px;border:1px solid var(--border);cursor:pointer;background:transparent;color:var(--text)}
  .btn.approve{background:rgba(34,197,94,.15);color:var(--green);border-color:rgba(34,197,94,.35)}
  .btn.reject{background:rgba(239,68,68,.12);color:var(--red);border-color:rgba(239,68,68,.3)}
  .btn:disabled{opacity:.5;cursor:default}
  .empty{color:var(--text);opacity:.25;font-size:12px;text-align:center;padding:14px 0}
  .note{font-size:12px;color:var(--dim);margin-bottom:14px;max-width:760px;line-height:1.5}
</style></head><body>
<header>
  <a class="back" href="/">← Dashboard</a>
  <h1>Support Tickets</h1>
  <span class="pill" id="modePill">…</span>
  <span class="pill" id="cntPill"></span>
  <span style="margin-left:auto;font-size:11px;color:var(--dim)" id="updated"></span>
</header>
<div class="note" id="opNote" style="display:none">No <code>TICKET_OPERATOR_USER_ID</code> configured — set it in the server <code>.env</code> for the ticket worker and this board to show tickets.</div>
<div class="board" id="board"></div>
<script>
  var COLS = [];
  function esc(s){var d=document.createElement('div');d.textContent=(s==null?'':String(s));return d.innerHTML;}
  function rel(ts){if(!ts)return '';var t=new Date(ts.replace(' ','T')+(ts.indexOf('Z')<0&&ts.indexOf('+')<0?'Z':''));var s=Math.floor((Date.now()-t.getTime())/1000);if(isNaN(s))return esc(ts);if(s<60)return s+'s ago';if(s<3600)return Math.floor(s/60)+'m ago';if(s<86400)return Math.floor(s/3600)+'h ago';return Math.floor(s/86400)+'d ago';}
  function card(t, isApproval){
    var sev = (t.severity||'normal').toLowerCase();
    var det = '';
    if(t.branch_name) det += '<div>branch: <code>'+esc(t.branch_name)+'</code></div>';
    if(t.diff_summary) det += '<div>diff:</div><pre>'+esc(t.diff_summary)+'</pre>';
    if(t.test_results) det += '<div>tests:</div><pre>'+esc(String(t.test_results).slice(-1200))+'</pre>';
    if(t.deploy_result) det += '<div>deploy:</div><pre>'+esc(String(t.deploy_result).slice(-1200))+'</pre>';
    if(t.last_error) det += '<div class="err">error: '+esc(t.last_error)+'</div>';
    if(t.body_raw) det += '<div style="margin-top:6px">message:</div><pre>'+esc(String(t.body_raw).slice(0,800))+'</pre>';
    var actions = isApproval ? '<div class="actions"><button class="btn approve" onclick="act(event,\\''+esc(t.id)+'\\',\\'approve\\')">Approve</button><button class="btn reject" onclick="act(event,\\''+esc(t.id)+'\\',\\'reject\\')">Reject</button></div>' : '';
    return '<div class="card" onclick="this.querySelector(&quot;.detail&quot;).classList.toggle(&quot;open&quot;)">'
      +'<div class="subj">'+esc(t.subject||'(no subject)')+'</div>'
      +'<div class="meta"><span>'+esc(t.client_name||t.client_email)+'</span>'
      +(t.classification?'<span class="badge">'+esc(t.classification)+'</span>':'')
      +'<span class="badge sev-'+esc(sev)+'">'+esc(sev)+'</span>'
      +'<span style="margin-left:auto">'+rel(t.updated_at||t.created_at)+'</span></div>'
      +'<div class="detail">'+det+actions+'</div></div>';
  }
  function act(ev, id, action){
    ev.stopPropagation();
    var btns = ev.target.parentNode.querySelectorAll('button'); btns.forEach(function(b){b.disabled=true;});
    ev.target.textContent = '…';
    fetch('/api/tickets/'+encodeURIComponent(id)+'/'+action,{method:'POST'}).then(function(r){return r.json();}).then(function(j){
      if(!j.success){alert('Failed: '+(j.error||'unknown')); btns.forEach(function(b){b.disabled=false;});}
      load();
    }).catch(function(){btns.forEach(function(b){b.disabled=false;});});
  }
  function load(){
    fetch('/api/tickets').then(function(r){return r.json();}).then(function(d){
      document.getElementById('opNote').style.display = d.operator ? 'none' : 'block';
      var mp=document.getElementById('modePill'); mp.textContent = d.dryRun?'DRY-RUN':'LIVE DEPLOY'; mp.className='pill '+(d.dryRun?'dry':'live');
      document.getElementById('cntPill').textContent = (d.count||0)+' tickets';
      document.getElementById('updated').textContent = 'updated '+new Date().toLocaleTimeString();
      COLS = d.columnMeta||[];
      var board=document.getElementById('board'); board.innerHTML='';
      COLS.forEach(function(c){
        var items = (d.columns&&d.columns[c.key])||[];
        var isApproval = c.key==='awaiting_approval';
        var html='<div class="col"><h2>'+esc(c.label)+'<span class="cnt">'+items.length+'</span></h2>';
        html += items.length ? items.map(function(t){return card(t,isApproval);}).join('') : '<div class="empty">—</div>';
        html+='</div>'; board.insertAdjacentHTML('beforeend',html);
      });
    }).catch(function(e){console.error(e);});
  }
  load(); setInterval(load, 5000);
</script></body></html>`;
}

async function getKanbanData(userId?: string): Promise<unknown> {
  const columns: Record<string, any[]> = {
    pending: [],
    in_progress: [],
    completed: [],
    blocked: [],
  };
  try {
    const tasksResult = await getAgentTasks(userId) as any;
    for (const t of tasksResult.tasks || []) {
      let col = t.status || "pending";
      if (col === "done") col = "completed";
      if (col === "cancelled" || col === "failed") col = "blocked";
      if (!columns[col]) col = "pending";
      columns[col].push({
        id: t.id,
        source: "task",
        agent: t.agent || "general",
        description: t.description || "",
        status: t.status || "pending",
        result: t.result || null,
        created_at: t.created_at,
        updated_at: t.updated_at,
      });
    }
  } catch { /* ignore */ }

  try {
    const delegResult = await getActiveDelegations() as any;
    for (const row of delegResult.delegations || []) {
      let meta: any = {};
      try { meta = typeof row.metadata === "string" ? JSON.parse(row.metadata) : (row.metadata || {}); } catch { /**/ }
      const rawStatus: string = meta.status || "pending";
      let col = rawStatus;
      if (col === "done") col = "completed";
      if (col === "failed" || col === "cancelled") col = "blocked";
      if (!columns[col]) col = "pending";
      columns[col].push({
        id: row.id,
        source: "delegation",
        agent: meta.agentSlug || meta.assigned_agent || "exec",
        description: meta.message || meta.task_description || row.message || "",
        status: rawStatus,
        result: meta.result || null,
        created_at: row.created_at,
        updated_at: row.created_at,
      });
    }
  } catch { /* ignore */ }

  return { columns };
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
  return supabase.sharedDb.db.query(
    `SELECT id, created_at, level, event, message, metadata, user_id FROM logs ${where} ORDER BY created_at DESC LIMIT ?`
  ).all(...params, limit) as any[];
}

async function getTrace(requestId: string): Promise<any[]> {
  // Escape LIKE wildcards to prevent pattern injection
  const escaped = requestId.replace(/[%_\\]/g, (c) => `\\${c}`);
  return supabase.sharedDb.db.query(
    `SELECT id, created_at, level, event, message, metadata, user_id FROM logs WHERE metadata LIKE ? ESCAPE '\\' ORDER BY created_at ASC`
  ).all(`%"requestId":"${escaped}"%`) as any[];
}

async function getCostBreakdown(period: string, groupBy: string): Promise<any[]> {
  // Whitelist values to prevent SQL injection
  const dayOffsets: Record<string, string> = { week: "-7 days", month: "-30 days", day: "-1 day" };
  const offset = dayOffsets[period] || "-1 day";
  const groupCol = groupBy === "provider" ? "provider" : "model";
  return supabase.sharedDb.db.query(
    `SELECT ${groupCol} as group_key, COUNT(*) as calls, SUM(cost_usd) as total_cost, SUM(input_tokens) as total_input, SUM(output_tokens) as total_output FROM cost_tracking WHERE created_at > datetime('now', ?) GROUP BY ${groupCol} ORDER BY total_cost DESC`
  ).all(offset) as any[];
}

// ============================================================
// ACCOUNT PAGE
// ============================================================

export function renderAccountPage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nova — Account</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#06060b;--glass:rgba(255,255,255,.05);--border:rgba(255,255,255,.10);--text:rgba(255,255,255,.92);--dim:rgba(255,255,255,.55);--indigo:#6366f1;--red:#ef4444;--green:#22c55e}
  body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);display:flex;align-items:center;justify-content:center;min-height:100vh;padding:18px}
  .box{background:var(--glass);border:1px solid var(--border);border-radius:14px;padding:2.2rem;width:380px}
  h1{font-size:1.15rem;font-weight:700;margin-bottom:1.6rem}
  label{display:block;font-size:0.75rem;text-transform:uppercase;letter-spacing:.5px;color:var(--dim);margin-bottom:.3rem}
  input{width:100%;padding:.65rem .85rem;background:rgba(255,255,255,.055);border:1px solid var(--border);color:var(--text);font-size:.9rem;border-radius:8px;outline:none;margin-bottom:1rem;font-family:inherit}
  input:focus{border-color:var(--indigo);box-shadow:0 0 0 3px rgba(99,102,241,.2)}
  button{width:100%;padding:.7rem;background:linear-gradient(135deg,#6366f1,#8b5cf6);border:none;color:#fff;font-weight:600;font-size:.9rem;border-radius:8px;cursor:pointer;font-family:inherit}
  button:hover{opacity:.9}
  .msg{margin-bottom:1rem;padding:.55rem .75rem;border-radius:8px;font-size:.85rem;display:none}
  .msg.ok{background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.35);color:var(--green)}
  .msg.err{background:rgba(239,68,68,.10);border:1px solid rgba(239,68,68,.3);color:var(--red)}
  .back{display:block;margin-bottom:1.4rem;color:var(--dim);text-decoration:none;font-size:.8rem}
  .back:hover{color:var(--text)}
  .hub-nav{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:1.4rem}
  .hub-link{color:var(--dim);text-decoration:none;font-size:.78rem;padding:4px 11px;border:1px solid var(--border);border-radius:7px;background:rgba(255,255,255,.04)}
  .hub-link:hover{color:var(--text);background:rgba(255,255,255,.08)}
</style></head><body>
<div class="box" style="width:440px">
  <nav class="hub-nav">
    <a class="hub-link" href="${DASHBOARD_BASE}/">Dashboard</a>
    <a class="hub-link" href="${DASHBOARD_BASE}/profile">Profile</a>
    <a class="hub-link" href="${DASHBOARD_BASE}/integrations">Integrations</a>
    <a class="hub-link" href="${DASHBOARD_BASE}/schedules">Schedules</a>
    <a class="hub-link" href="${DASHBOARD_BASE}/skills">Skills</a>
    <a class="hub-link" href="${DASHBOARD_BASE}/knowledge">Knowledge</a>
    <a class="hub-link" href="${DASHBOARD_BASE}/playbooks">Playbooks</a>
    <a class="hub-link" href="${DASHBOARD_BASE}/automations">Automations</a>
    <a class="hub-link" href="${DASHBOARD_BASE}/processes">Processes</a>
    <a class="hub-link" href="${DASHBOARD_BASE}/extraction">Extraction</a>
    <a class="hub-link" href="${DASHBOARD_BASE}/policies">Policies</a>
    <a class="hub-link" href="${DASHBOARD_BASE}/governance-admin">Governance Admin</a>
<a class="hub-link" href="${DASHBOARD_BASE}/roi">ROI</a>
    <a class="hub-link" href="${DASHBOARD_BASE}/data">Data</a>
    <a class="hub-link" href="${DASHBOARD_BASE}/activity">Activity</a>
    <a class="hub-link" href="${DASHBOARD_BASE}/deadletters">Dead letters</a>
    <a class="hub-link" href="${DASHBOARD_BASE}/connectors">Connectors</a>
    <a class="hub-link" href="${DASHBOARD_BASE}/history">History</a>
    <a class="hub-link" href="${DASHBOARD_BASE}/approvals">Approvals</a>
    <a class="hub-link" href="${DASHBOARD_BASE}/whatsapp">WhatsApp</a>
  </nav>
  <h1>Change Password</h1>
  <div class="msg" id="msg"></div>
  <form id="pwForm">
    <label>Current Password</label>
    <input type="password" id="current" autocomplete="current-password" required>
    <label>New Password</label>
    <input type="password" id="next" autocomplete="new-password" minlength="8" required>
    <button type="submit">Update Password</button>
  </form>
</div>
<script>
  var BASE = '${DASHBOARD_BASE}';
  function esc(s){var d=document.createElement('div');d.textContent=(s==null?'':String(s));return d.innerHTML;}
  document.getElementById('pwForm').addEventListener('submit', function(e) {
    e.preventDefault();
    var current = document.getElementById('current').value;
    var next = document.getElementById('next').value;
    var msg = document.getElementById('msg');
    msg.style.display = 'none';
    fetch(BASE + '/api/account/password', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({current: current, next: next})
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (data.ok) {
        msg.className = 'msg ok';
        msg.innerHTML = 'Password updated successfully.';
        msg.style.display = 'block';
        document.getElementById('pwForm').reset();
      } else {
        msg.className = 'msg err';
        msg.innerHTML = esc(data.error || 'Unknown error');
        msg.style.display = 'block';
      }
    }).catch(function(err) {
      msg.className = 'msg err';
      msg.innerHTML = esc(err.message || 'Request failed');
      msg.style.display = 'block';
    });
  });
</script>
</body></html>`;
}

// ============================================================
// INTEGRATIONS PAGE
// ============================================================

export function renderIntegrationsPage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nova — Integrations</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#06060b;--glass:rgba(255,255,255,.05);--border:rgba(255,255,255,.10);--text:rgba(255,255,255,.92);--dim:rgba(255,255,255,.55);--indigo:#6366f1;--green:#22c55e;--red:#ef4444}
  body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px;min-height:100vh}
  .wrap{max-width:660px;margin:0 auto}
  h1{font-size:1.15rem;font-weight:700;margin-bottom:1.4rem}
  .back{display:block;margin-bottom:1.2rem;color:var(--dim);text-decoration:none;font-size:.8rem}
  .back:hover{color:var(--text)}
  .row{background:var(--glass);border:1px solid var(--border);border-radius:10px;padding:12px 16px;margin-bottom:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .pname{font-weight:600;flex:1;min-width:120px;font-size:.9rem;text-transform:capitalize}
  .status{font-size:.75rem;padding:2px 8px;border-radius:999px;border:1px solid var(--border)}
  .status.ok{background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.3);color:var(--green)}
  .status.off{background:rgba(255,255,255,.04);color:var(--dim)}
  .btn{padding:5px 14px;border-radius:7px;border:1px solid var(--border);background:rgba(255,255,255,.06);color:var(--text);font-size:.78rem;cursor:pointer;font-family:inherit}
  .btn:hover{background:rgba(255,255,255,.10)}
  .btn.primary{background:var(--indigo);border-color:var(--indigo);color:#fff}
  .btn.primary:hover{opacity:.9}
  .key-input{flex:1;min-width:160px;padding:5px 10px;background:rgba(255,255,255,.055);border:1px solid var(--border);color:var(--text);font-size:.8rem;border-radius:7px;outline:none;font-family:inherit}
  .key-input:focus{border-color:var(--indigo)}
  .err{color:var(--red);font-size:.85rem}
  .dim{color:var(--dim);font-size:.85rem}
</style></head><body>
<div class="wrap">
  <a class="back" href="${DASHBOARD_BASE}/">← Dashboard</a>
  <h1>Integrations</h1>
  <div id="list"><p class="dim">Loading…</p></div>
</div>
<script>
  var BASE = '${DASHBOARD_BASE}';
  function esc(s){var d=document.createElement('div');d.textContent=(s==null?'':String(s));return d.innerHTML;}
  function escAttr(s){return esc(s).replace(/"/g,'&quot;');}
  var API_KEY_PROVIDERS = ['gohighlevel','clickup'];
  var listEl = document.getElementById('list');
  listEl.addEventListener('click',function(e){
    var btn = e.target;
    if(!btn||!btn.getAttribute){return;}
    var p = btn.getAttribute('data-provider');
    if(!p){return;}
    if(btn.classList.contains('action-connect')){connect(p);}
    else if(btn.classList.contains('action-disconnect')){disconnect(p);}
    else if(btn.classList.contains('action-save-key')){saveKey(p);}
  });
  function load(){
    fetch(BASE+'/api/integrations').then(function(r){return r.json();}).then(function(data){
      if(data.error){listEl.innerHTML='<p class="err">'+esc(data.error)+'</p>';return;}
      var items=data.integrations||[];
      var html='';
      items.forEach(function(item){
        var p=item.provider;
        var isConnected=item.status==='connected';
        var isApiKey=API_KEY_PROVIDERS.indexOf(p)>=0;
        html+='<div class="row">';
        html+='<span class="pname">'+esc(p)+'</span>';
        html+='<span class="status '+(isConnected?'ok':'off')+'">'+esc(item.status||'disconnected')+'</span>';
        if(isConnected){
          html+='<button class="btn action-disconnect" data-provider="'+escAttr(p)+'">Disconnect</button>';
        } else if(isApiKey){
          html+='<input class="key-input" data-provider="'+escAttr(p)+'" type="password" placeholder="API key">';
          html+='<button class="btn primary action-save-key" data-provider="'+escAttr(p)+'">Save Key</button>';
        } else {
          html+='<button class="btn primary action-connect" data-provider="'+escAttr(p)+'">Connect</button>';
        }
        html+='</div>';
      });
      listEl.innerHTML=html||'<p class="dim">No integrations found.</p>';
    }).catch(function(e){listEl.innerHTML='<p class="err">'+esc(e.message)+'</p>';});
  }
  function connect(p){
    fetch(BASE+'/api/integrations/'+encodeURIComponent(p)+'/connect',{method:'POST'})
      .then(function(r){return r.json();}).then(function(data){
        if(data.url){window.open(data.url,'_blank');}
        setTimeout(load,2000);
      }).catch(function(e){alert(e.message);});
  }
  function saveKey(p){
    var key='';
    var inputs=document.getElementsByClassName('key-input');
    for(var i=0;i<inputs.length;i++){
      if(inputs[i].getAttribute('data-provider')===p){key=inputs[i].value.trim();break;}
    }
    if(!key){alert('API key is required');return;}
    var creds;
    if(p==='clickup'){creds={api_token:key};}
    else if(p==='gohighlevel'){creds={bearer_token:key};}
    else{creds={api_key:key};}
    fetch(BASE+'/api/integrations/'+encodeURIComponent(p)+'/save-key',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({credentials:creds})
    }).then(function(r){return r.json();}).then(function(data){
      if(data.ok){load();}else{alert(data.error||'Save failed');}
    }).catch(function(e){alert(e.message);});
  }
  function disconnect(p){
    if(!confirm('Disconnect '+p+'?')){return;}
    fetch(BASE+'/api/integrations/'+encodeURIComponent(p)+'/disconnect',{method:'POST'})
      .then(function(r){return r.json();}).then(function(){load();})
      .catch(function(e){alert(e.message);});
  }
  load();
</script>
</body></html>`;
}

// ============================================================
// PROFILE PAGE
// ============================================================

export function renderProfilePage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nova — Profile</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#06060b;--glass:rgba(255,255,255,.05);--border:rgba(255,255,255,.10);--text:rgba(255,255,255,.92);--dim:rgba(255,255,255,.55);--indigo:#6366f1;--green:#22c55e;--red:#ef4444}
  body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px;min-height:100vh}
  .wrap{max-width:520px;margin:0 auto}
  h1{font-size:1.15rem;font-weight:700;margin-bottom:1.4rem}
  h2{font-size:.95rem;font-weight:600;margin:1.6rem 0 .8rem}
  .back{display:block;margin-bottom:1.2rem;color:var(--dim);text-decoration:none;font-size:.8rem}
  .back:hover{color:var(--text)}
  label{display:block;font-size:.8rem;color:var(--dim);margin-bottom:.3rem;margin-top:.9rem}
  label:first-of-type{margin-top:0}
  input[type=text],input[type=tel],select{width:100%;padding:7px 10px;background:rgba(255,255,255,.055);border:1px solid var(--border);color:var(--text);font-size:.85rem;border-radius:7px;outline:none;font-family:inherit}
  input[type=text]:focus,input[type=tel]:focus,select:focus{border-color:var(--indigo)}
  select option{background:#1a1a2e}
  .toggle-row{display:flex;align-items:center;justify-content:space-between;margin-top:.9rem}
  .toggle-row span{font-size:.8rem;color:var(--dim)}
  input[type=checkbox]{width:1rem;height:1rem;accent-color:var(--indigo)}
  .btn{margin-top:1.2rem;width:100%;padding:9px 0;border-radius:8px;border:none;background:var(--indigo);color:#fff;font-size:.88rem;cursor:pointer;font-family:inherit;font-weight:600}
  .btn:hover{opacity:.9}
  .msg{margin-bottom:1rem;padding:9px 12px;border-radius:8px;font-size:.82rem;display:none}
  .msg.ok{background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.3);color:var(--green)}
  .msg.err{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);color:var(--red)}
  .card{background:var(--glass);border:1px solid var(--border);border-radius:10px;padding:16px 18px;margin-bottom:16px}
</style></head><body>
<div class="wrap">
  <a class="back" href="${DASHBOARD_BASE}/">← Dashboard</a>
  <h1>Profile</h1>
  <div id="msg" class="msg"></div>
  <div class="card">
    <form id="profileForm">
      <label>Name</label>
      <input type="text" id="f-name" placeholder="Your name">
      <label>Timezone</label>
      <input type="text" id="f-timezone" placeholder="e.g. America/New_York">
      <label>Phone</label>
      <input type="tel" id="f-phone" placeholder="e.g. +15550000000">
      <label>AI Provider</label>
      <select id="f-ai_provider">
        <option value="">Default</option>
        <option value="claude">Claude</option>
        <option value="gemini">Gemini</option>
        <option value="codex">Codex</option>
      </select>
      <button type="submit" class="btn">Save Profile</button>
    </form>
  </div>
  <h2>Preferences</h2>
  <div class="card">
    <form id="prefsForm">
      <label class="toggle-row">
        <span>Voice Responses</span>
        <input type="checkbox" id="f-voice_responses">
      </label>
      <label class="toggle-row">
        <span>Auto Approve</span>
        <input type="checkbox" id="f-auto_approve">
      </label>
      <label>Notification Style</label>
      <select id="f-notification_style">
        <option value="normal">Normal</option>
        <option value="minimal">Minimal</option>
        <option value="verbose">Verbose</option>
      </select>
      <label>Language</label>
      <input type="text" id="f-language" placeholder="e.g. en">
      <button type="submit" class="btn">Save Preferences</button>
    </form>
  </div>
</div>
<script>
  var BASE = '${DASHBOARD_BASE}';
  function esc(s){var d=document.createElement('div');d.textContent=(s==null?'':String(s));return d.innerHTML;}
  function escAttr(s){return esc(s).replace(/"/g,'&quot;');}
  var msgEl = document.getElementById('msg');
  function showMsg(text, ok) {
    msgEl.className = 'msg ' + (ok ? 'ok' : 'err');
    msgEl.innerHTML = esc(text);
    msgEl.style.display = 'block';
    setTimeout(function(){msgEl.style.display='none';}, 3000);
  }
  function load() {
    fetch(BASE + '/api/profile').then(function(r){return r.json();}).then(function(data){
      if (data.error) { showMsg(data.error, false); return; }
      var u = data.user || {};
      var p = data.preferences || {};
      document.getElementById('f-name').value = u.name || '';
      document.getElementById('f-timezone').value = u.timezone || '';
      document.getElementById('f-phone').value = u.phone || '';
      var provEl = document.getElementById('f-ai_provider');
      provEl.value = u.ai_provider || '';
      document.getElementById('f-voice_responses').checked = !!p.voice_responses;
      document.getElementById('f-auto_approve').checked = !!p.auto_approve;
      document.getElementById('f-notification_style').value = p.notification_style || 'normal';
      document.getElementById('f-language').value = p.language || 'en';
    }).catch(function(e){showMsg(e.message || 'Load failed', false);});
  }
  document.getElementById('profileForm').addEventListener('submit', function(e) {
    e.preventDefault();
    var payload = {
      name: document.getElementById('f-name').value,
      timezone: document.getElementById('f-timezone').value,
      phone: document.getElementById('f-phone').value,
      ai_provider: document.getElementById('f-ai_provider').value
    };
    fetch(BASE + '/api/profile', {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload)
    }).then(function(r){return r.json();}).then(function(d){
      if (d.error) { showMsg(d.error, false); } else { showMsg('Profile saved', true); }
    }).catch(function(e){showMsg(e.message || 'Save failed', false);});
  });
  document.getElementById('prefsForm').addEventListener('submit', function(e) {
    e.preventDefault();
    var payload = {
      voice_responses: document.getElementById('f-voice_responses').checked,
      auto_approve: document.getElementById('f-auto_approve').checked,
      notification_style: document.getElementById('f-notification_style').value,
      language: document.getElementById('f-language').value
    };
    fetch(BASE + '/api/preferences', {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload)
    }).then(function(r){return r.json();}).then(function(d){
      if (d.error) { showMsg(d.error, false); } else { showMsg('Preferences saved', true); }
    }).catch(function(e){showMsg(e.message || 'Save failed', false);});
  });
  load();
</script>
</body></html>`;
}

// ============================================================
// SHARED CREDENTIALS PAGE (admin)
// ============================================================

export function renderSharedCredsPage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nova — Shared Credentials</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#06060b;--glass:rgba(255,255,255,.05);--border:rgba(255,255,255,.10);--text:rgba(255,255,255,.92);--dim:rgba(255,255,255,.55);--indigo:#6366f1;--red:#ef4444;--green:#22c55e}
  body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px;min-height:100vh}
  .wrap{max-width:660px;margin:0 auto}
  h1{font-size:1.15rem;font-weight:700;margin-bottom:1.4rem}
  h2{font-size:.78rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--dim);margin-bottom:.8rem}
  .back{display:block;margin-bottom:1.2rem;color:var(--dim);text-decoration:none;font-size:.8rem}
  .back:hover{color:var(--text)}
  .row{background:var(--glass);border:1px solid var(--border);border-radius:10px;padding:10px 14px;margin-bottom:8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .cell{font-size:.8rem;flex:1;min-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cell.dim{color:var(--dim)}
  .btn{padding:4px 12px;border-radius:7px;border:1px solid var(--border);background:rgba(255,255,255,.06);color:var(--text);font-size:.75rem;cursor:pointer;font-family:inherit}
  .btn:hover{background:rgba(255,255,255,.10)}
  .btn.del{border-color:rgba(239,68,68,.4);color:var(--red)}
  .btn.del:hover{background:rgba(239,68,68,.1)}
  .btn.primary{background:var(--indigo);border-color:var(--indigo);color:#fff}
  .btn.primary:hover{opacity:.9}
  .form-box{background:var(--glass);border:1px solid var(--border);border-radius:12px;padding:1.2rem;margin-top:1.6rem}
  label{display:block;font-size:.72rem;text-transform:uppercase;letter-spacing:.5px;color:var(--dim);margin-bottom:.25rem;margin-top:.7rem}
  label:first-child{margin-top:0}
  input,select,textarea{width:100%;padding:.5rem .75rem;background:rgba(255,255,255,.055);border:1px solid var(--border);color:var(--text);font-size:.85rem;border-radius:7px;outline:none;font-family:inherit}
  textarea{height:80px;resize:vertical}
  select option{background:#111}
  input:focus,select:focus,textarea:focus{border-color:var(--indigo)}
  .section{margin-bottom:1.4rem}
  .add-btn{margin-top:1rem;width:100%}
  .msg{padding:.45rem .75rem;border-radius:7px;font-size:.8rem;margin-top:.7rem;display:none}
  .msg.ok{background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.3);color:var(--green)}
  .msg.err{background:rgba(239,68,68,.10);border:1px solid rgba(239,68,68,.3);color:var(--red)}
  .err{color:var(--red);font-size:.85rem}
  .dim{color:var(--dim);font-size:.85rem}
</style></head><body>
<div class="wrap">
  <a class="back" href="${DASHBOARD_BASE}/">← Dashboard</a>
  <h1>Shared Credentials</h1>
  <div class="section">
    <h2>Existing</h2>
    <div id="list"><p class="dim">Loading…</p></div>
  </div>
  <div class="form-box">
    <h2>Add / Update</h2>
    <label>Provider</label>
    <input type="text" id="sc-provider" placeholder="e.g. notion, openai">
    <label>Kind</label>
    <select id="sc-kind">
      <option value="oauth">oauth</option>
      <option value="api_key">api_key</option>
      <option value="model_key">model_key</option>
    </select>
    <label>Credentials (JSON object or plain key value)</label>
    <textarea id="sc-creds" placeholder='{"api_key":"sk-..."} or just the key value'></textarea>
    <button class="btn primary add-btn" id="sc-add-btn">Add / Update</button>
    <div class="msg" id="sc-msg"></div>
  </div>
</div>
<script>
  var BASE = '${DASHBOARD_BASE}';
  function esc(s){var d=document.createElement('div');d.textContent=(s==null?'':String(s));return d.innerHTML;}
  function escAttr(s){return esc(s).replace(/"/g,'&quot;');}
  var listEl = document.getElementById('list');
  listEl.addEventListener('click',function(e){
    var btn = e.target;
    if(!btn||!btn.getAttribute){return;}
    var p = btn.getAttribute('data-provider');
    if(p&&btn.classList.contains('action-delete')){delCred(p);}
  });
  document.getElementById('sc-add-btn').addEventListener('click',addCred);
  function load(){
    fetch(BASE+'/api/shared-credentials').then(function(r){return r.json();}).then(function(data){
      if(data.error){listEl.innerHTML='<p class="err">'+esc(data.error)+'</p>';return;}
      var creds=data.credentials||[];
      if(!creds.length){listEl.innerHTML='<p class="dim">No shared credentials yet.</p>';return;}
      var html='';
      creds.forEach(function(c){
        html+='<div class="row">';
        html+='<span class="cell">'+esc(c.provider||'')+'</span>';
        html+='<span class="cell dim">'+esc(c.kind||'')+'</span>';
        html+='<span class="cell dim">'+esc(c.created_by||'')+'</span>';
        html+='<span class="cell dim">'+esc((c.updated_at||c.created_at||'').slice(0,10))+'</span>';
        html+='<button class="btn del action-delete" data-provider="'+escAttr(c.provider||'')+'">Delete</button>';
        html+='</div>';
      });
      listEl.innerHTML=html;
    }).catch(function(e){listEl.innerHTML='<p class="err">'+esc(e.message)+'</p>';});
  }
  function delCred(p){
    if(!confirm('Delete shared credential for '+p+'?')){return;}
    fetch(BASE+'/api/shared-credentials/'+encodeURIComponent(p),{method:'DELETE'})
      .then(function(r){return r.json();}).then(function(){load();})
      .catch(function(e){alert(e.message);});
  }
  function addCred(){
    var provider=document.getElementById('sc-provider').value.trim();
    var kind=document.getElementById('sc-kind').value;
    var rawCreds=document.getElementById('sc-creds').value.trim();
    var msg=document.getElementById('sc-msg');
    msg.style.display='none';
    if(!provider){msg.className='msg err';msg.textContent='Provider is required.';msg.style.display='block';return;}
    if(!rawCreds){msg.className='msg err';msg.textContent='Credentials are required.';msg.style.display='block';return;}
    var credentials;
    try{credentials=JSON.parse(rawCreds);}catch(jsonErr){credentials={value:rawCreds};}
    fetch(BASE+'/api/shared-credentials',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({provider:provider,kind:kind,credentials:credentials})
    }).then(function(r){return r.json();}).then(function(data){
      if(data.ok){
        msg.className='msg ok';msg.textContent='Saved.';msg.style.display='block';
        document.getElementById('sc-provider').value='';
        document.getElementById('sc-creds').value='';
        load();
      }else{
        msg.className='msg err';msg.textContent=data.error||'Save failed.';msg.style.display='block';
      }
    }).catch(function(e){msg.className='msg err';msg.textContent=e.message;msg.style.display='block';});
  }
  load();
</script>
</body></html>`;
}

// ============================================================
// SCHEDULES PAGE
// ============================================================

export function renderSchedulesPage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nova — Schedules</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#06060b;--glass:rgba(255,255,255,.05);--border:rgba(255,255,255,.10);--text:rgba(255,255,255,.92);--dim:rgba(255,255,255,.55);--indigo:#6366f1;--green:#22c55e;--red:#ef4444}
  body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px;min-height:100vh}
  .wrap{max-width:660px;margin:0 auto}
  h1{font-size:1.15rem;font-weight:700;margin-bottom:1.4rem}
  h2{font-size:.78rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--dim);margin:1.6rem 0 .8rem}
  .back{display:block;margin-bottom:1.2rem;color:var(--dim);text-decoration:none;font-size:.8rem}
  .back:hover{color:var(--text)}
  .row{background:var(--glass);border:1px solid var(--border);border-radius:10px;padding:12px 16px;margin-bottom:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .title{font-weight:600;flex:1;min-width:120px;font-size:.9rem}
  .meta{font-size:.75rem;color:var(--dim);flex:1;min-width:100px}
  .btn{padding:5px 14px;border-radius:7px;border:1px solid var(--border);background:rgba(255,255,255,.06);color:var(--text);font-size:.78rem;cursor:pointer;font-family:inherit}
  .btn:hover{background:rgba(255,255,255,.10)}
  .btn.danger{border-color:rgba(239,68,68,.4);color:var(--red)}
  .btn.danger:hover{background:rgba(239,68,68,.1)}
  .btn.primary{background:var(--indigo);border-color:var(--indigo);color:#fff}
  .btn.primary:hover{opacity:.9}
  .form-box{background:var(--glass);border:1px solid var(--border);border-radius:12px;padding:1.2rem;margin-top:.4rem}
  label{display:block;font-size:.72rem;text-transform:uppercase;letter-spacing:.5px;color:var(--dim);margin-bottom:.25rem;margin-top:.7rem}
  label:first-child{margin-top:0}
  input,textarea{width:100%;padding:.5rem .75rem;background:rgba(255,255,255,.055);border:1px solid var(--border);color:var(--text);font-size:.85rem;border-radius:7px;outline:none;font-family:inherit}
  textarea{height:80px;resize:vertical}
  input:focus,textarea:focus{border-color:var(--indigo)}
  .msg{margin-bottom:1rem;padding:9px 12px;border-radius:8px;font-size:.82rem;display:none}
  .msg.ok{background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.3);color:var(--green)}
  .msg.err{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);color:var(--red)}
  .empty{color:var(--dim);font-size:.85rem}
</style></head><body>
<div class="wrap">
  <a class="back" href="${DASHBOARD_BASE}/">← Dashboard</a>
  <h1>Schedules</h1>
  <div id="msg" class="msg"></div>
  <h2>Active Schedules</h2>
  <div id="list"><p class="empty">Loading…</p></div>
  <h2>Create Schedule</h2>
  <div class="form-box">
    <form id="createForm">
      <label>Title</label>
      <input type="text" id="f-title" placeholder="Schedule title" required>
      <label>Instructions</label>
      <textarea id="f-instructions" placeholder="What should Nova do?" required></textarea>
      <label>Trigger At (optional)</label>
      <input type="datetime-local" id="f-trigger_at">
      <label>Recurrence (optional)</label>
      <input type="text" id="f-recur_rule" placeholder="e.g. daily:09:00 or weekly:MON:08:00">
      <button type="submit" class="btn primary" style="margin-top:.9rem;width:100%;padding:9px 0;font-size:.88rem;font-weight:600;">Create</button>
    </form>
  </div>
</div>
<script>
  var BASE = '${DASHBOARD_BASE}';
  function esc(s){var d=document.createElement('div');d.textContent=(s==null?'':String(s));return d.innerHTML;}
  function escAttr(s){return esc(s).replace(/"/g,'&quot;');}
  var msgEl = document.getElementById('msg');
  var listEl = document.getElementById('list');
  function showMsg(text, ok) {
    msgEl.className = 'msg ' + (ok ? 'ok' : 'err');
    msgEl.innerHTML = esc(text);
    msgEl.style.display = 'block';
    setTimeout(function(){msgEl.style.display='none';}, 3000);
  }
  listEl.addEventListener('click', function(e) {
    var btn = e.target;
    if (!btn || !btn.getAttribute) { return; }
    if (!btn.classList.contains('action-cancel')) { return; }
    var id = btn.getAttribute('data-id');
    if (!id) { return; }
    if (!confirm('Cancel this schedule?')) { return; }
    fetch(BASE + '/api/schedules/' + encodeURIComponent(id) + '/cancel', { method: 'POST' })
      .then(function(r){ return r.json(); })
      .then(function(data) {
        if (data.error) { showMsg(data.error, false); } else { showMsg('Schedule cancelled', true); load(); }
      })
      .catch(function(e){ showMsg(e.message || 'Cancel failed', false); });
  });
  function load() {
    fetch(BASE + '/api/schedules').then(function(r){ return r.json(); }).then(function(data) {
      if (data.error) { listEl.innerHTML = '<p class="empty">'+esc(data.error)+'</p>'; return; }
      var items = (data.schedules || []).filter(function(s){ return s.status !== 'cancelled' && s.status !== 'completed'; });
      if (!items.length) { listEl.innerHTML = '<p class="empty">No active schedules.</p>'; return; }
      var html = '';
      items.forEach(function(s) {
        var next = s.trigger_at ? new Date(s.trigger_at).toLocaleString() : '—';
        var recur = s.recurrence || s.recur_rule || '';
        html += '<div class="row">';
        html += '<span class="title">'+esc(s.title)+'</span>';
        html += '<span class="meta">Next: '+esc(next)+(recur ? ' · '+esc(recur) : '')+'</span>';
        html += '<button class="btn danger action-cancel" data-id="'+escAttr(s.id)+'">Cancel</button>';
        html += '</div>';
      });
      listEl.innerHTML = html;
    }).catch(function(e){ listEl.innerHTML = '<p class="empty">'+esc(e.message)+'</p>'; });
  }
  document.getElementById('createForm').addEventListener('submit', function(e) {
    e.preventDefault();
    var payload = {
      title: document.getElementById('f-title').value,
      instructions: document.getElementById('f-instructions').value,
      trigger_at: document.getElementById('f-trigger_at').value || undefined,
      recur_rule: document.getElementById('f-recur_rule').value || undefined
    };
    fetch(BASE + '/api/schedules', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload)
    }).then(function(r){ return r.json(); }).then(function(data) {
      if (data.error) { showMsg(data.error, false); } else {
        showMsg('Schedule created', true);
        document.getElementById('f-title').value = '';
        document.getElementById('f-instructions').value = '';
        document.getElementById('f-trigger_at').value = '';
        document.getElementById('f-recur_rule').value = '';
        load();
      }
    }).catch(function(e){ showMsg(e.message || 'Create failed', false); });
  });
  load();
</script>
</body></html>`;
}

// ============================================================
// SKILLS PAGE
// ============================================================

export function renderSkillsPage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nova — Skills</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#06060b;--glass:rgba(255,255,255,.05);--border:rgba(255,255,255,.10);--text:rgba(255,255,255,.92);--dim:rgba(255,255,255,.55);--indigo:#6366f1;--green:#22c55e;--red:#ef4444}
  body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px;min-height:100vh}
  .wrap{max-width:660px;margin:0 auto}
  h1{font-size:1.15rem;font-weight:700;margin-bottom:1.4rem}
  .back{display:block;margin-bottom:1.2rem;color:var(--dim);text-decoration:none;font-size:.8rem}
  .back:hover{color:var(--text)}
  .row{background:var(--glass);border:1px solid var(--border);border-radius:10px;padding:12px 16px;margin-bottom:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .slug{font-weight:600;flex:1;min-width:120px;font-size:.9rem;color:var(--indigo)}
  .meta{font-size:.75rem;color:var(--dim);flex:1;min-width:100px}
  .btn{padding:5px 14px;border-radius:7px;border:1px solid var(--border);background:rgba(255,255,255,.06);color:var(--text);font-size:.78rem;cursor:pointer;font-family:inherit}
  .btn:hover{background:rgba(255,255,255,.10)}
  .btn.danger{border-color:rgba(239,68,68,.4);color:var(--red)}
  .btn.danger:hover{background:rgba(239,68,68,.1)}
  .msg{margin-bottom:1rem;padding:9px 12px;border-radius:8px;font-size:.82rem;display:none}
  .msg.ok{background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.3);color:var(--green)}
  .msg.err{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);color:var(--red)}
  .empty{color:var(--dim);font-size:.85rem}
</style></head><body>
<div class="wrap">
  <a class="back" href="${DASHBOARD_BASE}/">← Dashboard</a>
  <h1>Learned Skills</h1>
  <div id="msg" class="msg"></div>
  <div id="list"><p class="empty">Loading…</p></div>
</div>
<script>
  var BASE = '${DASHBOARD_BASE}';
  function esc(s){var d=document.createElement('div');d.textContent=(s==null?'':String(s));return d.innerHTML;}
  function escAttr(s){return esc(s).replace(/"/g,'&quot;');}
  var msgEl = document.getElementById('msg');
  var listEl = document.getElementById('list');
  function showMsg(text, ok) {
    msgEl.className = 'msg ' + (ok ? 'ok' : 'err');
    msgEl.innerHTML = esc(text);
    msgEl.style.display = 'block';
    setTimeout(function(){msgEl.style.display='none';}, 3000);
  }
  listEl.addEventListener('click', function(e) {
    var btn = e.target;
    if (!btn || !btn.getAttribute) { return; }
    if (!btn.classList.contains('action-delete')) { return; }
    var slug = btn.getAttribute('data-slug');
    if (!slug) { return; }
    if (!confirm('Delete skill "' + slug + '"?')) { return; }
    fetch(BASE + '/api/learned-skills/' + encodeURIComponent(slug) + '/delete', { method: 'POST' })
      .then(function(r){ return r.json(); })
      .then(function(data) {
        if (data.error) { showMsg(data.error, false); } else { showMsg('Skill deleted', true); load(); }
      })
      .catch(function(e){ showMsg(e.message || 'Delete failed', false); });
  });
  function load() {
    fetch(BASE + '/api/learned-skills').then(function(r){ return r.json(); }).then(function(data) {
      if (data.error) { listEl.innerHTML = '<p class="empty">'+esc(data.error)+'</p>'; return; }
      var items = data.skills || [];
      if (!items.length) { listEl.innerHTML = '<p class="empty">No learned skills yet.</p>'; return; }
      var html = '';
      items.forEach(function(s) {
        var triggers = '';
        try { triggers = (JSON.parse(s.trigger_phrases) || []).join(', '); } catch(e) { triggers = s.trigger_phrases || ''; }
        html += '<div class="row">';
        html += '<span class="slug">'+esc(s.slug)+'</span>';
        html += '<span class="meta">Triggers: '+esc(triggers)+' · Uses: '+esc(s.success_count)+'</span>';
        html += '<button class="btn danger action-delete" data-slug="'+escAttr(s.slug)+'">Delete</button>';
        html += '</div>';
      });
      listEl.innerHTML = html;
    }).catch(function(e){ listEl.innerHTML = '<p class="empty">'+esc(e.message)+'</p>'; });
  }
  load();
</script>
</body></html>`;
}

// ============================================================
// KNOWLEDGE PAGE (Nova Knowledge — RAG)
// ============================================================

export function renderKnowledgePage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nova — Knowledge</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#06060b;--glass:rgba(255,255,255,.05);--border:rgba(255,255,255,.10);--text:rgba(255,255,255,.92);--dim:rgba(255,255,255,.55);--indigo:#6366f1;--green:#22c55e;--red:#ef4444;--yellow:#f59e0b}
  body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px;min-height:100vh}
  .wrap{max-width:660px;margin:0 auto}
  h1{font-size:1.15rem;font-weight:700;margin-bottom:1.4rem}
  h2{font-size:.82rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin:1.4rem 0 .7rem}
  .back{display:block;margin-bottom:1.2rem;color:var(--dim);text-decoration:none;font-size:.8rem}
  .back:hover{color:var(--text)}
  .card{background:var(--glass);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:14px}
  .drop{border:1px dashed var(--border);border-radius:10px;padding:22px 16px;text-align:center;color:var(--dim);font-size:.85rem;cursor:pointer;transition:background .15s,border-color .15s}
  .drop:hover,.drop.drag{background:rgba(99,102,241,.08);border-color:var(--indigo);color:var(--text)}
  .controls{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;align-items:center}
  select,input[type=text]{padding:7px 10px;border-radius:7px;border:1px solid var(--border);background:rgba(255,255,255,.04);color:var(--text);font-size:.82rem;font-family:inherit}
  input[type=text]{flex:1;min-width:140px}
  .row{background:var(--glass);border:1px solid var(--border);border-radius:10px;padding:12px 16px;margin-bottom:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .title{font-weight:600;flex:1;min-width:120px;font-size:.9rem;color:var(--indigo)}
  .meta{font-size:.75rem;color:var(--dim)}
  .tag{font-size:.68rem;padding:2px 8px;border-radius:5px;border:1px solid var(--border);background:rgba(255,255,255,.05);color:var(--dim);text-transform:uppercase;letter-spacing:.04em}
  .st{font-size:.68rem;padding:2px 8px;border-radius:5px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
  .st-ready{background:rgba(34,197,94,.12);color:var(--green);border:1px solid rgba(34,197,94,.25)}
  .st-error{background:rgba(239,68,68,.12);color:var(--red);border:1px solid rgba(239,68,68,.25)}
  .st-other{background:rgba(255,255,255,.07);color:var(--dim);border:1px solid var(--border)}
  .btn{padding:5px 14px;border-radius:7px;border:1px solid var(--border);background:rgba(255,255,255,.06);color:var(--text);font-size:.78rem;cursor:pointer;font-family:inherit}
  .btn:hover{background:rgba(255,255,255,.10)}
  .btn.danger{border-color:rgba(239,68,68,.4);color:var(--red)}
  .btn.danger:hover{background:rgba(239,68,68,.1)}
  .btn.primary{border:none;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-weight:600}
  .hit{background:rgba(255,255,255,.02);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:8px;font-size:.82rem}
  .hit-head{display:flex;justify-content:space-between;gap:8px;margin-bottom:5px;flex-wrap:wrap}
  .hit-title{color:var(--indigo);font-weight:600;font-size:.78rem}
  .sim{color:var(--yellow);font-weight:600;font-size:.72rem}
  .snippet{color:var(--dim);line-height:1.5;white-space:pre-wrap;word-break:break-word}
  .msg{margin:1rem 0;padding:9px 12px;border-radius:8px;font-size:.82rem;display:none}
  .msg.ok{background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.3);color:var(--green)}
  .msg.err{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);color:var(--red)}
  .empty{color:var(--dim);font-size:.85rem}
  .scope-group{margin-bottom:1rem}
  .scope-label{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin-bottom:6px}
</style></head><body>
<div class="wrap">
  <a class="back" href="${DASHBOARD_BASE}/">← Dashboard</a>
  <h1>Nova Knowledge</h1>
  <div id="msg" class="msg"></div>

  <div class="card">
    <div id="drop" class="drop">Drop a file here, or click to choose (PDF, DOCX, MD, TXT)</div>
    <input type="file" id="file" style="display:none">
    <div class="controls">
      <select id="scope">
        <option value="personal">Personal</option>
        <option value="team">Team</option>
        <option value="agent">Agent</option>
      </select>
      <input type="text" id="agentSlug" placeholder="agent slug (e.g. architect)" style="display:none">
      <button class="btn primary" id="uploadBtn">Upload</button>
    </div>
  </div>

  <h2>Search</h2>
  <div class="card">
    <div class="controls" style="margin-top:0">
      <input type="text" id="q" placeholder="Search the knowledge base…">
      <input type="text" id="searchAgent" placeholder="agent slug (optional)">
      <button class="btn primary" id="searchBtn">Search</button>
    </div>
    <div id="hits" style="margin-top:12px"></div>
  </div>

  <h2>Documents</h2>
  <div id="list"><p class="empty">Loading…</p></div>
</div>
<script>
  var BASE = '${DASHBOARD_BASE}';
  function esc(s){var d=document.createElement('div');d.textContent=(s==null?'':String(s));return d.innerHTML;}
  function escAttr(s){return esc(s).replace(/"/g,'&quot;');}
  var msgEl = document.getElementById('msg');
  var listEl = document.getElementById('list');
  var hitsEl = document.getElementById('hits');
  var fileInput = document.getElementById('file');
  var dropEl = document.getElementById('drop');
  var scopeEl = document.getElementById('scope');
  var agentSlugEl = document.getElementById('agentSlug');
  var pending = null;

  function showMsg(text, ok) {
    msgEl.className = 'msg ' + (ok ? 'ok' : 'err');
    msgEl.innerHTML = esc(text);
    msgEl.style.display = 'block';
    setTimeout(function(){msgEl.style.display='none';}, 4000);
  }
  function stClass(st){var s=(st||'').toLowerCase();if(s==='ready')return 'st-ready';if(s==='error')return 'st-error';return 'st-other';}

  scopeEl.addEventListener('change', function(){
    agentSlugEl.style.display = scopeEl.value === 'agent' ? 'inline-block' : 'none';
  });

  dropEl.addEventListener('click', function(){ fileInput.click(); });
  fileInput.addEventListener('change', function(){
    if (fileInput.files && fileInput.files[0]) { pending = fileInput.files[0]; dropEl.textContent = pending.name; }
  });
  dropEl.addEventListener('dragover', function(e){ e.preventDefault(); dropEl.classList.add('drag'); });
  dropEl.addEventListener('dragleave', function(){ dropEl.classList.remove('drag'); });
  dropEl.addEventListener('drop', function(e){
    e.preventDefault(); dropEl.classList.remove('drag');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) { pending = e.dataTransfer.files[0]; dropEl.textContent = pending.name; }
  });

  document.getElementById('uploadBtn').addEventListener('click', function(){
    if (!pending) { showMsg('Choose a file first', false); return; }
    var fd = new FormData();
    fd.append('file', pending);
    fd.append('scope', scopeEl.value);
    if (scopeEl.value === 'agent') fd.append('agentSlug', agentSlugEl.value.trim());
    showMsg('Uploading…', true);
    fetch(BASE + '/api/kb/upload', { method: 'POST', body: fd })
      .then(function(r){ return r.json(); })
      .then(function(data){
        if (data.error || data.status === 'error') { showMsg(data.error || 'Upload failed', false); return; }
        var label = data.status === 'duplicate' ? 'Already indexed' : 'Indexed ' + (data.chunkCount||0) + ' chunks';
        showMsg(esc(data.title||pending.name) + ' — ' + label, true);
        pending = null; fileInput.value = ''; dropEl.textContent = 'Drop a file here, or click to choose (PDF, DOCX, MD, TXT)';
        load();
      })
      .catch(function(e){ showMsg(e.message || 'Upload failed', false); });
  });

  listEl.addEventListener('click', function(e){
    var btn = e.target;
    if (!btn || !btn.getAttribute || !btn.classList.contains('action-delete')) return;
    var id = btn.getAttribute('data-id');
    var scope = btn.getAttribute('data-scope');
    var title = btn.getAttribute('data-title') || 'this document';
    if (!id) return;
    if (!confirm('Delete "' + title + '"?')) return;
    fetch(BASE + '/api/kb/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id, scope: scope }) })
      .then(function(r){ return r.json(); })
      .then(function(data){ if (data.error) { showMsg(data.error, false); } else { showMsg('Deleted', true); load(); } })
      .catch(function(e){ showMsg(e.message || 'Delete failed', false); });
  });

  function scopeTag(d){
    if (d.scope === 'agent') return 'agent:' + (d.agentSlug || '?');
    return d.scope || 'personal';
  }

  function load(){
    fetch(BASE + '/api/kb').then(function(r){ return r.json(); }).then(function(data){
      if (data.error) { listEl.innerHTML = '<p class="empty">'+esc(data.error)+'</p>'; return; }
      var docs = data.docs || [];
      if (!docs.length) { listEl.innerHTML = '<p class="empty">No documents yet.</p>'; return; }
      var groups = { personal: [], team: [], agent: [] };
      docs.forEach(function(d){ (groups[d.scope] || (groups[d.scope]=[])).push(d); });
      var order = ['personal','team','agent'];
      var html = '';
      order.forEach(function(sc){
        var items = groups[sc];
        if (!items || !items.length) return;
        html += '<div class="scope-group"><div class="scope-label">'+esc(sc)+'</div>';
        items.forEach(function(d){
          html += '<div class="row">';
          html += '<span class="title">'+esc(d.title||'(untitled)')+'</span>';
          html += '<span class="tag">'+esc(scopeTag(d))+'</span>';
          html += '<span class="st '+stClass(d.status)+'">'+esc(d.status||'?')+'</span>';
          html += '<span class="meta">'+esc(d.chunkCount||0)+' chunks</span>';
          html += '<button class="btn danger action-delete" data-id="'+escAttr(d.id)+'" data-scope="'+escAttr(d.scope)+'" data-title="'+escAttr(d.title||'')+'">Delete</button>';
          html += '</div>';
        });
        html += '</div>';
      });
      listEl.innerHTML = html;
    }).catch(function(e){ listEl.innerHTML = '<p class="empty">'+esc(e.message)+'</p>'; });
  }

  function runSearch(){
    var q = document.getElementById('q').value.trim();
    var agent = document.getElementById('searchAgent').value.trim();
    if (!q) { hitsEl.innerHTML = '<p class="empty">Enter a query.</p>'; return; }
    hitsEl.innerHTML = '<p class="empty">Searching…</p>';
    var url = BASE + '/api/kb/search?q=' + encodeURIComponent(q) + (agent ? '&agent=' + encodeURIComponent(agent) : '');
    fetch(url).then(function(r){ return r.json(); }).then(function(data){
      if (data.error) { hitsEl.innerHTML = '<p class="empty">'+esc(data.error)+'</p>'; return; }
      var hits = data.hits || [];
      if (!hits.length) { hitsEl.innerHTML = '<p class="empty">No matches.</p>'; return; }
      var html = '';
      hits.forEach(function(h){
        var pct = Math.round((h.similarity || 0) * 100);
        html += '<div class="hit"><div class="hit-head">';
        html += '<span class="hit-title">'+esc(h.title||h.source||'')+'</span>';
        html += '<span class="sim">'+esc(pct)+'%</span>';
        html += '</div><div class="snippet">'+esc(h.text||'')+'</div></div>';
      });
      hitsEl.innerHTML = html;
    }).catch(function(e){ hitsEl.innerHTML = '<p class="empty">'+esc(e.message||'Search failed')+'</p>'; });
  }
  document.getElementById('searchBtn').addEventListener('click', runSearch);
  document.getElementById('q').addEventListener('keydown', function(e){ if (e.key === 'Enter') runSearch(); });

  load();
</script>
</body></html>`;
}

// ============================================================
// PLAYBOOKS PAGE
// ============================================================

export function renderPlaybooksPage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nova — Playbooks</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#06060b;--glass:rgba(255,255,255,.05);--border:rgba(255,255,255,.10);--text:rgba(255,255,255,.92);--dim:rgba(255,255,255,.55);--indigo:#6366f1;--green:#22c55e;--red:#ef4444;--yellow:#f59e0b}
  body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px;min-height:100vh}
  .wrap{max-width:660px;margin:0 auto}
  h1{font-size:1.15rem;font-weight:700;margin-bottom:1.4rem}
  h2{font-size:.82rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin:1.4rem 0 .7rem}
  .back{display:block;margin-bottom:1.2rem;color:var(--dim);text-decoration:none;font-size:.8rem}
  .back:hover{color:var(--text)}
  .hint{color:var(--dim);font-size:.8rem;line-height:1.5;margin-bottom:1rem}
  .card{background:var(--glass);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:14px}
  .controls{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;align-items:center}
  label{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--dim);display:block;margin-bottom:5px}
  select,input[type=text],textarea{padding:7px 10px;border-radius:7px;border:1px solid var(--border);background:rgba(255,255,255,.04);color:var(--text);font-size:.82rem;font-family:inherit;width:100%}
  textarea{resize:vertical;min-height:70px;line-height:1.5}
  .field{margin-bottom:12px}
  .row{background:var(--glass);border:1px solid var(--border);border-radius:10px;padding:12px 16px;margin-bottom:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .title{font-weight:600;flex:1;min-width:120px;font-size:.9rem;color:var(--indigo)}
  .meta{font-size:.75rem;color:var(--dim)}
  .tag{font-size:.68rem;padding:2px 8px;border-radius:5px;border:1px solid var(--border);background:rgba(255,255,255,.05);color:var(--dim);text-transform:uppercase;letter-spacing:.04em}
  .btn{padding:5px 14px;border-radius:7px;border:1px solid var(--border);background:rgba(255,255,255,.06);color:var(--text);font-size:.78rem;cursor:pointer;font-family:inherit}
  .btn:hover{background:rgba(255,255,255,.10)}
  .btn.danger{border-color:rgba(239,68,68,.4);color:var(--red)}
  .btn.danger:hover{background:rgba(239,68,68,.1)}
  .btn.primary{border:none;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-weight:600}
  .msg{margin:1rem 0;padding:9px 12px;border-radius:8px;font-size:.82rem;display:none}
  .msg.ok{background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.3);color:var(--green)}
  .msg.err{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);color:var(--red)}
  .empty{color:var(--dim);font-size:.85rem}
  .scope-group{margin-bottom:1rem}
  .scope-label{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin-bottom:6px}
  .vars{font-size:.72rem;color:var(--dim);width:100%;margin-top:4px}
</style></head><body>
<div class="wrap">
  <a class="back" href="${DASHBOARD_BASE}/">← Dashboard</a>
  <h1>Playbooks</h1>
  <p class="hint">Playbooks are reusable multi-agent SOPs. Author and manage them here — to <strong>run</strong> one, just say "run playbook &lt;name&gt;" in chat.</p>
  <div id="msg" class="msg"></div>

  <div class="controls" style="margin-top:0">
    <button class="btn" id="seedBtn">Seed starter library</button>
  </div>

  <h2>Your Playbooks</h2>
  <div id="list"><p class="empty">Loading…</p></div>

  <h2>Create Playbook</h2>
  <div class="card">
    <div class="field">
      <label>Name</label>
      <input type="text" id="name" placeholder="e.g. client-onboarding">
    </div>
    <div class="field">
      <label>Description</label>
      <input type="text" id="description" placeholder="What this playbook does">
    </div>
    <div class="field">
      <label>Scope</label>
      <select id="scope">
        <option value="personal">Personal</option>
        <option value="team">Team</option>
      </select>
    </div>
    <div class="field">
      <label>Variables — one per line, name only. Suffix <code>*</code> for required.</label>
      <textarea id="variables" placeholder="client*&#10;email*&#10;reason"></textarea>
    </div>
    <div class="field">
      <label>Steps — one per line as <code>agent|phase|description</code>. Phase is prepare or execute.</label>
      <textarea id="steps" placeholder="athena|prepare|Draft an onboarding brief for {{client}}.&#10;orion|execute|Send the welcome email to {{email}}."></textarea>
    </div>
    <button class="btn primary" id="createBtn">Create Playbook</button>
  </div>
</div>
<script>
  var BASE = '${DASHBOARD_BASE}';
  function esc(s){var d=document.createElement('div');d.textContent=(s==null?'':String(s));return d.innerHTML;}
  function escAttr(s){return esc(s).replace(/"/g,'&quot;');}
  var msgEl = document.getElementById('msg');
  var listEl = document.getElementById('list');

  function showMsg(text, ok) {
    msgEl.className = 'msg ' + (ok ? 'ok' : 'err');
    msgEl.innerHTML = esc(text);
    msgEl.style.display = 'block';
    setTimeout(function(){msgEl.style.display='none';}, 4000);
  }

  function parseVariables(raw){
    return (raw||'').split('\\n').map(function(l){return l.trim();}).filter(Boolean).map(function(l){
      var required = /\\*\\s*$/.test(l);
      var name = l.replace(/\\*\\s*$/, '').trim();
      return { name: name, required: required };
    }).filter(function(v){ return v.name; });
  }
  function parseSteps(raw){
    return (raw||'').split('\\n').map(function(l){return l.trim();}).filter(Boolean).map(function(l){
      var parts = l.split('|');
      var agent = (parts[0]||'').trim();
      var phase = (parts[1]||'').trim().toLowerCase();
      var description = parts.slice(2).join('|').trim();
      if (!description) { description = (parts[1]||'').trim() || agent; if (parts.length < 3) { phase = ''; } }
      var step = { description: description };
      if (agent) step.agent = agent;
      if (phase === 'prepare' || phase === 'execute') step.phase = phase;
      return step;
    }).filter(function(s){ return s.description; });
  }

  listEl.addEventListener('click', function(e){
    var btn = e.target;
    if (!btn || !btn.getAttribute || !btn.classList.contains('action-delete')) return;
    var id = btn.getAttribute('data-id');
    var scope = btn.getAttribute('data-scope');
    var name = btn.getAttribute('data-name') || 'this playbook';
    if (!id) return;
    if (!confirm('Delete "' + name + '"?')) return;
    fetch(BASE + '/api/playbooks/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id, scope: scope }) })
      .then(function(r){ return r.json(); })
      .then(function(data){ if (data.error) { showMsg(data.error, false); } else { showMsg('Deleted', true); load(); } })
      .catch(function(e){ showMsg(e.message || 'Delete failed', false); });
  });

  function varsLabel(pb){
    return (pb.variables||[]).map(function(v){ return v.required ? v.name + '*' : v.name; }).join(', ');
  }

  function load(){
    fetch(BASE + '/api/playbooks').then(function(r){ return r.json(); }).then(function(data){
      if (data.error) { listEl.innerHTML = '<p class="empty">'+esc(data.error)+'</p>'; return; }
      var pbs = data.playbooks || [];
      if (!pbs.length) { listEl.innerHTML = '<p class="empty">No playbooks yet. Seed the starter library or create one below.</p>'; return; }
      var groups = { personal: [], team: [] };
      pbs.forEach(function(p){ (groups[p.scope] || (groups[p.scope]=[])).push(p); });
      var order = ['personal','team'];
      var html = '';
      order.forEach(function(sc){
        var items = groups[sc];
        if (!items || !items.length) return;
        html += '<div class="scope-group"><div class="scope-label">'+esc(sc)+'</div>';
        items.forEach(function(p){
          var vars = varsLabel(p);
          html += '<div class="row">';
          html += '<span class="title">'+esc(p.name)+'</span>';
          html += '<span class="tag">v'+esc(p.version)+'</span>';
          html += '<span class="tag">'+esc(p.scope)+'</span>';
          html += '<span class="meta">'+esc((p.steps||[]).length)+' steps</span>';
          html += '<button class="btn danger action-delete" data-id="'+escAttr(p.id)+'" data-scope="'+escAttr(p.scope)+'" data-name="'+escAttr(p.name)+'">Delete</button>';
          if (vars) html += '<div class="vars">vars: '+esc(vars)+'</div>';
          html += '</div>';
        });
        html += '</div>';
      });
      listEl.innerHTML = html;
    }).catch(function(e){ listEl.innerHTML = '<p class="empty">'+esc(e.message)+'</p>'; });
  }

  document.getElementById('seedBtn').addEventListener('click', function(){
    showMsg('Seeding…', true);
    fetch(BASE + '/api/playbooks/seed', { method: 'POST' })
      .then(function(r){ return r.json(); })
      .then(function(data){
        if (data.error) { showMsg(data.error, false); return; }
        showMsg('Added ' + (data.added||0) + ' starter playbook(s)', true);
        load();
      })
      .catch(function(e){ showMsg(e.message || 'Seed failed', false); });
  });

  document.getElementById('createBtn').addEventListener('click', function(){
    var name = document.getElementById('name').value.trim();
    if (!name) { showMsg('Name is required', false); return; }
    var body = {
      name: name,
      description: document.getElementById('description').value.trim(),
      scope: document.getElementById('scope').value,
      variables: parseVariables(document.getElementById('variables').value),
      steps: parseSteps(document.getElementById('steps').value),
    };
    fetch(BASE + '/api/playbooks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function(r){ return r.json(); })
      .then(function(data){
        if (data.error) { showMsg(data.error, false); return; }
        showMsg('Saved ' + esc(data.name||name) + ' (v' + (data.version||1) + ')', true);
        document.getElementById('name').value = '';
        document.getElementById('description').value = '';
        document.getElementById('variables').value = '';
        document.getElementById('steps').value = '';
        load();
      })
      .catch(function(e){ showMsg(e.message || 'Create failed', false); });
  });

  load();
</script>
</body></html>`;
}

// ============================================================
// AUTOMATIONS PAGE
// ============================================================

export function renderAutomationsPage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nova — Automations</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#06060b;--glass:rgba(255,255,255,.05);--border:rgba(255,255,255,.10);--text:rgba(255,255,255,.92);--dim:rgba(255,255,255,.55);--indigo:#6366f1;--green:#22c55e;--red:#ef4444;--yellow:#f59e0b}
  body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px;min-height:100vh}
  .wrap{max-width:660px;margin:0 auto}
  h1{font-size:1.15rem;font-weight:700;margin-bottom:1.4rem}
  h2{font-size:.82rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin:1.4rem 0 .7rem}
  .back{display:block;margin-bottom:1.2rem;color:var(--dim);text-decoration:none;font-size:.8rem}
  .back:hover{color:var(--text)}
  .hint{color:var(--dim);font-size:.8rem;line-height:1.5;margin-bottom:1rem}
  .card{background:var(--glass);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:14px}
  label{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--dim);display:block;margin-bottom:5px}
  select,input[type=text],input[type=number],textarea{padding:7px 10px;border-radius:7px;border:1px solid var(--border);background:rgba(255,255,255,.04);color:var(--text);font-size:.82rem;font-family:inherit;width:100%}
  textarea{resize:vertical;min-height:70px;line-height:1.5}
  .field{margin-bottom:12px}
  .row{background:var(--glass);border:1px solid var(--border);border-radius:10px;padding:12px 16px;margin-bottom:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .title{font-weight:600;flex:1;min-width:120px;font-size:.9rem;color:var(--indigo)}
  .meta{font-size:.75rem;color:var(--dim)}
  .tag{font-size:.68rem;padding:2px 8px;border-radius:5px;border:1px solid var(--border);background:rgba(255,255,255,.05);color:var(--dim);text-transform:uppercase;letter-spacing:.04em}
  .btn{padding:5px 14px;border-radius:7px;border:1px solid var(--border);background:rgba(255,255,255,.06);color:var(--text);font-size:.78rem;cursor:pointer;font-family:inherit}
  .btn:hover{background:rgba(255,255,255,.10)}
  .btn.danger{border-color:rgba(239,68,68,.4);color:var(--red)}
  .btn.danger:hover{background:rgba(239,68,68,.1)}
  .btn.primary{border:none;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-weight:600}
  .msg{margin:1rem 0;padding:9px 12px;border-radius:8px;font-size:.82rem;display:none}
  .msg.ok{background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.3);color:var(--green)}
  .msg.err{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);color:var(--red)}
  .empty{color:var(--dim);font-size:.85rem}
  .webhook{width:100%;margin-top:6px;font-size:.72rem;color:var(--dim);word-break:break-all;background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:6px;padding:6px 8px;display:none}
  .webhook code{color:var(--text)}
  .sim{width:100%;margin-top:6px;background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:8px;padding:10px;display:none}
  .sim label{margin-bottom:4px}
  .sim textarea{font-family:ui-monospace,monospace;min-height:56px;font-size:.76rem;margin-bottom:8px}
  .sim-out{margin-top:8px;font-size:.78rem;border-radius:7px;padding:9px 11px;display:none}
  .sim-out.fire{background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.3);color:var(--green)}
  .sim-out.skip{background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.3);color:var(--yellow)}
  .sim-out.err{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:var(--red)}
  .sim-out .k{color:var(--dim);text-transform:uppercase;font-size:.64rem;letter-spacing:.05em}
  .sim-out code{color:var(--text);font-family:ui-monospace,monospace}
  .reveal{background:rgba(99,102,241,.12);border:1px solid rgba(99,102,241,.35);border-radius:8px;padding:10px 12px;margin:1rem 0;display:none}
  .reveal .k{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--dim);margin-bottom:4px}
  .reveal code{display:block;font-size:.74rem;color:var(--text);word-break:break-all;background:rgba(0,0,0,.25);border-radius:5px;padding:6px 8px;margin-bottom:8px}
  .switch{display:inline-flex;align-items:center;gap:6px;font-size:.72rem;color:var(--dim);cursor:pointer}
  .switch input{width:auto}
</style></head><body>
<div class="wrap">
  <a class="back" href="${DASHBOARD_BASE}/">← Dashboard</a>
  <h1>Automations</h1>
  <p class="hint">Automations turn an incoming event (a webhook or a metric threshold) into an agent task or a playbook run. Every automation fires through the approval gate — nothing consequential runs without your OK.</p>
  <div id="msg" class="msg"></div>
  <div id="reveal" class="reveal"></div>

  <h2>Your Automations</h2>
  <div id="list"><p class="empty">Loading…</p></div>

  <h2>Create Automation</h2>
  <div class="card">
    <div class="field">
      <label>Name</label>
      <input type="text" id="name" placeholder="e.g. new-lead-followup">
    </div>
    <div class="field">
      <label>Source type</label>
      <select id="sourceType">
        <option value="webhook">Webhook</option>
        <option value="metric">Metric</option>
      </select>
    </div>
    <div class="field">
      <label>Action type</label>
      <select id="actionType">
        <option value="agent">Agent</option>
        <option value="playbook">Playbook</option>
      </select>
    </div>
    <div id="agentFields">
      <div class="field">
        <label>Agent slug</label>
        <input type="text" id="agentRef" placeholder="e.g. orion">
      </div>
      <div class="field">
        <label>Template — the instruction sent to the agent (use {{field}} from the event)</label>
        <textarea id="template" placeholder="Follow up with {{email}} about {{topic}}."></textarea>
      </div>
    </div>
    <div id="playbookFields" style="display:none">
      <div class="field">
        <label>Playbook name</label>
        <input type="text" id="playbookRef" placeholder="e.g. client-onboarding">
      </div>
      <div class="field">
        <label>Variables — one per line as <code>key=value</code> (value may use {{field}})</label>
        <textarea id="playbookVars" placeholder="client={{name}}&#10;email={{email}}"></textarea>
      </div>
    </div>
    <div class="field">
      <label>Conditions — one per line as <code>field:op:value</code> (optional)</label>
      <textarea id="conditions" placeholder="amount:gt:100&#10;status:eq:paid&#10;body:semantic:a customer complaint:0.55"></textarea>
      <p class="hint" style="margin:.5rem 0 0">Ops: <code>eq</code>, <code>ne</code>, <code>gt</code>, <code>lt</code>, <code>contains</code>, <code>exists</code>, and <code>semantic</code>. A <code>semantic</code> line — <code>field:semantic:phrase:threshold</code> — fires when the event field is semantically similar to the phrase (threshold optional, default 0.5).</p>
    </div>
    <div class="field">
      <label>Dedupe template — skip duplicate events sharing this key (optional)</label>
      <input type="text" id="dedupeKey" placeholder="{{id}}">
    </div>
    <div class="field">
      <label>Rate limit per hour (optional)</label>
      <input type="number" id="rateLimit" min="0" placeholder="e.g. 20">
    </div>
    <button class="btn primary" id="createBtn">Create Automation</button>
  </div>
</div>
<script>
  var BASE = '${DASHBOARD_BASE}';
  function esc(s){var d=document.createElement('div');d.textContent=(s==null?'':String(s));return d.innerHTML;}
  function escAttr(s){return esc(s).replace(/"/g,'&quot;');}
  var msgEl = document.getElementById('msg');
  var listEl = document.getElementById('list');
  var revealEl = document.getElementById('reveal');

  function showMsg(text, ok) {
    msgEl.className = 'msg ' + (ok ? 'ok' : 'err');
    msgEl.innerHTML = esc(text);
    msgEl.style.display = 'block';
    setTimeout(function(){msgEl.style.display='none';}, 4000);
  }

  function parseConditions(raw){
    return (raw||'').split('\\n').map(function(l){return l.trim();}).filter(Boolean).map(function(l){
      var parts = l.split(':');
      var field = (parts[0]||'').trim();
      var op = (parts[1]||'').trim();
      if (op === 'semantic') {
        // field:semantic:<phrase>[:<threshold>]
        var rest = parts.slice(2);
        var threshold;
        if (rest.length > 1) {
          var last = rest[rest.length - 1].trim();
          if (last !== '' && !isNaN(Number(last))) { threshold = Number(last); rest = rest.slice(0, -1); }
        }
        var c = { field: field, op: op, value: rest.join(':').trim() };
        if (threshold !== undefined) c.threshold = threshold;
        return c;
      }
      var value = parts.slice(2).join(':').trim();
      return { field: field, op: op, value: value };
    }).filter(function(c){ return c.field && c.op; });
  }
  function parsePlaybookVars(raw){
    var out = {};
    (raw||'').split('\\n').map(function(l){return l.trim();}).filter(Boolean).forEach(function(l){
      var i = l.indexOf('=');
      if (i < 0) return;
      var k = l.slice(0, i).trim();
      var v = l.slice(i + 1).trim();
      if (k) out[k] = v;
    });
    return out;
  }

  var actionTypeEl = document.getElementById('actionType');
  function syncActionFields(){
    var agent = actionTypeEl.value === 'agent';
    document.getElementById('agentFields').style.display = agent ? '' : 'none';
    document.getElementById('playbookFields').style.display = agent ? 'none' : '';
  }
  actionTypeEl.addEventListener('change', syncActionFields);

  listEl.addEventListener('click', function(e){
    var btn = e.target;
    if (!btn || !btn.classList) return;
    if (btn.classList.contains('action-webhook')) {
      var wid = btn.getAttribute('data-id');
      var el = document.getElementById('wh-' + wid);
      if (el) el.style.display = el.style.display === 'block' ? 'none' : 'block';
      return;
    }
    if (btn.classList.contains('action-test')) {
      var sid = btn.getAttribute('data-id');
      var sim = document.getElementById('sim-' + sid);
      if (sim) sim.style.display = sim.style.display === 'block' ? 'none' : 'block';
      return;
    }
    if (btn.classList.contains('sim-run')) {
      var rid = btn.getAttribute('data-id');
      var panel = document.getElementById('sim-' + rid);
      if (!panel) return;
      var inEl = panel.querySelector('.sim-in');
      var outEl = panel.querySelector('.sim-out');
      var event;
      try { event = JSON.parse(inEl.value || '{}'); }
      catch (err) { outEl.className = 'sim-out err'; outEl.style.display = 'block'; outEl.textContent = 'Invalid JSON: ' + err.message; return; }
      btn.disabled = true;
      outEl.className = 'sim-out'; outEl.style.display = 'block'; outEl.textContent = 'Running…';
      fetch(BASE + '/api/automations/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: rid, event: event }) })
        .then(function(r){ return r.json(); })
        .then(function(data){
          if (data.error) { outEl.className = 'sim-out err'; outEl.textContent = data.error; return; }
          if (data.wouldFire) {
            outEl.className = 'sim-out fire';
            outEl.innerHTML = '<div class="k">Would fire</div>→ dispatch to <code>' + esc(data.agentSlug || '?') + '</code><br><span class="k">Task</span><br><code>' + esc(data.taskDescription || '') + '</code>';
          } else {
            outEl.className = 'sim-out skip';
            outEl.innerHTML = '<div class="k">Would not fire</div>' + esc(data.reason || 'conditions not met');
          }
        })
        .catch(function(err){ outEl.className = 'sim-out err'; outEl.textContent = err.message || 'Simulation failed'; })
        .then(function(){ btn.disabled = false; });
      return;
    }
    if (btn.classList.contains('action-delete')) {
      var id = btn.getAttribute('data-id');
      var name = btn.getAttribute('data-name') || 'this automation';
      if (!id) return;
      if (!confirm('Delete "' + name + '"?')) return;
      fetch(BASE + '/api/automations/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) })
        .then(function(r){ return r.json(); })
        .then(function(data){ if (data.error) { showMsg(data.error, false); } else { showMsg('Deleted', true); load(); } })
        .catch(function(e){ showMsg(e.message || 'Delete failed', false); });
    }
  });

  listEl.addEventListener('change', function(e){
    var box = e.target;
    if (!box || !box.classList || !box.classList.contains('action-toggle')) return;
    var id = box.getAttribute('data-id');
    fetch(BASE + '/api/automations/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id, enabled: box.checked }) })
      .then(function(r){ return r.json(); })
      .then(function(data){ if (data.error) { showMsg(data.error, false); box.checked = !box.checked; } else { showMsg(box.checked ? 'Enabled' : 'Disabled', true); } })
      .catch(function(e){ showMsg(e.message || 'Toggle failed', false); box.checked = !box.checked; });
  });

  function load(){
    fetch(BASE + '/api/automations').then(function(r){ return r.json(); }).then(function(data){
      if (data.error) { listEl.innerHTML = '<p class="empty">'+esc(data.error)+'</p>'; return; }
      var items = data.automations || [];
      if (!items.length) { listEl.innerHTML = '<p class="empty">No automations yet. Create one below.</p>'; return; }
      var html = '';
      items.forEach(function(a){
        var wid = escAttr(a.id);
        html += '<div class="row">';
        html += '<span class="title">'+esc(a.name)+'</span>';
        html += '<span class="tag">'+esc(a.sourceType)+' → '+esc(a.actionType)+':'+esc(a.actionRef)+'</span>';
        html += '<label class="switch"><input type="checkbox" class="action-toggle" data-id="'+wid+'"'+(a.enabled?' checked':'')+'> '+(a.enabled?'On':'Off')+'</label>';
        html += '<span class="meta">'+esc(a.fireCount||0)+' fires</span>';
        html += '<button class="btn action-webhook" data-id="'+wid+'">Show webhook URL</button>';
        html += '<button class="btn action-test" data-id="'+wid+'">Test / dry-run</button>';
        html += '<button class="btn danger action-delete" data-id="'+wid+'" data-name="'+escAttr(a.name)+'">Delete</button>';
        html += '<div class="webhook" id="wh-'+wid+'">POST <code>/automation/'+esc(a.userId)+'/'+esc(a.id)+'</code></div>';
        html += '<div class="sim" id="sim-'+wid+'" data-id="'+wid+'">'
          + '<label>Sample event (JSON) — evaluate conditions without executing</label>'
          + '<textarea class="sim-in">{}</textarea>'
          + '<button class="btn sim-run" data-id="'+wid+'">Run dry-run</button>'
          + '<div class="sim-out"></div>'
          + '</div>';
        html += '</div>';
      });
      listEl.innerHTML = html;
    }).catch(function(e){ listEl.innerHTML = '<p class="empty">'+esc(e.message)+'</p>'; });
  }

  function showReveal(webhookUrl, secret){
    revealEl.innerHTML =
      '<div class="k">Webhook URL — point your event source here</div>' +
      '<code>' + esc(webhookUrl) + '</code>' +
      '<div class="k">Secret — send as the <code>x-nova-signature</code> header</div>' +
      '<code>' + esc(secret) + '</code>';
    revealEl.style.display = 'block';
  }

  document.getElementById('createBtn').addEventListener('click', function(){
    var name = document.getElementById('name').value.trim();
    if (!name) { showMsg('Name is required', false); return; }
    var actionType = actionTypeEl.value;
    var body = {
      name: name,
      sourceType: document.getElementById('sourceType').value,
      actionType: actionType,
      conditions: parseConditions(document.getElementById('conditions').value),
      dedupeKey: document.getElementById('dedupeKey').value.trim() || undefined,
    };
    var rl = document.getElementById('rateLimit').value.trim();
    if (rl) body.rateLimitPerHour = parseInt(rl, 10);
    if (actionType === 'agent') {
      body.actionRef = document.getElementById('agentRef').value.trim();
      body.template = document.getElementById('template').value.trim();
    } else {
      body.actionRef = document.getElementById('playbookRef').value.trim();
      body.playbookVars = parsePlaybookVars(document.getElementById('playbookVars').value);
    }
    if (!body.actionRef) { showMsg((actionType === 'agent' ? 'Agent slug' : 'Playbook name') + ' is required', false); return; }
    fetch(BASE + '/api/automations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function(r){ return r.json(); })
      .then(function(data){
        if (data.error) { showMsg(data.error, false); return; }
        showMsg('Created ' + esc(data.name||name), true);
        if (data.webhookUrl) showReveal(data.webhookUrl, data.secret);
        document.getElementById('name').value = '';
        document.getElementById('agentRef').value = '';
        document.getElementById('template').value = '';
        document.getElementById('playbookRef').value = '';
        document.getElementById('playbookVars').value = '';
        document.getElementById('conditions').value = '';
        document.getElementById('dedupeKey').value = '';
        document.getElementById('rateLimit').value = '';
        load();
      })
      .catch(function(e){ showMsg(e.message || 'Create failed', false); });
  });

  syncActionFields();
  load();
</script>
</body></html>`;
}

export function renderProcessesPage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nova — Processes</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#06060b;--glass:rgba(255,255,255,.05);--border:rgba(255,255,255,.10);--text:rgba(255,255,255,.92);--dim:rgba(255,255,255,.55);--indigo:#6366f1;--green:#22c55e;--red:#ef4444;--yellow:#f59e0b}
  body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px;min-height:100vh}
  .wrap{max-width:660px;margin:0 auto}
  h1{font-size:1.15rem;font-weight:700;margin-bottom:1.4rem}
  h2{font-size:.82rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin:1.4rem 0 .7rem}
  .back{display:block;margin-bottom:1.2rem;color:var(--dim);text-decoration:none;font-size:.8rem}
  .back:hover{color:var(--text)}
  .hint{color:var(--dim);font-size:.8rem;line-height:1.5;margin-bottom:1rem}
  .card{background:var(--glass);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:14px}
  label{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--dim);display:block;margin-bottom:5px}
  select,input[type=text],textarea{padding:7px 10px;border-radius:7px;border:1px solid var(--border);background:rgba(255,255,255,.04);color:var(--text);font-size:.82rem;font-family:inherit;width:100%}
  textarea{resize:vertical;min-height:70px;line-height:1.5;font-family:ui-monospace,monospace}
  .field{margin-bottom:12px}
  .row{background:var(--glass);border:1px solid var(--border);border-radius:10px;padding:12px 16px;margin-bottom:10px}
  .rowhead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;cursor:pointer}
  .title{font-weight:600;flex:1;min-width:120px;font-size:.9rem;color:var(--indigo)}
  .meta{font-size:.75rem;color:var(--dim)}
  .tag{font-size:.68rem;padding:2px 8px;border-radius:5px;border:1px solid var(--border);background:rgba(255,255,255,.05);color:var(--dim);text-transform:uppercase;letter-spacing:.04em}
  .badge{font-size:.68rem;padding:2px 8px;border-radius:5px;text-transform:uppercase;letter-spacing:.04em;font-weight:600}
  .badge.running{background:rgba(99,102,241,.15);color:var(--indigo)}
  .badge.waiting{background:rgba(245,158,11,.15);color:var(--yellow)}
  .badge.done{background:rgba(34,197,94,.15);color:var(--green)}
  .badge.failed{background:rgba(239,68,68,.15);color:var(--red)}
  .badge.cancelled{background:rgba(255,255,255,.08);color:var(--dim)}
  .btn{padding:5px 14px;border-radius:7px;border:1px solid var(--border);background:rgba(255,255,255,.06);color:var(--text);font-size:.78rem;cursor:pointer;font-family:inherit}
  .btn:hover{background:rgba(255,255,255,.10)}
  .btn.danger{border-color:rgba(239,68,68,.4);color:var(--red)}
  .btn.danger:hover{background:rgba(239,68,68,.1)}
  .btn.primary{border:none;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-weight:600}
  .msg{margin:1rem 0;padding:9px 12px;border-radius:8px;font-size:.82rem;display:none}
  .msg.ok{background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.3);color:var(--green)}
  .msg.err{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);color:var(--red)}
  .empty{color:var(--dim);font-size:.85rem}
  .steps{margin-top:10px;padding-top:10px;border-top:1px solid var(--border);display:none}
  .steps.open{display:block}
  .step{display:flex;gap:8px;font-size:.8rem;padding:3px 0;color:var(--dim)}
  .step.cur{color:var(--text)}
  .step .mark{width:14px;flex-shrink:0;text-align:center}
  .step.done .mark{color:var(--green)}
  .step.cur .mark{color:var(--indigo)}
</style></head><body>
<div class="wrap">
  <a class="back" href="${DASHBOARD_BASE}/">← Dashboard</a>
  <h1>Processes</h1>
  <p class="hint">Processes are durable, long-running workflows. Each step is either an <strong>action</strong> (runs as a normal agent task — consequential ones pass the approval gate) or a <strong>wait</strong> (pauses on a timer or an external event). Processes resume automatically when a timer elapses, or via <code>/process signal &lt;event&gt;</code> in chat.</p>
  <div id="msg" class="msg"></div>

  <h2>Your Processes</h2>
  <div id="list"><p class="empty">Loading…</p></div>

  <h2>Create Process</h2>
  <div class="card">
    <div class="field">
      <label>Name</label>
      <input type="text" id="name" placeholder="e.g. contract-signature-chase">
    </div>
    <div class="field">
      <label>Steps — one per line: <code>action|&lt;agent&gt;|&lt;description&gt;</code>, <code>wait|until|+2d</code> (or ISO date), or <code>wait|event|&lt;name&gt;</code></label>
      <textarea id="steps" placeholder="action|orion|Send the contract to {{client}}.&#10;wait|until|+2d&#10;wait|event|signature.done&#10;action|athena|Draft a kickoff plan."></textarea>
    </div>
    <button class="btn primary" id="createBtn">Create Process</button>
  </div>

  <h2>Start from Playbook</h2>
  <div class="card">
    <div class="field">
      <label>Process name</label>
      <input type="text" id="pbProcName" placeholder="e.g. acme-onboarding">
    </div>
    <div class="field">
      <label>Playbook name</label>
      <input type="text" id="pbName" placeholder="e.g. client-onboarding">
    </div>
    <button class="btn primary" id="fromPlaybookBtn">Start from Playbook</button>
  </div>
</div>
<script>
  var BASE = '${DASHBOARD_BASE}';
  function esc(s){var d=document.createElement('div');d.textContent=(s==null?'':String(s));return d.innerHTML;}
  function escAttr(s){return esc(s).replace(/"/g,'&quot;');}
  var msgEl = document.getElementById('msg');
  var listEl = document.getElementById('list');

  function showMsg(text, ok) {
    msgEl.className = 'msg ' + (ok ? 'ok' : 'err');
    msgEl.innerHTML = esc(text);
    msgEl.style.display = 'block';
    setTimeout(function(){msgEl.style.display='none';}, 4000);
  }

  function parseSteps(raw){
    return (raw||'').split('\\n').map(function(l){return l.trim();}).filter(Boolean).map(function(l){
      var parts = l.split('|');
      var type = (parts[0]||'').trim().toLowerCase();
      if (type === 'wait') {
        var kind = (parts[1]||'').trim().toLowerCase();
        var val = parts.slice(2).join('|').trim();
        if (kind === 'event') return { type: 'wait', event: val };
        return { type: 'wait', until: val };
      }
      var agent = (parts[1]||'').trim();
      var description = parts.slice(2).join('|').trim();
      var step = { type: 'action', description: description };
      if (agent) step.agent = agent;
      return step;
    }).filter(function(s){ return s.type === 'wait' ? (s.until || s.event) : s.description; });
  }

  function stepLabel(s){
    if (s.type === 'wait') {
      if (s.event) return 'wait for event ' + esc(s.event);
      return 'wait until ' + esc(s.until || '?');
    }
    return (s.agent ? esc(s.agent) + ': ' : '') + esc(s.description || '');
  }

  function waitInfo(p){
    if (p.state !== 'waiting') return '';
    if (p.waitEvent) return '<span class="meta">⏸ event: ' + esc(p.waitEvent) + '</span>';
    if (p.waitUntil) return '<span class="meta">⏱ ' + esc(p.waitUntil) + '</span>';
    return '';
  }

  listEl.addEventListener('click', function(e){
    var btn = e.target;
    if (!btn || !btn.classList) return;
    if (btn.classList.contains('action-cancel')) {
      e.stopPropagation();
      var id = btn.getAttribute('data-id');
      var name = btn.getAttribute('data-name') || 'this process';
      if (!id) return;
      if (!confirm('Cancel "' + name + '"?')) return;
      fetch(BASE + '/api/processes/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) })
        .then(function(r){ return r.json(); })
        .then(function(data){ if (data.error) { showMsg(data.error, false); } else { showMsg('Cancelled', true); load(); } })
        .catch(function(err){ showMsg(err.message || 'Cancel failed', false); });
      return;
    }
    var head = btn.closest ? btn.closest('.rowhead') : null;
    if (head) {
      var steps = head.parentNode.querySelector('.steps');
      if (steps) steps.classList.toggle('open');
    }
  });

  function load(){
    fetch(BASE + '/api/processes').then(function(r){ return r.json(); }).then(function(data){
      if (data.error) { listEl.innerHTML = '<p class="empty">'+esc(data.error)+'</p>'; return; }
      var items = data.processes || [];
      if (!items.length) { listEl.innerHTML = '<p class="empty">No processes yet. Create one below.</p>'; return; }
      var html = '';
      items.forEach(function(p){
        var id = escAttr(p.id);
        var steps = p.steps || [];
        var cur = typeof p.currentStep === 'number' ? p.currentStep : 0;
        var active = p.state === 'running' || p.state === 'waiting';
        html += '<div class="row">';
        html += '<div class="rowhead">';
        html += '<span class="title">'+esc(p.name)+'</span>';
        html += '<span class="badge '+esc(p.state)+'">'+esc(p.state)+'</span>';
        html += '<span class="meta">step '+Math.min(cur+ (p.state==='done'?0:1), steps.length)+'/'+steps.length+'</span>';
        html += waitInfo(p);
        if (active) html += '<button class="btn danger action-cancel" data-id="'+id+'" data-name="'+escAttr(p.name)+'">Cancel</button>';
        html += '</div>';
        html += '<div class="steps">';
        steps.forEach(function(s, i){
          var cls = 'step';
          var mark = '○';
          if (p.state === 'done' || i < cur) { cls += ' done'; mark = '✓'; }
          else if (i === cur && active) { cls += ' cur'; mark = '▶'; }
          html += '<div class="'+cls+'"><span class="mark">'+mark+'</span><span>'+stepLabel(s)+'</span></div>';
        });
        html += '</div>';
        html += '</div>';
      });
      listEl.innerHTML = html;
    }).catch(function(e){ listEl.innerHTML = '<p class="empty">'+esc(e.message)+'</p>'; });
  }

  document.getElementById('createBtn').addEventListener('click', function(){
    var name = document.getElementById('name').value.trim();
    if (!name) { showMsg('Name is required', false); return; }
    var steps = parseSteps(document.getElementById('steps').value);
    if (!steps.length) { showMsg('At least one step is required', false); return; }
    fetch(BASE + '/api/processes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name, steps: steps }) })
      .then(function(r){ return r.json(); })
      .then(function(data){
        if (data.error) { showMsg(data.error, false); return; }
        showMsg('Created ' + esc(data.name||name), true);
        document.getElementById('name').value = '';
        document.getElementById('steps').value = '';
        load();
      })
      .catch(function(e){ showMsg(e.message || 'Create failed', false); });
  });

  document.getElementById('fromPlaybookBtn').addEventListener('click', function(){
    var name = document.getElementById('pbProcName').value.trim();
    var playbook = document.getElementById('pbName').value.trim();
    if (!name) { showMsg('Process name is required', false); return; }
    if (!playbook) { showMsg('Playbook name is required', false); return; }
    fetch(BASE + '/api/processes/from-playbook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name, playbook: playbook }) })
      .then(function(r){ return r.json(); })
      .then(function(data){
        if (data.error) { showMsg(data.error, false); return; }
        showMsg('Started ' + esc(data.name||name), true);
        document.getElementById('pbProcName').value = '';
        document.getElementById('pbName').value = '';
        load();
      })
      .catch(function(e){ showMsg(e.message || 'Start failed', false); });
  });

  load();
</script>
</body></html>`;
}

// ============================================================
// EXTRACTION PAGE
// ============================================================

export function renderExtractionPage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nova — Extraction</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#06060b;--glass:rgba(255,255,255,.05);--border:rgba(255,255,255,.10);--text:rgba(255,255,255,.92);--dim:rgba(255,255,255,.55);--indigo:#6366f1;--green:#22c55e;--red:#ef4444;--yellow:#f59e0b}
  body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px;min-height:100vh}
  .wrap{max-width:960px;margin:0 auto}
  h1{font-size:1.15rem;font-weight:700;margin-bottom:1.4rem}
  h2{font-size:.82rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin:1.4rem 0 .7rem}
  .back{display:block;margin-bottom:1.2rem;color:var(--dim);text-decoration:none;font-size:.8rem}
  .back:hover{color:var(--text)}
  .hint{color:var(--dim);font-size:.8rem;line-height:1.5;margin-bottom:1rem}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  @media (max-width:760px){.cols{grid-template-columns:1fr}}
  .card{background:var(--glass);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:14px}
  label{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--dim);display:block;margin-bottom:5px}
  select,input[type=text],textarea{padding:7px 10px;border-radius:7px;border:1px solid var(--border);background:rgba(255,255,255,.04);color:var(--text);font-size:.82rem;font-family:inherit;width:100%}
  textarea{resize:vertical;min-height:90px;line-height:1.5;font-family:ui-monospace,monospace}
  .field{margin-bottom:12px}
  .row{background:var(--glass);border:1px solid var(--border);border-radius:10px;padding:12px 16px;margin-bottom:10px}
  .rowhead{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .title{font-weight:600;flex:1;min-width:120px;font-size:.9rem;color:var(--indigo)}
  .meta{font-size:.75rem;color:var(--dim)}
  .btn{padding:5px 14px;border-radius:7px;border:1px solid var(--border);background:rgba(255,255,255,.06);color:var(--text);font-size:.78rem;cursor:pointer;font-family:inherit;text-decoration:none;display:inline-block}
  .btn:hover{background:rgba(255,255,255,.10)}
  .btn.danger{border-color:rgba(239,68,68,.4);color:var(--red)}
  .btn.danger:hover{background:rgba(239,68,68,.1)}
  .btn.primary{border:none;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-weight:600}
  .btn.sm{padding:3px 10px;font-size:.72rem}
  .msg{margin:1rem 0;padding:9px 12px;border-radius:8px;font-size:.82rem;display:none}
  .msg.ok{background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.3);color:var(--green)}
  .msg.err{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);color:var(--red)}
  .empty{color:var(--dim);font-size:.85rem}
  .fields{margin-top:8px;font-size:.78rem;color:var(--dim);line-height:1.5}
  .drop{border:1px dashed var(--border);border-radius:9px;padding:22px;text-align:center;color:var(--dim);font-size:.82rem;cursor:pointer;transition:border-color .15s,background .15s}
  .drop.over{border-color:var(--indigo);background:rgba(99,102,241,.08)}
  .kv{display:flex;gap:10px;padding:5px 0;border-bottom:1px solid var(--border);font-size:.82rem}
  .kv:last-child{border-bottom:none}
  .kv .k{color:var(--dim);min-width:130px;font-family:ui-monospace,monospace}
  .kv .v{flex:1;word-break:break-word}
  .kv.miss .k,.kv.miss .v{color:var(--red)}
  table{width:100%;border-collapse:collapse;font-size:.78rem}
  th{text-align:left;color:var(--dim);text-transform:uppercase;letter-spacing:.04em;font-size:.68rem;font-weight:600;padding:6px 8px;border-bottom:1px solid var(--border)}
  td{padding:6px 8px;border-bottom:1px solid var(--border);color:var(--text);word-break:break-word}
  .tablewrap{overflow-x:auto}
  .toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:.7rem}
</style></head><body>
<div class="wrap">
  <a class="back" href="${DASHBOARD_BASE}/">← Dashboard</a>
  <h1>Extraction</h1>
  <p class="hint">Turn documents into structured data. Define a <strong>schema</strong> (a set of fields), then upload a file — extraction reads PDFs, DOCX and plain text locally and structures them against your schema. Stored rows can be exported to CSV.</p>
  <div id="msg" class="msg"></div>

  <div class="cols">
    <div>
      <h2>Schemas</h2>
      <div id="list"><p class="empty">Loading…</p></div>

      <h2>Create / Edit Schema</h2>
      <div class="card">
        <div class="field">
          <label>Name</label>
          <input type="text" id="sName" placeholder="e.g. invoice">
        </div>
        <div class="field">
          <label>Fields — one per line: <code>name:type:required?</code> (type = string·number·boolean·date·array; add <code>:required</code> to require)</label>
          <textarea id="sFields" placeholder="invoice_number:string:required&#10;total:number:required&#10;due_date:date&#10;line_items:array&#10;paid:boolean"></textarea>
        </div>
        <div class="field">
          <label>Destination (optional)</label>
          <input type="text" id="sDest" placeholder="e.g. sheet name or notion db">
        </div>
        <button class="btn primary" id="saveBtn">Save Schema</button>
      </div>
    </div>

    <div>
      <h2>Run Extraction</h2>
      <div class="card">
        <div class="field">
          <label>Schema</label>
          <select id="runSchema"></select>
        </div>
        <div class="field">
          <div class="drop" id="drop">Drag &amp; drop a file here, or click to choose</div>
          <input type="file" id="file" style="display:none">
          <div class="meta" id="fileName" style="margin-top:6px"></div>
        </div>
        <button class="btn primary" id="runBtn">Extract</button>
        <div id="result" style="margin-top:12px"></div>
      </div>
    </div>
  </div>

  <div class="toolbar">
    <h2 style="margin:0">Stored Extractions</h2>
    <a class="btn sm" id="exportLink" href="#" style="display:none">Export CSV</a>
  </div>
  <div class="tablewrap"><div id="rows"><p class="empty">Pick a schema to view rows.</p></div></div>
</div>
<script>
  var BASE = '${DASHBOARD_BASE}';
  function esc(s){var d=document.createElement('div');d.textContent=(s==null?'':String(s));return d.innerHTML;}
  function escAttr(s){return esc(s).replace(/"/g,'&quot;');}
  var msgEl = document.getElementById('msg');
  var listEl = document.getElementById('list');
  var runSchemaEl = document.getElementById('runSchema');
  var rowsEl = document.getElementById('rows');
  var exportLink = document.getElementById('exportLink');
  var schemas = [];
  var pendingFile = null;

  function showMsg(text, ok) {
    msgEl.className = 'msg ' + (ok ? 'ok' : 'err');
    msgEl.innerHTML = esc(text);
    msgEl.style.display = 'block';
    setTimeout(function(){msgEl.style.display='none';}, 4000);
  }

  var TYPES = ['string','number','boolean','date','array'];
  function parseFields(raw){
    return (raw||'').split('\\n').map(function(l){return l.trim();}).filter(Boolean).map(function(l){
      var parts = l.split(':').map(function(p){return p.trim();});
      var name = parts[0];
      var type = (parts[1]||'').toLowerCase();
      if (TYPES.indexOf(type) < 0) type = 'string';
      var reqTok = (parts[2]||'').toLowerCase();
      var required = reqTok === 'required' || reqTok === 'req' || reqTok === 'true' || reqTok === '*' || reqTok === 'yes';
      var f = { name: name, type: type };
      if (required) f.required = true;
      return f;
    }).filter(function(f){ return f.name; });
  }
  function fieldsToText(fields){
    return (fields||[]).map(function(f){ return f.name + ':' + (f.type||'string') + (f.required ? ':required' : ''); }).join('\\n');
  }
  function fieldSummary(fields){
    return (fields||[]).map(function(f){ return esc(f.name) + '<span style="opacity:.6">:' + esc(f.type||'string') + (f.required?'*':'') + '</span>'; }).join(', ');
  }

  function renderList(){
    if (!schemas.length) { listEl.innerHTML = '<p class="empty">No schemas yet. Create one below.</p>'; return; }
    var html = '';
    schemas.forEach(function(s){
      var name = escAttr(s.name);
      html += '<div class="row">';
      html += '<div class="rowhead">';
      html += '<span class="title">'+esc(s.name)+'</span>';
      html += '<button class="btn sm action-edit" data-name="'+name+'">Edit</button>';
      html += '<button class="btn sm danger action-del" data-name="'+name+'">Delete</button>';
      html += '</div>';
      html += '<div class="fields">'+ (fieldSummary(s.fields) || '<span class="empty">no fields</span>') +'</div>';
      html += '</div>';
    });
    listEl.innerHTML = html;
  }

  function renderSchemaOptions(){
    var prev = runSchemaEl.value;
    runSchemaEl.innerHTML = '';
    schemas.forEach(function(s){
      var o = document.createElement('option');
      o.value = s.name; o.textContent = s.name;
      runSchemaEl.appendChild(o);
    });
    if (prev && schemas.some(function(s){return s.name===prev;})) runSchemaEl.value = prev;
    onSchemaChange();
  }

  listEl.addEventListener('click', function(e){
    var btn = e.target;
    if (!btn || !btn.getAttribute) return;
    var name = btn.getAttribute('data-name');
    if (!name) return;
    if (btn.classList.contains('action-edit')) {
      var s = schemas.filter(function(x){return x.name===name;})[0];
      if (!s) return;
      document.getElementById('sName').value = s.name;
      document.getElementById('sFields').value = fieldsToText(s.fields);
      document.getElementById('sDest').value = s.destination || '';
      window.scrollTo(0,0);
    } else if (btn.classList.contains('action-del')) {
      if (!confirm('Delete schema "'+name+'"?')) return;
      fetch(BASE + '/api/extract/schemas/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name }) })
        .then(function(r){ return r.json(); })
        .then(function(data){ if (data.error) { showMsg(data.error, false); } else { showMsg('Deleted', true); loadSchemas(); } })
        .catch(function(err){ showMsg(err.message || 'Delete failed', false); });
    }
  });

  document.getElementById('saveBtn').addEventListener('click', function(){
    var name = document.getElementById('sName').value.trim();
    if (!name) { showMsg('Name is required', false); return; }
    var fields = parseFields(document.getElementById('sFields').value);
    if (!fields.length) { showMsg('At least one field is required', false); return; }
    var destination = document.getElementById('sDest').value.trim();
    fetch(BASE + '/api/extract/schemas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name, fields: fields, destination: destination || null }) })
      .then(function(r){ return r.json(); })
      .then(function(data){
        if (data.error) { showMsg(data.error, false); return; }
        showMsg('Saved ' + esc(name), true);
        document.getElementById('sName').value = '';
        document.getElementById('sFields').value = '';
        document.getElementById('sDest').value = '';
        loadSchemas();
      })
      .catch(function(e){ showMsg(e.message || 'Save failed', false); });
  });

  // Run panel — file drag/drop
  var drop = document.getElementById('drop');
  var fileInput = document.getElementById('file');
  var fileNameEl = document.getElementById('fileName');
  function setFile(f){ pendingFile = f || null; fileNameEl.textContent = f ? f.name : ''; }
  drop.addEventListener('click', function(){ fileInput.click(); });
  fileInput.addEventListener('change', function(){ setFile(fileInput.files[0]); });
  ['dragenter','dragover'].forEach(function(ev){ drop.addEventListener(ev, function(e){ e.preventDefault(); drop.classList.add('over'); }); });
  ['dragleave','drop'].forEach(function(ev){ drop.addEventListener(ev, function(e){ e.preventDefault(); drop.classList.remove('over'); }); });
  drop.addEventListener('drop', function(e){ if (e.dataTransfer && e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); });

  document.getElementById('runBtn').addEventListener('click', function(){
    var schema = runSchemaEl.value;
    if (!schema) { showMsg('Pick a schema', false); return; }
    if (!pendingFile) { showMsg('Choose a file', false); return; }
    var fd = new FormData();
    fd.append('file', pendingFile);
    fd.append('schema', schema);
    var resEl = document.getElementById('result');
    resEl.innerHTML = '<p class="empty">Extracting…</p>';
    fetch(BASE + '/api/extract/run', { method: 'POST', body: fd })
      .then(function(r){ return r.json(); })
      .then(function(data){
        if (data.error) { resEl.innerHTML = ''; showMsg(data.error, false); return; }
        var missing = data.missing || [];
        var d = data.data || {};
        var html = '<div class="meta" style="margin-bottom:6px">status: '+esc(data.status)+'</div>';
        Object.keys(d).forEach(function(k){
          var miss = missing.indexOf(k) >= 0;
          var v = d[k]; if (Array.isArray(v)) v = v.join('; ');
          html += '<div class="kv'+(miss?' miss':'')+'"><span class="k">'+esc(k)+'</span><span class="v">'+esc(v==null||v===''?'—':v)+'</span></div>';
        });
        if (missing.length) html += '<div class="meta" style="color:var(--red);margin-top:6px">Missing: '+esc(missing.join(', '))+'</div>';
        resEl.innerHTML = html;
        showMsg('Extracted', true);
        loadRows();
      })
      .catch(function(e){ resEl.innerHTML = ''; showMsg(e.message || 'Extraction failed', false); });
  });

  function onSchemaChange(){
    var name = runSchemaEl.value;
    if (name) { exportLink.href = BASE + '/api/extract/export?schema=' + encodeURIComponent(name); exportLink.style.display = 'inline-block'; }
    else exportLink.style.display = 'none';
    loadRows();
  }
  runSchemaEl.addEventListener('change', onSchemaChange);

  function loadRows(){
    var name = runSchemaEl.value;
    if (!name) { rowsEl.innerHTML = '<p class="empty">Pick a schema to view rows.</p>'; return; }
    var schema = schemas.filter(function(s){return s.name===name;})[0];
    var fields = (schema && schema.fields) || [];
    fetch(BASE + '/api/extract/rows?schema=' + encodeURIComponent(name)).then(function(r){ return r.json(); }).then(function(data){
      if (data.error) { rowsEl.innerHTML = '<p class="empty">'+esc(data.error)+'</p>'; return; }
      var items = data.rows || [];
      if (!items.length) { rowsEl.innerHTML = '<p class="empty">No extractions yet for this schema.</p>'; return; }
      var html = '<table><thead><tr>';
      fields.forEach(function(f){ html += '<th>'+esc(f.name)+'</th>'; });
      html += '<th>status</th><th>when</th></tr></thead><tbody>';
      items.forEach(function(it){
        var d = it.data || {};
        html += '<tr>';
        fields.forEach(function(f){ var v = d[f.name]; if (Array.isArray(v)) v = v.join('; '); html += '<td>'+esc(v==null||v===''?'—':v)+'</td>'; });
        html += '<td>'+esc(it.status||'')+'</td><td>'+esc(it.createdAt||'')+'</td>';
        html += '</tr>';
      });
      html += '</tbody></table>';
      rowsEl.innerHTML = html;
    }).catch(function(e){ rowsEl.innerHTML = '<p class="empty">'+esc(e.message)+'</p>'; });
  }

  function loadSchemas(){
    fetch(BASE + '/api/extract/schemas').then(function(r){ return r.json(); }).then(function(data){
      if (data.error && !data.schemas) { listEl.innerHTML = '<p class="empty">'+esc(data.error)+'</p>'; return; }
      schemas = data.schemas || [];
      renderList();
      renderSchemaOptions();
    }).catch(function(e){ listEl.innerHTML = '<p class="empty">'+esc(e.message)+'</p>'; });
  }

  loadSchemas();
</script>
</body></html>`;
}

// ============================================================
// POLICIES PAGE (compliance layer — restrictive-only)
// ============================================================

export function renderPoliciesPage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nova — Policies</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#06060b;--glass:rgba(255,255,255,.05);--border:rgba(255,255,255,.10);--text:rgba(255,255,255,.92);--dim:rgba(255,255,255,.55);--indigo:#6366f1;--green:#22c55e;--red:#ef4444;--yellow:#f59e0b}
  body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px;min-height:100vh}
  .wrap{max-width:960px;margin:0 auto}
  h1{font-size:1.15rem;font-weight:700;margin-bottom:1.4rem}
  h2{font-size:.82rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin:1.4rem 0 .7rem}
  h3{font-size:.78rem;font-weight:600;color:var(--text);margin-bottom:.6rem}
  .back{display:block;margin-bottom:1.2rem;color:var(--dim);text-decoration:none;font-size:.8rem}
  .back:hover{color:var(--text)}
  .hint{color:var(--dim);font-size:.8rem;line-height:1.5;margin-bottom:1rem}
  .notice{background:rgba(245,158,11,.10);border:1px solid rgba(245,158,11,.3);color:var(--text);border-radius:9px;padding:11px 14px;font-size:.8rem;line-height:1.5;margin-bottom:1.2rem}
  .notice strong{color:var(--yellow)}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  @media (max-width:760px){.cols{grid-template-columns:1fr}}
  .card{background:var(--glass);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:14px}
  label{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--dim);display:block;margin-bottom:5px}
  select,input[type=text],input[type=number]{padding:7px 10px;border-radius:7px;border:1px solid var(--border);background:rgba(255,255,255,.04);color:var(--text);font-size:.82rem;font-family:inherit;width:100%}
  .field{margin-bottom:12px}
  .checks{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:5px}
  .checks label{display:inline-flex;align-items:center;gap:6px;text-transform:none;letter-spacing:0;font-size:.82rem;color:var(--text);margin:0;cursor:pointer}
  .checks input{width:auto}
  .row{background:var(--glass);border:1px solid var(--border);border-radius:10px;padding:12px 16px;margin-bottom:10px}
  .rowhead{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .title{font-weight:600;flex:1;min-width:120px;font-size:.88rem}
  .tag{padding:2px 8px;border-radius:5px;font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;background:rgba(255,255,255,.07);color:var(--dim);border:1px solid var(--border)}
  .tag.org{background:rgba(99,102,241,.18);color:var(--indigo);border-color:rgba(99,102,241,.3)}
  .tag.department{background:rgba(245,158,11,.14);color:var(--yellow);border-color:rgba(245,158,11,.3)}
  .tag.off{opacity:.55}
  .btn{padding:5px 14px;border-radius:7px;border:1px solid var(--border);background:rgba(255,255,255,.06);color:var(--text);font-size:.78rem;cursor:pointer;font-family:inherit;text-decoration:none;display:inline-block}
  .btn:hover{background:rgba(255,255,255,.10)}
  .btn.danger{border-color:rgba(239,68,68,.4);color:var(--red)}
  .btn.danger:hover{background:rgba(239,68,68,.1)}
  .btn.primary{border:none;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-weight:600}
  .btn.sm{padding:3px 10px;font-size:.72rem}
  .toggle{padding:3px 12px;font-size:.72rem;border-radius:20px}
  .toggle.on{border-color:rgba(34,197,94,.4);color:var(--green);background:rgba(34,197,94,.10)}
  .toggle.off{border-color:var(--border);color:var(--dim)}
  .msg{margin:1rem 0;padding:9px 12px;border-radius:8px;font-size:.82rem;display:none}
  .msg.ok{background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.3);color:var(--green)}
  .msg.err{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);color:var(--red)}
  .empty{color:var(--dim);font-size:.85rem}
  .group-title{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--dim);margin:1rem 0 .5rem}
</style></head><body>
<div class="wrap">
  <a class="back" href="${DASHBOARD_BASE}/">← Dashboard</a>
  <h1>Policies</h1>
  <p class="hint">The compliance layer. Policies add guardrails to what agents do — spend caps, approval requirements, and content checks — scoped to the whole org, a department, or a single user.</p>
  <div class="notice"><strong>Policies are restrictive-only.</strong> They add friction (require approval, block, or warn) but never grant more autonomy than the earned-autonomy ladder allows. With no policies defined, behavior is unchanged.</div>
  <div id="msg" class="msg"></div>

  <h2>Active Policies</h2>
  <div id="list"><p class="empty">Loading…</p></div>

  <h2>Create Policy</h2>
  <div class="card">
    <div class="cols">
      <div class="field">
        <label>Kind</label>
        <select id="kind">
          <option value="spend_cap">Spend cap</option>
          <option value="approval_matrix">Approval matrix</option>
          <option value="content_check">Content check</option>
        </select>
      </div>
      <div class="field">
        <label>Scope</label>
        <select id="scope">
          <option value="org">Org</option>
          <option value="department">Department</option>
          <option value="user">User</option>
        </select>
      </div>
    </div>
    <div class="field" id="scopeRefField" style="display:none">
      <label id="scopeRefLabel">Scope reference</label>
      <input type="text" id="scopeRef" placeholder="e.g. marketing or a user id">
    </div>

    <div id="form_spend_cap" class="kindform">
      <div class="cols">
        <div class="field">
          <label>Cap (USD)</label>
          <input type="number" id="sc_cap" min="0" step="1" placeholder="500">
        </div>
        <div class="field">
          <label>Period</label>
          <select id="sc_period"><option value="day">Per day</option><option value="month" selected>Per month</option></select>
        </div>
      </div>
      <div class="field">
        <label>Department (optional)</label>
        <input type="text" id="sc_dept" placeholder="e.g. marketing">
      </div>
    </div>

    <div id="form_approval_matrix" class="kindform" style="display:none">
      <div class="field">
        <label>Action type (optional)</label>
        <input type="text" id="am_action" placeholder="e.g. email.send">
      </div>
      <div class="field">
        <label>Approver user id(s) — comma separated</label>
        <input type="text" id="am_approvers" placeholder="e.g. user_123, user_456">
      </div>
      <div class="cols">
        <div class="field">
          <label>Min approver role (optional)</label>
          <input type="text" id="am_role" placeholder="e.g. manager">
        </div>
        <div class="field">
          <label>Escalate after (minutes, optional)</label>
          <input type="number" id="am_escalate" min="0" step="1" placeholder="60">
        </div>
      </div>
      <div class="field">
        <label>Department (optional)</label>
        <input type="text" id="am_dept" placeholder="e.g. marketing">
      </div>
    </div>

    <div id="form_content_check" class="kindform" style="display:none">
      <div class="field">
        <label>Checks</label>
        <div class="checks">
          <label><input type="checkbox" class="cc_check" value="pii" checked> PII</label>
          <label><input type="checkbox" class="cc_check" value="profanity"> Profanity</label>
          <label><input type="checkbox" class="cc_check" value="brand"> Brand</label>
          <label><input type="checkbox" class="cc_check" value="claims"> Claims</label>
        </div>
      </div>
      <div class="cols">
        <div class="field">
          <label>On fail</label>
          <select id="cc_onfail"><option value="block">Block</option><option value="warn">Warn</option></select>
        </div>
        <div class="field">
          <label>Department (optional)</label>
          <input type="text" id="cc_dept" placeholder="e.g. marketing">
        </div>
      </div>
    </div>

    <button class="btn primary" id="createBtn">Create Policy</button>
  </div>
</div>
<script>
  var BASE = '${DASHBOARD_BASE}';
  function esc(s){var d=document.createElement('div');d.textContent=(s==null?'':String(s));return d.innerHTML;}
  var msgEl = document.getElementById('msg');
  var listEl = document.getElementById('list');
  var kindEl = document.getElementById('kind');
  var scopeEl = document.getElementById('scope');

  function showMsg(text, ok){
    msgEl.className = 'msg ' + (ok ? 'ok' : 'err');
    msgEl.innerHTML = esc(text);
    msgEl.style.display = 'block';
    setTimeout(function(){msgEl.style.display='none';}, 4000);
  }

  var KIND_LABEL = { spend_cap: 'Spend cap', approval_matrix: 'Approval matrix', content_check: 'Content check' };

  function describe(p){
    var c = p.config || {};
    if (p.kind === 'spend_cap') {
      return 'cap $' + (c.capUsd != null ? c.capUsd : '?') + '/' + (c.period || 'month') + (c.department ? ' for ' + c.department : '');
    }
    if (p.kind === 'approval_matrix') {
      var who = Array.isArray(c.approvers) && c.approvers.length ? c.approvers.join(', ') : (c.minApproverRole || 'any approver');
      var s = 'approval for ' + (c.actionType || 'all actions') + ' by ' + who;
      if (c.escalateAfterMin) s += ' (escalate after ' + c.escalateAfterMin + 'm)';
      if (c.department) s += ' — ' + c.department;
      return s;
    }
    if (p.kind === 'content_check') {
      var checks = Array.isArray(c.checks) ? c.checks : [];
      return 'check [' + checks.join(', ') + '] → ' + (c.onFail || 'warn') + (c.department ? ' for ' + c.department : '');
    }
    return JSON.stringify(c);
  }

  function scopeLabel(p){
    var s = p.scope || 'org';
    return s + (p.scopeRef ? ':' + p.scopeRef : '');
  }

  function renderList(policies){
    if (!policies.length) { listEl.innerHTML = '<p class="empty">No policies defined. Agent behavior follows the earned-autonomy ladder unchanged.</p>'; return; }
    var order = ['spend_cap','approval_matrix','content_check'];
    var html = '';
    order.forEach(function(kind){
      var group = policies.filter(function(p){ return p.kind === kind; });
      if (!group.length) return;
      html += '<div class="group-title">' + esc(KIND_LABEL[kind] || kind) + '</div>';
      group.forEach(function(p){
        var scope = p.scope || 'org';
        html += '<div class="row">';
        html += '<div class="rowhead">';
        html += '<span class="title">' + esc(describe(p)) + '</span>';
        html += '<span class="tag ' + esc(scope) + (p.enabled ? '' : ' off') + '">' + esc(scopeLabel(p)) + '</span>';
        html += '<button class="btn sm toggle ' + (p.enabled ? 'on' : 'off') + ' action-toggle" data-id="' + esc(p.id) + '" data-enabled="' + (p.enabled ? '1' : '0') + '">' + (p.enabled ? 'On' : 'Off') + '</button>';
        html += '<button class="btn sm danger action-del" data-id="' + esc(p.id) + '">Delete</button>';
        html += '</div></div>';
      });
    });
    listEl.innerHTML = html;
  }

  listEl.addEventListener('click', function(e){
    var btn = e.target;
    if (!btn || !btn.getAttribute) return;
    var id = btn.getAttribute('data-id');
    if (!id) return;
    if (btn.classList.contains('action-toggle')) {
      var enabled = btn.getAttribute('data-enabled') === '1';
      fetch(BASE + '/api/policies/toggle', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id: id, enabled: !enabled }) })
        .then(function(r){ return r.json(); })
        .then(function(d){ if (d.error) { showMsg(d.error, false); } else { load(); } })
        .catch(function(err){ showMsg(err.message || 'Toggle failed', false); });
    } else if (btn.classList.contains('action-del')) {
      if (!confirm('Delete this policy?')) return;
      fetch(BASE + '/api/policies/delete', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id: id }) })
        .then(function(r){ return r.json(); })
        .then(function(d){ if (d.error) { showMsg(d.error, false); } else { showMsg('Deleted', true); load(); } })
        .catch(function(err){ showMsg(err.message || 'Delete failed', false); });
    }
  });

  function syncForms(){
    var kind = kindEl.value;
    ['spend_cap','approval_matrix','content_check'].forEach(function(k){
      document.getElementById('form_' + k).style.display = (k === kind) ? 'block' : 'none';
    });
  }
  function syncScope(){
    var scope = scopeEl.value;
    var field = document.getElementById('scopeRefField');
    var label = document.getElementById('scopeRefLabel');
    if (scope === 'org') { field.style.display = 'none'; }
    else { field.style.display = 'block'; label.textContent = (scope === 'department') ? 'Department name' : 'User id'; }
  }
  kindEl.addEventListener('change', syncForms);
  scopeEl.addEventListener('change', syncScope);

  function buildConfig(kind){
    if (kind === 'spend_cap') {
      var cap = parseFloat(document.getElementById('sc_cap').value);
      if (!(cap >= 0)) { showMsg('Cap must be a number', false); return null; }
      var cfg = { capUsd: cap, period: document.getElementById('sc_period').value };
      var dept = document.getElementById('sc_dept').value.trim();
      if (dept) cfg.department = dept;
      return cfg;
    }
    if (kind === 'approval_matrix') {
      var approvers = document.getElementById('am_approvers').value.split(',').map(function(s){ return s.trim(); }).filter(Boolean);
      var cfg = { approvers: approvers };
      var action = document.getElementById('am_action').value.trim();
      if (action) cfg.actionType = action;
      var role = document.getElementById('am_role').value.trim();
      if (role) cfg.minApproverRole = role;
      var esc = parseInt(document.getElementById('am_escalate').value, 10);
      if (Number.isFinite(esc) && esc > 0) cfg.escalateAfterMin = esc;
      var dept = document.getElementById('am_dept').value.trim();
      if (dept) cfg.department = dept;
      if (!approvers.length && !role) { showMsg('Add an approver id or a min role', false); return null; }
      return cfg;
    }
    if (kind === 'content_check') {
      var checks = Array.prototype.slice.call(document.querySelectorAll('.cc_check:checked')).map(function(el){ return el.value; });
      if (!checks.length) { showMsg('Select at least one check', false); return null; }
      var cfg = { checks: checks, onFail: document.getElementById('cc_onfail').value };
      var dept = document.getElementById('cc_dept').value.trim();
      if (dept) cfg.department = dept;
      return cfg;
    }
    return null;
  }

  document.getElementById('createBtn').addEventListener('click', function(){
    var kind = kindEl.value;
    var config = buildConfig(kind);
    if (!config) return;
    var scope = scopeEl.value;
    var scopeRef = (scope === 'org') ? null : (document.getElementById('scopeRef').value.trim() || null);
    fetch(BASE + '/api/policies', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ scope: scope, scopeRef: scopeRef, kind: kind, config: config }) })
      .then(function(r){ return r.json(); })
      .then(function(d){ if (d.error) { showMsg(d.error, false); return; } showMsg('Policy created', true); load(); })
      .catch(function(err){ showMsg(err.message || 'Create failed', false); });
  });

  function load(){
    fetch(BASE + '/api/policies').then(function(r){ return r.json(); }).then(function(data){
      if (data.error && !data.policies) { listEl.innerHTML = '<p class="empty">' + esc(data.error) + '</p>'; return; }
      renderList(data.policies || []);
    }).catch(function(e){ listEl.innerHTML = '<p class="empty">' + esc(e.message) + '</p>'; });
  }

  syncForms();
  syncScope();
  load();
</script>
</body></html>`;
}

// ============================================================
// GOVERNANCE ADMIN PAGE (RBAC · delegation · connector secrets)
// ============================================================

export function renderGovernanceAdminPage(): string {
  const encAtRest = !!process.env.NOVA_ENCRYPTION_KEY;
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nova — Governance Admin</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#06060b;--glass:rgba(255,255,255,.05);--border:rgba(255,255,255,.10);--text:rgba(255,255,255,.92);--dim:rgba(255,255,255,.55);--indigo:#6366f1;--green:#22c55e;--red:#ef4444;--yellow:#f59e0b}
  body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px;min-height:100vh}
  .wrap{max-width:960px;margin:0 auto}
  h1{font-size:1.15rem;font-weight:700;margin-bottom:1.4rem}
  h2{font-size:.82rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin:1.6rem 0 .7rem}
  h3{font-size:.78rem;font-weight:600;color:var(--text);margin-bottom:.6rem}
  .back{display:block;margin-bottom:1.2rem;color:var(--dim);text-decoration:none;font-size:.8rem}
  .back:hover{color:var(--text)}
  .hint{color:var(--dim);font-size:.8rem;line-height:1.5;margin-bottom:1rem}
  .notice{background:rgba(34,197,94,.10);border:1px solid rgba(34,197,94,.3);color:var(--text);border-radius:9px;padding:11px 14px;font-size:.8rem;line-height:1.5;margin-bottom:1.2rem}
  .notice strong{color:var(--green)}
  .card{background:var(--glass);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:14px}
  label{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--dim);display:block;margin-bottom:5px}
  select,input[type=text],input[type=password],input[type=date]{padding:7px 10px;border-radius:7px;border:1px solid var(--border);background:rgba(255,255,255,.04);color:var(--text);font-size:.82rem;font-family:inherit;width:100%}
  .field{margin-bottom:12px}
  table{width:100%;border-collapse:collapse;font-size:.8rem}
  th,td{text-align:left;padding:8px 8px;border-bottom:1px solid var(--border);vertical-align:top}
  th{color:var(--dim);font-weight:600;text-transform:uppercase;letter-spacing:.04em;font-size:.68rem}
  .bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .bar select,.bar input{width:auto}
  .btn{padding:5px 14px;border-radius:7px;border:1px solid var(--border);background:rgba(255,255,255,.06);color:var(--text);font-size:.78rem;cursor:pointer;font-family:inherit;text-decoration:none;display:inline-block}
  .btn:hover{background:rgba(255,255,255,.10)}
  .btn.sm{padding:3px 10px;font-size:.72rem}
  .btn.danger{border-color:rgba(239,68,68,.4);color:var(--red)}
  .btn.danger:hover{background:rgba(239,68,68,.1)}
  .btn.primary{border:none;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-weight:600}
  .pill{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:5px;font-size:.68rem;font-weight:600;background:rgba(99,102,241,.18);color:#a5b4fc;border:1px solid rgba(99,102,241,.3);margin:2px 4px 2px 0}
  .pill .x{cursor:pointer;opacity:.7}
  .pill .x:hover{opacity:1;color:var(--red)}
  .tag{padding:2px 8px;border-radius:5px;font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;background:rgba(255,255,255,.07);color:var(--dim);border:1px solid var(--border)}
  .tag.admin{background:rgba(245,158,11,.14);color:var(--yellow);border-color:rgba(245,158,11,.3)}
  .msg{margin:1rem 0;padding:9px 12px;border-radius:8px;font-size:.82rem;display:none}
  .msg.ok{background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.3);color:var(--green)}
  .msg.err{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);color:var(--red)}
  .empty{color:var(--dim);font-size:.85rem}
  .muted{color:var(--dim);font-size:.75rem}
  .cred-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  @media (max-width:760px){.cred-grid{grid-template-columns:1fr}}
</style></head><body>
<div class="wrap">
  <a class="back" href="${DASHBOARD_BASE}/">← Dashboard</a>
  <h1>Governance Admin</h1>
  <p class="hint">Access control plane: grant capabilities, set out-of-office delegation, and rotate connector secrets. Admins implicitly hold every capability — grants apply to members only.</p>
  ${encAtRest
    ? `<div class="notice"><strong>Encryption on.</strong> Connector secrets are encrypted at rest (AES-256-GCM) with <code>NOVA_ENCRYPTION_KEY</code>. Stored values are never displayed.</div>`
    : `<div class="notice" style="background:rgba(245,158,11,.10);border-color:rgba(245,158,11,.3)"><strong style="color:var(--yellow)">Encryption key not set.</strong> Set <code>NOVA_ENCRYPTION_KEY</code> to encrypt connector secrets at rest (AES-256-GCM).</div>`}
  <div id="msg" class="msg"></div>

  <h2>Capabilities (RBAC)</h2>
  <p class="hint">Admins can do everything. Members need explicit grants to run governed management actions.</p>
  <div class="card"><div id="rbac"><p class="empty">Loading…</p></div></div>

  <h2>Out-of-office delegation</h2>
  <p class="hint">Route a user's approvals to a delegate while they are away.</p>
  <div class="card"><div id="deleg"><p class="empty">Loading…</p></div></div>

  <h2>Connector secrets</h2>
  <p class="hint">Set credentials for business-system connectors. Secrets write straight to encrypted storage; they are never read back into this page.</p>
  <div id="connectors"><p class="empty">Loading…</p></div>
</div>
<script>
  var BASE = '${DASHBOARD_BASE}';
  function esc(s){var d=document.createElement('div');d.textContent=(s==null?'':String(s));return d.innerHTML;}
  var msgEl = document.getElementById('msg');
  function showMsg(text, ok){
    msgEl.className = 'msg ' + (ok ? 'ok' : 'err');
    msgEl.innerHTML = esc(text);
    msgEl.style.display = 'block';
    setTimeout(function(){msgEl.style.display='none';}, 4000);
  }
  var CAPS = [];
  var USERS = [];
  function userName(id){ for (var i=0;i<USERS.length;i++){ if (USERS[i].id===id) return USERS[i].name || USERS[i].username || USERS[i].id; } return id; }

  function post(path, body){
    return fetch(BASE + path, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{}) })
      .then(function(r){ return r.json().then(function(d){ return { status:r.status, body:d }; }); });
  }

  // ── RBAC ──
  function renderRbac(){
    var rbacEl = document.getElementById('rbac');
    if (!USERS.length) { rbacEl.innerHTML = '<p class="empty">No users.</p>'; return; }
    var capOpts = CAPS.map(function(c){ return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('');
    var html = '<table><thead><tr><th>User</th><th>Role</th><th>Grants</th><th>Manage</th></tr></thead><tbody>';
    USERS.forEach(function(u){
      var isAdmin = u.role === 'admin';
      html += '<tr>';
      html += '<td>' + esc(u.name || u.username || u.id) + '<div class="muted">' + esc(u.id) + '</div></td>';
      html += '<td><span class="tag ' + (isAdmin ? 'admin' : '') + '">' + esc(u.role || 'member') + '</span></td>';
      if (isAdmin) {
        html += '<td class="muted">all (admin)</td><td class="muted">—</td>';
      } else {
        var caps = u.caps || [];
        var grants = caps.length
          ? caps.map(function(c){ return '<span class="pill">' + esc(c) + '<span class="x action-revoke" data-user="' + esc(u.id) + '" data-cap="' + esc(c) + '">✕</span></span>'; }).join('')
          : '<span class="muted">none</span>';
        html += '<td>' + grants + '</td>';
        html += '<td><div class="bar"><select class="cap-sel" data-user="' + esc(u.id) + '">' + capOpts + '</select>'
              + '<button class="btn sm action-grant" data-user="' + esc(u.id) + '">Grant</button></div></td>';
      }
      html += '</tr>';
    });
    html += '</tbody></table>';
    rbacEl.innerHTML = html;
  }

  document.getElementById('rbac').addEventListener('click', function(e){
    var t = e.target;
    if (!t || !t.getAttribute) return;
    if (t.classList.contains('action-grant')) {
      var uid = t.getAttribute('data-user');
      var sel = document.querySelector('.cap-sel[data-user="' + uid + '"]');
      var cap = sel ? sel.value : '';
      if (!cap) return;
      post('/api/gov/grant', { userId: uid, capability: cap }).then(function(res){
        if (res.status !== 200 || res.body.error) { showMsg(res.body.error || 'Grant failed', false); return; }
        showMsg('Granted ' + cap, true); loadUsers();
      });
    } else if (t.classList.contains('action-revoke')) {
      var uid2 = t.getAttribute('data-user');
      var cap2 = t.getAttribute('data-cap');
      post('/api/gov/revoke', { userId: uid2, capability: cap2 }).then(function(res){
        if (res.status !== 200 || res.body.error) { showMsg(res.body.error || 'Revoke failed', false); return; }
        showMsg('Revoked ' + cap2, true); loadUsers();
      });
    }
  });

  // ── Delegation ──
  function renderDeleg(){
    var el = document.getElementById('deleg');
    if (!USERS.length) { el.innerHTML = '<p class="empty">No users.</p>'; return; }
    var html = '<table><thead><tr><th>User</th><th>Status</th><th>Set delegate</th></tr></thead><tbody>';
    USERS.forEach(function(u){
      var d = u.delegation;
      var status = d
        ? '→ <strong>' + esc(userName(d.delegateUserId)) + '</strong>' + (d.until ? ' <span class="muted">until ' + esc(d.until) + '</span>' : '') + (d.reason ? '<div class="muted">' + esc(d.reason) + '</div>' : '')
        : '<span class="muted">in office</span>';
      var opts = '<option value="">— delegate —</option>' + USERS.filter(function(o){ return o.id !== u.id; })
        .map(function(o){ return '<option value="' + esc(o.id) + '">' + esc(o.name || o.username || o.id) + '</option>'; }).join('');
      html += '<tr>';
      html += '<td>' + esc(u.name || u.username || u.id) + '</td>';
      html += '<td>' + status + (d ? ' <button class="btn sm danger action-clear" data-user="' + esc(u.id) + '">Clear</button>' : '') + '</td>';
      html += '<td><div class="bar"><select class="del-user" data-user="' + esc(u.id) + '">' + opts + '</select>'
            + '<input type="text" class="del-reason" data-user="' + esc(u.id) + '" placeholder="reason (optional)" style="width:150px">'
            + '<input type="date" class="del-until" data-user="' + esc(u.id) + '">'
            + '<button class="btn sm action-setdel" data-user="' + esc(u.id) + '">Set</button></div></td>';
      html += '</tr>';
    });
    html += '</tbody></table>';
    el.innerHTML = html;
  }

  document.getElementById('deleg').addEventListener('click', function(e){
    var t = e.target;
    if (!t || !t.getAttribute) return;
    if (t.classList.contains('action-setdel')) {
      var uid = t.getAttribute('data-user');
      var sel = document.querySelector('.del-user[data-user="' + uid + '"]');
      var reason = document.querySelector('.del-reason[data-user="' + uid + '"]');
      var until = document.querySelector('.del-until[data-user="' + uid + '"]');
      var delegateUserId = sel ? sel.value : '';
      if (!delegateUserId) { showMsg('Pick a delegate', false); return; }
      post('/api/gov/delegate', { userId: uid, delegateUserId: delegateUserId, reason: reason ? reason.value.trim() : '', until: until ? until.value : '' }).then(function(res){
        if (res.status !== 200 || res.body.error) { showMsg(res.body.error || 'Set failed', false); return; }
        showMsg('Delegation set', true); loadUsers();
      });
    } else if (t.classList.contains('action-clear')) {
      var uid2 = t.getAttribute('data-user');
      post('/api/gov/delegate/clear', { userId: uid2 }).then(function(res){
        if (res.status !== 200 || res.body.error) { showMsg(res.body.error || 'Clear failed', false); return; }
        showMsg('Delegation cleared', true); loadUsers();
      });
    }
  });

  // ── Connector secrets ──
  function renderConnectors(list){
    var el = document.getElementById('connectors');
    if (!list.length) { el.innerHTML = '<p class="empty">No connectors registered.</p>'; return; }
    var html = '';
    list.forEach(function(c){
      html += '<div class="card">';
      html += '<h3>' + esc(c.label) + ' <span class="muted">(' + esc(c.id) + ')</span></h3>';
      html += '<div class="muted" style="margin-bottom:10px">' + (c.rotations || 0) + ' rotation' + (c.rotations === 1 ? '' : 's') + ' logged</div>';
      html += '<div class="cred-grid">';
      (c.credEnv || []).forEach(function(env){
        html += '<div class="field"><label>' + esc(env) + '</label><input type="password" class="cred-input" data-conn="' + esc(c.id) + '" data-env="' + esc(env) + '" placeholder="•••• (leave blank to keep)" autocomplete="off"></div>';
      });
      html += '</div>';
      html += '<button class="btn primary action-savesecret" data-conn="' + esc(c.id) + '">Save secret</button>';
      html += '</div>';
    });
    el.innerHTML = html;
  }

  document.getElementById('connectors').addEventListener('click', function(e){
    var t = e.target;
    if (!t || !t.getAttribute || !t.classList.contains('action-savesecret')) return;
    var conn = t.getAttribute('data-conn');
    var inputs = document.querySelectorAll('.cred-input[data-conn="' + conn + '"]');
    var creds = {};
    var any = false;
    inputs.forEach(function(inp){ var v = inp.value; if (v) { creds[inp.getAttribute('data-env')] = v; any = true; } });
    if (!any) { showMsg('Enter at least one value', false); return; }
    post('/api/gov/connector-secret', { id: conn, creds: creds }).then(function(res){
      if (res.status !== 200 || !res.body.ok) { showMsg((res.body && res.body.error) || 'Save failed', false); return; }
      showMsg('Secret saved (encrypted at rest)', true);
      inputs.forEach(function(inp){ inp.value = ''; });
      loadConnectors();
    });
  });

  function loadUsers(){
    fetch(BASE + '/api/gov/users').then(function(r){ return r.json(); }).then(function(data){
      if (data.error) { document.getElementById('rbac').innerHTML = '<p class="empty">' + esc(data.error) + '</p>'; return; }
      USERS = data.users || [];
      CAPS = data.capabilities || [];
      renderRbac();
      renderDeleg();
    }).catch(function(e){ document.getElementById('rbac').innerHTML = '<p class="empty">' + esc(e.message) + '</p>'; });
  }
  function loadConnectors(){
    fetch(BASE + '/api/gov/connectors').then(function(r){ return r.json(); }).then(function(data){
      renderConnectors((data && data.connectors) || []);
    }).catch(function(e){ document.getElementById('connectors').innerHTML = '<p class="empty">' + esc(e.message) + '</p>'; });
  }

  loadUsers();
  loadConnectors();
</script>
</body></html>`;
}

// ============================================================
// ROI PAGE
// ============================================================

export function renderRoiPage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nova — ROI</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#06060b;--glass:rgba(255,255,255,.05);--border:rgba(255,255,255,.10);--text:rgba(255,255,255,.92);--dim:rgba(255,255,255,.55);--indigo:#6366f1;--green:#57C785;--red:#E86A84;--yellow:#F0B429;--blue:#2AABEE;--grid:rgba(255,255,255,.07)}
  body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px;min-height:100vh}
  .wrap{max-width:960px;margin:0 auto}
  h1{font-size:1.15rem;font-weight:700;margin-bottom:.5rem}
  h2{font-size:.82rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin:1.8rem 0 .8rem}
  .back{display:block;margin-bottom:1.2rem;color:var(--dim);text-decoration:none;font-size:.8rem}
  .back:hover{color:var(--text)}
  .hint{color:var(--dim);font-size:.8rem;line-height:1.5;margin-bottom:1.2rem}
  .hint code{background:rgba(255,255,255,.07);padding:1px 6px;border-radius:5px;font-size:.76rem;color:var(--text)}
  .periods{display:flex;gap:8px;margin-bottom:1.4rem}
  .period{padding:5px 15px;border-radius:20px;border:1px solid var(--border);background:rgba(255,255,255,.04);color:var(--dim);font-size:.78rem;cursor:pointer;font-family:inherit}
  .period:hover{color:var(--text)}
  .period.active{border-color:rgba(42,171,238,.5);color:var(--blue);background:rgba(42,171,238,.12);font-weight:600}
  .tiles{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}
  @media (max-width:760px){.tiles{grid-template-columns:repeat(2,1fr)}}
  .tile{background:var(--glass);border:1px solid var(--border);border-radius:12px;padding:16px 18px}
  .tile .num{font-size:1.7rem;font-weight:700;line-height:1.1;letter-spacing:-.02em}
  .tile .lbl{font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;color:var(--dim);margin-top:6px}
  .tile.accent .num{color:var(--blue)}
  .tile.net-pos .num{color:var(--green)}
  .tile.net-neg .num{color:var(--red)}
  .card{background:var(--glass);border:1px solid var(--border);border-radius:12px;padding:18px}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  @media (max-width:760px){.cols{grid-template-columns:1fr}}
  h3{font-size:.82rem;font-weight:600;color:var(--text);margin-bottom:.9rem}
  .empty{color:var(--dim);font-size:.82rem;padding:24px 4px;text-align:center}
  svg{width:100%;height:auto;display:block}
  .bar-label{fill:var(--dim);font-size:12px;font-family:Inter,system-ui,sans-serif}
  .bar-val{fill:var(--text);font-size:12px;font-weight:600;font-family:Inter,system-ui,sans-serif}
</style></head><body>
<div class="wrap">
  <a class="back" href="${DASHBOARD_BASE}/">← Dashboard</a>
  <h1>ROI</h1>
  <p class="hint">Business-outcome observability. Value is captured when agents tag outcomes with <code>[VALUE: $X | SAVED: Ymin]</code>; cost comes from the action ledger.</p>

  <div class="periods" id="periods">
    <button class="period" data-days="7">7 days</button>
    <button class="period" data-days="30">30 days</button>
    <button class="period" data-days="90">90 days</button>
  </div>

  <div class="tiles" id="tiles">
    <div class="tile"><div class="num" id="t_tasks">–</div><div class="lbl">Tasks automated</div></div>
    <div class="tile"><div class="num" id="t_hours">–</div><div class="lbl">Hours saved</div></div>
    <div class="tile accent"><div class="num" id="t_value">–</div><div class="lbl">Value influenced</div></div>
    <div class="tile"><div class="num" id="t_cost">–</div><div class="lbl">AI cost</div></div>
    <div class="tile" id="t_net_tile"><div class="num" id="t_net">–</div><div class="lbl">Net</div></div>
  </div>

  <div class="cols">
    <div>
      <h2>Value by department</h2>
      <div class="card"><div id="chart_dept"><p class="empty">Loading…</p></div></div>
    </div>
    <div>
      <h2>Hours saved by agent</h2>
      <div class="card"><div id="chart_agent"><p class="empty">Loading…</p></div></div>
    </div>
  </div>
</div>
<script>
  var BASE = '${DASHBOARD_BASE}';
  // Nova brand chart palette — assigned by category in fixed order, never cycled.
  var PALETTE = ['#2AABEE', '#F0B429', '#57C785', '#E86A84', '#8A97B0'];
  var days = 7;

  function esc(s){var d=document.createElement('div');d.textContent=(s==null?'':String(s));return d.innerHTML;}
  function fmtMoney(n){ return '$' + Math.round(n||0).toLocaleString(); }
  function fmtHours(n){ return (Math.round((n||0)*10)/10) + 'h'; }

  // Hand-built horizontal SVG bar chart. Single measure, categorical colors in fixed order.
  function barChart(entries, fmt){
    if (!entries.length) return '<p class="empty">No data yet.</p>';
    var W = 680, rowH = 34, barH = 15, labelW = 150, valW = 74;
    var pad = 8, chartX = labelW, chartW = W - labelW - valW - pad;
    var H = entries.length * rowH + 10;
    var max = 0; entries.forEach(function(e){ if (e.value > max) max = e.value; });
    if (max <= 0) max = 1;
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" preserveAspectRatio="xMinYMin meet">';
    // recessive grid: vertical lines at 25/50/75/100%
    [0.25,0.5,0.75,1].forEach(function(f){
      var x = chartX + chartW * f;
      svg += '<line x1="' + x + '" y1="4" x2="' + x + '" y2="' + (H - 6) + '" stroke="var(--grid)" stroke-width="1"/>';
    });
    entries.forEach(function(e, i){
      var cy = 5 + i * rowH + rowH / 2;
      var w = Math.max(2, chartW * (e.value / max));
      var color = PALETTE[i % PALETTE.length];
      // label (truncated, right-aligned)
      var lbl = e.label.length > 20 ? e.label.slice(0, 19) + '…' : e.label;
      svg += '<text class="bar-label" x="' + (labelW - 12) + '" y="' + (cy + 4) + '" text-anchor="end">' + esc(lbl) + '</text>';
      // bar — thin, 4px rounded data-end
      svg += '<rect x="' + chartX + '" y="' + (cy - barH / 2) + '" width="' + w + '" height="' + barH + '" rx="4" fill="' + color + '"/>';
      // direct value label
      svg += '<text class="bar-val" x="' + (chartX + w + 8) + '" y="' + (cy + 4) + '">' + esc(fmt(e.value)) + '</text>';
    });
    svg += '</svg>';
    return svg;
  }

  function toEntries(obj, key){
    return Object.keys(obj || {})
      .map(function(k){ return { label: k, value: (obj[k] && obj[k][key]) || 0 }; })
      .filter(function(e){ return e.value > 0; })
      .sort(function(a, b){ return b.value - a.value; });
  }

  function render(r){
    document.getElementById('t_tasks').textContent = (r.tasksAutomated || 0).toLocaleString();
    document.getElementById('t_hours').textContent = fmtHours(r.hoursSaved);
    document.getElementById('t_value').textContent = fmtMoney(r.valueUsd);
    document.getElementById('t_cost').textContent = fmtMoney(r.costUsd);
    document.getElementById('t_net').textContent = fmtMoney(r.netUsd);
    var netTile = document.getElementById('t_net_tile');
    netTile.className = 'tile ' + ((r.netUsd || 0) >= 0 ? 'net-pos' : 'net-neg');
    document.getElementById('chart_dept').innerHTML = barChart(toEntries(r.byDepartment, 'valueUsd'), fmtMoney);
    document.getElementById('chart_agent').innerHTML = barChart(toEntries(r.byAgent, 'hoursSaved'), fmtHours);
  }

  function load(){
    fetch(BASE + '/api/roi?days=' + days).then(function(res){ return res.json(); }).then(function(r){
      if (r.error) {
        document.getElementById('chart_dept').innerHTML = '<p class="empty">' + esc(r.error) + '</p>';
        document.getElementById('chart_agent').innerHTML = '<p class="empty">' + esc(r.error) + '</p>';
        return;
      }
      render(r);
    }).catch(function(e){
      document.getElementById('chart_dept').innerHTML = '<p class="empty">' + esc(e.message) + '</p>';
    });
  }

  var periodsEl = document.getElementById('periods');
  function setActive(){
    Array.prototype.forEach.call(periodsEl.children, function(b){
      b.classList.toggle('active', Number(b.getAttribute('data-days')) === days);
    });
  }
  periodsEl.addEventListener('click', function(e){
    var d = e.target && e.target.getAttribute && e.target.getAttribute('data-days');
    if (!d) return;
    days = Number(d);
    setActive();
    load();
  });

  setActive();
  load();
</script>
</body></html>`;
}

// ============================================================
// DATA PAGE (connected-data layer)
// ============================================================

export function renderDataPage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nova — Data</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#06060b;--glass:rgba(255,255,255,.05);--border:rgba(255,255,255,.10);--text:rgba(255,255,255,.92);--dim:rgba(255,255,255,.55);--indigo:#6366f1;--green:#57C785;--red:#E86A84;--yellow:#F0B429;--blue:#2AABEE}
  body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px;min-height:100vh}
  .wrap{max-width:960px;margin:0 auto}
  h1{font-size:1.15rem;font-weight:700;margin-bottom:.5rem}
  h2{font-size:.82rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin:1.8rem 0 .8rem}
  .back{display:block;margin-bottom:1.2rem;color:var(--dim);text-decoration:none;font-size:.8rem}
  .back:hover{color:var(--text)}
  .hint{color:var(--dim);font-size:.8rem;line-height:1.5;margin-bottom:1.2rem}
  .hint code{background:rgba(255,255,255,.07);padding:1px 6px;border-radius:5px;font-size:.76rem;color:var(--text)}
  .card{background:var(--glass);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:12px}
  .src-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:.5rem}
  .src-head h3{font-size:.95rem;font-weight:700}
  .badge{font-size:.66rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:2px 9px;border-radius:20px;border:1px solid var(--border);white-space:nowrap}
  .badge.http{color:var(--blue);border-color:rgba(42,171,238,.4);background:rgba(42,171,238,.12)}
  .badge.sqlite{color:var(--green);border-color:rgba(87,199,133,.4);background:rgba(87,199,133,.12)}
  .badge.connector{color:var(--yellow);border-color:rgba(240,180,41,.4);background:rgba(240,180,41,.12)}
  .cfg{font-family:ui-monospace,monospace;font-size:.72rem;color:var(--dim);word-break:break-word;margin-bottom:.7rem}
  .src-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  label{display:block;font-size:.72rem;color:var(--dim);margin-bottom:.35rem}
  input,select,textarea{width:100%;background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:inherit;font-size:.8rem;padding:8px 10px;margin-bottom:.7rem}
  textarea{font-family:ui-monospace,monospace;resize:vertical;min-height:64px}
  button{background:var(--blue);color:#04121c;border:none;border-radius:8px;font-family:inherit;font-weight:600;font-size:.8rem;padding:8px 18px;cursor:pointer}
  button.ghost{background:transparent;color:var(--dim);border:1px solid var(--border)}
  button.ghost:hover{color:var(--text)}
  button.danger{background:transparent;color:var(--red);border:1px solid rgba(232,106,132,.4)}
  button:disabled{opacity:.4;cursor:not-allowed}
  .ovr{margin-top:.7rem}
  .field{display:none}
  .field.show{display:block}
  table{border-collapse:collapse;width:100%;font-size:.76rem}
  th,td{text-align:left;padding:6px 10px;border-bottom:1px solid rgba(255,255,255,.06);white-space:nowrap}
  th{color:var(--dim);text-transform:uppercase;letter-spacing:.04em;font-size:.66rem;font-weight:600}
  td{font-family:ui-monospace,monospace}
  .tablewrap{overflow-x:auto;border:1px solid var(--border);border-radius:8px;margin-top:.5rem}
  .count{font-size:.74rem;color:var(--dim);margin-top:.5rem}
  .empty{color:var(--dim);font-size:.82rem;padding:24px 4px;text-align:center}
  .err{color:var(--red);font-size:.78rem;margin-top:.5rem}
</style></head><body>
<div class="wrap">
  <a class="back" href="${DASHBOARD_BASE}/">← Dashboard</a>
  <h1>Data</h1>
  <p class="hint">Connected-data layer. Sources are <b>read-only</b> — connect an HTTP report, a read-only SQLite file, or a connector read action, then query it here or from agents (<code>nova data query</code>). Connector write actions are refused by the backend.</p>

  <h2>Registered sources</h2>
  <div id="list"><p class="empty">Loading…</p></div>

  <h2>Query result</h2>
  <div class="card" id="resultCard"><p class="empty">Run a source to see rows here.</p></div>

  <h2>Add a source</h2>
  <div class="card">
    <label>Name</label>
    <input id="f_name" placeholder="e.g. sales-report">
    <label>Kind</label>
    <select id="f_kind">
      <option value="http">http</option>
      <option value="sqlite">sqlite</option>
      <option value="connector">connector</option>
    </select>

    <div class="field show" data-kind="http">
      <label>URL</label>
      <input id="f_url" placeholder="https://api.example.com/report.json">
      <label>Rows path (dot path to the array; optional)</label>
      <input id="f_rowsPath" placeholder="data.items">
      <label>Format (optional)</label>
      <select id="f_format">
        <option value="">auto (JSON)</option>
        <option value="csv">csv</option>
      </select>
    </div>

    <div class="field" data-kind="sqlite">
      <label>File path (read-only)</label>
      <input id="f_path" placeholder="/data/reports.db">
      <label>Query (SELECT / WITH only)</label>
      <textarea id="f_query">SELECT * FROM my_table LIMIT 100</textarea>
    </div>

    <div class="field" data-kind="connector">
      <label>Connector</label>
      <input id="f_connector" placeholder="stripe">
      <label>Action (read action)</label>
      <input id="f_action" placeholder="list_charges">
      <label>Rows path (optional)</label>
      <input id="f_crowsPath" placeholder="data">
    </div>

    <button id="saveBtn">Save source</button>
    <div class="err" id="saveErr" style="display:none"></div>
  </div>
</div>
<script>
  var BASE = '${DASHBOARD_BASE}';
  function esc(s){var d=document.createElement('div');d.textContent=(s==null?'':String(s));return d.innerHTML;}

  function cfgSummary(s){
    var c = s.config || {};
    if (s.kind === 'http') return (c.method || 'GET') + ' ' + (c.url || '') + (c.rowsPath ? ' · rows=' + c.rowsPath : '') + (c.format ? ' · ' + c.format : '');
    if (s.kind === 'sqlite') return (c.path || '') + (c.query ? ' · ' + c.query : '');
    if (s.kind === 'connector') return (c.connector || '') + '.' + (c.action || '') + (c.rowsPath ? ' · rows=' + c.rowsPath : '');
    return JSON.stringify(c);
  }

  function srcHtml(s){
    var h = '<div class="card" data-name="' + esc(s.name) + '" data-kind="' + esc(s.kind) + '">';
    h += '<div class="src-head"><h3>' + esc(s.name) + '</h3><span class="badge ' + esc(s.kind) + '">' + esc(s.kind) + '</span></div>';
    h += '<div class="cfg">' + esc(cfgSummary(s)) + '</div>';
    if (s.kind === 'sqlite') {
      h += '<div class="ovr"><label>Ad-hoc query override (optional)</label><textarea class="s-query" placeholder="SELECT ..."></textarea></div>';
    }
    h += '<div class="src-actions"><button class="s-run">Run</button><button class="ghost s-del danger">Delete</button></div>';
    h += '</div>';
    return h;
  }

  function renderTable(r){
    var card = document.getElementById('resultCard');
    var cols = r.columns || [];
    var rows = r.rows || [];
    if (!rows.length) { card.innerHTML = '<p class="empty">Source "' + esc(r.source) + '" returned no rows.</p>'; return; }
    var h = '<div class="tablewrap"><table><thead><tr>';
    cols.forEach(function(c){ h += '<th>' + esc(c) + '</th>'; });
    h += '</tr></thead><tbody>';
    rows.forEach(function(row){
      h += '<tr>';
      cols.forEach(function(c){
        var v = row[c];
        h += '<td>' + esc(v && typeof v === 'object' ? JSON.stringify(v) : v) + '</td>';
      });
      h += '</tr>';
    });
    h += '</tbody></table></div>';
    h += '<div class="count">' + rows.length + ' row(s) · source: ' + esc(r.source) + '</div>';
    card.innerHTML = h;
  }

  function runSource(name, query){
    var card = document.getElementById('resultCard');
    card.innerHTML = '<p class="empty">Running…</p>';
    fetch(BASE + '/api/data/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, query: query || undefined })
    }).then(function(r){ return r.json(); }).then(function(r){
      if (r.error) { card.innerHTML = '<p class="err">' + esc(r.error) + '</p>'; return; }
      renderTable(r);
    }).catch(function(e){ card.innerHTML = '<p class="err">' + esc(e.message) + '</p>'; });
  }

  function delSource(name){
    fetch(BASE + '/api/data/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name })
    }).then(function(){ load(); });
  }

  function wire(card){
    var name = card.getAttribute('data-name');
    var runBtn = card.querySelector('.s-run');
    var delBtn = card.querySelector('.s-del');
    var qEl = card.querySelector('.s-query');
    if (runBtn) runBtn.addEventListener('click', function(){ runSource(name, qEl ? qEl.value.trim() : ''); });
    if (delBtn) delBtn.addEventListener('click', function(){ delSource(name); });
  }

  function load(){
    var listEl = document.getElementById('list');
    fetch(BASE + '/api/data').then(function(r){ return r.json(); }).then(function(r){
      if (r.error) { listEl.innerHTML = '<p class="empty">' + esc(r.error) + '</p>'; return; }
      var list = r.sources || [];
      if (!list.length) { listEl.innerHTML = '<p class="empty">No data sources registered yet.</p>'; return; }
      listEl.innerHTML = list.map(srcHtml).join('');
      Array.prototype.forEach.call(listEl.querySelectorAll('.card'), wire);
    }).catch(function(e){ listEl.innerHTML = '<p class="empty">' + esc(e.message) + '</p>'; });
  }

  // kind field toggling
  var kindSel = document.getElementById('f_kind');
  function syncFields(){
    var k = kindSel.value;
    Array.prototype.forEach.call(document.querySelectorAll('.field'), function(f){
      f.classList.toggle('show', f.getAttribute('data-kind') === k);
    });
  }
  kindSel.addEventListener('change', syncFields);
  syncFields();

  function buildConfig(kind){
    if (kind === 'http') {
      var cfg = { url: document.getElementById('f_url').value.trim() };
      var rp = document.getElementById('f_rowsPath').value.trim();
      var fmt = document.getElementById('f_format').value;
      if (rp) cfg.rowsPath = rp;
      if (fmt) cfg.format = fmt;
      return cfg;
    }
    if (kind === 'sqlite') {
      return { path: document.getElementById('f_path').value.trim(), query: document.getElementById('f_query').value.trim() };
    }
    var c = { connector: document.getElementById('f_connector').value.trim(), action: document.getElementById('f_action').value.trim() };
    var crp = document.getElementById('f_crowsPath').value.trim();
    if (crp) c.rowsPath = crp;
    return c;
  }

  document.getElementById('saveBtn').addEventListener('click', function(){
    var errEl = document.getElementById('saveErr');
    errEl.style.display = 'none';
    var name = document.getElementById('f_name').value.trim();
    var kind = kindSel.value;
    if (!name) { errEl.textContent = 'Name is required.'; errEl.style.display = 'block'; return; }
    var config = buildConfig(kind);
    fetch(BASE + '/api/data', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, kind: kind, config: config })
    }).then(function(r){ return r.json(); }).then(function(r){
      if (r.error) { errEl.textContent = r.error; errEl.style.display = 'block'; return; }
      document.getElementById('f_name').value = '';
      load();
    }).catch(function(e){ errEl.textContent = e.message; errEl.style.display = 'block'; });
  });

  load();
</script>
</body></html>`;
}

// ============================================================
// CONNECTORS PAGE
// ============================================================

export function renderConnectorsPage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nova — Connectors</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#06060b;--glass:rgba(255,255,255,.05);--border:rgba(255,255,255,.10);--text:rgba(255,255,255,.92);--dim:rgba(255,255,255,.55);--indigo:#6366f1;--green:#57C785;--red:#E86A84;--yellow:#F0B429;--blue:#2AABEE}
  body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px;min-height:100vh}
  .wrap{max-width:960px;margin:0 auto}
  h1{font-size:1.15rem;font-weight:700;margin-bottom:.5rem}
  .back{display:block;margin-bottom:1.2rem;color:var(--dim);text-decoration:none;font-size:.8rem}
  .back:hover{color:var(--text)}
  .hint{color:var(--dim);font-size:.8rem;line-height:1.5;margin-bottom:1.4rem}
  .hint code{background:rgba(255,255,255,.07);padding:1px 6px;border-radius:5px;font-size:.76rem;color:var(--text)}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  @media (max-width:760px){.grid{grid-template-columns:1fr}}
  .card{background:var(--glass);border:1px solid var(--border);border-radius:12px;padding:18px}
  .card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:.7rem}
  .card-head h3{font-size:.95rem;font-weight:700}
  .kind{font-size:.66rem;text-transform:uppercase;letter-spacing:.05em;color:var(--dim)}
  .badge{font-size:.7rem;font-weight:600;padding:3px 10px;border-radius:20px;border:1px solid var(--border);white-space:nowrap}
  .badge.on{color:var(--green);border-color:rgba(87,199,133,.4);background:rgba(87,199,133,.12)}
  .badge.off{color:var(--dim)}
  .sec{font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;color:var(--dim);margin:1rem 0 .5rem}
  .env-list{display:flex;flex-wrap:wrap;gap:6px;margin-top:.4rem}
  .env{font-family:ui-monospace,monospace;font-size:.72rem;background:rgba(255,255,255,.06);border:1px solid var(--border);padding:2px 8px;border-radius:6px;color:var(--text)}
  .act{display:flex;align-items:center;gap:8px;font-size:.8rem;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.05)}
  .act:last-child{border-bottom:none}
  .act .aname{font-weight:600}
  .act .adesc{color:var(--dim);font-size:.74rem}
  .chip{font-size:.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:1px 7px;border-radius:5px}
  .chip.write{color:var(--red);background:rgba(232,106,132,.14);border:1px solid rgba(232,106,132,.4)}
  .chip.read{color:var(--blue);background:rgba(42,171,238,.12);border:1px solid rgba(42,171,238,.3)}
  .chip.trig{color:var(--yellow);background:rgba(240,180,41,.12);border:1px solid rgba(240,180,41,.3)}
  .run{margin-top:1rem;border-top:1px solid var(--border);padding-top:1rem}
  label{display:block;font-size:.72rem;color:var(--dim);margin-bottom:.35rem}
  select,textarea{width:100%;background:rgba(255,255,255,.04);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:inherit;font-size:.8rem;padding:8px 10px;margin-bottom:.7rem}
  textarea{font-family:ui-monospace,monospace;resize:vertical;min-height:64px}
  .confirm{display:flex;align-items:center;gap:8px;font-size:.76rem;color:var(--red);margin-bottom:.7rem}
  .confirm input{width:auto;margin:0}
  button{background:var(--blue);color:#04121c;border:none;border-radius:8px;font-family:inherit;font-weight:600;font-size:.8rem;padding:8px 18px;cursor:pointer}
  button:disabled{opacity:.4;cursor:not-allowed}
  pre.out{background:rgba(0,0,0,.35);border:1px solid var(--border);border-radius:8px;padding:10px;margin-top:.7rem;font-family:ui-monospace,monospace;font-size:.72rem;white-space:pre-wrap;word-break:break-word;max-height:260px;overflow:auto}
  .empty{color:var(--dim);font-size:.82rem;padding:24px 4px;text-align:center}
</style></head><body>
<div class="wrap">
  <a class="back" href="${DASHBOARD_BASE}/">← Dashboard</a>
  <h1>Connectors</h1>
  <p class="hint">Connect Nova to business systems (Stripe, Shopify, Zendesk, HubSpot). Credentials live in <b>env vars</b> (self-host) or the shared credentials store — never entered here. <b style="color:var(--red)">Write actions are consequential</b> (they charge, refund, create, or modify records); they require a confirm step before running.</p>
  <div class="grid" id="grid"><p class="empty">Loading…</p></div>
</div>
<script>
  var BASE = '${DASHBOARD_BASE}';
  function esc(s){var d=document.createElement('div');d.textContent=(s==null?'':String(s));return d.innerHTML;}

  function cardHtml(c){
    var badge = c.configured
      ? '<span class="badge on">● configured</span>'
      : '<span class="badge off">○ not configured</span>';
    var h = '<div class="card" data-id="' + esc(c.id) + '">';
    h += '<div class="card-head"><div><h3>' + esc(c.label) + '</h3><div class="kind">' + esc(c.authKind) + '</div></div>' + badge + '</div>';

    if (!c.configured) {
      h += '<div class="sec">Set these in .env</div><div class="env-list">';
      (c.credEnv || []).forEach(function(e){ h += '<span class="env">' + esc(e) + '</span>'; });
      h += '</div>';
    }

    h += '<div class="sec">Actions</div>';
    (c.actions || []).forEach(function(a){
      var chip = a.write ? '<span class="chip write">write</span>' : '<span class="chip read">read</span>';
      h += '<div class="act">' + chip + '<span class="aname">' + esc(a.name) + '</span><span class="adesc">' + esc(a.description) + '</span></div>';
    });

    if ((c.triggers || []).length) {
      h += '<div class="sec">Triggers</div>';
      c.triggers.forEach(function(t){
        h += '<div class="act"><span class="chip trig">event</span><span class="aname">' + esc(t.event) + '</span><span class="adesc">' + esc(t.description) + '</span></div>';
      });
    }

    if (c.configured && (c.actions || []).length) {
      var opts = c.actions.map(function(a){
        return '<option value="' + esc(a.name) + '" data-write="' + (a.write ? '1' : '') + '">' + esc(a.name) + (a.write ? ' (write)' : '') + '</option>';
      }).join('');
      h += '<div class="run">'
        + '<label>Run action</label>'
        + '<select class="a-sel">' + opts + '</select>'
        + '<label>Input (JSON)</label>'
        + '<textarea class="a-in">{}</textarea>'
        + '<div class="confirm" style="display:none"><input type="checkbox" class="a-confirm"> I understand this is a consequential write action.</div>'
        + '<button class="a-run">Run</button>'
        + '<pre class="out" style="display:none"></pre>'
        + '</div>';
    }
    h += '</div>';
    return h;
  }

  function wire(card){
    var sel = card.querySelector('.a-sel');
    if (!sel) return;
    var confirmWrap = card.querySelector('.confirm');
    var confirmBox = card.querySelector('.a-confirm');
    var runBtn = card.querySelector('.a-run');
    var inEl = card.querySelector('.a-in');
    var outEl = card.querySelector('.out');

    function isWrite(){ var o = sel.options[sel.selectedIndex]; return o && o.getAttribute('data-write') === '1'; }
    function sync(){
      var w = isWrite();
      confirmWrap.style.display = w ? 'flex' : 'none';
      runBtn.disabled = w && !confirmBox.checked;
    }
    sel.addEventListener('change', function(){ confirmBox.checked = false; sync(); });
    confirmBox.addEventListener('change', sync);
    sync();

    runBtn.addEventListener('click', function(){
      var input;
      try { input = JSON.parse(inEl.value || '{}'); }
      catch (e) { outEl.style.display = 'block'; outEl.textContent = 'Invalid JSON: ' + e.message; return; }
      runBtn.disabled = true;
      outEl.style.display = 'block';
      outEl.textContent = 'Running…';
      fetch(BASE + '/api/connectors/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: card.getAttribute('data-id'), action: sel.value, input: input })
      }).then(function(r){ return r.json(); }).then(function(r){
        outEl.textContent = JSON.stringify(r, null, 2);
      }).catch(function(e){
        outEl.textContent = 'Error: ' + e.message;
      }).then(function(){ sync(); });
    });
  }

  fetch(BASE + '/api/connectors').then(function(r){ return r.json(); }).then(function(r){
    var grid = document.getElementById('grid');
    if (r.error) { grid.innerHTML = '<p class="empty">' + esc(r.error) + '</p>'; return; }
    var list = r.connectors || [];
    if (!list.length) { grid.innerHTML = '<p class="empty">No connectors registered.</p>'; return; }
    grid.innerHTML = list.map(cardHtml).join('');
    Array.prototype.forEach.call(grid.querySelectorAll('.card'), wire);
  }).catch(function(e){
    document.getElementById('grid').innerHTML = '<p class="empty">' + esc(e.message) + '</p>';
  });
</script>
</body></html>`;
}

// ============================================================
// ACTIVITY PAGE (unified run feed)
// ============================================================

export function renderActivityPage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nova — Activity</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#06060b;--glass:rgba(255,255,255,.05);--border:rgba(255,255,255,.10);--text:rgba(255,255,255,.92);--dim:rgba(255,255,255,.55);--indigo:#6366f1;--green:#57C785;--red:#E86A84;--yellow:#F0B429;--blue:#2AABEE}
  body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px;min-height:100vh}
  .wrap{max-width:760px;margin:0 auto}
  h1{font-size:1.15rem;font-weight:700;margin-bottom:.5rem}
  .back{display:block;margin-bottom:1.2rem;color:var(--dim);text-decoration:none;font-size:.8rem}
  .back:hover{color:var(--text)}
  .hint{color:var(--dim);font-size:.8rem;line-height:1.5;margin-bottom:1.2rem}
  .filters{display:flex;gap:8px;margin-bottom:1.4rem;flex-wrap:wrap}
  .filter{padding:5px 15px;border-radius:20px;border:1px solid var(--border);background:rgba(255,255,255,.04);color:var(--dim);font-size:.78rem;cursor:pointer;font-family:inherit}
  .filter:hover{color:var(--text)}
  .filter.active{border-color:rgba(42,171,238,.5);color:var(--blue);background:rgba(42,171,238,.12);font-weight:600}
  .row{display:flex;align-items:flex-start;gap:12px;background:var(--glass);border:1px solid var(--border);border-radius:10px;padding:11px 15px;margin-bottom:8px}
  .row .ico{font-size:1rem;line-height:1.4;flex-shrink:0}
  .row .body{flex:1;min-width:0}
  .row .top{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
  .row .name{font-weight:600;font-size:.88rem}
  .row .badge{font-size:.64rem;text-transform:uppercase;letter-spacing:.05em;padding:2px 7px;border-radius:5px;border:1px solid var(--border);color:var(--dim)}
  .row .badge.fired,.row .badge.done{color:var(--green);border-color:rgba(87,199,133,.4);background:rgba(87,199,133,.12)}
  .row .badge.started,.row .badge.waiting{color:var(--yellow);border-color:rgba(240,180,41,.35);background:rgba(240,180,41,.1)}
  .row .badge.failed{color:var(--red);border-color:rgba(232,106,132,.4);background:rgba(232,106,132,.12)}
  .row .badge.skipped{color:var(--dim)}
  .row .kind{font-size:.64rem;text-transform:uppercase;letter-spacing:.05em;color:var(--dim)}
  .row .detail{font-size:.78rem;color:var(--dim);margin-top:3px;word-break:break-word}
  .row .time{font-size:.72rem;color:var(--dim);white-space:nowrap;flex-shrink:0}
  .empty{color:var(--dim);font-size:.82rem;padding:24px 4px;text-align:center}
</style></head><body>
<div class="wrap">
  <a class="back" href="${DASHBOARD_BASE}/">← Dashboard</a>
  <h1>Activity</h1>
  <p class="hint">A unified feed of every run across the system — automation fires, process steps, and playbook runs, newest first.</p>

  <div class="filters" id="filters">
    <button class="filter active" data-kind="">All</button>
    <button class="filter" data-kind="automation">Automations</button>
    <button class="filter" data-kind="process">Processes</button>
    <button class="filter" data-kind="playbook">Playbooks</button>
  </div>

  <div id="list"><p class="empty">Loading…</p></div>
</div>
<script>
  var BASE = '${DASHBOARD_BASE}';
  var kind = '';
  function esc(s){var d=document.createElement('div');d.textContent=(s==null?'':String(s));return d.innerHTML;}

  var KIND_ICON = { automation: '⚡', process: '🔄', playbook: '📖' };
  var STATUS_ICON = { fired: '✅', done: '✅', started: '▶️', waiting: '⏳', skipped: '⤼', failed: '❌' };

  function timeAgo(ts){
    if (!ts) return '';
    var then = new Date(ts).getTime();
    if (isNaN(then)) return esc(ts);
    var s = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  function rowHtml(e){
    var status = String(e.status || '');
    var ico = STATUS_ICON[status] || KIND_ICON[e.kind] || '•';
    var h = '<div class="row">';
    h += '<div class="ico">' + ico + '</div>';
    h += '<div class="body"><div class="top">';
    h += '<span class="name">' + esc(e.refName || e.refId || '(unnamed)') + '</span>';
    if (status) h += '<span class="badge ' + esc(status) + '">' + esc(status) + '</span>';
    h += '<span class="kind">' + esc(e.kind) + '</span></div>';
    if (e.detail) h += '<div class="detail">' + esc(e.detail) + '</div>';
    h += '</div>';
    h += '<div class="time">' + esc(timeAgo(e.createdAt)) + '</div>';
    h += '</div>';
    return h;
  }

  function load(){
    var listEl = document.getElementById('list');
    fetch(BASE + '/api/activity?kind=' + encodeURIComponent(kind) + '&limit=100').then(function(r){ return r.json(); }).then(function(data){
      if (data.error) { listEl.innerHTML = '<p class="empty">' + esc(data.error) + '</p>'; return; }
      var items = data.events || [];
      if (!items.length) { listEl.innerHTML = '<p class="empty">No activity yet.</p>'; return; }
      listEl.innerHTML = items.map(rowHtml).join('');
    }).catch(function(e){ listEl.innerHTML = '<p class="empty">' + esc(e.message) + '</p>'; });
  }

  var filtersEl = document.getElementById('filters');
  filtersEl.addEventListener('click', function(e){
    var b = e.target;
    if (!b || !b.classList || !b.classList.contains('filter')) return;
    kind = b.getAttribute('data-kind') || '';
    Array.prototype.forEach.call(filtersEl.children, function(c){ c.classList.toggle('active', c === b); });
    load();
  });

  load();
</script>
</body></html>`;
}

// ============================================================
// DEAD-LETTER QUEUE PAGE (failed automation dispatches)
// ============================================================

export function renderDeadLettersPage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nova — Dead Letters</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#06060b;--glass:rgba(255,255,255,.05);--border:rgba(255,255,255,.10);--text:rgba(255,255,255,.92);--dim:rgba(255,255,255,.55);--indigo:#6366f1;--green:#57C785;--red:#E86A84;--yellow:#F0B429;--blue:#2AABEE}
  body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px;min-height:100vh}
  .wrap{max-width:760px;margin:0 auto}
  h1{font-size:1.15rem;font-weight:700;margin-bottom:.5rem}
  .back{display:block;margin-bottom:1.2rem;color:var(--dim);text-decoration:none;font-size:.8rem}
  .back:hover{color:var(--text)}
  .hint{color:var(--dim);font-size:.8rem;line-height:1.5;margin-bottom:1.2rem}
  .hint code{background:rgba(255,255,255,.07);padding:1px 6px;border-radius:5px;font-size:.76rem;color:var(--text)}
  .msg{margin:0 0 1rem;padding:9px 12px;border-radius:8px;font-size:.82rem;display:none}
  .msg.ok{background:rgba(87,199,133,.12);border:1px solid rgba(87,199,133,.3);color:var(--green)}
  .msg.err{background:rgba(232,106,132,.12);border:1px solid rgba(232,106,132,.3);color:var(--red)}
  .card{background:var(--glass);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:10px}
  .card-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:.5rem}
  .card-head .name{font-weight:600;font-size:.9rem;flex:1;min-width:120px}
  .card-head .kind{font-size:.64rem;text-transform:uppercase;letter-spacing:.05em;color:var(--dim)}
  .card-head .time{font-size:.72rem;color:var(--dim);white-space:nowrap}
  .err-line{font-size:.8rem;color:var(--red);word-break:break-word;margin-bottom:.6rem}
  .sec{font-size:.66rem;text-transform:uppercase;letter-spacing:.05em;color:var(--dim);margin:.6rem 0 .3rem}
  pre.payload{background:rgba(0,0,0,.35);border:1px solid var(--border);border-radius:8px;padding:9px;font-family:ui-monospace,monospace;font-size:.72rem;white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto;color:var(--dim)}
  .actions{margin-top:.8rem;display:flex;align-items:center;gap:12px}
  .btn{padding:5px 14px;border-radius:7px;border:1px solid var(--border);background:rgba(255,255,255,.06);color:var(--text);font-size:.78rem;cursor:pointer;font-family:inherit}
  .btn.danger{border-color:rgba(232,106,132,.4);color:var(--red)}
  .btn.danger:hover{background:rgba(232,106,132,.1)}
  .btn:disabled{opacity:.4;cursor:not-allowed}
  .retry-note{font-size:.74rem;color:var(--dim)}
  .retry-note code{background:rgba(255,255,255,.07);padding:1px 6px;border-radius:5px;font-size:.72rem;color:var(--text)}
  .empty{color:var(--dim);font-size:.82rem;padding:24px 4px;text-align:center}
</style></head><body>
<div class="wrap">
  <a class="back" href="${DASHBOARD_BASE}/">← Dashboard</a>
  <h1>Dead letters</h1>
  <p class="hint">Automation dispatches that failed after their retries were exhausted. Inspect the error and payload, then <b>Drop</b> to discard. Retry is available from the CLI: <code>nova dlq retry &lt;id&gt;</code>.</p>
  <div id="msg" class="msg"></div>
  <div id="list"><p class="empty">Loading…</p></div>
</div>
<script>
  var BASE = '${DASHBOARD_BASE}';
  function esc(s){var d=document.createElement('div');d.textContent=(s==null?'':String(s));return d.innerHTML;}
  function escAttr(s){return esc(s).replace(/"/g,'&quot;');}
  var msgEl = document.getElementById('msg');
  var listEl = document.getElementById('list');

  function showMsg(text, ok){
    msgEl.className = 'msg ' + (ok ? 'ok' : 'err');
    msgEl.innerHTML = esc(text);
    msgEl.style.display = 'block';
    setTimeout(function(){ msgEl.style.display = 'none'; }, 4000);
  }

  function fmtTime(ts){
    if (!ts) return '';
    var d = new Date(ts);
    return isNaN(d.getTime()) ? esc(ts) : d.toLocaleString();
  }

  function prettyPayload(p){
    if (p == null || p === '') return '(empty)';
    try { return JSON.stringify(JSON.parse(p), null, 2); } catch (e) { return String(p); }
  }

  function cardHtml(d){
    var h = '<div class="card" data-id="' + escAttr(d.id) + '">';
    h += '<div class="card-head"><span class="name">' + esc(d.refName || d.refId || '(unnamed)') + '</span>';
    h += '<span class="kind">' + esc(d.kind) + '</span>';
    h += '<span class="time">' + fmtTime(d.createdAt) + '</span></div>';
    if (d.error) h += '<div class="err-line">' + esc(d.error) + '</div>';
    h += '<div class="sec">Payload</div><pre class="payload">' + esc(prettyPayload(d.payload)) + '</pre>';
    h += '<div class="actions"><button class="btn danger drop" data-id="' + escAttr(d.id) + '">Drop</button>';
    h += '<span class="retry-note">Retry via <code>nova dlq retry ' + esc(d.id) + '</code></span></div>';
    h += '</div>';
    return h;
  }

  listEl.addEventListener('click', function(e){
    var btn = e.target;
    if (!btn || !btn.classList || !btn.classList.contains('drop')) return;
    var id = btn.getAttribute('data-id');
    if (!id) return;
    if (!confirm('Drop this dead letter? This cannot be undone.')) return;
    btn.disabled = true;
    fetch(BASE + '/api/dlq/drop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) })
      .then(function(r){ return r.json(); })
      .then(function(data){ if (data.error) { showMsg(data.error, false); btn.disabled = false; } else { showMsg('Dropped', true); load(); } })
      .catch(function(err){ showMsg(err.message || 'Drop failed', false); btn.disabled = false; });
  });

  function load(){
    fetch(BASE + '/api/dlq').then(function(r){ return r.json(); }).then(function(data){
      if (data.error) { listEl.innerHTML = '<p class="empty">' + esc(data.error) + '</p>'; return; }
      var items = data.items || [];
      if (!items.length) { listEl.innerHTML = '<p class="empty">No dead letters — every dispatch has succeeded.</p>'; return; }
      listEl.innerHTML = items.map(cardHtml).join('');
    }).catch(function(e){ listEl.innerHTML = '<p class="empty">' + esc(e.message) + '</p>'; });
  }

  load();
</script>
</body></html>`;
}

// ============================================================
// TASK HISTORY PAGE
// ============================================================

export function renderHistoryPage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nova — Task History</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#06060b;--glass:rgba(255,255,255,.05);--border:rgba(255,255,255,.10);--text:rgba(255,255,255,.92);--dim:rgba(255,255,255,.55);--indigo:#6366f1;--green:#22c55e;--red:#ef4444;--yellow:#f59e0b}
  body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px;min-height:100vh}
  .wrap{max-width:720px;margin:0 auto}
  h1{font-size:1.15rem;font-weight:700;margin-bottom:1.4rem}
  .back{display:block;margin-bottom:1.2rem;color:var(--dim);text-decoration:none;font-size:.8rem}
  .back:hover{color:var(--text)}
  .row{background:var(--glass);border:1px solid var(--border);border-radius:10px;padding:12px 16px;margin-bottom:8px;cursor:pointer}
  .row:hover{background:rgba(255,255,255,.08)}
  .row-header{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .desc{font-weight:600;flex:1;min-width:120px;font-size:.88rem}
  .status-badge{padding:2px 8px;border-radius:5px;font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
  .status-active{background:rgba(99,102,241,.2);color:var(--indigo);border:1px solid rgba(99,102,241,.3)}
  .status-done{background:rgba(34,197,94,.12);color:var(--green);border:1px solid rgba(34,197,94,.25)}
  .status-blocked{background:rgba(239,68,68,.12);color:var(--red);border:1px solid rgba(239,68,68,.25)}
  .status-other{background:rgba(255,255,255,.07);color:var(--dim);border:1px solid var(--border)}
  .meta{font-size:.73rem;color:var(--dim);white-space:nowrap}
  .counts{font-size:.73rem;color:var(--dim)}
  .detail{display:none;margin-top:10px;border-top:1px solid var(--border);padding-top:10px}
  .detail.open{display:block}
  .sub-row{padding:7px 10px;border-radius:7px;border:1px solid var(--border);margin-bottom:6px;font-size:.8rem;background:rgba(255,255,255,.02)}
  .sub-agent{color:var(--indigo);font-weight:600;margin-right:6px}
  .artifact{padding:6px 10px;border-radius:6px;border:1px solid rgba(245,158,11,.2);background:rgba(245,158,11,.05);font-size:.78rem;margin-bottom:5px;word-break:break-all}
  .artifact-type{color:var(--yellow);font-weight:600;margin-right:6px}
  .section-label{font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin:8px 0 4px}
  .empty{color:var(--dim);font-size:.85rem}
  .loading{color:var(--dim);font-size:.82rem;font-style:italic}
</style></head><body>
<div class="wrap">
  <a class="back" href="${DASHBOARD_BASE}/">← Dashboard</a>
  <h1>Task History</h1>
  <div id="list"><p class="empty">Loading…</p></div>
</div>
<script>
  var BASE = '${DASHBOARD_BASE}';
  function esc(s){var d=document.createElement('div');d.textContent=(s==null?'':String(s));return d.innerHTML;}
  function escAttr(s){return esc(s).replace(/"/g,'&quot;');}
  function statusClass(st) {
    var s = (st||'').toLowerCase();
    if (s==='in_progress'||s==='running'||s==='executing'||s==='pending') return 'status-active';
    if (s==='done'||s==='completed') return 'status-done';
    if (s==='blocked'||s==='failed') return 'status-blocked';
    return 'status-other';
  }
  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return d.toLocaleString();
  }
  var listEl = document.getElementById('list');
  listEl.addEventListener('click', function(e) {
    var row = e.target;
    while (row && row !== listEl) {
      if (row.getAttribute && row.getAttribute('data-id')) break;
      row = row.parentElement;
    }
    if (!row || !row.getAttribute) return;
    var id = row.getAttribute('data-id');
    if (!id) return;
    var detail = row.querySelector('.detail');
    if (!detail) return;
    if (detail.classList.contains('open')) {
      detail.classList.remove('open');
      return;
    }
    detail.classList.add('open');
    if (detail.getAttribute('data-loaded')) return;
    detail.innerHTML = '<p class="loading">Loading detail…</p>';
    fetch(BASE + '/api/history/' + encodeURIComponent(id))
      .then(function(r){ return r.json(); })
      .then(function(data) {
        detail.setAttribute('data-loaded', '1');
        if (data.error) { detail.innerHTML = '<p class="empty">'+esc(data.error)+'</p>'; return; }
        var html = '';
        var subs = data.subtasks || [];
        var arts = data.artifacts || [];
        if (subs.length) {
          html += '<div class="section-label">Subtasks ('+esc(subs.length)+')</div>';
          subs.forEach(function(s) {
            html += '<div class="sub-row">';
            html += '<span class="sub-agent">'+esc(s.agent||'—')+'</span>';
            html += '<span>'+esc(s.description||s.task||'')+'</span>';
            html += ' <span class="status-badge '+esc(statusClass(s.status))+'">'+esc(s.status||'?')+'</span>';
            html += '</div>';
          });
        }
        if (arts.length) {
          html += '<div class="section-label">Artifacts ('+esc(arts.length)+')</div>';
          arts.forEach(function(a) {
            html += '<div class="artifact">';
            html += '<span class="artifact-type">'+esc(a.type||'artifact')+'</span>';
            html += esc(a.value||a.content||'');
            html += '</div>';
          });
        }
        if (!subs.length && !arts.length) html = '<p class="empty">No subtasks or artifacts.</p>';
        detail.innerHTML = html;
      })
      .catch(function(err){ detail.innerHTML = '<p class="empty">'+esc(err.message||'Load failed')+'</p>'; });
  });
  function load() {
    fetch(BASE + '/api/history').then(function(r){ return r.json(); }).then(function(data) {
      if (data.error) { listEl.innerHTML = '<p class="empty">'+esc(data.error)+'</p>'; return; }
      var tasks = data.tasks || [];
      if (!tasks.length) { listEl.innerHTML = '<p class="empty">No tasks yet.</p>'; return; }
      var html = '';
      tasks.forEach(function(t) {
        var sc = statusClass(t.status);
        html += '<div class="row" data-id="'+escAttr(t.id)+'">';
        html += '<div class="row-header">';
        html += '<span class="desc">'+esc(t.description||t.task||'Untitled')+'</span>';
        html += '<span class="status-badge '+esc(sc)+'">'+esc(t.status||'?')+'</span>';
        html += '<span class="counts">'+esc(t.subtask_done)+'/'+esc(t.subtask_total)+' subtasks</span>';
        html += '<span class="meta">'+esc(fmtTime(t.created_at))+'</span>';
        html += '</div>';
        html += '<div class="detail"></div>';
        html += '</div>';
      });
      listEl.innerHTML = html;
    }).catch(function(e){ listEl.innerHTML = '<p class="empty">'+esc(e.message)+'</p>'; });
  }
  load();
</script>
</body></html>`;
}

// ============================================================
// WHATSAPP CONFIG PAGE
// ============================================================

export function renderWhatsappPage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nova — WhatsApp Config</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#06060b;--glass:rgba(255,255,255,.05);--border:rgba(255,255,255,.10);--text:rgba(255,255,255,.92);--dim:rgba(255,255,255,.55);--indigo:#6366f1;--green:#22c55e;--red:#ef4444;--yellow:#f59e0b}
  body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px;min-height:100vh}
  .wrap{max-width:760px;margin:0 auto}
  h1{font-size:1.15rem;font-weight:700;margin-bottom:1.4rem}
  h2{font-size:.95rem;font-weight:700;margin:1.6rem 0 .8rem}
  .back{display:block;margin-bottom:1.2rem;color:var(--dim);text-decoration:none;font-size:.8rem}
  .back:hover{color:var(--text)}
  .card{background:var(--glass);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:10px}
  .field{margin-bottom:10px}
  label{display:block;font-size:.78rem;color:var(--dim);margin-bottom:4px}
  input[type=text],input[type=password],select{width:100%;padding:7px 10px;border-radius:6px;border:1px solid var(--border);background:rgba(255,255,255,.06);color:var(--text);font-size:.85rem;outline:none}
  input[type=text]:focus,input[type=password]:focus,select:focus{border-color:var(--indigo)}
  .btn{padding:6px 16px;border-radius:6px;border:1px solid var(--border);background:rgba(255,255,255,.07);color:var(--text);font-size:.8rem;font-weight:600;cursor:pointer;transition:opacity .15s}
  .btn:hover{opacity:.8}
  .btn-primary{border-color:rgba(99,102,241,.4);background:rgba(99,102,241,.15);color:var(--indigo)}
  .btn-danger{border-color:rgba(239,68,68,.35);background:rgba(239,68,68,.10);color:var(--red)}
  .status-badge{display:inline-block;padding:2px 10px;border-radius:5px;font-size:.74rem;font-weight:600}
  .status-ok{background:rgba(34,197,94,.12);color:var(--green);border:1px solid rgba(34,197,94,.25)}
  .status-no{background:rgba(239,68,68,.10);color:var(--red);border:1px solid rgba(239,68,68,.25)}
  table{width:100%;border-collapse:collapse;font-size:.82rem}
  th{text-align:left;padding:6px 8px;color:var(--dim);font-weight:600;border-bottom:1px solid var(--border);font-size:.74rem;text-transform:uppercase;letter-spacing:.04em}
  td{padding:7px 8px;border-bottom:1px solid rgba(255,255,255,.04);vertical-align:middle}
  tr:last-child td{border-bottom:none}
  .add-row{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:10px}
  .add-row input,.add-row select{flex:1;min-width:100px}
  .toast{position:fixed;bottom:20px;right:20px;padding:10px 18px;border-radius:8px;font-size:.83rem;font-weight:600;opacity:0;transition:opacity .3s;pointer-events:none;z-index:999}
  .toast.show{opacity:1}
  .toast-success{background:rgba(34,197,94,.2);border:1px solid rgba(34,197,94,.4);color:var(--green)}
  .toast-error{background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.35);color:var(--red)}
  .empty{color:var(--dim);font-size:.85rem}
</style></head><body>
<div class="wrap">
  <a class="back" href="${DASHBOARD_BASE}/">← Dashboard</a>
  <h1>WhatsApp Config</h1>

  <h2>Kapso Credentials <span id="status-badge"></span></h2>
  <div class="card">
    <div class="field"><label>API Key</label><input type="password" id="kapso-key" placeholder="Enter new API key"></div>
    <div class="field"><label>Phone Number ID</label><input type="text" id="kapso-pid" placeholder="e.g. 1234567890"></div>
    <div style="display:flex;gap:8px;margin-top:4px">
      <button class="btn btn-primary" id="btn-save-creds">Save Credentials</button>
      <button class="btn btn-danger" id="btn-clear-creds">Clear Credentials</button>
    </div>
  </div>

  <h2>Contacts</h2>
  <div class="card">
    <table id="contacts-table">
      <thead><tr><th>Phone</th><th>Name</th><th>Role</th><th></th></tr></thead>
      <tbody id="contacts-body"><tr><td colspan="4" class="empty">Loading…</td></tr></tbody>
    </table>
    <div class="add-row" style="margin-top:12px">
      <input type="text" id="c-phone" placeholder="Phone (+1234…)">
      <input type="text" id="c-name" placeholder="Name (optional)">
      <select id="c-role"><option value="allowed">allowed</option><option value="vip">vip</option><option value="blocked">blocked</option></select>
      <button class="btn btn-primary" id="btn-add-contact">Add Contact</button>
    </div>
  </div>

  <h2>Groups</h2>
  <div class="card">
    <table id="groups-table">
      <thead><tr><th>JID</th><th>Name</th><th>Active</th><th></th></tr></thead>
      <tbody id="groups-body"><tr><td colspan="4" class="empty">Loading…</td></tr></tbody>
    </table>
    <div class="add-row" style="margin-top:12px">
      <input type="text" id="g-jid" placeholder="Group JID (e.g. 123@g.us)">
      <input type="text" id="g-name" placeholder="Name (optional)">
      <select id="g-active"><option value="1">active</option><option value="0">inactive</option></select>
      <button class="btn btn-primary" id="btn-add-group">Add Group</button>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
  var BASE = '${DASHBOARD_BASE}';
  function esc(s){var d=document.createElement('div');d.textContent=(s==null?'':String(s));return d.innerHTML;}
  function escAttr(s){return esc(s).replace(/"/g,'&quot;');}
  var toastEl = document.getElementById('toast');
  var toastTimer;
  function showToast(msg, type) {
    toastEl.textContent = msg;
    toastEl.className = 'toast toast-' + (type||'success') + ' show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toastEl.classList.remove('show'); }, 3200);
  }

  // ── Credentials ──
  function loadStatus() {
    fetch(BASE + '/api/whatsapp/status').then(function(r){ return r.json(); }).then(function(d) {
      var badge = document.getElementById('status-badge');
      if (d.configured) {
        badge.className = 'status-badge status-ok';
        badge.textContent = 'Configured';
      } else {
        badge.className = 'status-badge status-no';
        badge.textContent = 'Not configured';
      }
    }).catch(function(){ });
  }
  document.getElementById('btn-save-creds').addEventListener('click', function() {
    var key = document.getElementById('kapso-key').value.trim();
    var pid = document.getElementById('kapso-pid').value.trim();
    if (!key || !pid) { showToast('Both API key and Phone Number ID are required', 'error'); return; }
    fetch(BASE + '/api/whatsapp/connect', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({kapso_api_key: key, kapso_phone_number_id: pid})
    }).then(function(r){ return r.json(); }).then(function(d) {
      if (d.configured) {
        document.getElementById('kapso-key').value = '';
        document.getElementById('kapso-pid').value = '';
        showToast('Credentials saved', 'success');
        loadStatus();
      } else { showToast('Error: ' + esc(d.error || 'Save failed'), 'error'); }
    }).catch(function(e){ showToast('Network error: ' + esc(e.message), 'error'); });
  });
  document.getElementById('btn-clear-creds').addEventListener('click', function() {
    if (!window.confirm('Clear WhatsApp credentials?')) return;
    fetch(BASE + '/api/whatsapp/disconnect', {method: 'POST'})
      .then(function(r){ return r.json(); }).then(function(d) {
        if (d.configured === false) { showToast('Credentials cleared', 'success'); loadStatus(); }
        else { showToast('Error: ' + esc(d.error || 'Failed'), 'error'); }
      }).catch(function(e){ showToast('Network error: ' + esc(e.message), 'error'); });
  });

  // ── Contacts ──
  var contactsBody = document.getElementById('contacts-body');
  function loadContacts() {
    fetch(BASE + '/api/whatsapp/contacts').then(function(r){ return r.json(); }).then(function(d) {
      var contacts = d.contacts || [];
      if (!contacts.length) { contactsBody.innerHTML = '<tr><td colspan="4" class="empty">No contacts yet.</td></tr>'; return; }
      var html = '';
      contacts.forEach(function(c) {
        html += '<tr>';
        html += '<td>' + esc(c.phone) + '</td>';
        html += '<td>' + esc(c.name || '') + '</td>';
        html += '<td>' + esc(c.role || '') + '</td>';
        html += '<td><button class="btn btn-danger" data-phone="' + escAttr(c.phone) + '" data-action="del-contact">Delete</button></td>';
        html += '</tr>';
      });
      contactsBody.innerHTML = html;
    }).catch(function(e){ contactsBody.innerHTML = '<tr><td colspan="4" class="empty">'+esc(e.message)+'</td></tr>'; });
  }
  document.getElementById('btn-add-contact').addEventListener('click', function() {
    var phone = document.getElementById('c-phone').value.trim();
    var name = document.getElementById('c-name').value.trim();
    var role = document.getElementById('c-role').value;
    if (!phone) { showToast('Phone is required', 'error'); return; }
    fetch(BASE + '/api/whatsapp/contacts', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({phone: phone, name: name || null, role: role})
    }).then(function(r){ return r.json(); }).then(function(d) {
      if (d.success) {
        document.getElementById('c-phone').value = '';
        document.getElementById('c-name').value = '';
        showToast('Contact saved', 'success');
        loadContacts();
      } else { showToast('Error: ' + esc(d.error || 'Save failed'), 'error'); }
    }).catch(function(e){ showToast('Network error: ' + esc(e.message), 'error'); });
  });
  contactsBody.addEventListener('click', function(e) {
    var btn = e.target;
    if (!btn || btn.tagName !== 'BUTTON' || btn.getAttribute('data-action') !== 'del-contact') return;
    var phone = btn.getAttribute('data-phone');
    if (!phone || !window.confirm('Delete contact ' + phone + '?')) return;
    btn.disabled = true;
    fetch(BASE + '/api/whatsapp/contacts/' + encodeURIComponent(phone), {method: 'DELETE'})
      .then(function(r){ return r.json(); }).then(function(d) {
        if (d.success) { showToast('Deleted', 'success'); loadContacts(); }
        else { showToast('Error: ' + esc(d.error || 'Delete failed'), 'error'); btn.disabled = false; }
      }).catch(function(e){ showToast('Network error: ' + esc(e.message), 'error'); btn.disabled = false; });
  });

  // ── Groups ──
  var groupsBody = document.getElementById('groups-body');
  function loadGroups() {
    fetch(BASE + '/api/whatsapp/groups').then(function(r){ return r.json(); }).then(function(d) {
      var groups = d.groups || [];
      if (!groups.length) { groupsBody.innerHTML = '<tr><td colspan="4" class="empty">No groups yet.</td></tr>'; return; }
      var html = '';
      groups.forEach(function(g) {
        html += '<tr>';
        html += '<td>' + esc(g.group_jid) + '</td>';
        html += '<td>' + esc(g.name || '') + '</td>';
        html += '<td>' + esc(g.active ? 'Yes' : 'No') + '</td>';
        html += '<td><button class="btn btn-danger" data-jid="' + escAttr(g.group_jid) + '" data-action="del-group">Delete</button></td>';
        html += '</tr>';
      });
      groupsBody.innerHTML = html;
    }).catch(function(e){ groupsBody.innerHTML = '<tr><td colspan="4" class="empty">'+esc(e.message)+'</td></tr>'; });
  }
  document.getElementById('btn-add-group').addEventListener('click', function() {
    var jid = document.getElementById('g-jid').value.trim();
    var name = document.getElementById('g-name').value.trim();
    var active = document.getElementById('g-active').value === '1' ? 1 : 0;
    if (!jid) { showToast('Group JID is required', 'error'); return; }
    fetch(BASE + '/api/whatsapp/groups', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({group_jid: jid, name: name || null, active: active})
    }).then(function(r){ return r.json(); }).then(function(d) {
      if (d.success) {
        document.getElementById('g-jid').value = '';
        document.getElementById('g-name').value = '';
        showToast('Group saved', 'success');
        loadGroups();
      } else { showToast('Error: ' + esc(d.error || 'Save failed'), 'error'); }
    }).catch(function(e){ showToast('Network error: ' + esc(e.message), 'error'); });
  });
  groupsBody.addEventListener('click', function(e) {
    var btn = e.target;
    if (!btn || btn.tagName !== 'BUTTON' || btn.getAttribute('data-action') !== 'del-group') return;
    var jid = btn.getAttribute('data-jid');
    if (!jid || !window.confirm('Delete group ' + jid + '?')) return;
    btn.disabled = true;
    fetch(BASE + '/api/whatsapp/groups/' + encodeURIComponent(jid), {method: 'DELETE'})
      .then(function(r){ return r.json(); }).then(function(d) {
        if (d.success) { showToast('Deleted', 'success'); loadGroups(); }
        else { showToast('Error: ' + esc(d.error || 'Delete failed'), 'error'); btn.disabled = false; }
      }).catch(function(e){ showToast('Network error: ' + esc(e.message), 'error'); btn.disabled = false; });
  });

  loadStatus();
  loadContacts();
  loadGroups();
</script>
</body></html>`;
}

// ============================================================
// APPROVALS PAGE
// ============================================================

// ============================================================
// GOVERNANCE CONTROL PLANE PAGE
// ============================================================

export function renderGovernancePage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nova — Governance</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#06060b;--glass:rgba(255,255,255,.05);--border:rgba(255,255,255,.10);--text:rgba(255,255,255,.92);--dim:rgba(255,255,255,.55);--indigo:#6366f1;--green:#22c55e;--red:#ef4444;--yellow:#f59e0b}
  body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px;min-height:100vh}
  .wrap{max-width:960px;margin:0 auto}
  h1{font-size:1.2rem;font-weight:700;margin-bottom:.4rem}
  h2{font-size:.95rem;font-weight:700;margin:1.6rem 0 .7rem}
  .sub{color:var(--dim);font-size:.8rem;margin-bottom:1rem}
  .back{display:inline-block;margin-bottom:1rem;color:var(--dim);text-decoration:none;font-size:.8rem}
  .back:hover{color:var(--text)}
  .bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:.6rem}
  select,input{background:rgba(255,255,255,.06);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:5px 8px;font-size:.8rem}
  .card{background:var(--glass);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:8px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-bottom:.4rem}
  .stat{background:var(--glass);border:1px solid var(--border);border-radius:10px;padding:12px}
  .stat .n{font-size:1.15rem;font-weight:700}
  .stat .l{font-size:.72rem;color:var(--dim);margin-top:2px}
  table{width:100%;border-collapse:collapse;font-size:.78rem}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)}
  th{color:var(--dim);font-weight:600}
  .empty{color:var(--dim);font-size:.82rem;padding:6px 0}
  .btn{padding:4px 10px;border-radius:6px;border:1px solid var(--border);background:rgba(255,255,255,.06);color:var(--text);font-size:.75rem;font-weight:600;cursor:pointer}
  .btn:hover{opacity:.85}
  .pill{display:inline-block;padding:1px 7px;border-radius:99px;font-size:.7rem;font-weight:600}
  .l0{background:rgba(148,163,184,.18);color:#94a3b8}
  .l1{background:rgba(99,102,241,.18);color:#a5b4fc}
  .l2{background:rgba(245,158,11,.16);color:var(--yellow)}
  .l3{background:rgba(34,197,94,.16);color:var(--green)}
  .toast{position:fixed;bottom:20px;right:20px;padding:10px 18px;border-radius:8px;font-size:.83rem;font-weight:600;opacity:0;transition:opacity .3s;pointer-events:none;z-index:999}
  .toast.show{opacity:1}
  .toast-success{background:rgba(34,197,94,.2);border:1px solid rgba(34,197,94,.4);color:var(--green)}
  .toast-error{background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.35);color:var(--red)}
</style></head><body>
<div class="wrap">
  <a class="back" href="${DASHBOARD_BASE}/">← Dashboard</a>
  <h1>Governance</h1>
  <div class="sub">Approve, audit, set autonomy, and watch spend &amp; goals — one control plane.</div>
  <div class="bar">
    <label class="sub" style="margin:0">User:</label>
    <select id="userSel"><option value="">— select —</option></select>
  </div>

  <h2>Pending Approvals</h2>
  <div id="approvals"><p class="empty">…</p></div>

  <h2>Budget &amp; Spend</h2>
  <div id="budgets"><p class="empty">…</p></div>

  <h2>Autonomy Levels</h2>
  <div class="sub">0 = always ask · 1 = notify · 2 = act within caps · 3 = full autonomy</div>
  <div id="autonomy"><p class="empty">Select a user.</p></div>
  <div class="card" id="grantForm" style="display:none">
    <div class="bar">
      <input id="gAgent" placeholder="agent (e.g. pixel)" />
      <input id="gAction" placeholder="action_type (e.g. social.publish)" />
      <select id="gLevel"><option value="0">0</option><option value="1">1</option><option value="2">2</option><option value="3">3</option></select>
      <input id="gCapAction" placeholder="cap/action $" style="width:110px" />
      <input id="gCapDaily" placeholder="cap/day $" style="width:100px" />
      <button class="btn" id="gSave">Set grant</button>
    </div>
  </div>

  <h2>Action Ledger</h2>
  <div id="ledger"><p class="empty">Select a user.</p></div>

  <h2>Goals</h2>
  <div id="goals"><p class="empty">Select a user.</p></div>
</div>
<div class="toast" id="toast"></div>
<script>
  var BASE = '${DASHBOARD_BASE}';
  var uid = '';
  function esc(s){var d=document.createElement('div');d.textContent=(s==null?'':String(s));return d.innerHTML;}
  function money(n){return '$'+(Number(n)||0).toFixed(4);}
  var toastEl=document.getElementById('toast'),toastTimer;
  function showToast(m,t){toastEl.textContent=m;toastEl.className='toast toast-'+(t||'success')+' show';clearTimeout(toastTimer);toastTimer=setTimeout(function(){toastEl.classList.remove('show');},3000);}
  function q(p){return uid?(p+(p.indexOf('?')>-1?'&':'?')+'user_id='+encodeURIComponent(uid)):p;}
  function getJSON(p){return fetch(BASE+p).then(function(r){return r.json();});}

  function loadUsers(){
    getJSON('/api/users').then(function(d){
      var users=(d&&d.users)||d||[];
      var sel=document.getElementById('userSel');
      (users||[]).forEach(function(u){
        var o=document.createElement('option');o.value=u.id;o.textContent=(u.name||u.username||u.id);sel.appendChild(o);
      });
    }).catch(function(){});
  }

  function loadApprovals(){
    getJSON('/api/approvals'+(uid?('?user_id='+encodeURIComponent(uid)):'')).then(function(d){
      var a=(d&&d.approvals)||[];var el=document.getElementById('approvals');
      if(!a.length){el.innerHTML='<p class="empty">No pending approvals.</p>';return;}
      el.innerHTML=a.map(function(x){return '<div class="card"><b>'+esc(x.original_text||'(no description)')+'</b>'+(x.prepare_summary?'<div class="sub" style="margin:6px 0 0">'+esc(x.prepare_summary)+'</div>':'')+'</div>';}).join('');
    });
  }

  function loadBudgets(){
    if(!uid){document.getElementById('budgets').innerHTML='<p class="empty">Select a user.</p>';return;}
    getJSON(q('/api/budgets')).then(function(d){
      var b=d&&d.budgets;var el=document.getElementById('budgets');
      if(!b){el.innerHTML='<p class="empty">'+esc((d&&d.error)||'No data.')+'</p>';return;}
      var h='<div class="grid">';
      h+='<div class="stat"><div class="n">'+money(b.today)+'</div><div class="l">Today'+(b.dailyCap!=null?(' / '+money(b.dailyCap)):'')+'</div></div>';
      h+='<div class="stat"><div class="n">'+money(b.month)+'</div><div class="l">This month'+(b.monthlyCap!=null?(' / '+money(b.monthlyCap)):'')+'</div></div>';
      h+='<div class="stat"><div class="n">'+money(b.allTime)+'</div><div class="l">All time</div></div>';
      if(b.dailyRemaining!=null)h+='<div class="stat"><div class="n">'+money(b.dailyRemaining)+'</div><div class="l">Daily remaining</div></div>';
      h+='</div>';
      if(b.perAgent&&b.perAgent.length){
        h+='<div class="card"><table><tr><th>Agent</th><th>Action</th><th>Spent today</th><th>Daily cap</th></tr>';
        b.perAgent.forEach(function(p){h+='<tr><td>'+esc(p.agent)+'</td><td>'+esc(p.action_type)+'</td><td>'+money(p.spent_today)+'</td><td>'+money(p.cap_daily)+'</td></tr>';});
        h+='</table></div>';
      }
      el.innerHTML=h;
    });
  }

  function levelPill(l){return '<span class="pill l'+l+'">L'+l+'</span>';}
  function loadAutonomy(){
    var el=document.getElementById('autonomy');
    document.getElementById('grantForm').style.display=uid?'block':'none';
    if(!uid){el.innerHTML='<p class="empty">Select a user.</p>';return;}
    getJSON(q('/api/autonomy')).then(function(d){
      var g=(d&&d.grants)||[];
      if(!g.length){el.innerHTML='<p class="empty">No autonomy grants yet — everything asks for approval.</p>';return;}
      var h='<div class="card"><table><tr><th>Agent</th><th>Action</th><th>Level</th><th>Cap/action</th><th>Cap/day</th></tr>';
      g.forEach(function(x){h+='<tr><td>'+esc(x.agent)+'</td><td>'+esc(x.action_type)+'</td><td>'+levelPill(x.level)+'</td><td>'+(x.spend_cap_action!=null?money(x.spend_cap_action):'—')+'</td><td>'+(x.spend_cap_daily!=null?money(x.spend_cap_daily):'—')+'</td></tr>';});
      h+='</table></div>';el.innerHTML=h;
    });
  }

  function loadLedger(){
    var el=document.getElementById('ledger');
    if(!uid){el.innerHTML='<p class="empty">Select a user.</p>';return;}
    getJSON(q('/api/ledger?limit=25')).then(function(d){
      var a=(d&&d.actions)||[];
      if(!a.length){el.innerHTML='<p class="empty">'+esc((d&&d.error)||'No actions recorded.')+'</p>';return;}
      var h='<div class="card"><table><tr><th>When</th><th>Agent</th><th>Action</th><th>Phase</th><th>Outcome</th><th>Cost</th></tr>';
      a.forEach(function(x){h+='<tr><td>'+esc((x.created_at||'').replace('T',' ').slice(0,16))+'</td><td>'+esc(x.agent)+'</td><td>'+esc(x.action_type)+'</td><td>'+esc(x.phase)+'</td><td>'+esc(x.outcome)+'</td><td>'+money(x.cost_usd)+'</td></tr>';});
      h+='</table></div>';el.innerHTML=h;
    });
  }

  function loadGoals(){
    var el=document.getElementById('goals');
    if(!uid){el.innerHTML='<p class="empty">Select a user.</p>';return;}
    getJSON(q('/api/goals')).then(function(d){
      var g=(d&&d.goals)||[];
      if(!g.length){el.innerHTML='<p class="empty">No active goals.</p>';return;}
      el.innerHTML=g.map(function(x){
        return '<div class="card"><b>'+esc(x.content)+'</b>'+(x.deadline?(' <span class="sub">· due '+esc(x.deadline)+'</span>'):'')+'<div class="sub" style="margin-top:4px">'+x.progress_count+' progress note(s)'+(x.last_reviewed_at?(' · last reviewed '+esc((x.last_reviewed_at||'').slice(0,10))):'')+'</div></div>';
      }).join('');
    });
  }

  function reloadAll(){loadApprovals();loadBudgets();loadAutonomy();loadLedger();loadGoals();}
  document.getElementById('userSel').addEventListener('change',function(e){uid=e.target.value;reloadAll();});
  document.getElementById('gSave').addEventListener('click',function(){
    if(!uid){showToast('Select a user first','error');return;}
    var body={agent:document.getElementById('gAgent').value,action_type:document.getElementById('gAction').value,level:parseInt(document.getElementById('gLevel').value,10),spend_cap_action:document.getElementById('gCapAction').value||null,spend_cap_daily:document.getElementById('gCapDaily').value||null};
    fetch(BASE+q('/api/autonomy'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json();}).then(function(d){
      if(d.ok){showToast('Grant saved');loadAutonomy();loadBudgets();}else{showToast(d.error||'Failed','error');}
    }).catch(function(e){showToast('Error: '+e.message,'error');});
  });

  loadUsers();reloadAll();
</script>
</body></html>`;
}

export function renderApprovalsPage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nova — Pending Approvals</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#06060b;--glass:rgba(255,255,255,.05);--border:rgba(255,255,255,.10);--text:rgba(255,255,255,.92);--dim:rgba(255,255,255,.55);--indigo:#6366f1;--green:#22c55e;--red:#ef4444;--yellow:#f59e0b}
  body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text);padding:24px;min-height:100vh}
  .wrap{max-width:720px;margin:0 auto}
  h1{font-size:1.15rem;font-weight:700;margin-bottom:1.4rem}
  .back{display:block;margin-bottom:1.2rem;color:var(--dim);text-decoration:none;font-size:.8rem}
  .back:hover{color:var(--text)}
  .card{background:var(--glass);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:10px}
  .card-task{font-weight:600;font-size:.9rem;margin-bottom:6px;word-break:break-word}
  .card-summary{font-size:.8rem;color:var(--dim);margin-bottom:12px;word-break:break-word;white-space:pre-wrap}
  .actions{display:flex;gap:8px;flex-wrap:wrap}
  .btn{padding:5px 14px;border-radius:6px;border:1px solid var(--border);background:rgba(255,255,255,.06);color:var(--text);font-size:.78rem;font-weight:600;cursor:pointer;transition:opacity .15s}
  .btn:hover{opacity:.8}
  .btn-approve{border-color:rgba(34,197,94,.35);background:rgba(34,197,94,.12);color:var(--green)}
  .btn-revise{border-color:rgba(245,158,11,.35);background:rgba(245,158,11,.10);color:var(--yellow)}
  .btn-cancel{border-color:rgba(239,68,68,.35);background:rgba(239,68,68,.10);color:var(--red)}
  .toast{position:fixed;bottom:20px;right:20px;padding:10px 18px;border-radius:8px;font-size:.83rem;font-weight:600;opacity:0;transition:opacity .3s;pointer-events:none;z-index:999}
  .toast.show{opacity:1}
  .toast-success{background:rgba(34,197,94,.2);border:1px solid rgba(34,197,94,.4);color:var(--green)}
  .toast-error{background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.35);color:var(--red)}
  .empty{color:var(--dim);font-size:.85rem}
  .loading{color:var(--dim);font-size:.82rem;font-style:italic}
</style></head><body>
<div class="wrap">
  <a class="back" href="${DASHBOARD_BASE}/">← Dashboard</a>
  <h1>Pending Approvals</h1>
  <div id="list"><p class="loading">Loading…</p></div>
</div>
<div class="toast" id="toast"></div>
<script>
  var BASE = '${DASHBOARD_BASE}';
  function esc(s){var d=document.createElement('div');d.textContent=(s==null?'':String(s));return d.innerHTML;}
  function escAttr(s){return esc(s).replace(/"/g,'&quot;');}
  var toastEl = document.getElementById('toast');
  var toastTimer;
  function showToast(msg, type) {
    toastEl.textContent = msg;
    toastEl.className = 'toast toast-' + (type||'success') + ' show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ toastEl.classList.remove('show'); }, 3000);
  }
  var listEl = document.getElementById('list');
  function load() {
    listEl.innerHTML = '<p class="loading">Loading…</p>';
    fetch(BASE + '/api/approvals')
      .then(function(r){ return r.json(); })
      .then(function(data) {
        var approvals = data.approvals || [];
        if (!approvals.length) {
          listEl.innerHTML = '<p class="empty">No pending approvals.</p>';
          return;
        }
        var html = '';
        approvals.forEach(function(a) {
          html += '<div class="card">';
          html += '<div class="card-task">' + esc(a.original_text || '(no description)') + '</div>';
          if (a.prepare_summary) {
            html += '<div class="card-summary">' + esc(a.prepare_summary) + '</div>';
          }
          html += '<div class="actions">';
          html += '<button class="btn btn-approve" data-id="' + escAttr(a.id) + '" data-action="approve">Approve</button>';
          html += '<button class="btn btn-revise" data-id="' + escAttr(a.id) + '" data-action="revise">Revise</button>';
          html += '<button class="btn btn-cancel" data-id="' + escAttr(a.id) + '" data-action="cancel">Cancel</button>';
          html += '</div></div>';
        });
        listEl.innerHTML = html;
      })
      .catch(function(e){ listEl.innerHTML = '<p class="empty">Error loading approvals: ' + esc(e.message) + '</p>'; });
  }
  listEl.addEventListener('click', function(e) {
    var btn = e.target;
    if (!btn || btn.tagName !== 'BUTTON') return;
    var id = btn.getAttribute('data-id');
    var action = btn.getAttribute('data-action');
    if (!id || !action) return;
    var feedback = '';
    if (action === 'revise') {
      feedback = window.prompt('Enter your revision feedback:');
      if (!feedback) return;
    }
    if (action === 'cancel') {
      if (!window.confirm('Cancel this approval request? This cannot be undone.')) return;
    }
    btn.disabled = true;
    fetch(BASE + '/api/approvals/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id, action: action, feedback: feedback || undefined })
    })
      .then(function(r){ return r.json(); })
      .then(function(d) {
        if (d.success || d.ok) {
          var label = action === 'approve' ? 'Approved' : action === 'cancel' ? 'Cancelled' : 'Revision submitted';
          showToast(label, 'success');
          load();
        } else {
          showToast('Error: ' + esc(d.error || 'Something went wrong'), 'error');
          btn.disabled = false;
        }
      })
      .catch(function(e){ showToast('Network error: ' + esc(e.message), 'error'); btn.disabled = false; });
  });
  load();
</script>
</body></html>`;
}

// ============================================================
// KANBAN PAGE
// ============================================================

export function renderKanban(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<title>Nova — Kanban Board</title>
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
    --text: rgba(255,255,255,0.92);
    --text-secondary: rgba(255,255,255,0.6);
    --text-dim: rgba(255,255,255,0.3);
    --col-pending: #6b7280;
    --col-inprogress: #6366f1;
    --col-completed: #22c55e;
    --col-blocked: #ef4444;
  }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    background: var(--bg);
    color: var(--text);
    font-size: 13px;
    line-height: 1.5;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  @keyframes pulse-dot { 0%,100% { box-shadow: 0 0 0 0 rgba(34,197,94,0.4); } 50% { box-shadow: 0 0 0 6px rgba(34,197,94,0); } }
  @keyframes fade-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes card-move { from { opacity: 0; transform: scale(0.96) translateY(-4px); } to { opacity: 1; transform: scale(1) translateY(0); } }

  /* HEADER */
  .kb-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 20px;
    border-bottom: 1px solid var(--glass-border);
    background: var(--glass);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    flex-shrink: 0;
    z-index: 100;
  }
  .kb-logo {
    display: flex; align-items: center; gap: 8px; text-decoration: none; color: var(--text);
  }
  .kb-logo-badge {
    width: 28px; height: 28px;
    background: linear-gradient(135deg, var(--indigo), var(--violet));
    border-radius: 7px;
    display: flex; align-items: center; justify-content: center;
    font-size: 0.8rem; font-weight: 700; color: #fff;
  }
  .kb-title { font-size: 1rem; font-weight: 700; }
  .kb-subtitle { font-size: 0.6rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 2px; }
  .kb-back {
    text-decoration: none; color: var(--text-dim); font-size: 11px;
    padding: 5px 10px; border: 1px solid var(--glass-border); border-radius: 6px;
    transition: color 0.2s, border-color 0.2s;
    white-space: nowrap;
  }
  .kb-back:hover { color: var(--text); border-color: rgba(255,255,255,0.2); }
  .kb-header-right { display: flex; align-items: center; gap: 10px; margin-left: auto; }
  .kb-live { display: flex; align-items: center; gap: 5px; color: var(--text-dim); font-size: 11px; }
  .live-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--success); animation: pulse-dot 2s infinite; }
  .kb-refresh {
    background: none; border: 1px solid var(--glass-border); color: var(--text-dim);
    cursor: pointer; font-size: 14px; padding: 4px 8px; border-radius: 6px;
    transition: color 0.2s, border-color 0.2s; line-height: 1;
  }
  .kb-refresh:hover { color: var(--text); border-color: rgba(255,255,255,0.2); }

  /* BOARD */
  .kb-board {
    flex: 1;
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
    padding: 16px;
    overflow-y: auto;
    align-items: start;
  }

  /* COLUMN */
  .kb-col {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  .kb-col-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-radius: 10px;
    background: var(--surface);
    border: 1px solid var(--glass-border);
    position: sticky;
    top: 0;
    z-index: 10;
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  }
  .kb-col-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .kb-col-name { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.8px; flex: 1; }
  .kb-col-count {
    font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 10px;
    background: rgba(255,255,255,0.07); color: var(--text-secondary);
  }
  .kb-col-cards { display: flex; flex-direction: column; gap: 8px; }
  .kb-empty {
    padding: 20px 12px;
    text-align: center;
    color: var(--text-dim);
    font-size: 11px;
    border: 1px dashed rgba(255,255,255,0.07);
    border-radius: 10px;
  }

  /* CARD */
  .kb-card {
    background: var(--glass);
    border: 1px solid var(--glass-border);
    border-radius: 10px;
    padding: 12px;
    cursor: default;
    transition: border-color 0.2s, background 0.2s, transform 0.15s;
    animation: card-move 0.25s ease;
  }
  .kb-card:hover {
    background: var(--glass-hover);
    border-color: rgba(255,255,255,0.18);
    transform: translateY(-1px);
  }
  .kb-card-top { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
  .kb-agent-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .kb-agent-name { font-size: 11px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; }
  .kb-source-pill {
    margin-left: auto; font-size: 9px; font-weight: 700; letter-spacing: 0.5px;
    padding: 2px 6px; border-radius: 4px; text-transform: uppercase;
    background: rgba(255,255,255,0.06); color: var(--text-dim);
  }
  .kb-card-desc {
    font-size: 12px; line-height: 1.5; color: var(--text);
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
  }
  .kb-card-desc.expanded { -webkit-line-clamp: unset; }
  .kb-card-result {
    margin-top: 6px;
    font-size: 11px; color: var(--text-dim); line-height: 1.4;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden;
    font-style: italic;
  }
  .kb-card-footer { display: flex; align-items: center; gap: 6px; margin-top: 10px; }
  .kb-status-pill {
    font-size: 9px; font-weight: 700; letter-spacing: 0.5px;
    padding: 2px 8px; border-radius: 10px; text-transform: uppercase;
  }
  .kb-time { margin-left: auto; font-size: 10px; color: var(--text-dim); white-space: nowrap; }

  /* status colors for pills */
  .status-pending    { background: rgba(107,114,128,0.15); color: #9ca3af; border: 1px solid rgba(107,114,128,0.2); }
  .status-in_progress{ background: rgba(99,102,241,0.15); color: #818cf8; border: 1px solid rgba(99,102,241,0.25); }
  .status-completed  { background: rgba(34,197,94,0.12); color: #4ade80; border: 1px solid rgba(34,197,94,0.2); }
  .status-done       { background: rgba(34,197,94,0.12); color: #4ade80; border: 1px solid rgba(34,197,94,0.2); }
  .status-blocked    { background: rgba(239,68,68,0.12); color: #f87171; border: 1px solid rgba(239,68,68,0.2); }
  .status-failed     { background: rgba(239,68,68,0.12); color: #f87171; border: 1px solid rgba(239,68,68,0.2); }
  .status-cancelled  { background: rgba(107,114,128,0.1); color: #6b7280; border: 1px solid rgba(107,114,128,0.15); }

  /* MOBILE: horizontal scroll */
  @media (max-width: 767px) {
    .kb-board {
      display: flex;
      flex-wrap: nowrap;
      overflow-x: auto;
      overflow-y: hidden;
      scroll-snap-type: x mandatory;
      -webkit-overflow-scrolling: touch;
      gap: 10px;
      padding: 12px;
      height: calc(100vh - 52px);
      align-items: stretch;
    }
    .kb-col {
      min-width: 85vw;
      max-width: 85vw;
      scroll-snap-align: start;
      flex-shrink: 0;
      overflow-y: auto;
      height: 100%;
    }
    .kb-col-header { position: sticky; top: 0; z-index: 5; }
    .kb-col-cards { padding-bottom: 24px; }
    .kb-board::-webkit-scrollbar { display: none; }
  }
  @media (min-width: 768px) and (max-width: 1199px) {
    .kb-board { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }

  /* Loading state */
  .kb-loading { display: flex; align-items: center; justify-content: center; flex: 1; color: var(--text-dim); font-size: 12px; gap: 8px; }
  .kb-spinner { width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.1); border-top-color: var(--indigo); border-radius: 50%; animation: spin 0.7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Scroll hint on mobile */
  .kb-scroll-hint {
    display: none;
    text-align: center;
    color: var(--text-dim);
    font-size: 10px;
    padding: 4px 0 8px;
    letter-spacing: 0.5px;
  }
  @media (max-width: 767px) { .kb-scroll-hint { display: block; } }

  /* Toast notifications */
  .toast-container {
    position: fixed; bottom: 20px; right: 20px; z-index: 9999;
    display: flex; flex-direction: column; gap: 8px; pointer-events: none;
  }
  .toast {
    padding: 12px 16px; border-radius: 8px; font-size: 13px; color: #fff;
    max-width: 320px; opacity: 0; transform: translateY(20px);
    transition: opacity 0.3s, transform 0.3s;
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
  }
  .toast.show { opacity: 1; transform: translateY(0); }
  .toast.success { background: #10b981; }
  .toast.error { background: #ef4444; }
  .toast.info { background: #3b82f6; }
</style>
</head>
<body>

<div id="toast-container" class="toast-container"></div>

<div class="kb-header">
  <a class="kb-logo" href="${DASHBOARD_BASE}/">
    <div class="kb-logo-badge">N</div>
    <div><div class="kb-title">Nova</div><div class="kb-subtitle">Kanban</div></div>
  </a>
  <a class="kb-back" href="${DASHBOARD_BASE}/">← Dashboard</a>
  <div class="kb-header-right">
    <div class="kb-live"><span class="live-dot" id="kb-sse-dot" style="background:var(--col-blocked)"></span><span id="kb-sse-label">Connecting…</span></div>
    <button class="kb-refresh" id="kb-refresh-btn" title="Refresh">↻</button>
  </div>
</div>

<div class="kb-scroll-hint">← swipe between columns →</div>

<div id="kb-board" class="kb-board">
  <div class="kb-loading"><div class="kb-spinner"></div> Loading…</div>
</div>

<script>
(function() {
  const BASE = '${DASHBOARD_BASE}';

  function showToast(message, type, durationMs) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    durationMs = durationMs || 3000;
    const el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.textContent = message;
    container.appendChild(el);
    requestAnimationFrame(function() { requestAnimationFrame(function() { el.classList.add('show'); }); });
    setTimeout(function() {
      el.classList.remove('show');
      setTimeout(function() { el.remove(); }, 300);
    }, durationMs);
  }

  const COLS = [
    { key: 'pending',    label: 'Pending',     color: '#6b7280' },
    { key: 'in_progress',label: 'In Progress', color: '#6366f1' },
    { key: 'completed',  label: 'Completed',   color: '#22c55e' },
    { key: 'blocked',    label: 'Blocked',     color: '#ef4444' },
  ];

  const AGENT_COLORS = {
    ceo:'#f59e0b', cfo:'#22c55e', cmo:'#ec4899', cto:'#06b6d4',
    coo:'#8b5cf6', research:'#3b82f6', critic:'#ef4444',
    helios:'#f59e0b', pixel:'#ec4899', kai:'#3b82f6', orion:'#22c55e',
    morpheus:'#8b5cf6', architect:'#06b6d4', athena:'#f59e0b',
    digit:'#3b82f6', echo:'#22c55e', flux:'#6366f1', quill:'#a78bfa',
    lex:'#64748b', helia:'#ec4899', bridge:'#06b6d4', oracle:'#f59e0b',
    cipher:'#8b5cf6', rift:'#ef4444', joule:'#22c55e', nexus:'#3b82f6',
    aura:'#ec4899', zen:'#4ade80', tesseract:'#06b6d4', magnus:'#f59e0b',
    cyra:'#6366f1',
  };

  function agentColor(slug) {
    return AGENT_COLORS[slug && slug.toLowerCase()] || '#6b7280';
  }

  function relativeTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - new Date(ts).getTime();
    const s = Math.floor(diff / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s/60) + 'm ago';
    if (s < 86400) return Math.floor(s/3600) + 'h ago';
    return Math.floor(s/86400) + 'd ago';
  }

  function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function renderCard(card) {
    const ac = agentColor(card.agent);
    const statusClass = 'status-' + (card.status || 'pending').replace(/[^a-z_]/g, '_');
    const hasResult = card.result && card.result.trim();
    return \`<div class="kb-card" data-id="\${escHtml(card.id)}" data-source="\${escHtml(card.source)}">
      <div class="kb-card-top">
        <span class="kb-agent-dot" style="background:\${ac}"></span>
        <span class="kb-agent-name" style="color:\${ac}">\${escHtml(card.agent)}</span>
        <span class="kb-source-pill">\${escHtml(card.source)}</span>
      </div>
      <div class="kb-card-desc">\${escHtml(card.description)}</div>
      \${hasResult ? \`<div class="kb-card-result">\${escHtml(card.result.slice(0, 200))}\${card.result.length > 200 ? '…' : ''}</div>\` : ''}
      <div class="kb-card-footer">
        <span class="kb-status-pill \${statusClass}">\${escHtml(card.status || 'pending')}</span>
        <span class="kb-time">\${relativeTime(card.updated_at || card.created_at)}</span>
      </div>
    </div>\`;
  }

  function renderBoard(data) {
    const board = document.getElementById('kb-board');
    if (!data || !data.columns) {
      board.innerHTML = '<div class="kb-loading">No data</div>';
      return;
    }
    board.innerHTML = COLS.map(col => {
      const cards = data.columns[col.key] || [];
      const cardHtml = cards.length
        ? cards.map(renderCard).join('')
        : '<div class="kb-empty">No tasks</div>';
      return \`<div class="kb-col" id="col-\${col.key}">
        <div class="kb-col-header">
          <span class="kb-col-dot" style="background:\${col.color}"></span>
          <span class="kb-col-name">\${col.label}</span>
          <span class="kb-col-count">\${cards.length}</span>
        </div>
        <div class="kb-col-cards" id="cards-\${col.key}">\${cardHtml}</div>
      </div>\`;
    }).join('');
  }

  function updateColumn(key, cards) {
    const el = document.getElementById('cards-' + key);
    if (!el) return;
    const count = document.querySelector('#col-' + key + ' .kb-col-count');
    if (count) count.textContent = cards.length;
    el.innerHTML = cards.length
      ? cards.map(renderCard).join('')
      : '<div class="kb-empty">No tasks</div>';
  }

  let _lastData = null;

  async function loadKanban() {
    try {
      const res = await fetch(BASE + '/api/kanban');
      const data = await res.json();
      _lastData = data;
      renderBoard(data);
    } catch(e) {
      document.getElementById('kb-board').innerHTML = '<div class="kb-loading">Failed to load — ' + e.message + '</div>';
    }
  }

  async function refreshFromApi() {
    try {
      const res = await fetch(BASE + '/api/kanban');
      const data = await res.json();
      if (!data.columns) return;
      _lastData = data;
      // Diff-update each column
      for (const col of ['pending','in_progress','completed','blocked']) {
        updateColumn(col, data.columns[col] || []);
      }
    } catch { /* ignore */ }
  }

  // SSE for live updates
  const RELOAD_EVENTS = new Set(['agent.dispatched','agent.completed','agent.progress','task.created','task.status','task.completed','exec.delegation']);
  let sseReloadTimer = null;
  function scheduleReload() {
    if (sseReloadTimer) clearTimeout(sseReloadTimer);
    sseReloadTimer = setTimeout(refreshFromApi, 800);
  }

  function connectSSE() {
    const dot = document.getElementById('kb-sse-dot');
    const label = document.getElementById('kb-sse-label');
    const es = new EventSource(BASE + '/api/activity/stream');
    let sseErrorShown = false;
    es.onopen = () => {
      sseErrorShown = false;
      dot.style.background = 'var(--col-completed)';
      label.textContent = 'Live';
    };
    es.onerror = () => {
      dot.style.background = 'var(--col-blocked)';
      label.textContent = 'Disconnected';
      if (!sseErrorShown) {
        sseErrorShown = true;
        showToast('Live connection lost. Reconnecting in 5s…', 'error', 5000);
      }
      es.close();
      setTimeout(() => { sseErrorShown = false; connectSSE(); }, 5000);
    };
    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        if (RELOAD_EVENTS.has(event.type)) scheduleReload();
      } catch { /* ignore */ }
    };
  }

  // Expand/collapse card description on tap
  document.addEventListener('click', function(e) {
    const card = e.target.closest('.kb-card');
    if (!card) return;
    const desc = card.querySelector('.kb-card-desc');
    if (desc) desc.classList.toggle('expanded');
  });

  document.getElementById('kb-refresh-btn').addEventListener('click', refreshFromApi);

  // Periodic fallback refresh every 30s
  setInterval(refreshFromApi, 30000);

  loadKanban();
  connectSSE();
})();
</script>
</body>
</html>`;
}

// ============================================================
// HTML DASHBOARD
// ============================================================

export function renderDashboard(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nova — Command Center</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #09090b;
    --bg-elevated: #111115;
    --surface: #18181b;
    --surface-hover: #1f1f23;
    --border: rgba(255,255,255,0.08);
    --border-subtle: rgba(255,255,255,0.05);
    --accent: #4f75ff;
    --accent-dim: rgba(79,117,255,0.12);
    --accent-hover: rgba(79,117,255,0.20);
    --success: #22c55e;
    --warning: #f59e0b;
    --error: #ef4444;
    --text: #fafafa;
    --text-secondary: #a1a1aa;
    --text-dim: #71717a;
    /* Compatibility aliases used by JS */
    --indigo: #4f75ff;
    --violet: #8b5cf6;
    --teal: #06b6d4;
    --pink: #ec4899;
    --blue: #3b82f6;
    --glass-border: rgba(255,255,255,0.08);
    /* Exec role colors — do NOT change */
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

  @keyframes pulse-dot { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
  @keyframes fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
  .blink { animation: blink 1.5s infinite; }

  /* ===== APP SHELL ===== */
  .app-shell { display: flex; flex-direction: column; height: 100vh; }

  /* ===== TOPBAR ===== */
  .topbar {
    height: 48px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 20px;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
    z-index: 100;
  }
  .topbar-brand { display: flex; align-items: center; gap: 10px; }
  .brand-mark {
    width: 28px; height: 28px;
    background: var(--accent);
    border-radius: 7px;
    display: flex; align-items: center; justify-content: center;
    font-size: 13px; font-weight: 700; color: #fff; flex-shrink: 0;
  }
  .brand-name { font-size: 14px; font-weight: 700; color: var(--text); }
  .brand-sep { color: var(--text-dim); font-size: 14px; }
  .brand-sub { font-size: 12px; color: var(--text-dim); }
  .topbar-right { display: flex; align-items: center; gap: 12px; }
  .time-display { font-size: 11px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
  .live-pill {
    display: flex; align-items: center; gap: 5px;
    font-size: 11px; color: var(--text-dim);
  }
  .live-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--success); animation: pulse-dot 2s infinite; flex-shrink: 0;
  }
  .sse-badge {
    padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 600;
    background: rgba(34,197,94,0.12); color: var(--success); border: 1px solid rgba(34,197,94,0.25);
  }
  .sse-badge.disconnected { background: rgba(239,68,68,0.12); color: var(--error); border-color: rgba(239,68,68,0.25); }
  .user-select {
    background: var(--surface); color: var(--text); border: 1px solid var(--border);
    padding: 5px 10px; font-family: inherit; font-size: 12px; border-radius: 7px; cursor: pointer;
    outline: none; transition: border-color 0.15s;
  }
  .user-select:focus { border-color: var(--accent); }
  .topbar-action {
    text-decoration: none; color: var(--text-dim); font-size: 12px;
    padding: 5px 12px; border: 1px solid var(--border); border-radius: 7px;
    transition: color 0.15s, border-color 0.15s; white-space: nowrap; cursor: pointer;
  }
  .topbar-action:hover { color: var(--text); border-color: rgba(255,255,255,0.16); }

  /* ===== BODY LAYOUT ===== */
  .body-layout {
    display: flex;
    flex: 1;
    overflow: hidden;
    min-height: 0;
  }

  /* ===== NAV SIDEBAR ===== */
  .nav-sidebar {
    width: 220px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--border);
    background: var(--bg-elevated);
    padding: 12px 8px;
    overflow-y: auto;
    gap: 4px;
  }
  .nav-sidebar::-webkit-scrollbar { width: 3px; }
  .nav-sidebar::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
  .nav-section { display: flex; flex-direction: column; gap: 1px; margin-bottom: 4px; }
  .nav-section-label {
    font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;
    color: var(--text-dim); padding: 6px 12px 4px; margin-top: 4px;
  }
  /* nav-item is also styled as dock-tab — see combined rule below */
  .nav-item {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 12px; border-radius: 8px; width: 100%;
    background: none; border: none; color: var(--text-dim);
    cursor: pointer; font-size: 13px; font-weight: 500; font-family: inherit;
    transition: background 0.15s, color 0.15s; text-align: left; white-space: nowrap;
  }
  .nav-item:hover { background: var(--surface); color: var(--text); }
  .nav-item.active { background: var(--accent-dim); color: var(--accent); }
  .nav-icon { width: 15px; height: 15px; flex-shrink: 0; opacity: 0.8; }
  .nav-item.active .nav-icon { opacity: 1; }
  .nav-footer {
    margin-top: auto;
    padding-top: 12px;
    border-top: 1px solid var(--border-subtle);
  }

  /* ===== MAIN CONTENT ===== */
  .main-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-height: 0;
  }
  .panels-container {
    flex: 1;
    overflow: hidden;
    position: relative;
    min-height: 0;
  }

  /* ===== DOCK PANELS ===== */
  .dock-panel { display: none; height: 100%; overflow-y: auto; padding: 20px 24px; box-sizing: border-box; }
  .dock-panel.active { display: flex; flex-direction: column; }
  .dock-panel::-webkit-scrollbar { width: 4px; }
  .dock-panel::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

  /* dock-tab: used both in nav and (legacy compatibility) anywhere JS targets .dock-tab */
  .dock-tab {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 12px; border-radius: 8px; width: 100%;
    background: none; border: none; color: var(--text-dim);
    cursor: pointer; font-size: 13px; font-weight: 500; font-family: inherit;
    transition: background 0.15s, color 0.15s; text-align: left; white-space: nowrap;
  }
  .dock-tab:hover { background: var(--surface); color: var(--text); }
  .dock-tab.active { background: var(--accent-dim); color: var(--accent); }

  /* ===== HOME PANEL — NOVA DOCK ===== */
  #nova-dock { padding: 20px 24px; overflow-y: auto; }

  .home-grid {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 16px;
    flex: 1;
    min-height: 0;
  }
  .home-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .home-card-title {
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.8px;
    color: var(--text-dim); margin-bottom: 12px; flex-shrink: 0;
  }
  .orbital-card { padding: 16px 16px 0; }

  /* ===== ORBITAL CANVAS ===== */
  .orbital-container {
    flex: 1; width: 100%;
    position: relative;
    min-height: 200px;
  }
  #orbital-canvas {
    width: 100%; height: 100%;
    display: block;
    cursor: grab;
  }
  #orbital-canvas:active { cursor: grabbing; }
  .center-stats {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
    text-align: center; pointer-events: none; z-index: 5;
  }
  .center-stats .nova-label { font-size: 12px; font-weight: 700; color: var(--accent); letter-spacing: 3px; }
  .center-stats .stat-row { font-size: 10px; color: var(--text-dim); margin-top: 2px; }
  .center-stats .stat-val { color: var(--text-secondary); font-weight: 600; }

  /* ===== EXEC CARDS ===== */
  .exec-card {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px 10px 15px;
    margin-bottom: 6px;
    cursor: pointer;
    transition: background 0.15s;
    position: relative;
    overflow: hidden;
  }
  .exec-card:hover { background: var(--surface-hover); }
  .exec-card .exec-accent {
    position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
    border-radius: 8px 0 0 8px;
  }
  .exec-card-header { display: flex; align-items: center; gap: 8px; }
  .exec-role-badge { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
  .exec-provider {
    font-size: 9px; padding: 1px 6px; border-radius: 6px;
    background: rgba(255,255,255,0.06); color: var(--text-dim);
    margin-left: auto;
  }
  .exec-persona { font-size: 10px; color: var(--text-dim); margin-top: 3px; }
  .exec-agents { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 6px; }
  .exec-agent-tag {
    font-size: 9px; padding: 1px 5px; border-radius: 4px;
    background: rgba(255,255,255,0.05); color: var(--text-dim);
  }
  .exec-stats { display: flex; gap: 12px; margin-top: 6px; }
  .exec-stat { font-size: 10px; color: var(--text-dim); }
  .exec-stat-val { font-weight: 600; }

  /* ===== ACTIVE AGENTS ===== */
  .active-agent-item { display: flex; align-items: center; gap: 8px; padding: 5px 0; font-size: 12px; }
  .active-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--success); animation: pulse-dot 2s infinite; flex-shrink: 0;
  }
  .active-agent-name { color: var(--text); font-weight: 500; flex: 1; }
  .active-agent-time { color: var(--text-dim); font-size: 10px; }

  /* ===== SECTION TITLE ===== */
  .section-title {
    font-size: 10px; text-transform: uppercase; letter-spacing: 1.5px;
    color: var(--text-dim); font-weight: 600; margin-bottom: 10px;
    display: flex; align-items: center; gap: 6px;
  }

  /* ===== ACTIVITY SIDEBAR ===== */
  .activity-sidebar {
    width: 260px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--border);
    background: var(--bg-elevated);
    overflow: hidden;
  }
  .activity-header {
    padding: 12px 14px 8px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .activity-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.8px; color: var(--text-dim); }
  .event-filter-bar {
    display: flex; gap: 4px; padding: 8px 10px;
    border-bottom: 1px solid var(--border); flex-shrink: 0;
  }
  .event-filter-btn {
    font-size: 10px; padding: 3px 9px; border-radius: 12px;
    background: none; border: 1px solid var(--border);
    color: var(--text-dim); cursor: pointer; font-family: inherit;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }
  .event-filter-btn:hover { background: var(--surface); color: var(--text); }
  .event-filter-btn.active { background: var(--accent-dim); color: var(--accent); border-color: rgba(79,117,255,0.3); }
  .event-stream {
    flex: 1; overflow-y: auto; padding: 8px 10px;
    font-family: 'JetBrains Mono', monospace; font-size: 10px; line-height: 1.6;
  }
  .event-stream::-webkit-scrollbar { width: 3px; }
  .event-stream::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }
  .event-entry { padding: 3px 0; border-bottom: 1px solid var(--border-subtle); animation: fade-in 0.3s ease; }
  .event-time { color: var(--text-dim); }
  .event-type { font-weight: 600; }
  .event-msg { color: var(--text-secondary); word-break: break-word; }
  .activity-stats {
    border-top: 1px solid var(--border);
    padding: 12px;
    flex-shrink: 0;
  }
  .activity-stats-title { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.8px; color: var(--text-dim); margin-bottom: 8px; }
  .stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .stat-pill {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; padding: 8px; text-align: center;
  }
  .stat-pill-label { font-size: 9px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; display: block; margin-bottom: 2px; }
  .stat-pill-value { font-size: 15px; font-weight: 700; color: var(--text); display: block; }
  .stat-pill-value.accent { color: var(--accent); }

  /* Mini-stat aliases used by JS-rendered content */
  .mini-stat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .mini-stat { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 8px; text-align: center; }
  .mini-stat-label { font-size: 9px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; }
  .mini-stat-value { font-size: 16px; font-weight: 700; color: var(--accent); }
  .mini-stat-value.green { color: var(--success); }
  .mini-stat-value.amber { color: var(--warning); }
  .mini-stat-value.cyan { color: var(--teal); }

  /* ===== TABLES ===== */
  .data-table { width: 100%; font-size: 12px; border-collapse: collapse; }
  .data-table th {
    text-align: left; color: var(--text-dim); font-size: 10px;
    text-transform: uppercase; letter-spacing: 0.5px;
    padding: 6px 10px; border-bottom: 1px solid var(--border);
    position: sticky; top: 0; background: var(--bg);
  }
  .data-table td { padding: 7px 10px; border-bottom: 1px solid var(--border-subtle); }
  .data-table tr:hover td { background: var(--surface-hover); }

  /* ===== MSG ROLES ===== */
  .msg-role {
    display: inline-block; padding: 1px 6px; font-size: 9px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.5px; border-radius: 3px;
  }
  .msg-role.user { color: #fff; background: var(--teal); }
  .msg-role.assistant { color: #fff; background: var(--accent); }
  .msg-role.system { color: #fff; background: var(--warning); }

  /* ===== INNER TABS ===== */
  .tabs { display: flex; gap: 3px; margin-bottom: 12px; flex-wrap: wrap; }
  .tab {
    padding: 4px 12px; cursor: pointer; font-size: 11px; color: var(--text-dim);
    border: none; background: none; font-family: inherit;
    border-radius: 16px; transition: color 0.15s, background 0.15s;
  }
  .tab:hover { color: var(--text); background: var(--surface); }
  .tab.active { color: #fff; background: var(--accent); }

  /* ===== METRIC ROW ===== */
  .metric-row { display: flex; justify-content: space-between; padding: 5px 0; border-bottom: 1px solid var(--border-subtle); }
  .metric-label { color: var(--text-dim); }
  .metric-value { color: var(--accent); font-weight: 600; }

  /* ===== COST CARDS ===== */
  .cost-summary { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
  .cost-card {
    flex: 1; min-width: 130px; background: var(--surface); border: 1px solid var(--border);
    padding: 12px; text-align: center; border-radius: 10px;
  }
  .cost-card-label { font-size: 9px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
  .cost-card-value { font-size: 20px; font-weight: 700; color: var(--accent); }
  .cost-card-value.amber { color: var(--warning); }
  .cost-card-value.cyan { color: var(--teal); }
  .cost-model-table { width: 100%; font-size: 11px; border-collapse: collapse; margin-top: 8px; }
  .cost-model-table th { text-align: left; color: var(--text-dim); font-size: 9px; text-transform: uppercase; padding: 4px 8px; border-bottom: 1px solid var(--border); }
  .cost-model-table td { padding: 4px 8px; border-bottom: 1px solid var(--border-subtle); }
  .cost-model-table td.cost-val { color: var(--accent); font-weight: 700; text-align: right; }
  .stacked-bar-chart { display: flex; align-items: flex-end; gap: 2px; height: 70px; margin-top: 6px; }
  .stacked-bar { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; min-height: 1px; position: relative; }
  .stacked-bar-segment { width: 100%; min-height: 0; transition: height 0.3s; opacity: 0.8; }
  .stacked-bar-segment:hover { opacity: 1; }
  .bar-label { position: absolute; bottom: -14px; left: 50%; transform: translateX(-50%); font-size: 8px; color: var(--text-dim); white-space: nowrap; }
  .cost-legend { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 18px; font-size: 10px; }
  .cost-legend-item { display: flex; align-items: center; gap: 4px; }
  .cost-legend-dot { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }
  .cost-section { margin-bottom: 20px; }
  .cost-section-title { font-size: 10px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; padding-bottom: 4px; border-bottom: 1px solid var(--border); }
  .cost-chart-container { display: flex; gap: 12px; flex-wrap: wrap; }
  .cost-chart-block { flex: 1; min-width: 260px; }
  .bar-chart { display: flex; align-items: flex-end; gap: 2px; height: 50px; margin-top: 8px; }
  .bar { flex: 1; background: var(--accent); min-height: 1px; position: relative; opacity: 0.65; border-radius: 2px 2px 0 0; }
  .bar:hover { opacity: 1; }

  /* ===== LOG / TRACE CONTENT ===== */
  .log-content { font-family: 'JetBrains Mono', monospace; font-size: 10px; line-height: 1.6; white-space: pre-wrap; word-break: break-all; color: var(--text-dim); }
  .log-file-name { color: var(--warning); font-size: 10px; margin: 8px 0 3px; padding: 3px 0; border-bottom: 1px solid var(--border); }

  /* ===== RESOURCE BARS ===== */
  .resource-bar-container { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .resource-label { width: 72px; font-size: 10px; color: var(--text-dim); }
  .resource-bar { flex: 1; height: 8px; background: var(--surface-hover); border: 1px solid var(--border); overflow: hidden; border-radius: 4px; }
  .resource-bar-fill { height: 100%; background: var(--accent); border-radius: 4px; transition: width 0.3s; }
  .resource-value { width: 70px; font-size: 10px; color: var(--accent); text-align: right; }

  /* ===== SERVICE CARDS ===== */
  .service-card {
    display: flex; align-items: center; gap: 8px; padding: 6px 8px;
    border-bottom: 1px solid var(--border-subtle); margin-bottom: 0;
  }
  .service-card:last-child { border-bottom: none; }
  .status-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .status-dot.running { background: var(--success); }
  .status-dot.error { background: var(--error); }
  .status-dot.idle { background: var(--warning); }
  .status-dot.not_installed, .status-dot.unknown { background: var(--text-dim); }
  .service-name { flex: 1; color: var(--text); font-size: 12px; }
  .service-meta { font-size: 10px; color: var(--text-dim); }

  /* ===== MEMORY TYPES ===== */
  .mem-type {
    display: inline-block; padding: 1px 6px; font-size: 9px; font-weight: 600;
    text-transform: uppercase; margin-right: 4px; border-radius: 3px;
  }
  .mem-type.fact { color: #fff; background: var(--teal); }
  .mem-type.goal { color: #fff; background: var(--warning); }
  .mem-type.completed_goal { color: #fff; background: var(--success); }
  .mem-type.preference { color: #fff; background: var(--violet); }

  /* ===== FORM CONTROLS ===== */
  .filter-row { display: flex; gap: 6px; margin-bottom: 10px; }
  select, input[type="text"] {
    background: var(--surface); color: var(--text); border: 1px solid var(--border);
    padding: 5px 10px; font-family: inherit; font-size: 12px; border-radius: 7px; outline: none;
    transition: border-color 0.15s;
  }
  select:focus, input[type="text"]:focus { border-color: var(--accent); }

  /* ===== CHAT BUBBLES ===== */
  .chat-bubble {
    max-width: 80%; padding: 9px 13px; border-radius: 12px;
    font-size: 13px; line-height: 1.45; position: relative; word-break: break-word;
  }
  .chat-bubble.user {
    align-self: flex-end; background: var(--accent); color: #fff;
    border-bottom-right-radius: 3px;
  }
  .chat-bubble.assistant {
    align-self: flex-start; background: var(--surface); border: 1px solid var(--border);
    color: var(--text); border-bottom-left-radius: 3px;
  }
  .chat-attachment {
    background: var(--surface-hover); border: 1px solid var(--border);
    border-radius: 4px; padding: 2px 6px; font-size: 10px;
    display: flex; align-items: center; gap: 4px;
  }
  .chat-attachment button { background: none; border: none; color: var(--error); cursor: pointer; padding: 0 2px; }

  /* ===== TOAST NOTIFICATIONS ===== */
  .toast-container {
    position: fixed; bottom: 20px; right: 20px; z-index: 9999;
    display: flex; flex-direction: column; gap: 8px; pointer-events: none;
  }
  .toast {
    padding: 12px 16px; border-radius: 8px; font-size: 13px; color: #fff;
    max-width: 320px; opacity: 0; transform: translateY(20px);
    transition: opacity 0.25s, transform 0.25s;
    font-family: 'Inter', sans-serif;
  }
  .toast.show { opacity: 1; transform: translateY(0); }
  .toast.success { background: #16a34a; }
  .toast.error { background: #ef4444; }
  .toast.info { background: var(--accent); }

  /* ===== EMPTY STATES ===== */
  .dash-empty-state { text-align: center; padding: 40px 20px; color: var(--text-dim); font-size: 12px; }
  .dash-empty-state-hint { font-size: 10px; margin-top: 6px; opacity: 0.7; }

  /* ===== FORM VALIDATION ===== */
  .input-error { border-color: #ef4444 !important; outline: 2px solid rgba(239,68,68,0.2) !important; }
  .field-error { color: #ef4444; font-size: 11px; margin-top: 3px; }

  /* ===== CONFIRM MODAL ===== */
  .confirm-modal {
    position: fixed; inset: 0; background: rgba(0,0,0,0.6);
    display: flex; align-items: center; justify-content: center; z-index: 10000;
  }
  .confirm-dialog {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 12px; padding: 24px; max-width: 380px; width: 90%;
    font-family: 'Inter', sans-serif; color: var(--text);
  }
  .confirm-dialog p { margin: 0 0 4px; font-size: 14px; line-height: 1.5; }
  .confirm-buttons { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; }
  .confirm-btn-cancel {
    padding: 8px 16px; border-radius: 7px; font-size: 12px; font-weight: 600;
    background: var(--surface-hover); color: var(--text-dim);
    border: 1px solid var(--border); cursor: pointer; transition: background 0.15s;
  }
  .confirm-btn-cancel:hover { background: var(--surface); color: var(--text); }
  .confirm-btn-confirm {
    padding: 8px 16px; border-radius: 7px; font-size: 12px; font-weight: 600;
    background: #ef4444; color: #fff; border: none; cursor: pointer; transition: opacity 0.15s;
  }
  .confirm-btn-confirm:hover { opacity: 0.88; }

  /* ===== RESPONSIVE ===== */
  @media (max-width: 1100px) {
    .activity-sidebar { display: none; }
    .nav-sidebar { width: 52px; padding: 12px 4px; }
    .nav-item, .dock-tab { padding: 8px; justify-content: center; }
    .nav-item span:not(.nav-icon), .dock-tab span:not(.nav-icon) { display: none; }
    .nav-section-label, .nav-footer .nav-section-label { display: none; }
  }
</style>
<script src="https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js"></script>
</head>
<body>
<div id="toast-container" class="toast-container"></div>

<div class="app-shell">

  <!-- ===== TOPBAR ===== -->
  <header class="topbar">
    <div class="topbar-brand">
      <div class="brand-mark">N</div>
      <span class="brand-name">Nova</span>
      <span class="brand-sep">&mdash;</span>
      <span class="brand-sub">Command Center</span>
    </div>
    <div class="topbar-right">
      <span class="time-display" id="header-time"></span>
      <span class="live-pill">
        <span class="live-dot"></span>
        Up: <span id="header-uptime">--</span>
      </span>
      <span class="sse-badge" id="sse-badge">LIVE</span>
      <select class="user-select" id="user-selector"><option value="">All Users</option></select>
      <a href="/governance" class="topbar-action">Governance</a>
      <a href="/kanban" class="topbar-action">Kanban</a>
<a href="/workboards" class="topbar-action">Workboards</a>
      <a href="/tickets" class="topbar-action">Tickets</a>
      <a href="/integrations" class="topbar-action">Integrations</a>
      <a href="/shared-credentials" class="topbar-action">Shared Creds</a>
      <a href="/profile" class="topbar-action">Profile</a>
      <a href="/schedules" class="topbar-action">Schedules</a>
      <a href="/skills" class="topbar-action">Skills</a>
      <a href="/knowledge" class="topbar-action">Knowledge</a>
      <a href="/playbooks" class="topbar-action">Playbooks</a>
      <a href="/automations" class="topbar-action">Automations</a>
      <a href="/processes" class="topbar-action">Processes</a>
      <a href="/extraction" class="topbar-action">Extraction</a>
      <a href="/policies" class="topbar-action">Policies</a>
      <a href="/governance-admin" class="topbar-action">Governance Admin</a>
      <a href="/roi" class="topbar-action">ROI</a>
      <a href="/data" class="topbar-action">Data</a>
      <a href="/activity" class="topbar-action">Activity</a>
      <a href="/deadletters" class="topbar-action">Dead letters</a>
      <a href="/connectors" class="topbar-action">Connectors</a>
      <a href="/history" class="topbar-action">History</a>
      <a href="/approvals" class="topbar-action">Approvals</a>
      <a href="/whatsapp" class="topbar-action">WhatsApp</a>
      <a href="/account" class="topbar-action">Account</a>
    </div>
  </header>

  <div class="body-layout">

    <!-- ===== LEFT NAV SIDEBAR ===== -->
    <nav class="nav-sidebar">

      <div class="nav-section">
        <div class="nav-section-label">Workspace</div>
        <button class="nav-item dock-tab active" data-panel="nova-dock">
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
          Home
        </button>
        <button class="nav-item dock-tab" data-panel="approvals-dock">
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>
          Approvals
        </button>
        <button class="nav-item dock-tab" data-panel="agent-tasks-dock">
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/></svg>
          Work
        </button>
        <button class="nav-item dock-tab" data-panel="traces-dock">
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
          Traces
        </button>
        <button class="nav-item dock-tab" data-panel="chat-dock">
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
          Chat
        </button>
      </div>

      <div class="nav-section">
        <div class="nav-section-label">Intelligence</div>
        <button class="nav-item dock-tab" data-panel="messages-dock">
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>
          History
        </button>
        <button class="nav-item dock-tab" data-panel="memory-dock">
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/></svg>
          Memory
        </button>
      </div>

      <div class="nav-section">
        <div class="nav-section-label">Operations</div>
        <button class="nav-item dock-tab" data-panel="costs-dock">
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>
          Analytics
        </button>
        <button class="nav-item dock-tab" data-panel="skills-dock">
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 010 14.14M4.93 4.93a10 10 0 000 14.14"/></svg>
          Integrations
        </button>
        <button class="nav-item dock-tab" data-panel="logs-dock">
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
          Infrastructure
        </button>
        <button class="nav-item dock-tab" data-panel="resources-dock">
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
          Resources
        </button>
        <button class="nav-item dock-tab" data-panel="alerts-dock">
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          Settings
        </button>
      </div>

      <div class="nav-section">
        <div class="nav-section-label">Management</div>
        <button class="nav-item dock-tab" data-panel="models-dock">
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9z"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/></svg>
          Models
        </button>
        <button class="nav-item dock-tab" data-panel="channels-dock">
          <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 11a9 9 0 019 9M4 4a16 16 0 0116 16"/><circle cx="5" cy="19" r="1"/></svg>
          Channels &amp; Access
        </button>
      </div>

      <!-- Services status pinned to bottom -->
      <div class="nav-footer">
        <div class="nav-section-label">Services</div>
        <div id="status-panel">
          <div style="color:var(--text-dim);font-size:11px;padding:4px 12px">Loading...</div>
        </div>
      </div>

    </nav>

    <!-- ===== MAIN CONTENT ===== -->
    <main class="main-content">
      <div class="panels-container" id="center-content">

        <!-- HOME PANEL -->
        <div class="dock-panel active" id="nova-dock">

          <!-- Home grid: exec board | active agents | 3D network -->
          <div class="home-grid">

            <div class="home-card">
              <div class="home-card-title">Executive Board</div>
              <div id="exec-panel" style="overflow-y:auto;flex:1;">
                <div style="color:var(--text-dim);font-size:11px">Loading...</div>
              </div>
            </div>

            <div class="home-card">
              <div class="home-card-title">Active Agents</div>
              <div id="active-agents-compact" style="overflow-y:auto;flex:1;">
                <div style="color:var(--text-dim);font-size:10px">None running</div>
              </div>
            </div>

            <div class="home-card orbital-card">
              <div class="home-card-title">Agent Network</div>
              <div class="orbital-container" id="orbital-container">
                <canvas id="orbital-canvas"></canvas>
                <div class="center-stats">
                  <div class="nova-label">NOVA</div>
                  <div class="stat-row">Agents: <span class="stat-val" id="stat-agents">24</span></div>
                  <div class="stat-row">Active: <span class="stat-val" id="stat-active">0</span></div>
                  <div class="stat-row">Today: $<span class="stat-val" id="stat-cost">0.00</span></div>
                </div>
              </div>
            </div>

          </div>
        </div>

        <!-- CHAT PANEL -->
        <div class="dock-panel" id="chat-dock">
          <div id="chat-messages" style="flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;min-height:0;">
            <div style="color:var(--text-dim);text-align:center;margin-top:30px;font-size:13px">Select a user to start chatting</div>
          </div>
          <div id="chat-input-container" style="border-top:1px solid var(--border);padding:12px 16px;display:flex;align-items:flex-end;gap:8px;flex-shrink:0;background:var(--bg-elevated);">
            <div style="flex:1;position:relative;">
              <textarea id="chat-input" placeholder="Message Nova..." required style="width:100%;background:var(--surface);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:10px 14px;font-family:inherit;font-size:13px;resize:none;min-height:44px;max-height:160px;outline:none;line-height:1.5;transition:border-color 0.15s;" onfocus="this.style.borderColor='var(--accent)'" onblur="this.style.borderColor='var(--border)'"></textarea>
              <div id="chat-attachments" style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;"></div>
            </div>
            <button id="chat-upload-btn" style="height:44px;width:44px;background:var(--surface);border:1px solid var(--border);border-radius:8px;color:var(--text-secondary);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.15s,color 0.15s;" title="Upload File" onmouseover="this.style.background='var(--surface-hover)';this.style.color='var(--text)'" onmouseout="this.style.background='var(--surface)';this.style.color='var(--text-secondary)'">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
            </button>
            <button id="chat-voice-btn" style="height:44px;width:44px;background:var(--surface);border:1px solid var(--border);border-radius:8px;color:var(--text-secondary);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.15s,color 0.15s;" title="Record Voice" onmouseover="this.style.background='var(--surface-hover)';this.style.color='var(--text)'" onmouseout="this.style.background='var(--surface)';this.style.color='var(--text-secondary)'">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8"/></svg>
            </button>
            <button id="chat-send-btn" style="height:44px;padding:0 20px;background:var(--accent);border:none;border-radius:8px;color:#fff;cursor:pointer;font-size:13px;font-weight:500;font-family:inherit;transition:opacity 0.15s;" onmouseover="this.style.opacity='0.85'" onmouseout="this.style.opacity='1'">Send</button>
          </div>
          <input type="file" id="chat-file-input" style="display:none;" multiple>
        </div>

        <!-- Lazy-loaded panels (content injected by JS) -->
        <div class="dock-panel" id="messages-dock"></div>
        <div class="dock-panel" id="agent-tasks-dock"></div>
        <div class="dock-panel" id="costs-dock"></div>
        <div class="dock-panel" id="approvals-dock"></div>
        <div class="dock-panel" id="memory-dock"></div>
        <div class="dock-panel" id="traces-dock"></div>
        <div class="dock-panel" id="logs-dock"></div>
        <div class="dock-panel" id="resources-dock"></div>
        <div class="dock-panel" id="skills-dock"></div>
        <div class="dock-panel" id="alerts-dock"></div>
        <div class="dock-panel" id="models-dock"></div>
        <div class="dock-panel" id="channels-dock"></div>

      </div>
    </main>

    <!-- ===== RIGHT ACTIVITY SIDEBAR ===== -->
    <aside class="activity-sidebar">

      <div class="activity-header">
        <span class="activity-title">Live Activity</span>
      </div>
      <div class="event-filter-bar">
        <button class="event-filter-btn active" data-filter="all">All</button>
        <button class="event-filter-btn" data-filter="agent">Agents</button>
        <button class="event-filter-btn" data-filter="exec">Execs</button>
        <button class="event-filter-btn" data-filter="error">Errors</button>
      </div>
      <div class="event-stream" id="event-stream">
        <div style="color:var(--text-dim)">Connecting...</div>
      </div>

      <div class="activity-stats">
        <div class="activity-stats-title">Stats</div>
        <div class="mini-stat-grid">
          <div class="mini-stat"><div class="mini-stat-label">Today</div><div class="mini-stat-value" id="cost-today">$0</div></div>
          <div class="mini-stat"><div class="mini-stat-label">Month</div><div class="mini-stat-value amber" id="cost-month">$0</div></div>
          <div class="mini-stat"><div class="mini-stat-label">Msgs 24h</div><div class="mini-stat-value cyan" id="msgs-today">0</div></div>
          <div class="mini-stat"><div class="mini-stat-label">SSE</div><div class="mini-stat-value green" id="sse-count">0</div></div>
        </div>
      </div>

    </aside>

  </div>
</div>


<script>
const BASE = '${DASHBOARD_BASE}';
const $ = (id) => document.getElementById(id);
const esc = (s) => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
function timeAgo(ts) { const s=Math.floor((Date.now()-new Date(ts).getTime())/1000); if(s<60) return s+'s'; if(s<3600) return Math.floor(s/60)+'m'; if(s<86400) return Math.floor(s/3600)+'h'; return Math.floor(s/86400)+'d'; }
function fmtUptime(sec) { const d=Math.floor(sec/86400),h=Math.floor((sec%86400)/3600),m=Math.floor((sec%3600)/60); if(d>0) return d+'d '+h+'h'; if(h>0) return h+'h '+m+'m'; return m+'m'; }

function showToast(message, type, durationMs) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  durationMs = durationMs || 3000;
  const el = document.createElement('div');
  el.className = 'toast ' + (type || 'info');
  el.textContent = message;
  container.appendChild(el);
  requestAnimationFrame(function() { requestAnimationFrame(function() { el.classList.add('show'); }); });
  setTimeout(function() {
    el.classList.remove('show');
    setTimeout(function() { el.remove(); }, 300);
  }, durationMs);
}

// D4: Confirm modal — replaces native confirm() for destructive actions
function confirmAction(message) {
  return new Promise(resolve => {
    const modal = document.createElement('div');
    modal.className = 'confirm-modal';
    modal.innerHTML = '<div class="confirm-dialog"><p>' + esc(message) + '</p><div class="confirm-buttons"><button class="confirm-btn-cancel">Cancel</button><button class="confirm-btn-confirm">Confirm</button></div></div>';
    document.body.appendChild(modal);
    const escHandler = (e) => {
      if (e.key === 'Escape') { document.removeEventListener('keydown', escHandler); modal.remove(); resolve(false); }
    };
    document.addEventListener('keydown', escHandler);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) { document.removeEventListener('keydown', escHandler); modal.remove(); resolve(false); }
    });
    modal.querySelector('.confirm-btn-cancel').onclick = () => { document.removeEventListener('keydown', escHandler); modal.remove(); resolve(false); };
    modal.querySelector('.confirm-btn-confirm').onclick = () => { document.removeEventListener('keydown', escHandler); modal.remove(); resolve(true); };
  });
}

// D3: Form validation
function validateForm(form) {
  let valid = true;
  form.querySelectorAll('[required]').forEach(input => {
    if (!input.value.trim()) {
      input.classList.add('input-error');
      valid = false;
    } else {
      input.classList.remove('input-error');
    }
  });
  return valid;
}

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
    if (sseConnected) {
      showToast('Connection lost. Reconnecting...', 'error', 6000);
    }
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

// ==== CENTER TABS ====
let activeDockPanel = 'nova-dock';
let dockPanelsLoaded = { 'nova-dock': true };

document.querySelectorAll('.dock-tab').forEach(tab => {
  tab.addEventListener('click', function() {
    const panel = this.dataset.panel;
    if (!panel) return;
    document.querySelectorAll('.dock-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.dock-panel').forEach(p => p.classList.remove('active'));
    this.classList.add('active');
    $(panel).classList.add('active');
    activeDockPanel = panel;
    if (!dockPanelsLoaded[panel]) loadDockPanel(panel);
    // Resize orbital canvas when returning to Nova tab
    if (panel === 'nova-dock' && renderer3d) {
      const container = $('orbital-container');
      if (container) {
        renderer3d.setSize(container.clientWidth, container.clientHeight);
        if (camera3d) camera3d.aspect = container.clientWidth / container.clientHeight;
        if (camera3d) camera3d.updateProjectionMatrix();
      }
    }
  });
});

function loadDockPanel(panel) {
  dockPanelsLoaded[panel] = true;
  switch(panel) {
    case 'nova-dock': /* 3D orbital is always live */ break;
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
    case 'alerts-dock': loadAlertRules(); break;
    case 'models-dock': loadModels(); break;
    case 'channels-dock': loadChannels(); break;
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
  if (!chatAttachments.length && !validateForm(input.parentElement)) return;
  if (!text && !chatAttachments.length) return;
  if (!selectedUserId) { showToast('Select a user first', 'info'); return; }

  const sendBtn = document.getElementById('chat-send-btn');
  const originalText = sendBtn?.textContent || 'Send';
  if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '...'; }

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
    if (!d.success) showToast('Error: ' + (d.error || 'Failed to send'), 'error');
  } catch(e) { showToast('Error sending message', 'error'); } finally {
    if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = originalText; }
  }
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
  } catch(e) { showToast('Upload failed: ' + e.message, 'error'); }
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
      const emptyLabel = agentTaskFilter === 'all' ? 'No tasks yet' : 'No ' + agentTaskFilter.replace('_', ' ') + ' tasks';
      html += '<div class="dash-empty-state">' + emptyLabel + '<div class="dash-empty-state-hint">Tasks will appear here as agents work.</div></div>';
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
    if (!d.approvals.length) { $('approvals-dock').innerHTML = '<div class="dash-empty-state">No pending approvals<div class="dash-empty-state-hint">New approvals will appear here as agents request authorization.</div></div>'; return; }
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
  if (action === 'cancel') {
    if (!await confirmAction('Cancel this approval request? This cannot be undone.')) return;
  }
  if (action === 'revise') feedback = prompt('Enter your revision feedback:');
  if (action === 'revise' && !feedback) return;
  try {
    const r = await fetch(BASE + '/api/approvals/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action, feedback })
    });
    const d = await r.json();
    if (d.success) {
      showToast(action === 'approve' ? 'Approved' : action === 'cancel' ? 'Cancelled' : 'Revision submitted', 'success');
      loadApprovals();
    } else {
      showToast('Error: ' + (d.error || 'Something went wrong'), 'error');
    }
  } catch(e) { showToast('Network error: ' + e.message, 'error'); }
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
  if (!await confirmAction('Delete this memory entry? This cannot be undone.')) return;
  try {
    const r = await fetch(BASE + '/api/memory/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    const d = await r.json();
    if (d.success) { showToast('Memory deleted', 'success'); loadMemory(); }
    else showToast(d.error || 'Failed to delete', 'error');
  } catch(e) { showToast('Network error', 'error'); }
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
      html += '<div style="color:var(--warning);font-size:10px;margin-bottom:4px;text-transform:uppercase;letter-spacing:1px">CLI Integrations (via mcp2cli)</div>';
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

// Alert Rules
async function loadAlertRules() {
  try {
    const r = await fetch(BASE + '/api/alerts/rules');
    const rules = await r.json();
    $('alerts-dock').innerHTML = \`
      <div style="padding:8px">
        <div style="color:var(--warning);font-size:10px;margin-bottom:10px;text-transform:uppercase;letter-spacing:1px">Alert Rules</div>
        <div style="display:flex;flex-direction:column;gap:8px;max-width:380px">
          <label style="display:flex;align-items:center;gap:8px;font-size:12px">
            <span style="flex:1;color:var(--text-dim)">Daily cost threshold ($)</span>
            <input id="ar-cost" type="number" min="0" step="0.01" value="\${rules.cost_daily_threshold_usd}" style="width:80px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 6px;border-radius:3px;font-size:12px">
          </label>
          <label style="display:flex;align-items:center;gap:8px;font-size:12px">
            <span style="flex:1;color:var(--text-dim)">Error rate threshold (%)</span>
            <input id="ar-errors" type="number" min="0" max="100" step="1" value="\${rules.error_rate_threshold_pct}" style="width:80px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 6px;border-radius:3px;font-size:12px">
          </label>
          <label style="display:flex;align-items:center;gap:8px;font-size:12px">
            <span style="flex:1;color:var(--text-dim)">Message lag (seconds)</span>
            <input id="ar-lag" type="number" min="0" step="30" value="\${rules.message_lag_seconds}" style="width:80px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 6px;border-radius:3px;font-size:12px">
          </label>
          <div style="display:flex;gap:8px;margin-top:4px">
            <button onclick="saveAlertRules()" style="background:var(--teal);color:#000;border:none;padding:6px 14px;border-radius:3px;font-size:11px;cursor:pointer;letter-spacing:1px;text-transform:uppercase">Save Rules</button>
            <button onclick="triggerAlertCheck()" style="background:var(--bg);color:var(--text-dim);border:1px solid var(--border);padding:6px 14px;border-radius:3px;font-size:11px;cursor:pointer;letter-spacing:1px;text-transform:uppercase">Run Check Now</button>
          </div>
        </div>
      </div>\`;
  } catch(e) { $('alerts-dock').innerHTML = '<div style="color:var(--error)">Error loading alert rules</div>'; }
}

async function saveAlertRules() {
  try {
    const rules = {
      cost_daily_threshold_usd: parseFloat($('ar-cost').value),
      error_rate_threshold_pct: parseFloat($('ar-errors').value),
      message_lag_seconds: parseInt($('ar-lag').value),
    };
    const r = await fetch(BASE + '/api/alerts/rules', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(rules) });
    const d = await r.json();
    if (d.ok) showToast('Alert rules saved', 'success');
    else showToast('Failed to save rules', 'error');
  } catch(e) { showToast('Error saving alert rules', 'error'); }
}

async function triggerAlertCheck() {
  try {
    await fetch(BASE + '/api/alerts/trigger-check', { method: 'POST' });
    showToast('Alert check triggered', 'success');
  } catch(e) { showToast('Error triggering check', 'error'); }
}

// ==== Management: AI Models + Channels & Access ====
const MGMT_INPUT = 'background:var(--bg);border:1px solid var(--border);color:var(--text);padding:6px 8px;border-radius:4px;font-size:12px;font-family:inherit;width:100%';
const MGMT_BTN = 'background:var(--bg);color:var(--text-dim);border:1px solid var(--border);padding:4px 10px;border-radius:4px;font-size:11px;cursor:pointer';
const MGMT_BTN_PRIMARY = 'background:var(--teal);color:#000;border:none;padding:6px 14px;border-radius:4px;font-size:11px;cursor:pointer;text-transform:uppercase;letter-spacing:1px';

async function loadModels() {
  const el = $('models-dock');
  el.innerHTML = '<div style="color:var(--text-dim)">Loading…</div>';
  try {
    const r = await fetch(BASE + '/api/providers');
    const d = await r.json();
    if (d.error) { el.innerHTML = '<div style="color:var(--error)">' + esc(d.error) + '</div>'; return; }
    const provs = d.providers || [];
    let html = '<div style="padding:8px;max-width:860px">';
    html += '<div style="color:var(--warning);font-size:10px;margin-bottom:10px;text-transform:uppercase;letter-spacing:1px">AI Models</div>';
    if (!provs.length) {
      html += '<div style="color:var(--text-dim);margin-bottom:12px">No custom providers configured. Add one below.</div>';
    } else {
      html += '<table class="data-table"><tr><th>Default</th><th>Name</th><th>Base URL</th><th>Key</th><th>Model</th><th></th></tr>';
      for (const p of provs) {
        const keyBadge = p.apiKeySet
          ? '<span style="color:var(--success)">✓ ' + esc(p.apiKeyEnv) + '</span>'
          : '<span style="color:var(--error)">✗ ' + esc(p.apiKeyEnv) + '</span>';
        html += '<tr>'
          + '<td><input type="radio" name="prov-default" data-default="' + esc(p.name) + '"' + (p.name === d.default ? ' checked' : '') + '></td>'
          + '<td style="color:var(--indigo)">' + esc(p.name) + '</td>'
          + '<td style="color:var(--text-dim)">' + esc(p.baseUrl) + '</td>'
          + '<td>' + keyBadge + '</td>'
          + '<td style="color:var(--text-dim)">' + esc(p.defaultModel) + '</td>'
          + '<td style="white-space:nowrap"><button data-test="' + esc(p.name) + '" style="' + MGMT_BTN + '">Test</button> '
          + '<button data-remove="' + esc(p.name) + '" style="' + MGMT_BTN + '">Remove</button></td>'
          + '</tr>';
      }
      html += '</table>';
    }
    html += '<div style="margin-top:16px;color:var(--warning);font-size:10px;text-transform:uppercase;letter-spacing:1px">Add provider</div>';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;max-width:640px;margin-top:8px">';
    html += '<input id="pm-name" placeholder="Name (e.g. openrouter)" style="' + MGMT_INPUT + '">';
    html += '<input id="pm-baseUrl" placeholder="Base URL (…/v1)" style="' + MGMT_INPUT + '">';
    html += '<input id="pm-apiKeyEnv" placeholder="API key env var (e.g. OPENROUTER_API_KEY)" style="' + MGMT_INPUT + '">';
    html += '<input id="pm-models" placeholder="Models (comma-separated)" style="' + MGMT_INPUT + '">';
    html += '<input id="pm-defaultModel" placeholder="Default model (optional)" style="' + MGMT_INPUT + '">';
    html += '<select id="pm-costClass" style="' + MGMT_INPUT + '">'
      + '<option value="cheap-api">cheap-api</option>'
      + '<option value="standard-api">standard-api</option>'
      + '<option value="premium-api">premium-api</option>'
      + '<option value="subscription-cli">subscription-cli</option>'
      + '</select>';
    html += '</div>';
    html += '<button id="pm-add" style="' + MGMT_BTN_PRIMARY + ';margin-top:10px">Add provider</button>';
    html += '<div style="color:var(--text-dim);font-size:11px;margin-top:8px">API keys live in .env as the named env var — Nova only stores the variable name, never the secret.</div>';
    html += '<div id="pm-test-result" style="margin-top:10px;font-size:12px"></div>';
    html += '</div>';
    el.innerHTML = html;
    el.querySelectorAll('[data-test]').forEach(b => { b.onclick = () => testProvider(b.dataset.test); });
    el.querySelectorAll('[data-remove]').forEach(b => { b.onclick = () => removeProvider(b.dataset.remove); });
    el.querySelectorAll('[data-default]').forEach(b => { b.onchange = () => setProviderDefault(b.dataset.default); });
    const addBtn = $('pm-add'); if (addBtn) addBtn.onclick = addProvider;
  } catch(e) { el.innerHTML = '<div style="color:var(--error)">Error loading providers</div>'; }
}

async function addProvider() {
  const body = {
    name: $('pm-name').value.trim(),
    baseUrl: $('pm-baseUrl').value.trim(),
    apiKeyEnv: $('pm-apiKeyEnv').value.trim(),
    models: $('pm-models').value.split(',').map(s => s.trim()).filter(Boolean),
    defaultModel: $('pm-defaultModel').value.trim(),
    costClass: $('pm-costClass').value,
  };
  if (!body.name || !body.baseUrl || !body.apiKeyEnv || !body.models.length) {
    showToast('Fill name, base URL, key env, and models', 'error'); return;
  }
  try {
    const r = await fetch(BASE + '/api/providers', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const d = await r.json();
    if (d.ok) { showToast('Provider added', 'success'); loadModels(); }
    else showToast(d.error || 'Failed to add', 'error');
  } catch(e) { showToast('Error adding provider', 'error'); }
}

async function testProvider(name) {
  const out = $('pm-test-result');
  if (out) { out.style.color = 'var(--text-dim)'; out.textContent = 'Testing ' + name + '…'; }
  try {
    const r = await fetch(BASE + '/api/providers/' + encodeURIComponent(name) + '/test', { method: 'POST' });
    const d = await r.json();
    if (d.ok) {
      if (out) { out.style.color = 'var(--success)'; out.textContent = '✓ ' + name + ' ok (' + d.ms + 'ms) ' + (d.detail || ''); }
      showToast(name + ' reachable', 'success');
    } else {
      if (out) { out.style.color = 'var(--error)'; out.textContent = '✗ ' + name + ': ' + (d.error || 'failed'); }
      showToast(name + ' test failed', 'error');
    }
  } catch(e) { showToast('Error testing provider', 'error'); }
}

async function removeProvider(name) {
  if (!(await confirmAction('Remove provider "' + name + '"?'))) return;
  try {
    const r = await fetch(BASE + '/api/providers/' + encodeURIComponent(name), { method: 'DELETE' });
    const d = await r.json();
    if (d.ok) { showToast('Removed ' + name, 'success'); loadModels(); }
    else showToast(d.error || 'Failed to remove', 'error');
  } catch(e) { showToast('Error removing provider', 'error'); }
}

async function setProviderDefault(name) {
  try {
    const r = await fetch(BASE + '/api/providers/default', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name }) });
    const d = await r.json();
    if (d.ok) showToast('Default model → ' + name, 'success');
    else showToast(d.error || 'Failed', 'error');
  } catch(e) { showToast('Error setting default', 'error'); }
}

async function loadChannels() {
  const el = $('channels-dock');
  el.innerHTML = '<div style="color:var(--text-dim)">Loading…</div>';
  try {
    const [cr, ir] = await Promise.all([fetch(BASE + '/api/channels'), fetch(BASE + '/api/invites')]);
    const cd = await cr.json();
    const idata = await ir.json();
    let html = '<div style="padding:8px;max-width:720px">';
    html += '<div style="color:var(--warning);font-size:10px;margin-bottom:10px;text-transform:uppercase;letter-spacing:1px">Channels</div>';
    html += '<table class="data-table"><tr><th>Channel</th><th>Status</th><th>Token env</th></tr>';
    for (const c of (cd.channels || [])) {
      const status = c.enabled ? '<span style="color:var(--success)">enabled</span>' : '<span style="color:var(--text-dim)">off</span>';
      const tok = c.tokenSet
        ? '<span style="color:var(--success)">✓ ' + esc(c.tokenEnv) + '</span>'
        : '<span style="color:var(--text-dim)">✗ ' + esc(c.tokenEnv) + '</span>';
      html += '<tr><td style="color:var(--indigo)">' + esc(c.type) + '</td><td>' + status + '</td><td>' + tok + '</td></tr>';
    }
    html += '</table>';
    html += '<div style="color:var(--text-dim);font-size:11px;margin-top:6px">Set the token env var in .env, then restart Nova to enable a channel.</div>';
    html += '<div style="margin-top:16px;color:var(--warning);font-size:10px;text-transform:uppercase;letter-spacing:1px">Access — invite codes</div>';
    html += '<div style="display:flex;gap:8px;align-items:center;margin-top:8px">';
    html += '<select id="inv-role" style="' + MGMT_INPUT + ';width:auto"><option value="member">member</option><option value="admin">admin</option></select>';
    html += '<button id="inv-gen" style="' + MGMT_BTN_PRIMARY + '">Generate invite</button>';
    html += '</div>';
    html += '<div id="inv-new" style="margin-top:8px;font-size:12px"></div>';
    html += '<div id="inv-list" style="margin-top:12px"></div>';
    html += '</div>';
    el.innerHTML = html;
    const gen = $('inv-gen'); if (gen) gen.onclick = generateInvite;
    renderInvites(idata.invites || []);
  } catch(e) { el.innerHTML = '<div style="color:var(--error)">Error loading channels</div>'; }
}

function renderInvites(list) {
  const el = $('inv-list');
  if (!el) return;
  if (!list.length) { el.innerHTML = '<div style="color:var(--text-dim);font-size:12px">No active invites.</div>'; return; }
  let html = '<table class="data-table"><tr><th>Code</th><th>Role</th><th>Expires</th><th></th></tr>';
  for (const i of list) {
    html += '<tr><td style="font-family:monospace;color:var(--accent)">' + esc(i.code) + '</td>'
      + '<td>' + esc(i.role) + '</td>'
      + '<td style="color:var(--text-dim)">' + esc(i.expires_at) + '</td>'
      + '<td><button data-revoke="' + esc(i.code) + '" style="' + MGMT_BTN + '">Revoke</button></td></tr>';
  }
  html += '</table>';
  el.innerHTML = html;
  el.querySelectorAll('[data-revoke]').forEach(b => { b.onclick = () => revokeInvite(b.dataset.revoke); });
}

async function loadInvites() {
  try { const r = await fetch(BASE + '/api/invites'); const d = await r.json(); renderInvites(d.invites || []); } catch(e) {}
}

async function generateInvite() {
  try {
    const role = $('inv-role').value;
    const r = await fetch(BASE + '/api/invite', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ role }) });
    const d = await r.json();
    if (d.code) {
      $('inv-new').innerHTML = '<div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:6px;padding:10px">'
        + '<span style="font-family:monospace;font-size:15px;color:var(--accent)">' + esc(d.code) + '</span> '
        + '<button id="inv-copy" style="' + MGMT_BTN + '">Copy</button>'
        + '<div style="color:var(--text-dim);margin-top:6px;white-space:pre-wrap">' + esc(d.message) + '</div></div>';
      const cp = $('inv-copy');
      if (cp) cp.onclick = () => { navigator.clipboard.writeText(d.code).then(() => showToast('Copied', 'success')); };
      loadInvites();
    } else showToast(d.error || 'Failed', 'error');
  } catch(e) { showToast('Error generating invite', 'error'); }
}

async function revokeInvite(code) {
  if (!(await confirmAction('Revoke code ' + code + '?'))) return;
  try {
    const r = await fetch(BASE + '/api/invites/' + encodeURIComponent(code), { method: 'DELETE' });
    const d = await r.json();
    if (d.ok) { showToast('Revoked', 'success'); loadInvites(); }
    else showToast('Failed to revoke', 'error');
  } catch(e) { showToast('Error revoking', 'error'); }
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
// HEALTH CHECK
// ============================================================

const MESSAGE_LAG_THRESHOLD_S = 300; // 5 minutes

async function handleHealthCheck(): Promise<Response> {
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
  let dbStatus: "ok" | "error" = "ok";
  let lastMessageAt: string | null = null;
  let messageLagSeconds: number | null = null;
  let overallStatus: "ok" | "degraded" | "down" = "ok";

  try {
    // Simple read probe — will throw if DB is unavailable
    supabase.raw.prepare("SELECT 1").get();

    // Most recent activity from logs table (shared.db)
    const row = supabase.raw
      .prepare("SELECT created_at FROM logs ORDER BY created_at DESC LIMIT 1")
      .get() as { created_at: string } | undefined;

    if (row?.created_at) {
      lastMessageAt = new Date(row.created_at + "Z").toISOString();
      messageLagSeconds = Math.floor((Date.now() - new Date(lastMessageAt).getTime()) / 1000);
      if (messageLagSeconds > MESSAGE_LAG_THRESHOLD_S) {
        overallStatus = "degraded";
      }
    }
    // No rows yet (fresh install) → lastMessageAt stays null, status stays "ok"
  } catch {
    dbStatus = "error";
    overallStatus = "down";
  }

  const body = {
    status: overallStatus,
    db: dbStatus,
    last_message_at: lastMessageAt,
    message_lag_seconds: messageLagSeconds,
    uptime_seconds: uptimeSeconds,
  };

  return jsonResponse(body, overallStatus === "down" ? 503 : 200);
}

// ============================================================
// OAUTH RESULT PAGE
// ============================================================

function renderOAuthResult(ok: boolean, msg: string): string {
  const color = ok ? "#22c55e" : "#ef4444";
  const icon = ok ? "✓" : "✗";
  const title = ok ? "Connected" : "Connection Failed";
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh}.card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:2rem;text-align:center;max-width:400px;width:90%}.icon{font-size:3rem;color:${color};margin-bottom:1rem}.title{font-size:1.25rem;font-weight:600;margin-bottom:.5rem;color:${color}}.msg{color:#94a3b8;font-size:.9rem;margin-bottom:1.5rem}.btn{display:inline-block;padding:.5rem 1.25rem;background:#3b82f6;color:#fff;border-radius:6px;text-decoration:none;font-size:.9rem}</style></head><body><div class="card"><div class="icon">${icon}</div><div class="title">${title}</div><div class="msg">${msg.replace(/</g,"&lt;").replace(/>/g,"&gt;")}</div><a class="btn" href="javascript:window.close()">Close</a></div></body></html>`;
}

// ============================================================
// SERVER
// ============================================================

if (RUN_SERVER) {
const server = Bun.serve({
  port: PORT,
  ...(BIND_HOST ? { hostname: BIND_HOST } : {}),
  async fetch(req) {
    const url = new URL(req.url);
    // Strip DASHBOARD_BASE prefix so route matching works regardless of reverse proxy path
    const rawPath = url.pathname;
    const path = DASHBOARD_BASE && rawPath.startsWith(DASHBOARD_BASE)
      ? rawPath.slice(DASHBOARD_BASE.length) || "/"
      : rawPath;

    // Health check (no auth required)
    if (path === "/health") {
      return handleHealthCheck();
    }

    // Login/logout routes
    if (path === "/login" && req.method === "POST") {
      return handleLogin(req);
    }
    if (path === "/logout") {
      return handleLogout();
    }

    // OAuth callback — session-exempt; auth is the signed state param
    if (path === "/api/integrations/callback" && req.method === "GET") {
      const { verifyOAuthState, handleOAuthCallback } = await import("./integrations.ts");
      const stateParam = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const err = url.searchParams.get("error");
      if (err) return new Response(renderOAuthResult(false, `OAuth error: ${err}`), { headers: { "Content-Type": "text/html" } });
      if (!stateParam || !code) return new Response(renderOAuthResult(false, "Missing state or code"), { headers: { "Content-Type": "text/html" } });
      const state = verifyOAuthState(stateParam);
      if (!state?.provider || !state?.userId) return new Response(renderOAuthResult(false, "Invalid or tampered state"), { headers: { "Content-Type": "text/html" } });
      const result = await handleOAuthCallback(supabase, state.provider, code, state.userId);
      if (result.success) {
        await (await import("./integrations.ts")).regenerateMcpConfig(supabase, state.userId).catch(() => {});
      }
      return new Response(renderOAuthResult(!!result.success, result.success ? `${state.provider} connected!` : (result.error || "Connection failed")), { headers: { "Content-Type": "text/html" } });
    }

    // Auth gate — everything below requires login
    const authResult = isAuthenticated(req);
    if (authResult === "no_password") {
      return noPasswordWarningPage();
    }
    if (!authResult) {
      return loginPage(undefined, path);
    }

    // Rate limit API requests
    if (path.startsWith("/api/")) {
      const sid = getSessionIdFromRequest(req);
      if (sid && !checkRateLimit(sid)) {
        return jsonResponse({ error: "Rate limit exceeded" }, 429);
      }
    }

    // Account page — change password (available even when must_change_password is set)
    if (path === "/account") {
      return new Response(renderAccountPage(), { headers: { "Content-Type": "text/html",
        "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'" } });
    }
    if (path === "/api/account/password" && req.method === "POST") {
      const me = getSessionUser(req); if (!me) return jsonResponse({ error: "unauthenticated" }, 401);
      const body = await req.json();
      return jsonResponse(await changeOwnPassword(me.userId, String(body.current || ""), String(body.next || "")));
    }

    // Resolve session user once for authz checks throughout the rest of this handler.
    // (/account and /api/account/password above are exempt and handle their own me lookups.)
    const me = getSessionUser(req);
    const isAdmin = isAdminRole(me?.role);

    // Enforce must_change_password: any logged-in DB user with must_change_password=1 is
    // blocked from all routes except /account and /api/account/password until they reset.
    // __master__ has no DB row — skip enforcement for it.
    if (me && me.userId !== "__master__") {
      const dbUser = supabase.getUserById(me.userId);
      if (dbUser?.must_change_password === 1) {
        if (path.startsWith("/api/")) return jsonResponse({ error: "Must change password before accessing this resource" }, 403);
        return new Response(null, { status: 302, headers: { Location: `${DASHBOARD_BASE}/account` } });
      }
    }

    // Dashboard HTML (admin only — members redirect to /account)
    if (path === "/") {
      if (!isAdmin) return new Response(null, { status: 302, headers: { Location: `${DASHBOARD_BASE}/account` } });
      return new Response(renderDashboard(), {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'",
        },
      });
    }

    // Governance control plane page (admin only)
    if (path === "/governance") {
      if (!isAdmin) return new Response(null, { status: 302, headers: { Location: `${DASHBOARD_BASE}/account` } });
      return new Response(renderGovernancePage(), {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
        },
      });
    }

    // Kanban board page (admin only)
    if (path === "/kanban") {
      if (!isAdmin) return new Response(null, { status: 302, headers: { Location: `${DASHBOARD_BASE}/account` } });
      return new Response(renderKanban(), {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'",
        },
      });
    }

    // Workboards index page (admin only)
    if (path === "/workboards") {
      if (!isAdmin) return new Response(null, { status: 302, headers: { Location: `${DASHBOARD_BASE}/account` } });
      return new Response(renderWorkboardIndex(getDb(), me?.userId ?? ""), {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'",
        },
      });
    }

    // Workboard detail page (admin only)
    const wbPage = path.match(/^\/workboards\/([\w-]+)$/);
    if (wbPage) {
      if (!isAdmin) return new Response(null, { status: 302, headers: { Location: `${DASHBOARD_BASE}/account` } });
      return new Response(renderWorkboard(getDb(), me?.userId ?? "", wbPage[1]), {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'",
        },
      });
    }

    // Support-ticket Kanban page (admin only)
    if (path === "/tickets") {
      if (!isAdmin) return new Response(null, { status: 302, headers: { Location: `${DASHBOARD_BASE}/account` } });
      return new Response(renderTicketBoard(), {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
        },
      });
    }

    // Integrations page
    if (path === "/integrations") {
      return new Response(renderIntegrationsPage(), {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
        },
      });
    }

    // Profile page (all authenticated users)
    if (path === "/profile") {
      if (!me) return new Response(null, { status: 302, headers: { Location: `${DASHBOARD_BASE}/account` } });
      return new Response(renderProfilePage(), {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
        },
      });
    }

    // Schedules page (all authenticated users)
    if (path === "/schedules") {
      if (!me) return new Response(null, { status: 302, headers: { Location: `${DASHBOARD_BASE}/account` } });
      return new Response(renderSchedulesPage(), {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
        },
      });
    }

    // Skills page (all authenticated users)
    if (path === "/skills") {
      if (!me) return new Response(null, { status: 302, headers: { Location: `${DASHBOARD_BASE}/account` } });
      return new Response(renderSkillsPage(), {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
        },
      });
    }

    // Knowledge page (all authenticated users)
    if (path === "/knowledge") {
      if (!me) return new Response(null, { status: 302, headers: { Location: `${DASHBOARD_BASE}/account` } });
      return new Response(renderKnowledgePage(), {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
        },
      });
    }

    // Playbooks page (all authenticated users)
    if (path === "/playbooks") {
      if (!me) return new Response(null, { status: 302, headers: { Location: `${DASHBOARD_BASE}/account` } });
      return new Response(renderPlaybooksPage(), {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
        },
      });
    }

    // Automations page (all authenticated users)
    if (path === "/automations") {
      if (!me) return new Response(null, { status: 302, headers: { Location: `${DASHBOARD_BASE}/account` } });
      return new Response(renderAutomationsPage(), {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
        },
      });
    }

    // Processes page (all authenticated users)
    if (path === "/processes") {
      if (!me) return new Response(null, { status: 302, headers: { Location: `${DASHBOARD_BASE}/account` } });
      return new Response(renderProcessesPage(), {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
        },
      });
    }

    // Extraction page (all authenticated users)
    if (path === "/extraction") {
      if (!me) return new Response(null, { status: 302, headers: { Location: `${DASHBOARD_BASE}/account` } });
      return new Response(renderExtractionPage(), {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
        },
      });
    }

    // Policies page (all authenticated users)
    if (path === "/policies") {
      if (!me) return new Response(null, { status: 302, headers: { Location: `${DASHBOARD_BASE}/account` } });
      return new Response(renderPoliciesPage(), {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
        },
      });
    }

    // Governance Admin page (RBAC · delegation · connector secrets).
    // Gated on the access.manage capability — admins always pass, so admin behavior is unchanged.
    if (path === "/governance-admin") {
      const { hasCapability } = await import("./permissions.ts");
      if (!hasCapability(supabase, me?.userId ?? "", "access.manage" as any)) {
        return new Response(null, { status: 302, headers: { Location: `${DASHBOARD_BASE}/account` } });
      }
      return new Response(renderGovernanceAdminPage(), {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
        },
      });
    }

    // ROI page (all authenticated users)
    if (path === "/roi") {
      if (!me) return new Response(null, { status: 302, headers: { Location: `${DASHBOARD_BASE}/account` } });
      return new Response(renderRoiPage(), {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
        },
      });
    }

    if (path === "/data") {
      if (!me) return new Response(null, { status: 302, headers: { Location: `${DASHBOARD_BASE}/account` } });
      return new Response(renderDataPage(), {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
        },
      });
    }

    // Connectors page (all authenticated users)
    if (path === "/connectors") {
      if (!me) return new Response(null, { status: 302, headers: { Location: `${DASHBOARD_BASE}/account` } });
      return new Response(renderConnectorsPage(), {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
        },
      });
    }

    // Activity page (all authenticated users)
    if (path === "/activity") {
      if (!me) return new Response(null, { status: 302, headers: { Location: `${DASHBOARD_BASE}/account` } });
      return new Response(renderActivityPage(), {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
        },
      });
    }

    // Dead-letter queue page (all authenticated users)
    if (path === "/deadletters") {
      if (!me) return new Response(null, { status: 302, headers: { Location: `${DASHBOARD_BASE}/account` } });
      return new Response(renderDeadLettersPage(), {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
        },
      });
    }

    // Task History page (all authenticated users)
    if (path === "/history") {
      if (!me) return new Response(null, { status: 302, headers: { Location: `${DASHBOARD_BASE}/account` } });
      return new Response(renderHistoryPage(), {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
        },
      });
    }

    // WhatsApp config page (all authenticated users)
    if (path === "/whatsapp") {
      if (!me) return new Response(null, { status: 302, headers: { Location: `${DASHBOARD_BASE}/account` } });
      return new Response(renderWhatsappPage(), {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
        },
      });
    }

    // Approvals page (all authenticated users)
    if (path === "/approvals") {
      if (!me) return new Response(null, { status: 302, headers: { Location: `${DASHBOARD_BASE}/account` } });
      return new Response(renderApprovalsPage(), {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
        },
      });
    }

    // Shared Credentials page (admin)
    if (path === "/shared-credentials") {
      return new Response(renderSharedCredsPage(), {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
        },
      });
    }

    // API routes — admins may filter by ?user_id=; members are pinned to their own data
    const userId = isAdmin ? (url.searchParams.get("user_id") || undefined) : me?.userId;
    // Guard for system-wide / cross-user endpoints: returns 403 for non-admins, null for admins
    const adminApi = (): Response | null => { if (!isAdmin) return jsonResponse({ error: "Admin only" }, 403); return null; };

    if (path.startsWith("/api/workboards")) {
      const wbUserId = userId || me?.userId;
      if (!wbUserId) return jsonResponse({ error: "user_id required" }, 400);
      const handled = await handleWorkboardApi(path, req, { db: getDb(), userId: wbUserId });
      if (handled) return handled;
    }

    if (path === "/api/users" && req.method === "GET") {
      const me = getSessionUser(req);
      if (me?.role !== "admin") return jsonResponse({ error: "Admin only" }, 403);
      return jsonResponse(await getUsers());
    }
    if (path === "/api/users" && req.method === "POST") {
      const me = getSessionUser(req);
      if (me?.role !== "admin") return jsonResponse({ error: "Admin only" }, 403);
      const b = await req.json();
      return jsonResponse(await adminCreateUser({ name: String(b.name || ""), username: String(b.username || ""), telegram_id: String(b.telegram_id || ""), role: String(b.role || "member") }));
    }
    const resetM = path.match(/^\/api\/users\/([^/]+)\/reset-password$/);
    if (resetM && req.method === "POST") {
      const me = getSessionUser(req);
      if (me?.role !== "admin") return jsonResponse({ error: "Admin only" }, 403);
      return jsonResponse(await adminResetPassword(decodeURIComponent(resetM[1])));
    }
    const delM = path.match(/^\/api\/users\/([^/]+)$/);
    if (delM && req.method === "DELETE") {
      const me = getSessionUser(req);
      if (me?.role !== "admin") return jsonResponse({ error: "Admin only" }, 403);
      supabase.updateUser(decodeURIComponent(delM[1]), { active: 0 });
      return jsonResponse({ ok: true });
    }
    if (path === "/api/status") { const g = adminApi(); if (g) return g; return jsonResponse(await getStatus()); }
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
      const g = adminApi(); if (g) return g;
      const service = url.searchParams.get("service") || "all";
      const lines = parseInt(url.searchParams.get("lines") || "100");
      return jsonResponse(await getLogs(service, Math.min(lines, 500)));
    }
    if (path === "/api/tasks") return jsonResponse(await getTasks());
    if (path === "/api/costs") return jsonResponse(await getCosts(userId));

    // ── Nova Knowledge (RAG) ──
    if (path === "/api/kb" && req.method === "GET") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      const agentParam = url.searchParams.get("agent") || undefined;
      try {
        return jsonResponse({ docs: supabase.listKbDocsVisible(userId, agentParam) });
      } catch (e: any) {
        return jsonResponse({ docs: [], error: e.message });
      }
    }
    if (path === "/api/kb/upload" && req.method === "POST") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      try {
        const formData = await req.formData();
        const file = formData.get("file") as File;
        if (!file) return jsonResponse({ error: "Missing file" }, 400);
        const scope = ((formData.get("scope") as string) || "personal") as "personal" | "team" | "agent";
        const agentSlug = (formData.get("agentSlug") as string) || undefined;
        const buf = Buffer.from(await file.arrayBuffer());
        const { ingestDocument } = await import("./knowledge.ts");
        const { sourceTypeFromName } = await import("./text-chunk.ts");
        const st = sourceTypeFromName(file.name);
        const isText = st === "md" || st === "txt";
        const result = await ingestDocument({
          db: supabase,
          userId,
          scope,
          agentSlug: agentSlug || undefined,
          title: file.name,
          source: "dashboard:" + file.name,
          sourceType: st,
          bytes: isText ? undefined : buf,
          text: isText ? buf.toString("utf8") : undefined,
        });
        return jsonResponse(result, result.status === "error" ? 400 : 200);
      } catch (e: any) {
        return jsonResponse({ status: "error", error: e.message }, 400);
      }
    }
    if (path === "/api/kb/delete" && req.method === "POST") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      try {
        const b = await req.json();
        if (!b.id || !b.scope) return jsonResponse({ error: "id and scope required" }, 400);
        supabase.deleteKbDoc(String(b.scope), userId, String(b.id));
        return jsonResponse({ success: true });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 400);
      }
    }
    if (path === "/api/kb/search" && req.method === "GET") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      const q = url.searchParams.get("q") || "";
      if (!q.trim()) return jsonResponse({ hits: [] });
      const agent = url.searchParams.get("agent") || undefined;
      try {
        const { searchKnowledge } = await import("./knowledge.ts");
        return jsonResponse({ hits: await searchKnowledge(supabase, q, { userId, agentSlug: agent || undefined, limit: 8, threshold: 0.3 }) });
      } catch (e: any) {
        return jsonResponse({ hits: [], error: e.message });
      }
    }
    // ── Playbooks (SOPs) ──
    if (path === "/api/playbooks" && req.method === "GET") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      try {
        return jsonResponse({ playbooks: supabase.listPlaybooksVisible(userId) });
      } catch (e: any) {
        return jsonResponse({ playbooks: [], error: e.message });
      }
    }
    if (path === "/api/playbooks" && req.method === "POST") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      { const { hasCapability } = await import("./permissions.ts"); if (!hasCapability(supabase, me?.userId ?? "", "playbook.manage" as any)) return jsonResponse({ error: "permission denied" }, 403); }
      try {
        const b = await req.json();
        if (!b.name) return jsonResponse({ error: "name required" }, 400);
        const result = supabase.insertPlaybook({
          scope: b.scope === "team" ? "team" : "personal",
          userId,
          name: String(b.name),
          description: b.description ? String(b.description) : undefined,
          variables: Array.isArray(b.variables) ? b.variables : [],
          steps: Array.isArray(b.steps) ? b.steps : [],
        });
        return jsonResponse(result);
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 400);
      }
    }
    if (path === "/api/playbooks/seed" && req.method === "POST") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      { const { hasCapability } = await import("./permissions.ts"); if (!hasCapability(supabase, me?.userId ?? "", "playbook.manage" as any)) return jsonResponse({ error: "permission denied" }, 403); }
      try {
        const { SEED_PLAYBOOKS } = await import("./playbooks.ts");
        let count = 0;
        for (const s of SEED_PLAYBOOKS) {
          if (supabase.findPlaybook(userId, s.name)) continue;
          supabase.insertPlaybook({ ...s, scope: "personal", userId });
          count++;
        }
        return jsonResponse({ success: true, added: count });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 400);
      }
    }
    if (path === "/api/playbooks/delete" && req.method === "POST") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      { const { hasCapability } = await import("./permissions.ts"); if (!hasCapability(supabase, me?.userId ?? "", "playbook.manage" as any)) return jsonResponse({ error: "permission denied" }, 403); }
      try {
        const b = await req.json();
        if (!b.id || !b.scope) return jsonResponse({ error: "id and scope required" }, 400);
        supabase.deletePlaybook(String(b.scope) as "personal" | "team", userId, String(b.id));
        return jsonResponse({ success: true });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 400);
      }
    }
    // ── Automations (event → condition → workflow) ──
    if (path === "/api/automations" && req.method === "GET") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      try {
        return jsonResponse({ automations: supabase.listAutomations(userId) });
      } catch (e: any) {
        return jsonResponse({ automations: [], error: e.message });
      }
    }
    if (path === "/api/automations" && req.method === "POST") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      { const { hasCapability } = await import("./permissions.ts"); if (!hasCapability(supabase, me?.userId ?? "", "automation.manage" as any)) return jsonResponse({ error: "permission denied" }, 403); }
      try {
        const b = await req.json();
        if (!b.name) return jsonResponse({ error: "name required" }, 400);
        if (!b.actionRef) return jsonResponse({ error: "actionRef required" }, 400);
        const actionType = b.actionType === "playbook" ? "playbook" : "agent";
        const actionConfig = actionType === "playbook"
          ? { vars: b.playbookVars && typeof b.playbookVars === "object" ? b.playbookVars : {} }
          : { template: b.template ? String(b.template) : "" };
        const { generateWebhookSecret } = await import("./webhook-server.ts");
        const secret = generateWebhookSecret();
        const result = supabase.insertAutomation({
          userId,
          name: String(b.name),
          sourceType: String(b.sourceType || "webhook"),
          conditions: Array.isArray(b.conditions) ? b.conditions : [],
          actionType,
          actionRef: String(b.actionRef),
          actionConfig,
          dedupeKey: b.dedupeKey ? String(b.dedupeKey) : undefined,
          rateLimitPerHour: typeof b.rateLimitPerHour === "number" && b.rateLimitPerHour > 0 ? b.rateLimitPerHour : undefined,
          secret,
        });
        return jsonResponse({ ...result, webhookUrl: `/automation/${userId}/${result.id}`, secret });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 400);
      }
    }
    if (path === "/api/automations/toggle" && req.method === "POST") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      { const { hasCapability } = await import("./permissions.ts"); if (!hasCapability(supabase, me?.userId ?? "", "automation.manage" as any)) return jsonResponse({ error: "permission denied" }, 403); }
      try {
        const b = await req.json();
        if (!b.id) return jsonResponse({ error: "id required" }, 400);
        supabase.setAutomationEnabled(userId, String(b.id), !!b.enabled);
        return jsonResponse({ success: true });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 400);
      }
    }
    if (path === "/api/automations/delete" && req.method === "POST") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      { const { hasCapability } = await import("./permissions.ts"); if (!hasCapability(supabase, me?.userId ?? "", "automation.manage" as any)) return jsonResponse({ error: "permission denied" }, 403); }
      try {
        const b = await req.json();
        if (!b.id) return jsonResponse({ error: "id required" }, 400);
        supabase.deleteAutomation(userId, String(b.id));
        return jsonResponse({ success: true });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 400);
      }
    }
    // ── Processes (durable long-running workflows) ──
    if (path === "/api/processes" && req.method === "GET") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      try {
        return jsonResponse({ processes: supabase.listProcesses(userId) });
      } catch (e: any) {
        return jsonResponse({ processes: [], error: e.message });
      }
    }
    if (path === "/api/processes" && req.method === "POST") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      try {
        const b = await req.json();
        if (!b.name) return jsonResponse({ error: "name required" }, 400);
        if (!Array.isArray(b.steps) || !b.steps.length) return jsonResponse({ error: "steps required" }, 400);
        const result = supabase.insertProcess({ userId, name: String(b.name), steps: b.steps });
        return jsonResponse(result);
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 400);
      }
    }
    if (path === "/api/processes/from-playbook" && req.method === "POST") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      try {
        const b = await req.json();
        if (!b.name) return jsonResponse({ error: "name required" }, 400);
        if (!b.playbook) return jsonResponse({ error: "playbook required" }, 400);
        const pb = supabase.findPlaybook(userId, String(b.playbook));
        if (!pb) return jsonResponse({ error: "playbook not found" }, 404);
        const steps = (pb.steps || []).map((s: any) => ({ type: "action" as const, agent: s.agent, description: s.description }));
        const result = supabase.insertProcess({ userId, name: String(b.name), steps, playbookId: pb.id });
        return jsonResponse(result);
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 400);
      }
    }
    if (path === "/api/processes/cancel" && req.method === "POST") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      try {
        const b = await req.json();
        if (!b.id) return jsonResponse({ error: "id required" }, 400);
        supabase.updateProcess(userId, String(b.id), { state: "cancelled" });
        return jsonResponse({ success: true });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 400);
      }
    }
    // ── Structured extraction (document → data) ──
    if (path === "/api/extract/schemas" && req.method === "GET") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      try {
        return jsonResponse({ schemas: supabase.listExtractSchemas(userId) });
      } catch (e: any) {
        return jsonResponse({ schemas: [], error: e.message });
      }
    }
    if (path === "/api/extract/schemas" && req.method === "POST") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      try {
        const b = await req.json();
        if (!b.name) return jsonResponse({ error: "name required" }, 400);
        if (!Array.isArray(b.fields) || !b.fields.length) return jsonResponse({ error: "fields required" }, 400);
        return jsonResponse(supabase.upsertExtractSchema(userId, { name: String(b.name), fields: b.fields, destination: b.destination ?? null }));
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 400);
      }
    }
    if (path === "/api/extract/schemas/delete" && req.method === "POST") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      try {
        const b = await req.json();
        if (!b.name) return jsonResponse({ error: "name required" }, 400);
        supabase.deleteExtractSchema(userId, String(b.name));
        return jsonResponse({ success: true });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 400);
      }
    }
    if (path === "/api/extract/rows" && req.method === "GET") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      try {
        const schema = url.searchParams.get("schema") || undefined;
        return jsonResponse({ rows: supabase.listExtractions(userId, schema) });
      } catch (e: any) {
        return jsonResponse({ rows: [], error: e.message });
      }
    }
    if (path === "/api/extract/export" && req.method === "GET") {
      if (!userId) return new Response("userId required", { status: 400 });
      try {
        const name = url.searchParams.get("schema") || "";
        const schema = supabase.getExtractSchema(userId, name);
        if (!schema) return new Response("schema not found", { status: 404 });
        const rows = supabase.listExtractions(userId, name);
        const { extractionsToCsv } = await import("./extraction.ts");
        const csv = extractionsToCsv(schema.fields, rows);
        return new Response(csv, {
          headers: { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="${name || "extractions"}.csv"` },
        });
      } catch (e: any) {
        return new Response(e.message, { status: 400 });
      }
    }
    if (path === "/api/extract/run" && req.method === "POST") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      try {
        const form = await req.formData();
        const file = form.get("file") as File;
        const schemaName = String(form.get("schema") || "");
        if (!file) return jsonResponse({ error: "file required" }, 400);
        if (!schemaName) return jsonResponse({ error: "schema required" }, 400);
        const schema = supabase.getExtractSchema(userId, schemaName);
        if (!schema) return jsonResponse({ error: "schema not found" }, 404);
        const { extractStructured } = await import("./extraction.ts");
        const { sourceTypeFromName } = await import("./text-chunk.ts");
        const { getProvider, getDefaultProvider } = await import("./ai-provider.ts");
        const claude = getProvider("claude") ?? getDefaultProvider();
        const callLLM = async (p: string) => (await claude.call({ prompt: p, model: claude.mapModelTier("standard"), maxTurns: 1, outputFormat: "text" })).text;
        const st = sourceTypeFromName(file.name);
        const bytes = Buffer.from(await file.arrayBuffer());
        const isText = st === "md" || st === "txt";
        const result = await extractStructured({
          db: supabase,
          userId,
          schema,
          source: file.name,
          sourceType: st,
          ...(isText ? { text: bytes.toString("utf8") } : { bytes }),
          callLLM,
        });
        return jsonResponse(result);
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 400);
      }
    }
    // ── Compliance policies (restrictive-only) ──
    if (path === "/api/policies" && req.method === "GET") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      try {
        return jsonResponse({ policies: supabase.listPolicies(userId) });
      } catch (e: any) {
        return jsonResponse({ policies: [], error: e.message });
      }
    }
    if (path === "/api/policies" && req.method === "POST") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      { const { hasCapability } = await import("./permissions.ts"); if (!hasCapability(supabase, me?.userId ?? "", "policy.manage" as any)) return jsonResponse({ error: "permission denied" }, 403); }
      try {
        const b = await req.json();
        if (!b.kind) return jsonResponse({ error: "kind required" }, 400);
        if (!b.config || typeof b.config !== "object") return jsonResponse({ error: "config required" }, 400);
        return jsonResponse(supabase.insertPolicy({
          userId,
          scope: b.scope ?? undefined,
          scopeRef: b.scopeRef ?? null,
          kind: String(b.kind),
          config: b.config,
        }));
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 400);
      }
    }
    if (path === "/api/policies/toggle" && req.method === "POST") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      { const { hasCapability } = await import("./permissions.ts"); if (!hasCapability(supabase, me?.userId ?? "", "policy.manage" as any)) return jsonResponse({ error: "permission denied" }, 403); }
      try {
        const b = await req.json();
        if (!b.id) return jsonResponse({ error: "id required" }, 400);
        supabase.setPolicyEnabled(userId, String(b.id), !!b.enabled);
        return jsonResponse({ success: true });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 400);
      }
    }
    if (path === "/api/policies/delete" && req.method === "POST") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      { const { hasCapability } = await import("./permissions.ts"); if (!hasCapability(supabase, me?.userId ?? "", "policy.manage" as any)) return jsonResponse({ error: "permission denied" }, 403); }
      try {
        const b = await req.json();
        if (!b.id) return jsonResponse({ error: "id required" }, 400);
        supabase.deletePolicy(userId, String(b.id));
        return jsonResponse({ success: true });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 400);
      }
    }
    // ── Governance admin (RBAC · delegation · connector secrets) ──
    // All /api/gov/* routes require the access.manage capability. Admins always pass
    // (hasCapability returns true for admins), so admin behavior is unchanged.
    if (path.startsWith("/api/gov/")) {
      const { hasCapability } = await import("./permissions.ts");
      if (!hasCapability(supabase, me?.userId ?? "", "access.manage" as any)) {
        return jsonResponse({ error: "permission denied" }, 403);
      }
    }
    if (path === "/api/gov/users" && req.method === "GET") {
      try {
        const { CAPABILITIES } = await import("./permissions.ts");
        const users = supabase.getAllUsers().map((u: any) => ({
          id: u.id,
          name: u.name,
          username: u.username,
          role: u.role,
          caps: supabase.listUserCapabilities(u.id),
          delegation: supabase.getActiveDelegation(u.id),
        }));
        return jsonResponse({ users, capabilities: CAPABILITIES });
      } catch (e: any) {
        return jsonResponse({ users: [], capabilities: [], error: e.message }, 500);
      }
    }
    if (path === "/api/gov/grant" && req.method === "POST") {
      try {
        const b = await req.json();
        if (!b.userId || !b.capability) return jsonResponse({ error: "userId and capability required" }, 400);
        const { isCapability } = await import("./permissions.ts");
        if (!isCapability(String(b.capability))) return jsonResponse({ error: "unknown capability" }, 400);
        supabase.grantCapability(String(b.userId), String(b.capability), me?.userId);
        return jsonResponse({ ok: true });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 400);
      }
    }
    if (path === "/api/gov/revoke" && req.method === "POST") {
      try {
        const b = await req.json();
        if (!b.userId || !b.capability) return jsonResponse({ error: "userId and capability required" }, 400);
        supabase.revokeCapability(String(b.userId), String(b.capability));
        return jsonResponse({ ok: true });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 400);
      }
    }
    if (path === "/api/gov/delegate" && req.method === "POST") {
      try {
        const b = await req.json();
        if (!b.userId || !b.delegateUserId) return jsonResponse({ error: "userId and delegateUserId required" }, 400);
        supabase.setDelegation(
          String(b.userId),
          String(b.delegateUserId),
          b.reason ? String(b.reason) : undefined,
          b.until ? String(b.until) : undefined,
        );
        return jsonResponse({ ok: true });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 400);
      }
    }
    if (path === "/api/gov/delegate/clear" && req.method === "POST") {
      try {
        const b = await req.json();
        if (!b.userId) return jsonResponse({ error: "userId required" }, 400);
        supabase.clearDelegation(String(b.userId));
        return jsonResponse({ ok: true });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 400);
      }
    }
    if (path === "/api/gov/connectors" && req.method === "GET") {
      try {
        const { listConnectors } = await import("./connectors/registry.ts");
        return jsonResponse({
          connectors: listConnectors().map((c) => ({
            id: c.id,
            label: c.label,
            credEnv: c.credEnv,
            rotations: supabase.listSecretRotations(c.id).length,
          })),
        });
      } catch (e: any) {
        return jsonResponse({ connectors: [], error: e.message }, 500);
      }
    }
    if (path === "/api/gov/connector-secret" && req.method === "POST") {
      try {
        const b = await req.json();
        if (!b.id) return jsonResponse({ error: "id required" }, 400);
        if (!b.creds || typeof b.creds !== "object") return jsonResponse({ error: "creds required" }, 400);
        supabase.setConnectorSecret(String(b.id), b.creds as Record<string, string>, me?.userId || "dashboard");
        return jsonResponse({ ok: true });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 400);
      }
    }
    if (path === "/api/roi" && req.method === "GET") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      try {
        const { rollupRoi } = await import("./roi.ts");
        const days = Number(url.searchParams.get("days"));
        return jsonResponse(rollupRoi(supabase, userId, Number(days) || 7));
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 500);
      }
    }
    // ── Data sources (connected-data layer) ──
    if (path === "/api/data" && req.method === "GET") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      try {
        return jsonResponse({ sources: supabase.listDataSources(userId) });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 400);
      }
    }
    if (path === "/api/data" && req.method === "POST") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      try {
        const body = await req.json().catch(() => ({}));
        const name = String(body.name || "").trim();
        const kind = String(body.kind || "").trim();
        if (!name) return jsonResponse({ error: "name required" }, 400);
        if (!kind) return jsonResponse({ error: "kind required" }, 400);
        return jsonResponse(supabase.upsertDataSource(userId, { name, kind, config: body.config || {} }));
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 400);
      }
    }
    if (path === "/api/data/delete" && req.method === "POST") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      try {
        const body = await req.json().catch(() => ({}));
        const name = String(body.name || "").trim();
        if (!name) return jsonResponse({ error: "name required" }, 400);
        supabase.deleteDataSource(userId, name);
        return jsonResponse({ ok: true });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 400);
      }
    }
    if (path === "/api/data/query" && req.method === "POST") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      try {
        const body = await req.json().catch(() => ({}));
        const name = String(body.name || "").trim();
        if (!name) return jsonResponse({ error: "name required" }, 400);
        const source = supabase.getDataSource(userId, name);
        if (!source) return jsonResponse({ error: `no data source "${name}"` }, 404);
        const { queryDataSource } = await import("./data-sources.ts");
        const query = body.query ? String(body.query) : undefined;
        const r = await queryDataSource(supabase, source, { query });
        return jsonResponse({ columns: r.columns, rows: r.rows.slice(0, 200), source: r.source });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 400);
      }
    }
    // ── Activity (unified run feed: automation / process / playbook) ──
    if (path === "/api/activity" && req.method === "GET") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      try {
        const kind = url.searchParams.get("kind") || undefined;
        const limit = Number(url.searchParams.get("limit")) || 50;
        return jsonResponse({ events: supabase.listRunEvents(userId, { kind: kind || undefined, limit }) });
      } catch (e: any) {
        return jsonResponse({ events: [], error: e.message });
      }
    }
    // ── Dead-letter queue (failed automation dispatches) ──
    if (path === "/api/dlq" && req.method === "GET") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      try {
        return jsonResponse({ items: supabase.listDeadLetters(userId) });
      } catch (e: any) {
        return jsonResponse({ items: [], error: e.message });
      }
    }
    if (path === "/api/dlq/drop" && req.method === "POST") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      try {
        const b = await req.json();
        if (!b.id) return jsonResponse({ error: "id required" }, 400);
        supabase.deleteDeadLetter(userId, String(b.id));
        return jsonResponse({ success: true });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 400);
      }
    }
    // ── Automation dry-run (evaluate conditions, execute nothing) ──
    if (path === "/api/automations/simulate" && req.method === "POST") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      try {
        const b = await req.json();
        if (!b.id) return jsonResponse({ error: "id required" }, 400);
        const automation = supabase.listAutomations(userId).find((a: any) => a.id === String(b.id));
        if (!automation) return jsonResponse({ error: "automation not found" }, 404);
        const { simulateAutomation } = await import("./simulate.ts");
        return jsonResponse(simulateAutomation(supabase, automation, b.event || {}));
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 400);
      }
    }
    // ── Connectors (business systems: Stripe/Shopify/Zendesk/HubSpot) ──
    if (path === "/api/connectors" && req.method === "GET") {
      try {
        const { listConnectors, isConnectorConfigured } = await import("./connectors/registry.ts");
        return jsonResponse({
          connectors: listConnectors().map((c) => ({
            id: c.id,
            label: c.label,
            authKind: c.authKind,
            credEnv: c.credEnv,
            configured: isConnectorConfigured(c, supabase),
            actions: Object.entries(c.actions).map(([name, a]) => ({ name, description: a.description, write: !!a.write })),
            triggers: (c.triggers || []).map((t) => ({ event: t.event, description: t.description })),
          })),
        });
      } catch (e: any) {
        return jsonResponse({ connectors: [], error: e.message }, 500);
      }
    }
    if (path === "/api/connectors/run" && req.method === "POST") {
      { const { hasCapability } = await import("./permissions.ts"); if (!hasCapability(supabase, me?.userId ?? "", "connector.manage" as any)) return jsonResponse({ error: "permission denied" }, 403); }
      const body = await req.json().catch(() => ({}));
      const id = String(body.id || "");
      const action = String(body.action || "");
      if (!id) return jsonResponse({ ok: false, error: "id required" }, 400);
      if (!action) return jsonResponse({ ok: false, error: "action required" }, 400);
      try {
        const { runConnectorAction } = await import("./connectors/registry.ts");
        return jsonResponse(await runConnectorAction(supabase, id, action, body.input || {}));
      } catch (e: any) {
        return jsonResponse({ ok: false, error: e.message }, 500);
      }
    }
    if (path === "/api/ledger") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      const agent = url.searchParams.get("agent") || undefined;
      const actionType = url.searchParams.get("actionType") || undefined;
      const parsed = parseInt(url.searchParams.get("limit") || "50");
      const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : 50;
      try {
        return jsonResponse({ actions: supabase.getActions(userId, { agent, actionType, limit }) });
      } catch (e: any) {
        return jsonResponse({ actions: [], error: e.message });
      }
    }
    // ── Governance control plane ──
    if (path === "/api/autonomy") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      if (req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        return jsonResponse(await setAutonomyGrantView(userId, body));
      }
      return jsonResponse(await getAutonomyView(userId));
    }
    if (path === "/api/budgets") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      return jsonResponse(await getBudgetsView(userId));
    }
    if (path === "/api/goals") {
      if (!userId) return jsonResponse({ error: "userId required" }, 400);
      return jsonResponse(await getGoalsView(userId));
    }

    if (path === "/api/usage-by-user") { const g = adminApi(); if (g) return g; return jsonResponse(await getUsageByUser()); }
    if (path === "/api/agent-tasks") return jsonResponse(await getAgentTasks(userId));
    if (path === "/api/kanban") return jsonResponse(await getKanbanData(userId));

    // Support tickets
    if (path === "/api/tickets") return jsonResponse(await getTicketBoardData());
    const ticketActionMatch = path.match(/^\/api\/tickets\/([^/]+)\/(approve|reject)$/);
    if (ticketActionMatch && req.method === "POST") {
      return jsonResponse(await actOnTicket(decodeURIComponent(ticketActionMatch[1]), ticketActionMatch[2] as "approve" | "reject"));
    }
    if (path === "/api/resources") { const g = adminApi(); if (g) return g; return jsonResponse(await getResources()); }
    if (path === "/api/voice") return jsonResponse(await getVoice(userId));
    if (path === "/api/skills") { const g = adminApi(); if (g) return g; return jsonResponse(await getSkills()); }

    // Per-user learned skills
    if (path === "/api/learned-skills" && req.method === "GET") {
      const me = getSessionUser(req);
      if (!me) return jsonResponse({ error: "unauthenticated" }, 401);
      return jsonResponse(await getLearnedSkillsHandler(me.userId));
    }
    const learnedSkillDeleteMatch = path.match(/^\/api\/learned-skills\/([^/]+)\/delete$/);
    if (learnedSkillDeleteMatch && req.method === "POST") {
      const me = getSessionUser(req);
      if (!me) return jsonResponse({ error: "unauthenticated" }, 401);
      return jsonResponse(await deleteLearnedSkillHandler(me.userId, decodeURIComponent(learnedSkillDeleteMatch[1])));
    }

    // Approvals
    if (path === "/api/approvals") return jsonResponse(await getApprovals(userId));
    if (path === "/api/approvals/resolve" && req.method === "POST") {
      const me = getSessionUser(req);
      if (!me) return jsonResponse({ error: "unauthenticated" }, 401);
      const body = await req.json();
      return jsonResponse(await resolveApproval(body.id, body.action, body.feedback, me.userId));
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

    // Active agents (admin only)
    if (path === "/api/agents/active") {
      const g = adminApi(); if (g) return g;
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

    // Agent catalog (admin only)
    if (path === "/api/agents/catalog") {
      const g = adminApi(); if (g) return g;
      return jsonResponse(await getAgentCatalog());
    }

    // Executives (admin only)
    if (path === "/api/executives") {
      const g = adminApi(); if (g) return g;
      return jsonResponse(await getExecutives());
    }

    // Board sessions (admin only)
    if (path === "/api/board/recent") {
      const g = adminApi(); if (g) return g;
      return jsonResponse(await getRecentBoardSessions());
    }

    // Active delegations (admin only)
    if (path === "/api/delegations/active") {
      const g = adminApi(); if (g) return g;
      return jsonResponse(await getActiveDelegations());
    }

    // Alert rules
    if (path === "/api/alerts/rules") {
      if (req.method === "POST") {
        const body = await req.json();
        alertRules = { ...alertRules, ...body };
        return jsonResponse({ ok: true, rules: alertRules });
      }
      return jsonResponse(alertRules);
    }
    if (path === "/api/alerts/trigger-check" && req.method === "POST") {
      checkAlertRules().catch(() => {});
      return jsonResponse({ ok: true, message: "Alert check triggered" });
    }

    // ── CS / SDR Mode API ──────────────────────────────────────────────────

    // CS Config
    if (path === "/api/cs/config") {
      if (req.method === "GET") {
        return jsonResponse(supabase.getCsConfig());
      }
      if (req.method === "PATCH") {
        const body = await req.json().catch(() => ({}));
        supabase.saveCsConfig(body);
        return jsonResponse(supabase.getCsConfig());
      }
    }

    // CS Documents
    if (path === "/api/cs/documents") {
      if (req.method === "GET") {
        return jsonResponse(supabase.getCsDocuments());
      }
      if (req.method === "POST") {
        const form = await req.formData();
        const file = form.get("file") as File;
        if (!file) return jsonResponse({ error: "Missing file" }, 400);
        const buffer = Buffer.from(await file.arrayBuffer());
        const { randomUUID } = await import("crypto");
        const docId = randomUUID();
        supabase.createCsDocument(docId, file.name, buffer.length, file.type);
        const { ingestDocument } = await import("./cs-rag.ts");
        ingestDocument(supabase, docId, buffer, file.type).catch((err: unknown) => logError(err, "cs-ingest"));
        return jsonResponse({ id: docId, status: "processing" }, 202);
      }
    }

    // CS Documents — delete by id
    const csDocDeleteMatch = path.match(/^\/api\/cs\/documents\/([^/]+)$/);
    if (csDocDeleteMatch && req.method === "DELETE") {
      supabase.deleteCsDocument(decodeURIComponent(csDocDeleteMatch[1]));
      return jsonResponse({ ok: true });
    }

    // CS Sessions
    if (path === "/api/cs/sessions" && req.method === "GET") {
      return jsonResponse(supabase.getCsSessions());
    }

    // CS Sessions — messages and status update by id
    const csSessionMatch = path.match(/^\/api\/cs\/sessions\/([^/]+)(\/messages)?$/);
    if (csSessionMatch) {
      const sessionId = decodeURIComponent(csSessionMatch[1]);
      const isMessages = !!csSessionMatch[2];
      if (isMessages && req.method === "GET") {
        return jsonResponse(supabase.getCsMessages(sessionId));
      }
      if (!isMessages && req.method === "PATCH") {
        const body = await req.json().catch(() => ({}));
        supabase.updateCsSession(sessionId, { status: body.status });
        return jsonResponse({ ok: true });
      }
    }

    // Admin shared-credential routes
    if (path === "/api/shared-credentials" && req.method === "GET") {
      if (getSessionUser(req)?.role !== "admin") return jsonResponse({ error: "Admin only" }, 403);
      return jsonResponse({ credentials: supabase.listSharedCredentials() }); // masked
    }
    if (path === "/api/shared-credentials" && req.method === "POST") {
      const me = getSessionUser(req);
      if (me?.role !== "admin") return jsonResponse({ error: "Admin only" }, 403);
      const b = await req.json();
      if (!b.provider || !b.kind) return jsonResponse({ error: "provider and kind required" }, 400);
      supabase.upsertSharedCredential({ provider: String(b.provider), kind: String(b.kind), credentials: b.credentials || {}, created_by: me.userId });
      // eager propagation: regenerate MCP config for all active users (small user base)
      for (const u of supabase.getAllActiveUsers()) {
        await (await import("./integrations.ts")).regenerateMcpConfig(supabase, u.id).catch(()=>{});
      }
      return jsonResponse({ ok: true });
    }
    const scDel = path.match(/^\/api\/shared-credentials\/([^/]+)$/);
    if (scDel && req.method === "DELETE") {
      if (getSessionUser(req)?.role !== "admin") return jsonResponse({ error: "Admin only" }, 403);
      supabase.deleteSharedCredential(decodeURIComponent(scDel[1]));
      return jsonResponse({ ok: true });
    }

    // Per-user integration routes — scoped to session userId (no IDOR)
    const meI = getSessionUser(req);
    if (path === "/api/integrations" && req.method === "GET") {
      if (!meI) return jsonResponse({ error: "unauthenticated" }, 401);
      const { getIntegrationStatus } = await import("./integrations.ts");
      return jsonResponse({ integrations: await getIntegrationStatus(supabase, meI.userId) });
    }
    const connM = path.match(/^\/api\/integrations\/([^/]+)\/connect$/);
    if (connM && req.method === "POST") {
      if (!meI) return jsonResponse({ error: "unauthenticated" }, 401);
      const { getOAuthUrl } = await import("./integrations.ts");
      const base = process.env.DASHBOARD_PUBLIC_URL || "";
      return jsonResponse(getOAuthUrl(decodeURIComponent(connM[1]) as any, meI.userId, base));
    }
    const keyM = path.match(/^\/api\/integrations\/([^/]+)\/save-key$/);
    if (keyM && req.method === "POST") {
      if (!meI) return jsonResponse({ error: "unauthenticated" }, 401);
      const b = await req.json().catch(() => ({}));
      supabase.upsertIntegration({ user_id: meI.userId, provider: decodeURIComponent(keyM[1]), status: "connected", credentials: b.credentials || {} });
      await (await import("./integrations.ts")).regenerateMcpConfig(supabase, meI.userId).catch(() => {});
      return jsonResponse({ ok: true });
    }
    const discM = path.match(/^\/api\/integrations\/([^/]+)\/disconnect$/);
    if (discM && req.method === "POST") {
      if (!meI) return jsonResponse({ error: "unauthenticated" }, 401);
      supabase.upsertIntegration({ user_id: meI.userId, provider: decodeURIComponent(discM[1]), status: "disconnected", credentials: {} });
      await (await import("./integrations.ts")).regenerateMcpConfig(supabase, meI.userId).catch(() => {});
      return jsonResponse({ ok: true });
    }

    // Per-user profile routes — scoped to session userId only (no IDOR)
    if (path === "/api/profile" && req.method === "GET") {
      const me = getSessionUser(req);
      if (!me) return jsonResponse({ error: "unauthenticated" }, 401);
      return jsonResponse(await getProfile(me.userId));
    }
    if (path === "/api/profile" && req.method === "PUT") {
      const me = getSessionUser(req);
      if (!me) return jsonResponse({ error: "unauthenticated" }, 401);
      return jsonResponse(await updateProfile(me.userId, await req.json().catch(() => ({}))));
    }
    if (path === "/api/preferences" && req.method === "PUT") {
      const me = getSessionUser(req);
      if (!me) return jsonResponse({ error: "unauthenticated" }, 401);
      return jsonResponse(await updatePreferences(me.userId, await req.json().catch(() => ({}))));
    }

    // Per-user schedule routes — scoped to session userId only (no IDOR)
    if (path === "/api/schedules" && req.method === "GET") {
      const me = getSessionUser(req);
      if (!me) return jsonResponse({ error: "unauthenticated" }, 401);
      return jsonResponse(await getSchedules(me.userId));
    }
    if (path === "/api/schedules" && req.method === "POST") {
      const me = getSessionUser(req);
      if (!me) return jsonResponse({ error: "unauthenticated" }, 401);
      return jsonResponse(await createSchedule(me.userId, await req.json().catch(() => ({}))));
    }
    const schedCancelM = path.match(/^\/api\/schedules\/([^/]+)\/cancel$/);
    if (schedCancelM && req.method === "POST") {
      const me = getSessionUser(req);
      if (!me) return jsonResponse({ error: "unauthenticated" }, 401);
      return jsonResponse(await cancelSchedule(me.userId, decodeURIComponent(schedCancelM[1])));
    }

    // Per-user task history routes — scoped to session userId only (no IDOR)
    if (path === "/api/history" && req.method === "GET") {
      const me = getSessionUser(req);
      if (!me) return jsonResponse({ error: "unauthenticated" }, 401);
      return jsonResponse(await getTaskHistoryHandler(me.userId));
    }
    const historyDetailM = path.match(/^\/api\/history\/([^/]+)$/);
    if (historyDetailM && req.method === "GET") {
      const me = getSessionUser(req);
      if (!me) return jsonResponse({ error: "unauthenticated" }, 401);
      return jsonResponse(await getTaskDetailHandler(me.userId, decodeURIComponent(historyDetailM[1])));
    }

    // ── WhatsApp config routes (DB-backed, no live manager) ──
    if (path === "/api/whatsapp/connect" && req.method === "POST") {
      const me = getSessionUser(req);
      if (!me) return jsonResponse({ error: "unauthenticated" }, 401);
      const body = await req.json().catch(() => ({}));
      const { kapso_api_key, kapso_phone_number_id } = body;
      if (!kapso_api_key || !kapso_phone_number_id) {
        return jsonResponse({ error: "kapso_api_key and kapso_phone_number_id are required" }, 400);
      }
      supabase.setKapsoCredentials(me.userId, String(kapso_api_key), String(kapso_phone_number_id));
      return jsonResponse({ configured: true });
    }
    if (path === "/api/whatsapp/disconnect" && req.method === "POST") {
      const me = getSessionUser(req);
      if (!me) return jsonResponse({ error: "unauthenticated" }, 401);
      supabase.clearKapsoCredentials(me.userId);
      return jsonResponse({ configured: false });
    }
    if (path === "/api/whatsapp/status" && req.method === "GET") {
      const me = getSessionUser(req);
      if (!me) return jsonResponse({ error: "unauthenticated" }, 401);
      const user = supabase.getUserById(me.userId);
      return jsonResponse({ configured: !!(user?.kapso_api_key) });
    }
    if (path === "/api/whatsapp/contacts" && req.method === "GET") {
      const me = getSessionUser(req);
      if (!me) return jsonResponse({ error: "unauthenticated" }, 401);
      return jsonResponse({ contacts: supabase.getWhatsappContacts(me.userId) });
    }
    if (path === "/api/whatsapp/contacts" && req.method === "POST") {
      const me = getSessionUser(req);
      if (!me) return jsonResponse({ error: "unauthenticated" }, 401);
      const body = await req.json().catch(() => ({}));
      const { phone, name, role, permissions } = body;
      if (!phone) return jsonResponse({ error: "phone is required" }, 400);
      const validRole = validateContactRole(role || "allowed");
      if (!validRole) return jsonResponse({ error: `Invalid role: ${role}` }, 400);
      try {
        supabase.upsertWhatsappContact(
          me.userId,
          String(phone).replace(/[^0-9+]/g, ""),
          name ? String(name) : null,
          validRole,
          permissions && typeof permissions === "object" ? permissions : {}
        );
        return jsonResponse({ success: true });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 500);
      }
    }
    const contactDeleteMatch = path.match(/^\/api\/whatsapp\/contacts\/([^/]+)$/);
    if (contactDeleteMatch && req.method === "DELETE") {
      const me = getSessionUser(req);
      if (!me) return jsonResponse({ error: "unauthenticated" }, 401);
      try {
        supabase.deleteWhatsappContact(me.userId, decodeURIComponent(contactDeleteMatch[1]));
        return jsonResponse({ success: true });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 500);
      }
    }
    if (path === "/api/whatsapp/groups" && req.method === "GET") {
      const me = getSessionUser(req);
      if (!me) return jsonResponse({ error: "unauthenticated" }, 401);
      return jsonResponse({ groups: supabase.getWhatsappGroups(me.userId) });
    }
    if (path === "/api/whatsapp/groups" && req.method === "POST") {
      const me = getSessionUser(req);
      if (!me) return jsonResponse({ error: "unauthenticated" }, 401);
      const body = await req.json().catch(() => ({}));
      const { group_jid, name, active, permissions } = body;
      if (!group_jid) return jsonResponse({ error: "group_jid is required" }, 400);
      try {
        supabase.upsertWhatsappGroup(
          me.userId,
          String(group_jid),
          name ? String(name) : null,
          active !== undefined ? (active ? 1 : 0) : 1,
          permissions && typeof permissions === "object" ? permissions : {}
        );
        return jsonResponse({ success: true });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 500);
      }
    }
    const groupDeleteMatch = path.match(/^\/api\/whatsapp\/groups\/([^/]+)$/);
    if (groupDeleteMatch && req.method === "DELETE") {
      const me = getSessionUser(req);
      if (!me) return jsonResponse({ error: "unauthenticated" }, 401);
      try {
        supabase.deleteWhatsappGroup(me.userId, decodeURIComponent(groupDeleteMatch[1]));
        return jsonResponse({ success: true });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // ── AI Models (provider registry) — admin only ──────────────────────────
    // Secrets are never returned: only the env-var name + whether it is set.
    if (path === "/api/providers" && req.method === "GET") {
      const g = adminApi(); if (g) return g;
      const profiles = readConfigProfiles(providerConfigPath());
      const masked = profiles.map((p) => ({
        name: p.name,
        baseUrl: p.baseUrl,
        models: p.models,
        defaultModel: p.defaultModel,
        costClass: p.costClass,
        capabilities: p.capabilities ?? null,
        apiKeyEnv: p.apiKeyEnv,
        apiKeySet: !!process.env[p.apiKeyEnv],
      }));
      const admin = supabase.getUsersByRole("admin")[0];
      let def = admin?.ai_provider || null;
      if (!def) { try { def = getDefaultProvider().name; } catch { def = null; } }
      return jsonResponse({ providers: masked, default: def });
    }
    if (path === "/api/providers" && req.method === "POST") {
      const g = adminApi(); if (g) return g;
      const b = await req.json().catch(() => ({}));
      const profile = {
        name: String(b.name || "").trim(),
        baseUrl: String(b.baseUrl || "").trim(),
        apiKeyEnv: String(b.apiKeyEnv || "").trim(),
        models: Array.isArray(b.models)
          ? b.models.map((m: any) => String(m).trim()).filter(Boolean)
          : String(b.models || "").split(",").map((m) => m.trim()).filter(Boolean),
        defaultModel: String(b.defaultModel || "").trim(),
        costClass: String(b.costClass || "").trim(),
        ...(b.capabilities && typeof b.capabilities === "object" ? { capabilities: b.capabilities } : {}),
      } as any;
      if (!profile.defaultModel && profile.models.length) profile.defaultModel = profile.models[0];
      const err = validateProfile(profile);
      if (err) return jsonResponse({ error: err }, 400);
      try {
        upsertProviderProfile(profile, providerConfigPath());
        return jsonResponse({ ok: true });
      } catch (e: any) {
        return jsonResponse({ error: e.message }, 400);
      }
    }
    const provTestM = path.match(/^\/api\/providers\/([^/]+)\/test$/);
    if (provTestM && req.method === "POST") {
      const g = adminApi(); if (g) return g;
      const name = decodeURIComponent(provTestM[1]);
      const profile = loadProviderProfiles(providerConfigPath()).find((p) => p.name === name);
      if (!profile) return jsonResponse({ ok: false, error: "unknown provider" }, 404);
      const start = performance.now();
      try {
        const { OpenAICompatibleProvider } = await import("./providers/openai-compatible.ts");
        const prov = new OpenAICompatibleProvider(profile);
        if (!(await prov.isAvailable())) {
          return jsonResponse({ ok: false, error: `${profile.apiKeyEnv} not set`, ms: Math.round(performance.now() - start) });
        }
        const r = await prov.call({ prompt: "ping", noMcp: true, maxTurns: 1 });
        return jsonResponse({ ok: true, detail: String(r.text || "").slice(0, 120), ms: Math.round(performance.now() - start) });
      } catch (e: any) {
        return jsonResponse({ ok: false, error: e.message, ms: Math.round(performance.now() - start) });
      }
    }
    if (path === "/api/providers/default" && req.method === "POST") {
      const g = adminApi(); if (g) return g;
      const b = await req.json().catch(() => ({}));
      const name = String(b.name || "").trim();
      if (!name) return jsonResponse({ error: "name required" }, 400);
      for (const admin of supabase.getUsersByRole("admin")) {
        supabase.updateUser(admin.id, { ai_provider: name });
      }
      try { setDefaultProvider(name); } catch { /* provider not registered in this process — DB pref still updated */ }
      return jsonResponse({ ok: true, default: name });
    }
    const provDelM = path.match(/^\/api\/providers\/([^/]+)$/);
    if (provDelM && req.method === "DELETE") {
      const g = adminApi(); if (g) return g;
      removeProviderProfile(decodeURIComponent(provDelM[1]), providerConfigPath());
      return jsonResponse({ ok: true });
    }

    // ── Channels & Access — admin only ──────────────────────────────────────
    // Channel token editing is out of scope: status only, never token values.
    if (path === "/api/channels" && req.method === "GET") {
      const g = adminApi(); if (g) return g;
      const allowlist = (process.env.NOVA_CHANNELS || "").split(",").map((s) => s.trim()).filter(Boolean);
      const allowed = (t: string) => allowlist.length === 0 || allowlist.includes(t);
      const defs: Array<{ type: string; tokenEnv: string }> = [
        { type: "telegram", tokenEnv: "TELEGRAM_BOT_TOKEN" },
        { type: "slack", tokenEnv: "SLACK_BOT_TOKEN" },
        { type: "whatsapp", tokenEnv: "WHATSAPP_WEBHOOK_URL" },
        { type: "discord", tokenEnv: "DISCORD_BOT_TOKEN" },
        { type: "cli", tokenEnv: "NOVA_CLI" },
      ];
      const channels = defs.map((d) => {
        const tokenSet = !!process.env[d.tokenEnv];
        return { type: d.type, enabled: allowed(d.type) && tokenSet, tokenEnv: d.tokenEnv, tokenSet };
      });
      return jsonResponse({ channels });
    }
    if (path === "/api/invite" && req.method === "POST") {
      const g = adminApi(); if (g) return g;
      const b = await req.json().catch(() => ({}));
      const role = b.role === "admin" ? "admin" : "member";
      const adminId = me?.userId || supabase.getUsersByRole("admin")[0]?.id || "__master__";
      const code = supabase.createPairingCode(adminId, role, 24 * 60);
      const message = `Your Nova invite code: ${code}\nSend it to Nova (or use "request access") to join. Expires in 24 hours.`;
      return jsonResponse({ code, role, message });
    }
    if (path === "/api/invites" && req.method === "GET") {
      const g = adminApi(); if (g) return g;
      return jsonResponse({ invites: supabase.getActivePairingCodes() });
    }
    const inviteDelM = path.match(/^\/api\/invites\/([^/]+)$/);
    if (inviteDelM && req.method === "DELETE") {
      const g = adminApi(); if (g) return g;
      supabase.deletePairingCode(decodeURIComponent(inviteDelM[1]));
      return jsonResponse({ ok: true });
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
console.log("  GET  /api/ledger     — Action ledger (agent task audit trail)");
console.log("  GET/POST /api/autonomy — Autonomy grants (governance)");
console.log("  GET  /api/budgets    — Spend vs cap summary");
console.log("  GET  /api/goals      — Active goals + progress");
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
}
