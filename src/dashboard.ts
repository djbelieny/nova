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
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
const LOGS_DIR = join(PROJECT_ROOT, "logs");

// Supabase (optional)
const supabase: SupabaseClient | null =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

const startTime = Date.now();

// ============================================================
// HELPERS
// ============================================================

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
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
  const services = [
    { name: "telegram-relay", label: "Telegram Relay" },
    { name: "voice-server", label: "Voice Server" },
    { name: "smart-checkin", label: "Smart Check-in" },
    { name: "morning-briefing", label: "Morning Briefing" },
    { name: "dashboard", label: "Dashboard" },
  ];

  const results = [];
  for (const svc of services) {
    const id = `com.claude.${svc.name}`;
    try {
      const proc = Bun.spawn(["launchctl", "list", id], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      if (exitCode === 0) {
        const pidMatch = out.match(/"PID"\s*=\s*(\d+)/);
        const statusMatch = out.match(/"LastExitStatus"\s*=\s*(\d+)/);
        const pid = pidMatch ? parseInt(pidMatch[1]) : null;
        const lastExit = statusMatch ? parseInt(statusMatch[1]) : 0;

        results.push({
          name: svc.name,
          label: svc.label,
          status: pid ? "running" : lastExit === 0 ? "idle" : "error",
          pid,
          lastExitCode: lastExit,
        });
      } else {
        results.push({ name: svc.name, label: svc.label, status: "not_installed", pid: null, lastExitCode: null });
      }
    } catch {
      results.push({ name: svc.name, label: svc.label, status: "unknown", pid: null, lastExitCode: null });
    }
  }

  return { services: results, uptime: Math.floor((Date.now() - startTime) / 1000) };
}

async function getMessages(limit: number): Promise<unknown> {
  if (!supabase) return { messages: [], error: "Supabase not configured" };
  try {
    const { data, error } = await supabase
      .from("messages")
      .select("id, created_at, role, content, channel, metadata")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) return { messages: [], error: error.message };
    return { messages: data || [] };
  } catch (e: any) {
    return { messages: [], error: e.message };
  }
}

async function getMemory(type: string): Promise<unknown> {
  if (!supabase) return { memory: [], error: "Supabase not configured" };
  try {
    let query = supabase
      .from("memory")
      .select("id, created_at, type, content, deadline, completed_at, priority")
      .order("created_at", { ascending: false })
      .limit(100);
    if (type !== "all") {
      query = query.eq("type", type);
    }
    const { data, error } = await query;
    if (error) return { memory: [], error: error.message };
    return { memory: data || [] };
  } catch (e: any) {
    return { memory: [], error: e.message };
  }
}

async function getMetrics(): Promise<unknown> {
  if (!supabase) return { error: "Supabase not configured" };
  try {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [dayResult, weekResult, channelResult] = await Promise.all([
      supabase.from("messages").select("id", { count: "exact", head: true }).gte("created_at", oneDayAgo),
      supabase.from("messages").select("id", { count: "exact", head: true }).gte("created_at", oneWeekAgo),
      supabase.from("messages").select("channel, role, created_at").gte("created_at", oneDayAgo),
    ]);

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
  const services = [
    { name: "smart-checkin", label: "Smart Check-in" },
    { name: "morning-briefing", label: "Morning Briefing" },
  ];

  const results = [];
  for (const svc of services) {
    const plistPath = join(process.env.HOME || "~", "Library", "LaunchAgents", `com.claude.${svc.name}.plist`);
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

  // Also check scheduler.ts tasks
  try {
    const proc = Bun.spawn(["bun", "run", join(PROJECT_ROOT, "src/scheduler.ts"), "list"], {
      stdout: "pipe", stderr: "pipe", cwd: PROJECT_ROOT,
    });
    const out = await new Response(proc.stdout).text();
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
      uploads: { path: uploadsDir, size: uploadsSize, formatted: formatBytes(uploadsSize) },
      temp: { path: tempDir, size: tempSize, formatted: formatBytes(tempSize) },
      logs: { path: LOGS_DIR, size: logsSize, formatted: formatBytes(logsSize) },
    },
    processes,
  };
}

async function getVoice(): Promise<unknown> {
  if (!supabase) return { calls: [], error: "Supabase not configured" };
  try {
    const { data, error } = await supabase
      .from("messages")
      .select("id, created_at, role, content, metadata")
      .eq("channel", "phone")
      .order("created_at", { ascending: false })
      .limit(20);
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
            <option value="telegram-relay">Telegram Relay</option>
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
    const r = await fetch('/api/status');
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
    const r = await fetch('/api/metrics');
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
    const r = await fetch('/api/messages?limit=50');
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
    const r = await fetch('/api/memory?type=' + memoryType);
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
    const r = await fetch('/api/tasks');
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
    const r = await fetch('/api/voice');
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
    const r = await fetch('/api/skills');
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

// ---- RESOURCES ----
async function loadResources() {
  try {
    const r = await fetch('/api/resources');
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
    const r = await fetch('/api/logs?service=' + service + '&lines=80');
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

// ---- INIT & INTERVALS ----
loadStatus();  loadMetrics();  loadMessages();  loadMemory();
loadTasks();   loadVoice();    loadSkills();     loadResources();  loadLogs();

setInterval(loadStatus, 10000);
setInterval(loadLogs, 10000);
setInterval(loadMessages, 15000);
setInterval(loadResources, 20000);
setInterval(loadMetrics, 30000);
setInterval(loadMemory, 30000);
setInterval(loadTasks, 30000);
setInterval(loadVoice, 30000);
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

    // Health check
    if (path === "/health") {
      return jsonResponse({ status: "ok", service: "nova-dashboard", uptime: Math.floor((Date.now() - startTime) / 1000) });
    }

    // Dashboard HTML
    if (path === "/") {
      return new Response(renderDashboard(), { headers: { "Content-Type": "text/html" } });
    }

    // API routes
    if (path === "/api/status") return jsonResponse(await getStatus());
    if (path === "/api/messages") {
      const limit = parseInt(url.searchParams.get("limit") || "50");
      return jsonResponse(await getMessages(Math.min(limit, 200)));
    }
    if (path === "/api/memory") {
      const type = url.searchParams.get("type") || "all";
      return jsonResponse(await getMemory(type));
    }
    if (path === "/api/metrics") return jsonResponse(await getMetrics());
    if (path === "/api/logs") {
      const service = url.searchParams.get("service") || "all";
      const lines = parseInt(url.searchParams.get("lines") || "100");
      return jsonResponse(await getLogs(service, Math.min(lines, 500)));
    }
    if (path === "/api/tasks") return jsonResponse(await getTasks());
    if (path === "/api/resources") return jsonResponse(await getResources());
    if (path === "/api/voice") return jsonResponse(await getVoice());
    if (path === "/api/skills") return jsonResponse(await getSkills());

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Nova Command Center running on http://localhost:${PORT}`);
console.log("Routes:");
console.log("  GET  /              — Dashboard UI");
console.log("  GET  /health        — Health check");
console.log("  GET  /api/status    — Service status");
console.log("  GET  /api/messages  — Recent messages");
console.log("  GET  /api/memory    — Memory entries");
console.log("  GET  /api/metrics   — Performance metrics");
console.log("  GET  /api/logs      — Log viewer");
console.log("  GET  /api/tasks     — Scheduled tasks");
console.log("  GET  /api/resources — System resources");
console.log("  GET  /api/voice     — Voice call activity");
console.log("  GET  /api/skills    — Skills & integrations");
