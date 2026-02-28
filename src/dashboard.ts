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
import { readFile, readdir, stat } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = dirname(dirname(__filename));
const PORT = 3033;
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".nova");
const LOGS_DIR = join(PROJECT_ROOT, "logs");

// Supabase (optional)
const supabase: SupabaseClient | null =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

const startTime = Date.now();

// ============================================================
// AUTH — cookie-based session login
// ============================================================

const DASHBOARD_USER = process.env.DASHBOARD_USER || "admin";
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || "";
const DASHBOARD_BASE = process.env.DASHBOARD_BASE || "/dashboard";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-memory session store (survives for container lifetime)
const sessions = new Map<string, { user: string; expiresAt: number }>();

function generateSessionId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function isAuthenticated(req: Request): boolean {
  if (!DASHBOARD_PASS) return true; // No password set = auth disabled
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

function loginPage(error?: string): Response {
  const errorHtml = error ? `<div class="error">${error}</div>` : "";
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Nova — Login</title>
  <link href="https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0a0a0a;
      color: #00ff41;
      font-family: 'Share Tech Mono', monospace;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .login-box {
      border: 1px solid #00ff41;
      padding: 2rem;
      width: 340px;
      background: rgba(0, 255, 65, 0.03);
      box-shadow: 0 0 20px rgba(0, 255, 65, 0.1);
    }
    h1 {
      font-size: 1.4rem;
      text-align: center;
      margin-bottom: 1.5rem;
      text-shadow: 0 0 10px rgba(0, 255, 65, 0.5);
    }
    label { display: block; margin-bottom: 0.3rem; font-size: 0.85rem; opacity: 0.7; }
    input {
      width: 100%;
      padding: 0.6rem;
      background: #111;
      border: 1px solid #333;
      color: #00ff41;
      font-family: inherit;
      font-size: 0.95rem;
      margin-bottom: 1rem;
      outline: none;
    }
    input:focus { border-color: #00ff41; box-shadow: 0 0 5px rgba(0, 255, 65, 0.3); }
    button {
      width: 100%;
      padding: 0.7rem;
      background: transparent;
      border: 1px solid #00ff41;
      color: #00ff41;
      font-family: inherit;
      font-size: 1rem;
      cursor: pointer;
      text-transform: uppercase;
      letter-spacing: 2px;
    }
    button:hover { background: rgba(0, 255, 65, 0.1); }
    .error {
      background: rgba(255, 0, 0, 0.1);
      border: 1px solid #ff4444;
      color: #ff4444;
      padding: 0.5rem;
      margin-bottom: 1rem;
      text-align: center;
      font-size: 0.85rem;
    }
    .scanline {
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      pointer-events: none; z-index: 999;
      background: repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.03) 2px, rgba(0,0,0,0.03) 4px);
    }
  </style>
</head>
<body>
  <div class="scanline"></div>
  <div class="login-box">
    <h1>// NOVA COMMAND CENTER</h1>
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
        "Set-Cookie": `nova_session=${sessionId}; Path=${DASHBOARD_BASE}; HttpOnly; SameSite=Strict; Max-Age=86400; Secure`,
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
      "Set-Cookie": `nova_session=; Path=${DASHBOARD_BASE}; HttpOnly; Max-Age=0`,
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
        { name: "relay", label: "Relay", unit: "com.nova.relay" },
        { name: "voice-server", label: "Voice Server", unit: "com.nova.voice-server" },
        { name: "smart-checkin", label: "Smart Check-in", unit: "com.nova.smart-checkin" },
        { name: "morning-briefing", label: "Morning Briefing", unit: "com.nova.morning-briefing" },
        { name: "dashboard", label: "Dashboard", unit: "com.nova.dashboard" },
      ]
    : [
        { name: "relay", label: "Relay", unit: "nova-relay" },
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
  if (!supabase) return { users: [], error: "Supabase not configured" };
  try {
    const { data, error } = await supabase
      .from("users")
      .select("id, name, telegram_id, role, timezone, active")
      .order("created_at");
    if (error) return { users: [], error: error.message };
    return { users: data || [] };
  } catch (e: any) {
    return { users: [], error: e.message };
  }
}

async function getMessages(limit: number, userId?: string): Promise<unknown> {
  if (!supabase) return { messages: [], error: "Supabase not configured" };
  try {
    let query = supabase
      .from("messages")
      .select("id, created_at, role, content, channel, metadata")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (userId) query = query.eq("user_id", userId);
    const { data, error } = await query;
    if (error) return { messages: [], error: error.message };
    return { messages: data || [] };
  } catch (e: any) {
    return { messages: [], error: e.message };
  }
}

async function getMemory(type: string, userId?: string): Promise<unknown> {
  if (!supabase) return { memory: [], error: "Supabase not configured" };
  try {
    let query = supabase
      .from("memory")
      .select("id, created_at, type, content, deadline, completed_at, priority, scope")
      .order("created_at", { ascending: false })
      .limit(100);
    if (type !== "all") {
      query = query.eq("type", type);
    }
    if (userId) query = query.eq("user_id", userId);
    const { data, error } = await query;
    if (error) return { memory: [], error: error.message };
    return { memory: data || [] };
  } catch (e: any) {
    return { memory: [], error: e.message };
  }
}

async function getMetrics(userId?: string): Promise<unknown> {
  if (!supabase) return { error: "Supabase not configured" };
  try {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    let dayQ = supabase.from("messages").select("id", { count: "exact", head: true }).gte("created_at", oneDayAgo);
    let weekQ = supabase.from("messages").select("id", { count: "exact", head: true }).gte("created_at", oneWeekAgo);
    let chanQ = supabase.from("messages").select("channel, role, created_at").gte("created_at", oneDayAgo);
    if (userId) {
      dayQ = dayQ.eq("user_id", userId);
      weekQ = weekQ.eq("user_id", userId);
      chanQ = chanQ.eq("user_id", userId);
    }

    const [dayResult, weekResult, channelResult] = await Promise.all([dayQ, weekQ, chanQ]);

    // Hourly breakdown for last 24h
    const hourly: Record<number, number> = {};
    for (let i = 0; i < 24; i++) hourly[i] = 0;
    const channelCounts: Record<string, number> = {};
    const roleCounts: Record<string, number> = {};

    if (channelResult.data) {
      for (const msg of channelResult.data) {
        const h = new Date(msg.created_at).getHours();
        hourly[h] = (hourly[h] || 0) + 1;
        channelCounts[msg.channel || "unknown"] = (channelCounts[msg.channel || "unknown"] || 0) + 1;
        roleCounts[msg.role || "unknown"] = (roleCounts[msg.role || "unknown"] || 0) + 1;
      }
    }

    return {
      today: dayResult.count || 0,
      thisWeek: weekResult.count || 0,
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
  const uploadsDir = join(RELAY_DIR, "uploads");
  const tempDir = join(RELAY_DIR, "temp");

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
  if (!supabase) return { calls: [], error: "Supabase not configured" };
  try {
    let query = supabase
      .from("messages")
      .select("id, created_at, role, content, metadata")
      .eq("channel", "phone")
      .order("created_at", { ascending: false })
      .limit(20);
    if (userId) query = query.eq("user_id", userId);
    const { data, error } = await query;
    if (error) return { calls: [], error: error.message };
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
  if (!supabase) return { error: "Supabase not configured" };
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const selectFields = "provider, model, cost_usd, input_tokens, output_tokens, created_at";
    let dailyQ = supabase.from("cost_tracking").select(selectFields).gte("created_at", todayStart).order("created_at", { ascending: true });
    let monthlyQ = supabase.from("cost_tracking").select(selectFields).gte("created_at", monthStart).order("created_at", { ascending: true });
    let lifetimeQ = supabase.from("cost_tracking").select(selectFields).order("created_at", { ascending: true });
    if (userId) {
      dailyQ = dailyQ.eq("user_id", userId);
      monthlyQ = monthlyQ.eq("user_id", userId);
      lifetimeQ = lifetimeQ.eq("user_id", userId);
    }

    const { data: dailyData } = await dailyQ;
    const { data: monthlyData } = await monthlyQ;
    const { data: lifetimeData } = await lifetimeQ;

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
  if (!supabase) return { error: "Supabase not configured" };
  try {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    // Get all users
    const { data: users } = await supabase
      .from("users")
      .select("id, name, role, active")
      .order("created_at");

    if (!users || !users.length) return { users: [] };

    // Fetch messages and costs in parallel
    const [
      { data: dayMsgs },
      { data: weekMsgs },
      { data: monthCosts },
    ] = await Promise.all([
      supabase.from("messages").select("user_id").gte("created_at", oneDayAgo),
      supabase.from("messages").select("user_id").gte("created_at", oneWeekAgo),
      supabase.from("cost_tracking").select("user_id, provider, cost_usd").gte("created_at", monthStart),
    ]);

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
  if (!supabase) return { tasks: [], error: "Supabase not configured" };
  try {
    let query = supabase
      .from("agent_tasks")
      .select("id, created_at, updated_at, agent, description, status, result, metadata")
      .order("updated_at", { ascending: false })
      .limit(30);
    if (userId) query = query.eq("user_id", userId);
    const { data, error } = await query;
    if (error) return { tasks: [], error: error.message };
    return { tasks: data || [] };
  } catch (e: any) {
    return { tasks: [], error: e.message };
  }
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
<title>NOVA COMMAND CENTER</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --green: #00ff41;
    --green-dim: #00cc33;
    --green-glow: #00ff4180;
    --amber: #ffb000;
    --amber-dim: #cc8800;
    --red: #ff3333;
    --cyan: #00e5ff;
    --bg: #0a0a0a;
    --panel: #111111;
    --panel-header: #1a1a1a;
    --border: #222;
    --dim: #555;
    --text: #ccc;
  }

  body {
    font-family: 'JetBrains Mono', 'Fira Code', 'Courier New', monospace;
    background: var(--bg);
    color: var(--text);
    font-size: 13px;
    line-height: 1.5;
    min-height: 100vh;
    overflow-x: hidden;
  }

  /* Scanline overlay */
  body::after {
    content: '';
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: repeating-linear-gradient(
      0deg,
      transparent,
      transparent 2px,
      rgba(0,0,0,0.08) 2px,
      rgba(0,0,0,0.08) 4px
    );
    pointer-events: none;
    z-index: 9999;
  }

  /* CRT flicker */
  @keyframes flicker {
    0% { opacity: 1; }
    3% { opacity: 0.97; }
    6% { opacity: 1; }
    7% { opacity: 0.95; }
    9% { opacity: 1; }
    100% { opacity: 1; }
  }
  body { animation: flicker 8s infinite; }

  @keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
  .blink { animation: blink 1.5s infinite; }

  @keyframes pulse-glow {
    0%,100% { text-shadow: 0 0 4px var(--green-glow); }
    50% { text-shadow: 0 0 12px var(--green-glow), 0 0 20px var(--green-glow); }
  }

  .container { max-width: 1600px; margin: 0 auto; padding: 12px; }

  /* Header */
  .header {
    text-align: center;
    padding: 16px;
    border: 1px solid var(--green-dim);
    background: var(--panel);
    margin-bottom: 12px;
    position: relative;
  }
  .header pre {
    color: var(--green);
    font-size: 10px;
    line-height: 1.2;
    text-shadow: 0 0 10px var(--green-glow);
    animation: pulse-glow 4s infinite;
  }
  .header-info {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 8px;
    color: var(--dim);
    font-size: 11px;
  }
  .header-info .live {
    color: var(--green);
    font-weight: 700;
  }

  /* Grid layout */
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .full-width { grid-column: 1 / -1; }

  /* Panels */
  .panel {
    background: var(--panel);
    border: 1px solid var(--border);
    overflow: hidden;
  }
  .panel-header {
    background: var(--panel-header);
    padding: 8px 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--border);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--green);
    font-weight: 700;
  }
  .panel-header .indicator {
    font-size: 10px;
    color: var(--dim);
  }
  .panel-body {
    padding: 12px;
    max-height: 350px;
    overflow-y: auto;
  }
  .panel-body::-webkit-scrollbar { width: 4px; }
  .panel-body::-webkit-scrollbar-track { background: var(--bg); }
  .panel-body::-webkit-scrollbar-thumb { background: var(--border); }

  /* Service cards */
  .service-card {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px;
    border: 1px solid var(--border);
    margin-bottom: 6px;
    background: var(--bg);
  }
  .status-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .status-dot.running { background: var(--green); box-shadow: 0 0 6px var(--green); }
  .status-dot.error { background: var(--red); box-shadow: 0 0 6px var(--red); }
  .status-dot.idle { background: var(--amber); box-shadow: 0 0 6px var(--amber); }
  .status-dot.not_installed, .status-dot.unknown { background: var(--dim); }
  .service-name { flex: 1; color: var(--text); }
  .service-meta { font-size: 10px; color: var(--dim); }

  /* Messages / Activity feed */
  .msg-entry {
    padding: 6px 0;
    border-bottom: 1px solid #1a1a1a;
    font-size: 12px;
  }
  .msg-entry:last-child { border-bottom: none; }
  .msg-role {
    display: inline-block;
    padding: 1px 6px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-right: 6px;
  }
  .msg-role.user { color: var(--bg); background: var(--cyan); }
  .msg-role.assistant { color: var(--bg); background: var(--green); }
  .msg-role.system { color: var(--bg); background: var(--amber); }
  .msg-channel {
    font-size: 10px;
    color: var(--dim);
    margin-left: 4px;
  }
  .msg-time {
    font-size: 10px;
    color: var(--dim);
    float: right;
  }
  .msg-content {
    color: var(--text);
    margin-top: 2px;
    word-break: break-word;
    max-height: 60px;
    overflow: hidden;
  }

  /* Memory entries */
  .mem-entry {
    padding: 6px 0;
    border-bottom: 1px solid #1a1a1a;
    font-size: 12px;
  }
  .mem-type {
    display: inline-block;
    padding: 1px 6px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    margin-right: 6px;
  }
  .mem-type.fact { color: var(--bg); background: var(--cyan); }
  .mem-type.goal { color: var(--bg); background: var(--amber); }
  .mem-type.completed_goal { color: var(--bg); background: var(--green); }
  .mem-type.preference { color: var(--bg); background: #a855f7; }

  /* Tabs */
  .tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--border);
    margin-bottom: 8px;
  }
  .tab {
    padding: 4px 12px;
    cursor: pointer;
    font-size: 11px;
    color: var(--dim);
    border: 1px solid transparent;
    border-bottom: none;
    background: none;
    font-family: inherit;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .tab:hover { color: var(--text); }
  .tab.active {
    color: var(--green);
    border-color: var(--border);
    background: var(--panel);
    border-bottom-color: var(--panel);
    margin-bottom: -1px;
  }

  /* Metrics */
  .metric-row {
    display: flex;
    justify-content: space-between;
    padding: 4px 0;
    border-bottom: 1px solid #1a1a1a;
  }
  .metric-label { color: var(--dim); }
  .metric-value { color: var(--green); font-weight: 700; }

  .bar-chart {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 60px;
    margin-top: 12px;
    padding-top: 4px;
  }
  .bar {
    flex: 1;
    background: var(--green-dim);
    min-height: 1px;
    position: relative;
    opacity: 0.7;
    transition: opacity 0.2s;
  }
  .bar:hover { opacity: 1; }
  .bar-label {
    position: absolute;
    bottom: -16px;
    left: 50%;
    transform: translateX(-50%);
    font-size: 8px;
    color: var(--dim);
    white-space: nowrap;
  }

  /* Log viewer */
  .log-content {
    font-size: 11px;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-all;
    color: var(--dim);
    max-height: 300px;
    overflow-y: auto;
  }
  .log-content::-webkit-scrollbar { width: 4px; }
  .log-content::-webkit-scrollbar-track { background: var(--bg); }
  .log-content::-webkit-scrollbar-thumb { background: var(--border); }
  .log-file-name {
    color: var(--amber);
    font-size: 11px;
    margin: 8px 0 4px;
    padding: 4px 0;
    border-bottom: 1px solid var(--border);
  }
  .log-file-name:first-child { margin-top: 0; }

  /* Resource bars */
  .resource-bar-container {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }
  .resource-label { width: 80px; font-size: 11px; color: var(--dim); }
  .resource-bar {
    flex: 1;
    height: 12px;
    background: var(--bg);
    border: 1px solid var(--border);
    overflow: hidden;
  }
  .resource-bar-fill {
    height: 100%;
    background: var(--green-dim);
    transition: width 0.5s;
  }
  .resource-value { width: 80px; font-size: 11px; color: var(--green); text-align: right; }

  /* Task / skill tables */
  .data-table {
    width: 100%;
    font-size: 12px;
    border-collapse: collapse;
  }
  .data-table th {
    text-align: left;
    color: var(--dim);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--border);
  }
  .data-table td {
    padding: 6px 8px;
    border-bottom: 1px solid #1a1a1a;
  }

  /* Select / filter controls */
  .filter-row {
    display: flex;
    gap: 8px;
    margin-bottom: 8px;
  }
  select, input[type="text"] {
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    padding: 4px 8px;
    font-family: inherit;
    font-size: 11px;
  }
  select:focus, input[type="text"]:focus { outline: none; border-color: var(--green-dim); }

  /* Cost charts */
  .cost-summary {
    display: flex;
    gap: 16px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }
  .cost-card {
    flex: 1;
    min-width: 180px;
    background: var(--bg);
    border: 1px solid var(--border);
    padding: 12px;
    text-align: center;
  }
  .cost-card-label {
    font-size: 10px;
    color: var(--dim);
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-bottom: 4px;
  }
  .cost-card-value {
    font-size: 22px;
    font-weight: 700;
    color: var(--green);
  }
  .cost-card-value.amber { color: var(--amber); }
  .cost-card-value.cyan { color: var(--cyan); }

  .cost-section {
    margin-bottom: 20px;
  }
  .cost-section-title {
    font-size: 11px;
    color: var(--amber);
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-bottom: 8px;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--border);
  }
  .cost-chart-container {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
  }
  .cost-chart-block {
    flex: 1;
    min-width: 280px;
  }

  .stacked-bar-chart {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 80px;
    margin-top: 8px;
    padding-top: 4px;
    position: relative;
  }
  .stacked-bar {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    min-height: 1px;
    position: relative;
  }
  .stacked-bar-segment {
    width: 100%;
    min-height: 0;
    transition: height 0.3s;
    opacity: 0.8;
  }
  .stacked-bar-segment:hover { opacity: 1; }
  .stacked-bar .bar-label {
    position: absolute;
    bottom: -16px;
    left: 50%;
    transform: translateX(-50%);
    font-size: 8px;
    color: var(--dim);
    white-space: nowrap;
  }

  .cost-legend {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    margin-top: 20px;
    font-size: 11px;
  }
  .cost-legend-item {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .cost-legend-dot {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    flex-shrink: 0;
  }

  .cost-model-table {
    width: 100%;
    font-size: 12px;
    border-collapse: collapse;
    margin-top: 8px;
  }
  .cost-model-table th {
    text-align: left;
    color: var(--dim);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--border);
  }
  .cost-model-table td {
    padding: 5px 8px;
    border-bottom: 1px solid #1a1a1a;
  }
  .cost-model-table td.cost-val {
    color: var(--green);
    font-weight: 700;
    text-align: right;
  }

  /* Responsive */
  @media (max-width: 900px) {
    .grid { grid-template-columns: 1fr; }
    .header pre { font-size: 7px; }
  }
</style>
</head>
<body>
<div class="container">

  <!-- HEADER -->
  <div class="header">
    <pre>
 ███╗   ██╗ ██████╗ ██╗   ██╗ █████╗      ██████╗ ██████╗ ███╗   ███╗███╗   ███╗ █████╗ ███╗   ██╗██████╗
 ████╗  ██║██╔═══██╗██║   ██║██╔══██╗    ██╔════╝██╔═══██╗████╗ ████║████╗ ████║██╔══██╗████╗  ██║██╔══██╗
 ██╔██╗ ██║██║   ██║██║   ██║███████║    ██║     ██║   ██║██╔████╔██║██╔████╔██║███████║██╔██╗ ██║██║  ██║
 ██║╚██╗██║██║   ██║╚██╗ ██╔╝██╔══██║    ██║     ██║   ██║██║╚██╔╝██║██║╚██╔╝██║██╔══██║██║╚██╗██║██║  ██║
 ██║ ╚████║╚██████╔╝ ╚████╔╝ ██║  ██║    ╚██████╗╚██████╔╝██║ ╚═╝ ██║██║ ╚═╝ ██║██║  ██║██║ ╚████║██████╔╝
 ╚═╝  ╚═══╝ ╚═════╝   ╚═══╝  ╚═╝  ╚═╝     ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═════╝
    </pre>
    <div class="header-info">
      <span><span class="live blink">● LIVE</span> &nbsp;COMMAND CENTER v1.0</span>
      <span id="header-time"></span>
      <span>UPTIME: <span id="header-uptime">--</span></span>
    </div>
  </div>

  <!-- USER SELECTOR -->
  <div style="margin-bottom:12px;display:flex;align-items:center;gap:12px;">
    <label style="color:var(--green);font-size:11px;text-transform:uppercase;letter-spacing:1px;">User Filter:</label>
    <select id="user-selector" style="min-width:200px;">
      <option value="">All Users (Admin View)</option>
    </select>
  </div>

  <div class="grid">

    <!-- SYSTEM STATUS -->
    <div class="panel">
      <div class="panel-header">
        <span>System Status</span>
        <span class="indicator"><span class="blink" style="color:var(--green)">●</span> 10s</span>
      </div>
      <div class="panel-body" id="status-panel">
        <div style="color:var(--dim)">Loading...</div>
      </div>
    </div>

    <!-- PERFORMANCE METRICS -->
    <div class="panel">
      <div class="panel-header">
        <span>Performance Metrics</span>
        <span class="indicator">30s</span>
      </div>
      <div class="panel-body" id="metrics-panel">
        <div style="color:var(--dim)">Loading...</div>
      </div>
    </div>

    <!-- API COSTS -->
    <div class="panel full-width">
      <div class="panel-header">
        <span>API Costs</span>
        <span class="indicator">30s</span>
      </div>
      <div class="panel-body" id="costs-panel" style="max-height:500px">
        <div style="color:var(--dim)">Loading...</div>
      </div>
    </div>

    <!-- USAGE BY USER -->
    <div class="panel full-width">
      <div class="panel-header">
        <span>Usage by User</span>
        <span class="indicator">30s</span>
      </div>
      <div class="panel-body" id="usage-by-user-panel" style="max-height:400px">
        <div style="color:var(--dim)">Loading...</div>
      </div>
    </div>

    <!-- ACTIVITY FEED -->
    <div class="panel">
      <div class="panel-header">
        <span>Activity Feed</span>
        <span class="indicator"><span class="blink" style="color:var(--green)">●</span> 15s</span>
      </div>
      <div class="panel-body" id="messages-panel" style="max-height:400px">
        <div style="color:var(--dim)">Loading...</div>
      </div>
    </div>

    <!-- MEMORY BANK -->
    <div class="panel">
      <div class="panel-header">
        <span>Memory Bank</span>
        <span class="indicator">30s</span>
      </div>
      <div class="panel-body" id="memory-panel">
        <div style="color:var(--dim)">Loading...</div>
      </div>
    </div>

    <!-- SCHEDULED TASKS -->
    <div class="panel">
      <div class="panel-header">
        <span>Scheduled Tasks</span>
        <span class="indicator">30s</span>
      </div>
      <div class="panel-body" id="tasks-panel">
        <div style="color:var(--dim)">Loading...</div>
      </div>
    </div>

    <!-- SKILLS & INTEGRATIONS -->
    <div class="panel">
      <div class="panel-header">
        <span>Skills &amp; Integrations</span>
        <span class="indicator">60s</span>
      </div>
      <div class="panel-body" id="skills-panel">
        <div style="color:var(--dim)">Loading...</div>
      </div>
    </div>

    <!-- VOICE CALLS -->
    <div class="panel">
      <div class="panel-header">
        <span>Voice Calls</span>
        <span class="indicator">30s</span>
      </div>
      <div class="panel-body" id="voice-panel">
        <div style="color:var(--dim)">Loading...</div>
      </div>
    </div>

    <!-- AGENT TASKS -->
    <div class="panel full-width">
      <div class="panel-header">
        <span>Agent Tasks</span>
        <span class="indicator"><span class="blink" style="color:var(--green)">●</span> 15s</span>
      </div>
      <div class="panel-body" id="agent-tasks-panel" style="max-height:400px">
        <div style="color:var(--dim)">Loading...</div>
      </div>
    </div>

    <!-- SYSTEM RESOURCES -->
    <div class="panel">
      <div class="panel-header">
        <span>System Resources</span>
        <span class="indicator">20s</span>
      </div>
      <div class="panel-body" id="resources-panel">
        <div style="color:var(--dim)">Loading...</div>
      </div>
    </div>

    <!-- LOG VIEWER -->
    <div class="panel full-width">
      <div class="panel-header">
        <span>Log Viewer</span>
        <span class="indicator"><span class="blink" style="color:var(--green)">●</span> 10s</span>
      </div>
      <div class="panel-body" id="logs-panel" style="max-height:400px">
        <div class="filter-row">
          <select id="log-service">
            <option value="all">All Services</option>
            <option value="relay">Relay</option>
            <option value="voice-server">Voice Server</option>
            <option value="smart-checkin">Smart Check-in</option>
            <option value="morning-briefing">Morning Briefing</option>
          </select>
        </div>
        <div id="logs-content" style="color:var(--dim)">Loading...</div>
      </div>
    </div>

  </div>
</div>

<script>
const BASE = '${DASHBOARD_BASE}';
const $ = (id) => document.getElementById(id);
const esc = (s) => {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
};

function timeAgo(ts) {
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return d + 'd ' + h + 'h ' + m + 'm';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm ' + (sec % 60) + 's';
}

// Update clock
setInterval(() => {
  const now = new Date();
  $('header-time').textContent = now.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}, 1000);

// ---- STATUS ----
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
        + '<span class="service-meta">'
        + (s.pid ? 'PID ' + s.pid : s.status.replace('_', ' '))
        + '</span></div>';
    }
    $('status-panel').innerHTML = html || '<div style="color:var(--dim)">No services found</div>';
  } catch(e) { $('status-panel').innerHTML = '<div style="color:var(--red)">Error: ' + esc(e.message) + '</div>'; }
}

// ---- METRICS ----
async function loadMetrics() {
  try {
    const r = await fetch(BASE + '/api/metrics' + (selectedUserId ? '?user_id=' + selectedUserId : ''));
    const d = await r.json();
    if (d.error) { $('metrics-panel').innerHTML = '<div style="color:var(--dim)">' + esc(d.error) + '</div>'; return; }

    let html = '<div class="metric-row"><span class="metric-label">Messages (24h)</span><span class="metric-value">' + d.today + '</span></div>';
    html += '<div class="metric-row"><span class="metric-label">Messages (7d)</span><span class="metric-value">' + d.thisWeek + '</span></div>';

    // Channel breakdown
    for (const [ch, count] of Object.entries(d.byChannel || {})) {
      html += '<div class="metric-row"><span class="metric-label">  ' + esc(ch) + '</span><span class="metric-value">' + count + '</span></div>';
    }

    // Role breakdown
    for (const [role, count] of Object.entries(d.byRole || {})) {
      html += '<div class="metric-row"><span class="metric-label">  ' + esc(role) + '</span><span class="metric-value">' + count + '</span></div>';
    }

    // Hourly chart
    const hourly = d.hourly || {};
    const maxVal = Math.max(1, ...Object.values(hourly));
    html += '<div class="bar-chart">';
    for (let i = 0; i < 24; i++) {
      const v = hourly[i] || 0;
      const pct = (v / maxVal) * 100;
      html += '<div class="bar" style="height:' + Math.max(1, pct) + '%" title="' + i + ':00 — ' + v + ' msgs">'
        + (i % 4 === 0 ? '<span class="bar-label">' + i + '</span>' : '')
        + '</div>';
    }
    html += '</div>';

    $('metrics-panel').innerHTML = html;
  } catch(e) { $('metrics-panel').innerHTML = '<div style="color:var(--red)">Error: ' + esc(e.message) + '</div>'; }
}

// ---- MESSAGES ----
async function loadMessages() {
  try {
    const r = await fetch(BASE + '/api/messages?limit=50' + userParam());
    const d = await r.json();
    if (!d.messages.length) { $('messages-panel').innerHTML = '<div style="color:var(--dim)">No messages yet</div>'; return; }

    let html = '';
    for (const m of d.messages) {
      html += '<div class="msg-entry">'
        + '<span class="msg-time">' + timeAgo(m.created_at) + '</span>'
        + '<span class="msg-role ' + m.role + '">' + esc(m.role) + '</span>'
        + '<span class="msg-channel">' + esc(m.channel || '') + '</span>'
        + '<div class="msg-content">' + esc((m.content || '').substring(0, 200)) + '</div>'
        + '</div>';
    }
    $('messages-panel').innerHTML = html;
  } catch(e) { $('messages-panel').innerHTML = '<div style="color:var(--red)">Error: ' + esc(e.message) + '</div>'; }
}

// ---- MEMORY ----
let memoryType = 'all';
async function loadMemory() {
  try {
    const r = await fetch(BASE + '/api/memory?type=' + memoryType + userParam());
    const d = await r.json();

    let html = '<div class="tabs">';
    for (const t of ['all','fact','goal','completed_goal','preference']) {
      html += '<button class="tab' + (memoryType === t ? ' active' : '') + '" onclick="memoryType=\\'' + t + '\\';loadMemory()">' + t.replace('_',' ') + '</button>';
    }
    html += '</div>';

    if (!d.memory.length) {
      html += '<div style="color:var(--dim)">No entries</div>';
    } else {
      for (const m of d.memory) {
        html += '<div class="mem-entry">'
          + '<span class="mem-type ' + m.type + '">' + esc(m.type) + '</span>'
          + '<span style="color:var(--dim);font-size:10px">' + timeAgo(m.created_at) + '</span>'
          + (m.deadline ? '<span style="color:var(--amber);font-size:10px;margin-left:8px">deadline: ' + new Date(m.deadline).toLocaleDateString() + '</span>' : '')
          + '<div style="margin-top:2px">' + esc((m.content || '').substring(0, 200)) + '</div>'
          + '</div>';
      }
    }
    $('memory-panel').innerHTML = html;
  } catch(e) { $('memory-panel').innerHTML = '<div style="color:var(--red)">Error: ' + esc(e.message) + '</div>'; }
}

// ---- TASKS ----
async function loadTasks() {
  try {
    const r = await fetch(BASE + '/api/tasks');
    const d = await r.json();
    if (!d.tasks.length) { $('tasks-panel').innerHTML = '<div style="color:var(--dim)">No scheduled tasks</div>'; return; }

    let html = '<table class="data-table"><tr><th>Service</th><th>Schedule</th><th>Status</th></tr>';
    for (const t of d.tasks) {
      const statusColor = t.installed ? 'var(--green)' : 'var(--dim)';
      html += '<tr><td>' + esc(t.label) + '</td><td>' + esc(t.schedule) + '</td><td style="color:' + statusColor + '">' + (t.installed ? 'INSTALLED' : 'NOT FOUND') + '</td></tr>';
    }
    html += '</table>';
    $('tasks-panel').innerHTML = html;
  } catch(e) { $('tasks-panel').innerHTML = '<div style="color:var(--red)">Error: ' + esc(e.message) + '</div>'; }
}

// ---- VOICE ----
async function loadVoice() {
  try {
    const r = await fetch(BASE + '/api/voice' + (selectedUserId ? '?user_id=' + selectedUserId : ''));
    const d = await r.json();
    if (!d.calls || !d.calls.length) { $('voice-panel').innerHTML = '<div style="color:var(--dim)">No recent voice activity</div>'; return; }

    let html = '';
    for (const c of d.calls) {
      html += '<div class="msg-entry">'
        + '<span class="msg-time">' + timeAgo(c.created_at) + '</span>'
        + '<span class="msg-role ' + c.role + '">' + esc(c.role) + '</span>'
        + '<div class="msg-content">' + esc((c.content || '').substring(0, 150)) + '</div>'
        + '</div>';
    }
    $('voice-panel').innerHTML = html;
  } catch(e) { $('voice-panel').innerHTML = '<div style="color:var(--red)">Error: ' + esc(e.message) + '</div>'; }
}

// ---- SKILLS ----
async function loadSkills() {
  try {
    const r = await fetch(BASE + '/api/skills');
    const d = await r.json();

    let html = '';
    if (d.mcp && d.mcp.length) {
      html += '<div style="color:var(--amber);font-size:11px;margin-bottom:6px;text-transform:uppercase;letter-spacing:1px">MCP Integrations</div>';
      html += '<table class="data-table"><tr><th>Name</th><th>Type</th></tr>';
      for (const m of d.mcp) {
        html += '<tr><td style="color:var(--cyan)">' + esc(m.name) + '</td><td>' + esc(m.type) + '</td></tr>';
      }
      html += '</table>';
    }

    if (d.skills && d.skills.length) {
      html += '<div style="color:var(--amber);font-size:11px;margin:12px 0 6px;text-transform:uppercase;letter-spacing:1px">Skills</div>';
      html += '<table class="data-table"><tr><th>Name</th><th>Description</th></tr>';
      for (const s of d.skills) {
        html += '<tr><td style="color:var(--green)">' + esc(s.name) + '</td><td>' + esc(s.description) + '</td></tr>';
      }
      html += '</table>';
    }

    if (!html) html = '<div style="color:var(--dim)">No skills or integrations found</div>';
    $('skills-panel').innerHTML = html;
  } catch(e) { $('skills-panel').innerHTML = '<div style="color:var(--red)">Error: ' + esc(e.message) + '</div>'; }
}

// ---- AGENT TASKS ----
let agentTaskFilter = 'all';
async function loadAgentTasks() {
  try {
    const r = await fetch(BASE + '/api/agent-tasks' + (selectedUserId ? '?user_id=' + selectedUserId : ''));
    const d = await r.json();

    let html = '<div class="tabs">';
    for (const t of ['all','pending','in_progress','done','blocked','cancelled']) {
      const label = t === 'in_progress' ? 'active' : t;
      html += '<button class="tab' + (agentTaskFilter === t ? ' active' : '') + '" onclick="agentTaskFilter=\\'' + t + '\\';loadAgentTasks()">' + label + '</button>';
    }
    html += '</div>';

    const tasks = (d.tasks || []).filter(function(t) {
      return agentTaskFilter === 'all' || t.status === agentTaskFilter;
    });

    if (!tasks.length) {
      html += '<div style="color:var(--dim)">No ' + (agentTaskFilter === 'all' ? '' : agentTaskFilter + ' ') + 'tasks</div>';
    } else {
      html += '<table class="data-table"><tr><th>Agent</th><th>Task</th><th>Status</th><th>Result</th><th>Updated</th></tr>';
      for (const t of tasks) {
        const statusColors = { in_progress: 'var(--green)', blocked: 'var(--amber)', done: 'var(--cyan)', pending: 'var(--dim)', cancelled: 'var(--dim)' };
        const color = statusColors[t.status] || 'var(--dim)';
        html += '<tr>'
          + '<td style="color:var(--cyan)">' + esc(t.agent) + '</td>'
          + '<td>' + esc((t.description || '').substring(0, 80)) + '</td>'
          + '<td style="color:' + color + ';font-weight:700;text-transform:uppercase;font-size:10px">' + esc(t.status) + '</td>'
          + '<td style="color:var(--dim);font-size:11px">' + esc((t.result || '—').substring(0, 60)) + '</td>'
          + '<td style="color:var(--dim);font-size:10px;white-space:nowrap">' + timeAgo(t.updated_at) + '</td>'
          + '</tr>';
      }
      html += '</table>';
    }

    $('agent-tasks-panel').innerHTML = html;
  } catch(e) { $('agent-tasks-panel').innerHTML = '<div style="color:var(--red)">Error: ' + esc(e.message) + '</div>'; }
}

// ---- RESOURCES ----
async function loadResources() {
  try {
    const r = await fetch(BASE + '/api/resources');
    const d = await r.json();

    const maxDisk = Math.max(1, d.disk.uploads.size, d.disk.temp.size, d.disk.logs.size);

    let html = '';
    for (const [label, info] of [['uploads', d.disk.uploads], ['temp', d.disk.temp], ['logs', d.disk.logs]]) {
      const pct = Math.min(100, (info.size / Math.max(maxDisk, 1)) * 100);
      html += '<div class="resource-bar-container">'
        + '<span class="resource-label">' + label + '</span>'
        + '<div class="resource-bar"><div class="resource-bar-fill" style="width:' + pct + '%"></div></div>'
        + '<span class="resource-value">' + info.formatted + '</span>'
        + '</div>';
    }

    if (d.processes && d.processes.length) {
      html += '<div style="color:var(--amber);font-size:11px;margin:12px 0 6px;text-transform:uppercase;letter-spacing:1px">Processes</div>';
      html += '<table class="data-table"><tr><th>Service</th><th>PID</th><th>CPU</th><th>MEM</th></tr>';
      for (const p of d.processes) {
        html += '<tr><td>' + esc(p.name) + '</td><td>' + p.pid + '</td><td>' + esc(p.cpu) + '</td><td>' + esc(p.mem) + '</td></tr>';
      }
      html += '</table>';
    }

    $('resources-panel').innerHTML = html;
  } catch(e) { $('resources-panel').innerHTML = '<div style="color:var(--red)">Error: ' + esc(e.message) + '</div>'; }
}

// ---- LOGS ----
async function loadLogs() {
  try {
    const service = $('log-service').value;
    const r = await fetch(BASE + '/api/logs?service=' + service + '&lines=80');
    const d = await r.json();

    if (!d.logs.length) { $('logs-content').innerHTML = '<div style="color:var(--dim)">No log files found</div>'; return; }

    let html = '';
    for (const f of d.logs) {
      html += '<div class="log-file-name">// ' + esc(f.name) + '</div>';
      html += '<div class="log-content">' + esc(f.content || '(empty)') + '</div>';
    }
    $('logs-content').innerHTML = html;
  } catch(e) { $('logs-content').innerHTML = '<div style="color:var(--red)">Error: ' + esc(e.message) + '</div>'; }
}

$('log-service').addEventListener('change', loadLogs);

// ---- COSTS ----
const PROVIDER_COLORS = {
  claude: '#00ff41', openai: '#00e5ff', groq: '#ffb000', elevenlabs: '#a855f7',
  ultravox: '#ff3333', fal: '#ff6b9d', heygen: '#00ccff'
};
const FALLBACK_COLORS = ['#66ff66','#ff9933','#33cccc','#cc66ff','#ff6666','#66ccff','#ffcc00'];
function getProviderColor(name) { return PROVIDER_COLORS[name] || FALLBACK_COLORS[Object.keys(PROVIDER_COLORS).length % FALLBACK_COLORS.length]; }
function getSeriesColor(idx) {
  const all = Object.values(PROVIDER_COLORS).concat(FALLBACK_COLORS);
  return all[idx % all.length];
}

function renderProviderTable(byProvider) {
  const providers = Object.entries(byProvider || {}).sort(function(a,b) { return b[1].cost - a[1].cost; });
  if (!providers.length) return '<div style="color:var(--dim);font-size:11px">No data</div>';
  let html = '<table class="cost-model-table"><tr><th>Provider</th><th>Calls</th><th style="text-align:right">Input Tok</th><th style="text-align:right">Output Tok</th><th style="text-align:right">Cost</th></tr>';
  for (const [provider, d] of providers) {
    const color = getProviderColor(provider);
    html += '<tr>'
      + '<td style="color:' + color + ';font-weight:700;text-transform:uppercase">' + esc(provider) + '</td>'
      + '<td>' + d.count + '</td>'
      + '<td style="text-align:right">' + (d.input_tokens || 0).toLocaleString() + '</td>'
      + '<td style="text-align:right">' + (d.output_tokens || 0).toLocaleString() + '</td>'
      + '<td class="cost-val">$' + d.cost.toFixed(4) + '</td>'
      + '</tr>';
  }
  html += '</table>';
  return html;
}

function renderModelTable(byModel) {
  const models = Object.entries(byModel || {}).sort(function(a,b) { return b[1].cost - a[1].cost; });
  if (!models.length) return '<div style="color:var(--dim);font-size:11px">No data</div>';
  let html = '<table class="cost-model-table"><tr><th>Model</th><th>Calls</th><th style="text-align:right">Input Tok</th><th style="text-align:right">Output Tok</th><th style="text-align:right">Cost</th></tr>';
  for (const [model, d] of models) {
    const shortName = model.replace(/^claude-/, '').replace(/-\\d{8}$/, '');
    html += '<tr>'
      + '<td style="color:var(--cyan)">' + esc(shortName) + '</td>'
      + '<td>' + d.count + '</td>'
      + '<td style="text-align:right">' + (d.input_tokens || 0).toLocaleString() + '</td>'
      + '<td style="text-align:right">' + (d.output_tokens || 0).toLocaleString() + '</td>'
      + '<td class="cost-val">$' + d.cost.toFixed(4) + '</td>'
      + '</tr>';
  }
  html += '</table>';
  return html;
}

function renderStackedChart(chartData, labelFn, maxBuckets) {
  const series = Object.keys(chartData || {});
  if (!series.length) return '<div style="color:var(--dim);font-size:11px">No chart data</div>';
  const allKeys = new Set();
  for (const s of series) for (const k of Object.keys(chartData[s])) allKeys.add(k);
  let buckets = Array.from(allKeys).sort();
  if (maxBuckets && buckets.length > maxBuckets) buckets = buckets.slice(-maxBuckets);
  let maxVal = 0;
  for (const b of buckets) {
    let sum = 0;
    for (const s of series) sum += (chartData[s][b] || 0);
    if (sum > maxVal) maxVal = sum;
  }
  if (maxVal === 0) maxVal = 1;

  let html = '<div class="stacked-bar-chart">';
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    let total = 0;
    for (const s of series) total += (chartData[s][b] || 0);
    html += '<div class="stacked-bar" style="height:100%" title="' + labelFn(b) + ': $' + total.toFixed(4) + '">';
    for (let si = 0; si < series.length; si++) {
      const val = chartData[series[si]][b] || 0;
      const pct = (val / maxVal) * 100;
      const color = getProviderColor(series[si]) || getSeriesColor(si);
      if (pct > 0) {
        html += '<div class="stacked-bar-segment" style="height:' + pct + '%;background:' + color + '" title="' + series[si] + ': $' + val.toFixed(4) + '"></div>';
      }
    }
    const showLabel = buckets.length <= 12 || (i % Math.ceil(buckets.length / 12) === 0);
    if (showLabel) html += '<span class="bar-label">' + labelFn(b) + '</span>';
    html += '</div>';
  }
  html += '</div>';

  html += '<div class="cost-legend">';
  for (let si = 0; si < series.length; si++) {
    const color = getProviderColor(series[si]) || getSeriesColor(si);
    html += '<div class="cost-legend-item"><div class="cost-legend-dot" style="background:' + color + '"></div><span>' + esc(series[si]) + '</span></div>';
  }
  html += '</div>';
  return html;
}

async function loadCosts() {
  try {
    const r = await fetch(BASE + '/api/costs' + (selectedUserId ? '?user_id=' + selectedUserId : ''));
    const d = await r.json();
    if (d.error) { $('costs-panel').innerHTML = '<div style="color:var(--dim)">' + esc(d.error) + '</div>'; return; }

    // Summary cards — total + per provider
    let html = '<div class="cost-summary">';
    html += '<div class="cost-card"><div class="cost-card-label">Today</div><div class="cost-card-value">$' + (d.totalDaily || 0).toFixed(4) + '</div></div>';
    html += '<div class="cost-card"><div class="cost-card-label">This Month</div><div class="cost-card-value amber">$' + (d.totalMonthly || 0).toFixed(2) + '</div></div>';
    html += '<div class="cost-card"><div class="cost-card-label">Lifetime</div><div class="cost-card-value cyan">$' + (d.totalLifetime || 0).toFixed(2) + '</div></div>';
    html += '</div>';

    // Provider summary for the month
    if (d.monthly.byProvider && Object.keys(d.monthly.byProvider).length > 0) {
      html += '<div class="cost-summary" style="margin-top:8px">';
      const provEntries = Object.entries(d.monthly.byProvider).sort(function(a,b) { return b[1].cost - a[1].cost; });
      for (const [prov, pdata] of provEntries) {
        const color = getProviderColor(prov);
        html += '<div class="cost-card" style="border-color:' + color + '40"><div class="cost-card-label" style="color:' + color + '">' + esc(prov.toUpperCase()) + '</div><div class="cost-card-value" style="color:' + color + ';font-size:16px">$' + pdata.cost.toFixed(2) + '</div><div style="font-size:10px;color:var(--dim)">' + pdata.count + ' calls</div></div>';
      }
      html += '</div>';
    }

    // Today — hourly chart by provider + provider table + model table
    html += '<div class="cost-section">';
    html += '<div class="cost-section-title">Today — Hourly by Provider</div>';
    html += '<div class="cost-chart-container">';
    html += '<div class="cost-chart-block">';
    html += renderStackedChart(d.daily.hourlyChart, function(h) { return h + ':00'; }, 24);
    html += '</div>';
    html += '<div class="cost-chart-block">';
    html += renderProviderTable(d.daily.byProvider);
    html += '<div style="margin-top:12px;font-size:10px;color:var(--amber);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">By Model</div>';
    html += renderModelTable(d.daily.byModel);
    html += '</div>';
    html += '</div></div>';

    // This Month — daily chart by provider + tables
    html += '<div class="cost-section">';
    html += '<div class="cost-section-title">This Month — Daily by Provider</div>';
    html += '<div class="cost-chart-container">';
    html += '<div class="cost-chart-block">';
    html += renderStackedChart(d.monthly.dailyChart, function(day) { return 'Day ' + day; }, 31);
    html += '</div>';
    html += '<div class="cost-chart-block">';
    html += renderProviderTable(d.monthly.byProvider);
    html += '<div style="margin-top:12px;font-size:10px;color:var(--amber);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">By Model</div>';
    html += renderModelTable(d.monthly.byModel);
    html += '</div>';
    html += '</div></div>';

    // Lifetime — monthly chart by provider + tables
    html += '<div class="cost-section">';
    html += '<div class="cost-section-title">Lifetime — Monthly by Provider</div>';
    html += '<div class="cost-chart-container">';
    html += '<div class="cost-chart-block">';
    html += renderStackedChart(d.lifetime.monthlyChart, function(m) { return m; }, 24);
    html += '</div>';
    html += '<div class="cost-chart-block">';
    html += renderProviderTable(d.lifetime.byProvider);
    html += '<div style="margin-top:12px;font-size:10px;color:var(--amber);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">By Model</div>';
    html += renderModelTable(d.lifetime.byModel);
    html += '</div>';
    html += '</div></div>';

    $('costs-panel').innerHTML = html;
  } catch(e) { $('costs-panel').innerHTML = '<div style="color:var(--red)">Error: ' + esc(e.message) + '</div>'; }
}

// ---- USER SELECTOR ----
let selectedUserId = '';

async function loadUsers() {
  try {
    const r = await fetch(BASE + '/api/users');
    const d = await r.json();
    const sel = $('user-selector');
    // Keep the "All Users" option
    sel.innerHTML = '<option value="">All Users (Admin View)</option>';
    for (const u of (d.users || [])) {
      const status = u.active ? '' : ' (inactive)';
      sel.innerHTML += '<option value="' + u.id + '">' + esc(u.name) + ' — ' + esc(u.role) + status + '</option>';
    }
    sel.value = selectedUserId;
  } catch(e) { console.error('Users load error:', e); }
}

$('user-selector').addEventListener('change', function() {
  selectedUserId = this.value;
  // Reload all data with new filter
  loadMessages(); loadMemory(); loadMetrics(); loadVoice(); loadCosts(); loadAgentTasks();
});

function userParam() {
  return selectedUserId ? '&user_id=' + selectedUserId : '';
}

// ---- USAGE BY USER ----
async function loadUsageByUser() {
  try {
    const r = await fetch(BASE + '/api/usage-by-user');
    const d = await r.json();
    if (d.error) { $('usage-by-user-panel').innerHTML = '<div style="color:var(--dim)">' + esc(d.error) + '</div>'; return; }
    if (!d.users || !d.users.length) { $('usage-by-user-panel').innerHTML = '<div style="color:var(--dim)">No users found</div>'; return; }

    const providers = d.providers || [];

    let html = '<table class="data-table">';
    html += '<tr><th>User</th><th>Status</th><th style="text-align:right">Msgs 24h</th><th style="text-align:right">Msgs 7d</th>';
    // Dynamic provider columns
    for (const p of providers) {
      const color = getProviderColor(p);
      html += '<th style="text-align:right;color:' + color + '">' + esc(p.toUpperCase()) + '</th>';
    }
    html += '<th style="text-align:right">TOTAL</th></tr>';

    for (const u of d.users) {
      const statusColor = u.active ? 'var(--green)' : 'var(--dim)';
      const statusText = u.active ? 'ACTIVE' : 'INACTIVE';
      html += '<tr>'
        + '<td style="color:var(--cyan);font-weight:700">' + esc(u.name) + '</td>'
        + '<td style="color:' + statusColor + ';font-size:10px;font-weight:700">' + statusText + '</td>'
        + '<td style="text-align:right">' + u.msgs24h + '</td>'
        + '<td style="text-align:right">' + u.msgs7d + '</td>';
      for (const p of providers) {
        const cost = (u.byProvider && u.byProvider[p]) || 0;
        const color = getProviderColor(p);
        html += '<td style="text-align:right;color:' + color + ';font-weight:700">$' + cost.toFixed(2) + '</td>';
      }
      html += '<td class="cost-val">$' + (u.costMonth || 0).toFixed(2) + '</td>';
      html += '</tr>';
    }

    // Totals row
    if (d.totals) {
      const t = d.totals;
      html += '<tr style="border-top:2px solid var(--border)">'
        + '<td style="color:var(--amber);font-weight:700">TOTAL</td>'
        + '<td></td>'
        + '<td style="text-align:right;color:var(--amber);font-weight:700">' + t.msgs24h + '</td>'
        + '<td style="text-align:right;color:var(--amber);font-weight:700">' + t.msgs7d + '</td>';
      for (const p of providers) {
        const cost = (t.byProvider && t.byProvider[p]) || 0;
        const color = getProviderColor(p);
        html += '<td style="text-align:right;color:' + color + ';font-weight:700">$' + cost.toFixed(2) + '</td>';
      }
      html += '<td class="cost-val" style="color:var(--amber)">$' + (t.costMonth || 0).toFixed(2) + '</td>';
      html += '</tr>';
    }

    html += '</table>';
    html += '<div style="font-size:10px;color:var(--dim);margin-top:8px">Costs shown for current month</div>';
    $('usage-by-user-panel').innerHTML = html;
  } catch(e) { $('usage-by-user-panel').innerHTML = '<div style="color:var(--red)">Error: ' + esc(e.message) + '</div>'; }
}

// ---- INIT & INTERVALS ----
loadUsers();
loadStatus();  loadMetrics();  loadMessages();  loadMemory();
loadTasks();   loadVoice();    loadSkills();     loadResources();  loadLogs();
loadAgentTasks(); loadCosts(); loadUsageByUser();

setInterval(loadStatus, 10000);
setInterval(loadLogs, 10000);
setInterval(loadMessages, 15000);
setInterval(loadAgentTasks, 15000);
setInterval(loadResources, 20000);
setInterval(loadMetrics, 30000);
setInterval(loadMemory, 30000);
setInterval(loadTasks, 30000);
setInterval(loadVoice, 30000);
setInterval(loadCosts, 30000);
setInterval(loadUsageByUser, 30000);
setInterval(loadSkills, 60000);
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
    if (!isAuthenticated(req)) {
      return loginPage();
    }

    // Dashboard HTML
    if (path === "/") {
      return new Response(renderDashboard(), {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'",
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
