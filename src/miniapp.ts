#!/usr/bin/env bun
/**
 * Nova Telegram Mini App
 *
 * Rich mobile UI inside Telegram for managing profile, agents, approvals, and task history.
 * Serves on port 3034 (configurable via MINIAPP_PORT), validates Telegram initData via HMAC-SHA256.
 *
 * Run: bun run src/miniapp.ts
 */

import "dotenv/config";
import { getDb, type Database } from "./db.ts";
import { getAllAgents, loadAgents } from "./agent-router.ts";
import { registerProvider, getAllProviders, getAvailableProviderNames } from "./ai-provider.ts";
import { ClaudeProvider } from "./providers/claude.ts";
import { GeminiProvider } from "./providers/gemini.ts";
import { CodexProvider } from "./providers/codex.ts";

// Register AI providers for availability checks
registerProvider(new ClaudeProvider());
registerProvider(new GeminiProvider());
registerProvider(new CodexProvider());
import {
  getIntegrationStatus,
  getOAuthUrl,
  handleOAuthCallback,
  disconnectIntegration,
  saveApiKeyIntegration,
  verifyOAuthState,
  PER_USER_PROVIDERS,
  API_KEY_PROVIDERS,
  type Provider,
  type ApiKeyProvider,
} from "./integrations.ts";
import { WhatsAppManager } from "./whatsapp-manager.ts";

// ============================================================
// CONFIGURATION
// ============================================================

const PORT = parseInt(process.env.MINIAPP_PORT || "3034", 10);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

const supabase: Database = getDb();

const startTime = Date.now();

// Allowed CORS origin — Telegram Web App or localhost for dev
const CORS_ORIGIN = process.env.MINIAPP_URL || "https://web.telegram.org";

// ============================================================
// HELPERS
// ============================================================

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": CORS_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, initData",
    },
  });
}

function corsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": CORS_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, initData",
    },
  });
}

// ============================================================
// TELEGRAM initData VALIDATION (HMAC-SHA256)
// ============================================================

async function validateInitData(initDataRaw: string): Promise<{ valid: boolean; user: any }> {
  if (!initDataRaw || !BOT_TOKEN) {
    return { valid: false, user: null };
  }

  try {
    const params = new URLSearchParams(initDataRaw);
    const hash = params.get("hash");
    if (!hash) return { valid: false, user: null };

    // Build data_check_string: sorted key=value pairs (excluding hash), joined by \n
    const entries: string[] = [];
    for (const [key, value] of params.entries()) {
      if (key === "hash") continue;
      entries.push(`${key}=${value}`);
    }
    entries.sort();
    const dataCheckString = entries.join("\n");

    // secret_key = HMAC-SHA256("WebAppData", bot_token)
    const encoder = new TextEncoder();
    const secretKeyMaterial = await crypto.subtle.importKey(
      "raw",
      encoder.encode("WebAppData"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const secretKeyBytes = await crypto.subtle.sign("HMAC", secretKeyMaterial, encoder.encode(BOT_TOKEN));

    // computed_hash = HMAC-SHA256(data_check_string, secret_key)
    const computedKeyMaterial = await crypto.subtle.importKey(
      "raw",
      secretKeyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const computedHashBytes = await crypto.subtle.sign("HMAC", computedKeyMaterial, encoder.encode(dataCheckString));

    // Compare hex strings
    const computedHash = Array.from(new Uint8Array(computedHashBytes))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    if (computedHash !== hash) {
      return { valid: false, user: null };
    }

    // Check auth_date expiration (reject if older than 1 hour)
    const authDate = parseInt(params.get("auth_date") || "0", 10);
    if (authDate > 0 && Math.floor(Date.now() / 1000) - authDate > 3600) {
      return { valid: false, user: null };
    }

    // Extract user
    const userStr = params.get("user");
    const user = userStr ? JSON.parse(decodeURIComponent(userStr)) : null;

    return { valid: true, user };
  } catch (e) {
    console.error("[miniapp] initData validation error:", e);
    return { valid: false, user: null };
  }
}

/**
 * Resolve Telegram user ID to Nova user record.
 */
async function resolveNovaUser(telegramUserId: number): Promise<any | null> {
  try {
    return supabase.getUserByTelegramId(String(telegramUserId));
  } catch {
    return null;
  }
}

/**
 * Auth middleware — returns the Nova user or a 401 Response.
 */
async function authenticateRequest(req: Request): Promise<{ user: any; telegramUser: any } | Response> {
  const initDataRaw = req.headers.get("initdata") || req.headers.get("initData") || "";
  const { valid, user: telegramUser } = await validateInitData(initDataRaw);

  if (!valid || !telegramUser) {
    return jsonResponse({ error: "Unauthorized: invalid initData" }, 401);
  }

  const novaUser = await resolveNovaUser(telegramUser.id);
  if (!novaUser) {
    return jsonResponse({ error: "User not found" }, 404);
  }

  return { user: novaUser, telegramUser };
}

// ============================================================
// API HANDLERS
// ============================================================

async function getProfile(userId: string): Promise<unknown> {
  try {
    const user = supabase.getUserById(userId);
    const prefs = user?.preferences || {};
    return {
      user: user || null,
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
    const allowed = ["name", "timezone", "phone", "ai_provider"];
    const updates: Record<string, any> = {};
    for (const key of allowed) {
      if (fields[key] !== undefined) updates[key] = fields[key];
    }
    if (Object.keys(updates).length === 0) return { error: "No valid fields to update" };

    const user = supabase.updateUser(userId, updates);
    return { user };
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

async function getAgentsWithStats(userId: string): Promise<unknown> {
  const agentDefs = getAllAgents();

  try {
    const tasks = supabase.getAgentTaskStats(userId);

    const statsMap: Record<string, { total: number; success: number }> = {};
    for (const t of tasks || []) {
      const slug = (t.agent || "").toLowerCase();
      if (!statsMap[slug]) statsMap[slug] = { total: 0, success: 0 };
      statsMap[slug].total++;
      if (t.status === "done" || t.status === "completed") statsMap[slug].success++;
    }

    return {
      agents: agentDefs.map((a) => {
        const s = statsMap[a.slug] || { total: 0, success: 0 };
        return {
          name: a.name,
          slug: a.slug,
          description: a.description,
          taskCount: s.total,
          successRate: s.total > 0 ? Math.round((s.success / s.total) * 100) : 0,
        };
      }),
    };
  } catch (e: any) {
    return { agents: agentDefs.map((a) => ({ ...a, taskCount: 0, successRate: 0 })), error: e.message };
  }
}

async function getAgentTasks(userId: string, agentSlug: string): Promise<unknown> {
  try {
    const data = supabase.getTasksByAgent(userId, agentSlug);
    return { tasks: data || [] };
  } catch (e: any) {
    return { tasks: [], error: e.message };
  }
}

async function getApprovals(userId: string): Promise<unknown> {
  try {
    const data = supabase.getPendingApprovals(userId);
    return { approvals: data || [] };
  } catch (e: any) {
    return { approvals: [], error: e.message };
  }
}

async function handleApprovalAction(
  userId: string,
  approvalId: string,
  action: "approved" | "cancelled" | "revised",
  feedback?: string
): Promise<unknown> {
  try {
    supabase.updateApprovalStatus(approvalId, action, feedback || null, userId);
    return { approval: { id: approvalId, status: action } };
  } catch (e: any) {
    return { error: e.message };
  }
}

async function getTaskHistory(userId: string): Promise<unknown> {
  try {
    const parents = supabase.getParentTasks(userId);
    if (parents.length === 0) return { tasks: [] };

    const parentIds = parents.map((t: any) => t.id);
    const subtasks = supabase.getSubtasksByParentIds(parentIds);

    // Build count maps
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

    // Attach counts and sort: active first, then completed by recency
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

async function getTaskDetail(userId: string, taskId: string): Promise<unknown> {
  try {
    const task = supabase.getTaskById(taskId, userId);
    if (!task) return { error: "Task not found" };

    const subtasks = supabase.getSubtasksByParentIds([taskId]);

    // Fetch artifacts for this task and all its subtasks
    const allTaskIds = [taskId, ...(subtasks || []).map((s: any) => s.id)];
    const artifacts = supabase.getArtifactsByTaskIds(allTaskIds);

    return { task, subtasks: subtasks || [], artifacts: artifacts || [] };
  } catch (e: any) {
    return { error: e.message };
  }
}

// ============================================================
// DASHBOARD HANDLER
// ============================================================

async function getDashboard(): Promise<unknown> {
  try {
    const data = supabase.getNovaStatus();
    if (!data) return { error: "No status data" };

    // Parse JSON fields if stored as strings
    const callsByModel = typeof data.calls_by_model === "string"
      ? JSON.parse(data.calls_by_model) : (data.calls_by_model || {});

    return {
      uptime_since: data.uptime_since,
      uptime_hours: data.uptime_since
        ? ((Date.now() - new Date(data.uptime_since).getTime()) / 3600000).toFixed(1)
        : "0",
      calls_total: data.calls_total || 0,
      calls_success: data.calls_success || 0,
      calls_failed: data.calls_failed || 0,
      calls_by_model: callsByModel,
      rate_limit_hits: data.rate_limit_hits || 0,
      avg_duration_ms: data.avg_duration_ms || 0,
      active_slots: data.active_slots || 0,
      max_slots: data.max_slots || 2,
      queue_depth: data.queue_depth || 0,
      active_tasks: data.active_tasks || 0,
      pending_approvals: data.pending_approvals || 0,
      updated_at: data.updated_at,
    };
  } catch (e: any) {
    return { error: e.message };
  }
}

// ============================================================
// INTEGRATIONS HANDLERS
// ============================================================

async function getIntegrations(userId: string): Promise<unknown> {
  try {
    const statuses = await getIntegrationStatus(supabase, userId);
    return { integrations: statuses };
  } catch (e: any) {
    return { integrations: [], error: e.message };
  }
}

async function connectIntegration(userId: string, provider: string): Promise<unknown> {
  if (!PER_USER_PROVIDERS.includes(provider as Provider)) {
    return { error: `Invalid provider: ${provider}` };
  }

  const callbackBase = process.env.MINIAPP_URL || `http://localhost:${PORT}`;
  const result = getOAuthUrl(provider as Provider, userId, callbackBase);

  if (result.error) return { error: result.error };

  // Mark as pending in DB
  supabase.upsertIntegration({
    user_id: userId,
    provider,
    status: "pending",
  });

  return { url: result.url };
}

async function disconnectIntegrationHandler(userId: string, provider: string): Promise<unknown> {
  if (!PER_USER_PROVIDERS.includes(provider as Provider)) {
    return { error: `Invalid provider: ${provider}` };
  }

  const result = await disconnectIntegration(supabase, userId, provider as Provider);
  return result;
}

async function saveApiKeyHandler(userId: string, provider: string, req: Request): Promise<unknown> {
  if (!API_KEY_PROVIDERS.includes(provider as ApiKeyProvider)) {
    return { error: `Invalid API-key provider: ${provider}` };
  }

  const body = await req.json().catch(() => ({}));

  switch (provider) {
    case "gohighlevel": {
      const { bearer_token, location_id } = body as { bearer_token?: string; location_id?: string };
      if (!bearer_token) return { error: "Bearer token is required" };
      if (!location_id) return { error: "Location ID is required" };

      const result = await saveApiKeyIntegration(
        supabase,
        userId,
        "gohighlevel",
        { bearer_token },
        { location_id }
      );
      return result;
    }

    case "clickup": {
      const { api_token } = body as { api_token?: string };
      if (!api_token) return { error: "API token is required" };
      return await saveApiKeyIntegration(supabase, userId, "clickup", { api_token }, {});
    }

    default:
      return { error: `Unknown API-key provider: ${provider}` };
  }
}

// ============================================================
// WHATSAPP HANDLERS
// ============================================================

/** Get WhatsAppManager from global (set by relay.ts) or create standalone. */
function getWhatsAppManager(): WhatsAppManager {
  const global = (globalThis as any).__novaWhatsAppManager;
  if (global) return global;
  // Standalone mode (miniapp running without relay) — create ephemeral manager
  const manager = new WhatsAppManager(supabase);
  (globalThis as any).__novaWhatsAppManager = manager;
  return manager;
}

async function whatsappConnect(userId: string, phone?: string): Promise<unknown> {
  try {
    const manager = getWhatsAppManager();
    await manager.connect(userId, phone);
    // Give it a moment for QR/pairing code generation
    await new Promise((r) => setTimeout(r, 4000));
    return manager.getStatus(userId);
  } catch (e: any) {
    return { error: e.message };
  }
}

async function whatsappStatus(userId: string): Promise<unknown> {
  try {
    const manager = getWhatsAppManager();
    return manager.getStatus(userId);
  } catch (e: any) {
    return { error: e.message };
  }
}

async function whatsappDisconnect(userId: string): Promise<unknown> {
  try {
    const manager = getWhatsAppManager();
    await manager.disconnect(userId);
    return { success: true };
  } catch (e: any) {
    return { error: e.message };
  }
}

async function whatsappGetContacts(userId: string): Promise<unknown> {
  try {
    return { contacts: supabase.getWhatsappContacts(userId) };
  } catch (e: any) {
    return { contacts: [], error: e.message };
  }
}

async function whatsappUpsertContact(userId: string, body: any): Promise<unknown> {
  const { phone, name, role, permissions } = body;
  if (!phone) return { error: "phone is required" };
  const validRoles = ["allowed", "blocked", "vip"];
  if (role && !validRoles.includes(role)) return { error: `Invalid role: ${role}` };
  try {
    supabase.upsertWhatsappContact(
      userId,
      phone.replace(/[^0-9+]/g, ""),
      name || null,
      role || "allowed",
      permissions || {},
    );
    return { success: true };
  } catch (e: any) {
    return { error: e.message };
  }
}

async function whatsappDeleteContact(userId: string, phone: string): Promise<unknown> {
  try {
    supabase.deleteWhatsappContact(userId, decodeURIComponent(phone));
    return { success: true };
  } catch (e: any) {
    return { error: e.message };
  }
}

async function whatsappGetGroups(userId: string): Promise<unknown> {
  try {
    return { groups: supabase.getWhatsappGroups(userId) };
  } catch (e: any) {
    return { groups: [], error: e.message };
  }
}

async function whatsappUpsertGroup(userId: string, body: any): Promise<unknown> {
  const { group_jid, name, active, permissions } = body;
  if (!group_jid) return { error: "group_jid is required" };
  try {
    supabase.upsertWhatsappGroup(
      userId,
      group_jid,
      name || null,
      active !== undefined ? (active ? 1 : 0) : 1,
      permissions || {},
    );
    return { success: true };
  } catch (e: any) {
    return { error: e.message };
  }
}

async function whatsappDeleteGroup(userId: string, groupJid: string): Promise<unknown> {
  try {
    supabase.deleteWhatsappGroup(userId, decodeURIComponent(groupJid));
    return { success: true };
  } catch (e: any) {
    return { error: e.message };
  }
}

// ============================================================
// SCHEDULES HANDLERS
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

// ============================================================
// USERS HANDLERS (admin only)
// ============================================================

async function listUsers(): Promise<unknown> {
  try {
    const data = supabase.getAllActiveUsers();
    return { users: data || [] };
  } catch (e: any) {
    return { users: [], error: e.message };
  }
}

async function addUser(fields: Record<string, any>): Promise<unknown> {
  const { telegram_id, name, timezone, pin } = fields;
  if (!telegram_id || !name) return { error: "telegram_id and name are required" };
  try {
    const user = supabase.upsertUser({
      telegram_id,
      name,
      timezone: timezone || "UTC",
      role: "member",
      pin: pin || undefined,
    });
    return { user };
  } catch (e: any) {
    return { error: e.message };
  }
}

async function deactivateUser(userId: string): Promise<unknown> {
  try {
    supabase.updateUser(userId, { active: 0 });
    return { success: true };
  } catch (e: any) {
    return { error: e.message };
  }
}

// ============================================================
// OAUTH RESULT PAGE
// ============================================================

function renderOAuthResult(success: boolean, message: string): string {
  const emoji = success ? "\u2705" : "\u274C";
  const color = success ? "#22c55e" : "#ef4444";
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<title>Nova — Integration</title>
<style>body{background:#0a0a0f;color:#fff;font-family:'Inter',-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;}
.card{background:rgba(255,255,255,0.055);border-radius:14px;padding:40px;max-width:400px;border:1px solid rgba(255,255,255,0.10);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);box-shadow:0 4px 24px rgba(0,0,0,0.25);}.icon{font-size:48px;margin-bottom:16px;}.msg{font-size:18px;margin-bottom:24px;color:${color};}
.hint{font-size:14px;color:#999;}</style></head>
<body><div class="card"><div class="icon">${emoji}</div><div class="msg">${message.replace(/</g, "&lt;")}</div>
<div class="hint">You can close this window and return to the Nova app.</div></div></body></html>`;
}

// ============================================================
// FRONTEND SPA
// ============================================================

function renderMiniApp(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <title>Nova</title>
  <style>
    :root {
      --bg: var(--tg-theme-bg-color, #0a0a0f);
      --text: var(--tg-theme-text-color, #ffffff);
      --hint: var(--tg-theme-hint-color, #999999);
      --link: var(--tg-theme-link-color, #6366f1);
      --btn: var(--tg-theme-button-color, #6366f1);
      --btn-text: var(--tg-theme-button-text-color, #ffffff);
      --secondary-bg: var(--tg-theme-secondary-bg-color, #0d0d14);
      --section-bg: var(--tg-theme-section-bg-color, rgba(255,255,255,0.055));
      --accent: var(--tg-theme-accent-text-color, #6366f1);
      --subtitle: var(--tg-theme-subtitle-text-color, #999999);
      --destructive: var(--tg-theme-destructive-text-color, #ef4444);
      --card-radius: 14px;
      --tab-height: 56px;
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
      -webkit-tap-highlight-color: transparent;
    }

    html, body {
      height: 100%;
      overflow: hidden;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      font-size: 15px;
      line-height: 1.4;
    }

    ::-webkit-scrollbar { display: none; }

    .app {
      display: flex;
      flex-direction: column;
      height: 100vh;
      height: 100dvh;
    }

    /* ---- Content area ---- */
    .content {
      flex: 1;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      scroll-behavior: smooth;
      padding: 16px 16px calc(var(--tab-height) + 16px) 16px;
    }

    /* ---- Tab bar ---- */
    .tab-bar {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      height: var(--tab-height);
      background: rgba(255,255,255,0.055);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      display: flex;
      align-items: center;
      overflow-x: auto;
      border-top: 1px solid rgba(255,255,255,0.10);
      z-index: 100;
      padding-bottom: env(safe-area-inset-bottom, 0);
      scrollbar-width: none;
    }
    .tab-bar::-webkit-scrollbar { display: none; }

    .tab-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-width: 64px;
      flex: 0 0 auto;
      height: 100%;
      cursor: pointer;
      color: var(--hint);
      font-size: 10px;
      gap: 2px;
      transition: color 0.2s;
      user-select: none;
      padding: 0 6px;
    }

    .tab-item.active { color: var(--accent); }
    .tab-item svg { width: 24px; height: 24px; fill: currentColor; }

    /* ---- Page transitions ---- */
    .page { display: none; animation: fadeIn 0.2s ease; }
    .page.active { display: block; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }

    /* ---- Detail slide-in ---- */
    .detail-view {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: var(--bg);
      z-index: 90;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      padding: 16px 16px 80px 16px;
      transform: translateX(100%);
      transition: transform 0.25s ease;
    }
    .detail-view.open { transform: translateX(0); }

    /* ---- Cards ---- */
    .card {
      background: var(--section-bg);
      border-radius: var(--card-radius);
      padding: 16px;
      margin-bottom: 12px;
      border: 1px solid rgba(255,255,255,0.10);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      box-shadow: 0 4px 24px rgba(0,0,0,0.25);
    }

    /* ---- Avatar ---- */
    .avatar {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 28px;
      font-weight: 600;
      color: #fff;
      flex-shrink: 0;
    }

    .avatar-sm {
      width: 44px;
      height: 44px;
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
      font-weight: 700;
      color: #fff;
      flex-shrink: 0;
    }

    /* ---- Form fields ---- */
    .field-group { margin-bottom: 16px; }
    .field-label {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--hint);
      margin-bottom: 6px;
    }
    .field-input {
      width: 100%;
      background: var(--secondary-bg);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px;
      padding: 12px 14px;
      color: var(--text);
      font-size: 15px;
      outline: none;
      transition: border-color 0.2s;
    }
    .field-input:focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,0.15); }
    select.field-input {
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23999'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 14px center;
      padding-right: 36px;
    }

    /* ---- Toggle ---- */
    .toggle-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 0;
    }
    .toggle-row + .toggle-row { border-top: 1px solid rgba(255,255,255,0.06); }
    .toggle-label { font-size: 15px; }
    .toggle-hint { font-size: 12px; color: var(--hint); margin-top: 2px; }
    .toggle {
      width: 50px;
      height: 28px;
      background: rgba(255,255,255,0.12);
      border-radius: 14px;
      position: relative;
      cursor: pointer;
      transition: background 0.25s;
      flex-shrink: 0;
    }
    .toggle.on { background: #6366f1; }
    .toggle::after {
      content: '';
      position: absolute;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: #fff;
      top: 3px;
      left: 3px;
      transition: transform 0.25s;
    }
    .toggle.on::after { transform: translateX(22px); }

    /* ---- Agent grid ---- */
    .agent-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .agent-card {
      background: rgba(255,255,255,0.055);
      border-radius: var(--card-radius);
      padding: 16px;
      cursor: pointer;
      transition: transform 0.15s, box-shadow 0.15s;
      position: relative;
      overflow: hidden;
      border: 1px solid rgba(255,255,255,0.10);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      box-shadow: 0 4px 24px rgba(0,0,0,0.25);
    }
    .agent-card:active { transform: scale(0.97); }
    .agent-name { font-weight: 600; font-size: 14px; margin-top: 10px; }
    .agent-desc { font-size: 12px; color: var(--hint); margin-top: 4px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .agent-badge {
      position: absolute;
      top: 10px;
      right: 10px;
      background: #6366f1;
      color: #ffffff;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 10px;
      min-width: 20px;
      text-align: center;
    }

    /* ---- Approval cards ---- */
    .approval-card {
      background: rgba(255,255,255,0.055);
      border-radius: var(--card-radius);
      padding: 16px;
      margin-bottom: 12px;
      border: 1px solid rgba(255,255,255,0.10);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      box-shadow: 0 4px 24px rgba(0,0,0,0.25);
    }
    .approval-request {
      font-size: 14px;
      line-height: 1.5;
      margin-bottom: 8px;
    }
    .approval-meta {
      font-size: 12px;
      color: var(--hint);
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .approval-actions {
      display: flex;
      gap: 8px;
    }
    .approval-btn {
      flex: 1;
      padding: 10px;
      border: none;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      color: #fff;
      transition: opacity 0.15s;
    }
    .approval-btn:active { opacity: 0.7; }
    .approval-btn.approve { background: #6366f1; }
    .approval-btn.revise { background: #f59e0b; }
    .approval-btn.cancel { background: #ef4444; }
    .approval-expand { display: none; margin-top: 12px; }
    .approval-expand.open { display: block; }

    .revise-input {
      width: 100%;
      background: var(--secondary-bg);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px;
      padding: 10px 12px;
      color: var(--text);
      font-size: 14px;
      outline: none;
      margin-bottom: 8px;
      resize: none;
      min-height: 60px;
    }

    /* ---- Task history ---- */
    .task-item {
      background: rgba(255,255,255,0.055);
      border-radius: var(--card-radius);
      padding: 14px 16px;
      margin-bottom: 10px;
      cursor: pointer;
      transition: transform 0.15s;
      border: 1px solid rgba(255,255,255,0.10);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
    }
    .task-item:active { transform: scale(0.98); }
    .task-header {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .status-dot.done { background: #22c55e; }
    .status-dot.blocked { background: #ef4444; }
    .status-dot.in_progress { background: #f59e0b; }
    .status-dot.pending { background: var(--hint); }
    .task-desc {
      font-size: 14px;
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .task-agent-badge {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 8px;
      color: #fff;
      flex-shrink: 0;
    }
    .task-meta {
      font-size: 12px;
      color: var(--hint);
      margin-top: 6px;
      display: flex;
      gap: 12px;
    }

    /* ---- Filter chips ---- */
    .filter-bar {
      display: flex;
      gap: 8px;
      margin-bottom: 14px;
      overflow-x: auto;
      padding-bottom: 4px;
    }
    .filter-chip {
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 500;
      background: rgba(255,255,255,0.055);
      color: var(--hint);
      cursor: pointer;
      white-space: nowrap;
      border: 1px solid rgba(255,255,255,0.10);
      transition: all 0.2s;
      user-select: none;
    }
    .filter-chip.active {
      background: #6366f1;
      color: #ffffff;
      border-color: #6366f1;
    }

    /* ---- Empty state ---- */
    .empty-state {
      text-align: center;
      padding: 48px 20px;
      color: var(--hint);
    }
    .empty-state svg { width: 48px; height: 48px; fill: var(--hint); margin-bottom: 12px; opacity: 0.5; }
    .empty-state h3 { font-size: 16px; margin-bottom: 6px; color: var(--text); }
    .empty-state p { font-size: 13px; }

    /* ---- Toast ---- */
    .toast-container {
      position: fixed;
      top: 16px;
      left: 16px;
      right: 16px;
      z-index: 200;
      display: flex;
      flex-direction: column;
      gap: 8px;
      pointer-events: none;
    }
    .toast {
      background: rgba(255,255,255,0.055);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid rgba(255,255,255,0.10);
      color: var(--text);
      padding: 12px 16px;
      border-radius: 12px;
      font-size: 14px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      animation: toastIn 0.3s ease, toastOut 0.3s ease 2.7s forwards;
      pointer-events: auto;
    }
    .toast.error { border-left: 3px solid #ef4444; }
    .toast.success { border-left: 3px solid #22c55e; }
    @keyframes toastIn { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes toastOut { from { opacity: 1; } to { opacity: 0; } }

    /* ---- Section headers ---- */
    .section-header {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: var(--hint);
      margin: 20px 0 10px 0;
    }
    .section-header:first-child { margin-top: 0; }

    /* ---- Profile header ---- */
    .profile-header {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 24px;
    }
    .profile-info h2 { font-size: 20px; font-weight: 600; }
    .profile-info p { font-size: 13px; color: var(--hint); }

    /* ---- Detail view content ---- */
    .detail-header {
      display: flex;
      align-items: center;
      gap: 14px;
      margin-bottom: 20px;
    }
    .detail-header h2 { font-size: 20px; font-weight: 600; }
    .detail-header p { font-size: 13px; color: var(--hint); }
    .detail-section { margin-bottom: 20px; }
    .detail-section h3 { font-size: 14px; font-weight: 600; margin-bottom: 8px; color: var(--accent); }

    .tools-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .tool-chip {
      padding: 4px 10px;
      border-radius: 8px;
      font-size: 12px;
      background: rgba(255,255,255,0.06);
      color: var(--hint);
    }

    .stat-row {
      display: flex;
      justify-content: space-around;
      margin-bottom: 20px;
    }
    .stat-item { text-align: center; }
    .stat-value { font-size: 24px; font-weight: 700; color: var(--accent); }
    .stat-label { font-size: 11px; color: var(--hint); margin-top: 2px; }

    /* ---- Pull to refresh indicator ---- */
    .ptr-indicator {
      text-align: center;
      padding: 12px;
      color: var(--hint);
      font-size: 13px;
      display: none;
    }
    .ptr-indicator.visible { display: block; }

    /* ---- Subtask list in detail ---- */
    .subtask-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 0;
      border-bottom: 1px solid rgba(255,255,255,0.04);
    }
    .subtask-item:last-child { border-bottom: none; }

    /* ---- Tasks view enhancements ---- */
    .subtask-progress {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      color: var(--hint);
      background: rgba(255,255,255,0.06);
      padding: 2px 8px;
      border-radius: 10px;
      white-space: nowrap;
    }
    .subtask-progress .progress-fill {
      display: inline-block;
      height: 4px;
      border-radius: 2px;
      background: #22c55e;
      min-width: 2px;
    }
    .subtask-progress .progress-track {
      display: inline-block;
      width: 32px;
      height: 4px;
      border-radius: 2px;
      background: rgba(255,255,255,0.1);
      overflow: hidden;
    }
    .section-divider {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--hint);
      padding: 12px 0 6px;
      margin-top: 4px;
    }
    .section-divider:first-child { margin-top: 0; }
    .artifact-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 0;
      border-bottom: 1px solid rgba(255,255,255,0.04);
    }
    .artifact-item:last-child { border-bottom: none; }
    .artifact-icon {
      width: 32px;
      height: 32px;
      border-radius: 8px;
      background: rgba(255,255,255,0.06);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      font-size: 14px;
    }
    .artifact-badges {
      display: flex;
      gap: 4px;
      margin-top: 2px;
    }
    .artifact-badge {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 8px;
      font-weight: 500;
    }
    .artifact-badge.verified { background: rgba(34,197,94,0.15); color: #22c55e; }
    .artifact-badge.delivered { background: rgba(6,182,212,0.15); color: #06b6d4; }
    .artifact-badge.pending-badge { background: rgba(255,255,255,0.06); color: var(--hint); }

    /* ---- Loading spinner ---- */
    .loading {
      text-align: center;
      padding: 32px;
      color: var(--hint);
    }
    .spinner {
      width: 24px;
      height: 24px;
      border: 2px solid rgba(255,255,255,0.1);
      border-top-color: #6366f1;
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
      margin: 0 auto 8px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="app">
    <div class="toast-container" id="toastContainer"></div>

    <!-- ======== DASHBOARD PAGE ======== -->
    <div class="content page active" id="pageDashboard">
      <div class="section-header">System Status</div>
      <div id="dashboardContent">
        <div class="loading"><div class="spinner"></div>Loading dashboard...</div>
      </div>
    </div>

    <!-- ======== PROFILE PAGE ======== -->
    <div class="content page" id="pageProfile">
      <div class="ptr-indicator" id="ptrProfile">Pull to refresh</div>
      <div class="profile-header" id="profileHeader">
        <div class="avatar" id="profileAvatar" style="background:#6366f1;">?</div>
        <div class="profile-info">
          <h2 id="profileName">Loading...</h2>
          <p id="profileRole">Nova User</p>
        </div>
      </div>

      <div class="section-header">Personal Info</div>
      <div class="card">
        <div class="field-group">
          <div class="field-label">Name</div>
          <input type="text" class="field-input" id="fieldName" placeholder="Your name">
        </div>
        <div class="field-group">
          <div class="field-label">Timezone</div>
          <select class="field-input" id="fieldTimezone">
            <option value="">Select timezone</option>
            <option value="America/New_York">America/New_York (EST)</option>
            <option value="America/Chicago">America/Chicago (CST)</option>
            <option value="America/Denver">America/Denver (MST)</option>
            <option value="America/Los_Angeles">America/Los_Angeles (PST)</option>
            <option value="America/Anchorage">America/Anchorage (AKST)</option>
            <option value="Pacific/Honolulu">Pacific/Honolulu (HST)</option>
            <option value="America/Toronto">America/Toronto (EST)</option>
            <option value="America/Vancouver">America/Vancouver (PST)</option>
            <option value="America/Mexico_City">America/Mexico_City (CST)</option>
            <option value="America/Sao_Paulo">America/Sao_Paulo (BRT)</option>
            <option value="America/Argentina/Buenos_Aires">Buenos Aires (ART)</option>
            <option value="America/Bogota">America/Bogota (COT)</option>
            <option value="Europe/London">Europe/London (GMT)</option>
            <option value="Europe/Paris">Europe/Paris (CET)</option>
            <option value="Europe/Berlin">Europe/Berlin (CET)</option>
            <option value="Europe/Madrid">Europe/Madrid (CET)</option>
            <option value="Europe/Rome">Europe/Rome (CET)</option>
            <option value="Europe/Amsterdam">Europe/Amsterdam (CET)</option>
            <option value="Europe/Zurich">Europe/Zurich (CET)</option>
            <option value="Europe/Stockholm">Europe/Stockholm (CET)</option>
            <option value="Europe/Moscow">Europe/Moscow (MSK)</option>
            <option value="Europe/Istanbul">Europe/Istanbul (TRT)</option>
            <option value="Asia/Dubai">Asia/Dubai (GST)</option>
            <option value="Asia/Kolkata">Asia/Kolkata (IST)</option>
            <option value="Asia/Bangkok">Asia/Bangkok (ICT)</option>
            <option value="Asia/Singapore">Asia/Singapore (SGT)</option>
            <option value="Asia/Hong_Kong">Asia/Hong_Kong (HKT)</option>
            <option value="Asia/Shanghai">Asia/Shanghai (CST)</option>
            <option value="Asia/Tokyo">Asia/Tokyo (JST)</option>
            <option value="Asia/Seoul">Asia/Seoul (KST)</option>
            <option value="Australia/Sydney">Australia/Sydney (AEST)</option>
            <option value="Australia/Melbourne">Australia/Melbourne (AEST)</option>
            <option value="Pacific/Auckland">Pacific/Auckland (NZST)</option>
            <option value="Africa/Cairo">Africa/Cairo (EET)</option>
            <option value="Africa/Lagos">Africa/Lagos (WAT)</option>
            <option value="Africa/Johannesburg">Africa/Johannesburg (SAST)</option>
            <option value="Africa/Nairobi">Africa/Nairobi (EAT)</option>
          </select>
        </div>
        <div class="field-group">
          <div class="field-label">Phone</div>
          <input type="tel" class="field-input" id="fieldPhone" placeholder="+1 234 567 8900">
        </div>
      </div>

      <div class="section-header">Preferences</div>
      <div class="card">
        <div class="toggle-row">
          <div>
            <div class="toggle-label">Voice Responses</div>
            <div class="toggle-hint">Bot replies with voice messages</div>
          </div>
          <div class="toggle" id="toggleVoice" onclick="toggleSwitch(this, 'voice_responses')"></div>
        </div>
        <div class="toggle-row">
          <div>
            <div class="toggle-label">Auto-Approve</div>
            <div class="toggle-hint">Skip approval for routine tasks</div>
          </div>
          <div class="toggle" id="toggleAutoApprove" onclick="toggleSwitch(this, 'auto_approve')"></div>
        </div>
        <div class="field-group" style="padding-top:12px;">
          <div class="field-label">Notification Style</div>
          <select class="field-input" id="fieldNotifStyle">
            <option value="minimal">Minimal</option>
            <option value="normal">Normal</option>
            <option value="detailed">Detailed</option>
          </select>
        </div>
        <div class="field-group">
          <div class="field-label">Language</div>
          <input type="text" class="field-input" id="fieldLanguage" placeholder="en">
        </div>
      </div>

      <div class="section-header">AI Provider</div>
      <div class="card" id="aiProviderCard">
        <div class="field-group">
          <div class="field-label">Active Provider</div>
          <div id="aiProviderOptions" style="display:flex;flex-direction:column;gap:8px;margin-top:4px;">
            <label style="display:flex;align-items:center;gap:8px;padding:8px;border-radius:8px;border:1px solid var(--border);cursor:pointer;">
              <input type="radio" name="aiProvider" value="claude" checked>
              <div>
                <div style="font-weight:600;font-size:14px;">Claude</div>
                <div style="font-size:12px;color:var(--hint);">Anthropic Claude via CLI — default provider</div>
              </div>
              <span class="provider-badge" id="badgeClaude" style="margin-left:auto;font-size:11px;padding:2px 6px;border-radius:4px;background:var(--border);color:var(--hint);"></span>
            </label>
            <label style="display:flex;align-items:center;gap:8px;padding:8px;border-radius:8px;border:1px solid var(--border);cursor:pointer;">
              <input type="radio" name="aiProvider" value="gemini">
              <div>
                <div style="font-weight:600;font-size:14px;">Gemini</div>
                <div style="font-size:12px;color:var(--hint);">Google Gemini via CLI — fast and free tier</div>
              </div>
              <span class="provider-badge" id="badgeGemini" style="margin-left:auto;font-size:11px;padding:2px 6px;border-radius:4px;background:var(--border);color:var(--hint);"></span>
            </label>
            <label style="display:flex;align-items:center;gap:8px;padding:8px;border-radius:8px;border:1px solid var(--border);cursor:pointer;">
              <input type="radio" name="aiProvider" value="codex">
              <div>
                <div style="font-weight:600;font-size:14px;">Codex</div>
                <div style="font-size:12px;color:var(--hint);">OpenAI Codex CLI — o3/o4-mini models</div>
              </div>
              <span class="provider-badge" id="badgeCodex" style="margin-left:auto;font-size:11px;padding:2px 6px;border-radius:4px;background:var(--border);color:var(--hint);"></span>
            </label>
            <label style="display:flex;align-items:center;gap:8px;padding:8px;border-radius:8px;border:1px solid var(--border);cursor:pointer;">
              <input type="radio" name="aiProvider" value="smart">
              <div>
                <div style="font-weight:600;font-size:14px;">Smart Routing</div>
                <div style="font-size:12px;color:var(--hint);">Auto-select provider based on task type</div>
              </div>
            </label>
          </div>
        </div>
      </div>
    </div>

    <!-- ======== AGENTS PAGE ======== -->
    <div class="content page" id="pageAgents">
      <div class="ptr-indicator" id="ptrAgents">Pull to refresh</div>
      <div class="section-header">Your Agents</div>
      <div class="agent-grid" id="agentGrid">
        <div class="loading"><div class="spinner"></div>Loading agents...</div>
      </div>
    </div>

    <!-- ======== APPROVALS PAGE ======== -->
    <div class="content page" id="pageApprovals">
      <div class="ptr-indicator" id="ptrApprovals">Pull to refresh</div>
      <div class="section-header">Pending Approvals</div>
      <div id="approvalList">
        <div class="loading"><div class="spinner"></div>Loading approvals...</div>
      </div>
    </div>

    <!-- ======== HISTORY PAGE ======== -->
    <div class="content page" id="pageHistory">
      <div class="ptr-indicator" id="ptrHistory">Pull to refresh</div>
      <div class="filter-bar" id="filterBar">
        <div class="filter-chip active" data-filter="all" onclick="setFilter('all')">All</div>
        <div class="filter-chip" data-filter="pending" onclick="setFilter('pending')">Pending</div>
        <div class="filter-chip" data-filter="in_progress" onclick="setFilter('in_progress')">In Progress</div>
        <div class="filter-chip" data-filter="blocked" onclick="setFilter('blocked')">Blocked</div>
        <div class="filter-chip" data-filter="done" onclick="setFilter('done')">Done</div>
      </div>
      <div id="taskList">
        <div class="loading"><div class="spinner"></div>Loading tasks...</div>
      </div>
    </div>

    <!-- ======== INTEGRATIONS PAGE ======== -->
    <div class="content page" id="pageIntegrations">
      <div class="section-header">Integrations</div>
      <div id="whatsappCard" style="margin-bottom:12px;"></div>
      <div id="integrationsList">
        <div class="loading"><div class="spinner"></div>Loading integrations...</div>
      </div>
    </div>

    <!-- ======== SCHEDULES PAGE ======== -->
    <div class="content page" id="pageSchedules">
      <div class="section-header">Scheduled Tasks</div>
      <div id="schedulesList">
        <div class="loading"><div class="spinner"></div>Loading schedules...</div>
      </div>
    </div>

    <!-- ======== USERS PAGE (admin only) ======== -->
    <div class="content page" id="pageUsers">
      <div class="section-header">User Management</div>
      <div id="addUserForm" class="card" style="margin-bottom:16px;">
        <div class="field-group">
          <div class="field-label">Telegram ID</div>
          <input type="text" class="field-input" id="newUserTelegramId" placeholder="123456789">
        </div>
        <div class="field-group">
          <div class="field-label">Name</div>
          <input type="text" class="field-input" id="newUserName" placeholder="John">
        </div>
        <div class="field-group">
          <div class="field-label">Timezone</div>
          <input type="text" class="field-input" id="newUserTimezone" placeholder="America/New_York" value="UTC">
        </div>
        <button class="approval-btn approve" style="width:100%;margin-top:8px;" onclick="addNewUser()">Add User</button>
      </div>
      <div id="usersList">
        <div class="loading"><div class="spinner"></div>Loading users...</div>
      </div>
    </div>

    <!-- ======== AGENT DETAIL ======== -->
    <div class="detail-view" id="agentDetail">
      <div id="agentDetailContent"></div>
    </div>

    <!-- ======== TASK DETAIL ======== -->
    <div class="detail-view" id="taskDetail">
      <div id="taskDetailContent"></div>
    </div>

    <!-- ======== TAB BAR ======== -->
    <div class="tab-bar">
      <div class="tab-item active" data-tab="pageDashboard" onclick="switchTab('pageDashboard')">
        <svg viewBox="0 0 24 24"><path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/></svg>
        <span>Dashboard</span>
      </div>
      <div class="tab-item" data-tab="pageProfile" onclick="switchTab('pageProfile')">
        <svg viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
        <span>Profile</span>
      </div>
      <div class="tab-item" data-tab="pageIntegrations" onclick="switchTab('pageIntegrations')">
        <svg viewBox="0 0 24 24"><path d="M17 7h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1 0 1.43-.98 2.63-2.31 2.98l1.46 1.46C20.88 15.61 22 13.95 22 12c0-2.76-2.24-5-5-5zm-1 4h-2.19l2 2H16v-2zM2 4.27l3.11 3.11C3.29 8.12 2 9.91 2 12c0 2.76 2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1 0-1.59 1.21-2.9 2.76-3.07L8.73 11H8v2h2.73L13 15.27V17h1.73l4.01 4L20 19.74 3.27 3 2 4.27z"/></svg>
        <span>Integrations</span>
      </div>
      <div class="tab-item" data-tab="pageAgents" onclick="switchTab('pageAgents')">
        <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
        <span>Agents</span>
      </div>
      <div class="tab-item" data-tab="pageSchedules" onclick="switchTab('pageSchedules')">
        <svg viewBox="0 0 24 24"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>
        <span>Schedules</span>
      </div>
      <div class="tab-item" data-tab="pageUsers" onclick="switchTab('pageUsers')">
        <svg viewBox="0 0 24 24"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
        <span>Users</span>
      </div>
      <div class="tab-item" data-tab="pageApprovals" onclick="switchTab('pageApprovals')">
        <svg viewBox="0 0 24 24"><path d="M18 7l-1.41-1.41-6.34 6.34 1.41 1.41L18 7zm4.24-1.41L11.66 16.17 7.48 12l-1.41 1.41L11.66 19l12-12-1.42-1.41zM.41 13.41L6 19l1.41-1.41L1.83 12 .41 13.41z"/></svg>
        <span>Approvals</span>
      </div>
      <div class="tab-item" data-tab="pageHistory" onclick="switchTab('pageHistory')">
        <svg viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-1 7V3.5L18.5 9H13zM7 17h5v-1H7v1zm7-4H7v-1h7v1zm-3-4h-4v1h4V9z"/></svg>
        <span>Tasks</span>
      </div>
    </div>
  </div>

  <script>
    // ============================================================
    // STATE
    // ============================================================
    const AGENT_COLORS = ['#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FFEAA7','#DDA0DD','#98D8C8','#F7DC6F','#BB8FCE','#85C1E9','#F0B27A','#82E0AA'];
    let initData = '';
    let currentTab = 'pageDashboard';
    let currentFilter = 'all';
    let profileData = null;
    let prefsData = null;
    let agentsData = [];
    let approvalsData = [];
    let tasksData = [];
    let openDetailType = null; // 'agent' or 'task'
    let tasksPollingTimer = null;
    let approvalRefreshInterval = null;

    // ============================================================
    // INIT
    // ============================================================
    document.addEventListener('DOMContentLoaded', function() {
      if (window.Telegram && Telegram.WebApp) {
        Telegram.WebApp.ready();
        Telegram.WebApp.expand();
        Telegram.WebApp.setHeaderColor('secondary_bg_color');
        initData = Telegram.WebApp.initData || '';

        Telegram.WebApp.BackButton.onClick(function() {
          closeDetail();
        });
      }

      loadDashboard();
      loadProfile();
      loadWhatsApp();
      loadIntegrations();
      loadAgents();
      loadSchedules();
      loadUsers();
      loadApprovals();
      loadTasks();

      // Auto-refresh approvals every 10 seconds, dashboard every 30s
      approvalRefreshInterval = setInterval(function() {
        if (currentTab === 'pageApprovals') loadApprovals(true);
        if (currentTab === 'pageDashboard') loadDashboard();
      }, 10000);
    });

    // ============================================================
    // API HELPERS
    // ============================================================
    function apiUrl(path) {
      return '/api' + path;
    }

    async function apiFetch(path, options) {
      const opts = options || {};
      opts.headers = opts.headers || {};
      opts.headers['initData'] = initData;
      if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(opts.body);
      }
      try {
        const res = await fetch(apiUrl(path), opts);
        const json = await res.json();
        if (!res.ok) {
          showToast(json.error || 'Request failed', 'error');
          return null;
        }
        return json;
      } catch (e) {
        showToast('Network error: ' + e.message, 'error');
        return null;
      }
    }

    // ============================================================
    // TOAST
    // ============================================================
    function showToast(msg, type) {
      const container = document.getElementById('toastContainer');
      const el = document.createElement('div');
      el.className = 'toast ' + (type || '');
      el.textContent = msg;
      container.appendChild(el);
      setTimeout(function() { el.remove(); }, 3000);
    }

    // ============================================================
    // TAB SWITCHING
    // ============================================================
    function switchTab(tabId) {
      if (openDetailType) closeDetail();
      currentTab = tabId;

      document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
      document.getElementById(tabId).classList.add('active');

      document.querySelectorAll('.tab-item').forEach(function(t) {
        t.classList.toggle('active', t.getAttribute('data-tab') === tabId);
      });

      if (window.Telegram && Telegram.WebApp && Telegram.WebApp.HapticFeedback) {
        Telegram.WebApp.HapticFeedback.selectionChanged();
      }

      // Hide MainButton when not on profile
      if (window.Telegram && Telegram.WebApp) {
        if (tabId === 'pageProfile') {
          Telegram.WebApp.MainButton.setText('Save Profile');
          Telegram.WebApp.MainButton.show();
          Telegram.WebApp.MainButton.onClick(saveProfile);
        } else {
          Telegram.WebApp.MainButton.hide();
        }
      }

      // Auto-refresh polling for Tasks tab
      if (tasksPollingTimer) { clearInterval(tasksPollingTimer); tasksPollingTimer = null; }
      if (tabId === 'pageHistory') {
        tasksPollingTimer = setInterval(function() { loadTasks(true); }, 5000);
      }
    }

    // ============================================================
    // DETAIL VIEWS
    // ============================================================
    function openDetail(type) {
      openDetailType = type;
      var el = document.getElementById(type === 'agent' ? 'agentDetail' : 'taskDetail');
      el.classList.add('open');
      if (window.Telegram && Telegram.WebApp) {
        Telegram.WebApp.BackButton.show();
        Telegram.WebApp.MainButton.hide();
      }
    }

    function closeDetail() {
      if (!openDetailType) return;
      var el = document.getElementById(openDetailType === 'agent' ? 'agentDetail' : 'taskDetail');
      el.classList.remove('open');
      openDetailType = null;
      if (window.Telegram && Telegram.WebApp) {
        Telegram.WebApp.BackButton.hide();
        if (currentTab === 'pageProfile') {
          Telegram.WebApp.MainButton.setText('Save Profile');
          Telegram.WebApp.MainButton.show();
        }
      }
    }

    // ============================================================
    // PROFILE
    // ============================================================
    async function loadProfile() {
      var data = await apiFetch('/profile');
      if (!data) return;

      profileData = data.user;
      prefsData = data.preferences;

      if (profileData) {
        var name = profileData.name || 'User';
        document.getElementById('profileName').textContent = name;
        document.getElementById('profileRole').textContent = profileData.role || 'Nova User';
        document.getElementById('profileAvatar').textContent = name.charAt(0).toUpperCase();
        document.getElementById('fieldName').value = profileData.name || '';
        document.getElementById('fieldTimezone').value = profileData.timezone || '';
        document.getElementById('fieldPhone').value = profileData.phone || '';
      }

      if (prefsData) {
        if (prefsData.voice_responses) document.getElementById('toggleVoice').classList.add('on');
        if (prefsData.auto_approve) document.getElementById('toggleAutoApprove').classList.add('on');
        document.getElementById('fieldNotifStyle').value = prefsData.notification_style || 'normal';
        document.getElementById('fieldLanguage').value = prefsData.language || 'en';
      }

      // Load AI provider
      loadAIProvider();

      // Show MainButton for save
      if (window.Telegram && Telegram.WebApp && currentTab === 'pageProfile') {
        Telegram.WebApp.MainButton.setText('Save Profile');
        Telegram.WebApp.MainButton.show();
        Telegram.WebApp.MainButton.onClick(saveProfile);
      }
    }

    async function saveProfile() {
      if (window.Telegram && Telegram.WebApp) {
        Telegram.WebApp.MainButton.showProgress();
      }

      var selectedProvider = 'claude';
      var radios = document.querySelectorAll('input[name="aiProvider"]');
      radios.forEach(function(r) { if (r.checked) selectedProvider = r.value; });

      var profileFields = {
        name: document.getElementById('fieldName').value.trim(),
        timezone: document.getElementById('fieldTimezone').value,
        phone: document.getElementById('fieldPhone').value.trim(),
        ai_provider: selectedProvider
      };

      var prefFields = {
        voice_responses: document.getElementById('toggleVoice').classList.contains('on'),
        auto_approve: document.getElementById('toggleAutoApprove').classList.contains('on'),
        notification_style: document.getElementById('fieldNotifStyle').value,
        language: document.getElementById('fieldLanguage').value.trim() || 'en'
      };

      var r1 = await apiFetch('/profile', { method: 'PUT', body: profileFields });
      var r2 = await apiFetch('/preferences', { method: 'PUT', body: prefFields });

      if (window.Telegram && Telegram.WebApp) {
        Telegram.WebApp.MainButton.hideProgress();
      }

      if (r1 && r2) {
        showToast('Profile saved', 'success');
        if (window.Telegram && Telegram.WebApp && Telegram.WebApp.HapticFeedback) {
          Telegram.WebApp.HapticFeedback.notificationOccurred('success');
        }
        // Update header
        if (profileFields.name) {
          document.getElementById('profileName').textContent = profileFields.name;
          document.getElementById('profileAvatar').textContent = profileFields.name.charAt(0).toUpperCase();
        }
      }
    }

    function toggleSwitch(el, key) {
      el.classList.toggle('on');
      if (window.Telegram && Telegram.WebApp && Telegram.WebApp.HapticFeedback) {
        Telegram.WebApp.HapticFeedback.impactOccurred('light');
      }
    }

    async function loadAIProvider() {
      var data = await apiFetch('/ai-provider');
      if (!data) return;
      var radios = document.querySelectorAll('input[name="aiProvider"]');
      radios.forEach(function(r) {
        if (r.value === data.current) r.checked = true;
      });
      var badges = { claude: document.getElementById('badgeClaude'), gemini: document.getElementById('badgeGemini'), codex: document.getElementById('badgeCodex') };
      if (data.providers) {
        data.providers.forEach(function(p) {
          var badge = badges[p.name];
          if (badge) {
            badge.textContent = p.available ? 'Available' : 'Unavailable';
            badge.style.background = p.available ? '#22c55e22' : '#ef444422';
            badge.style.color = p.available ? '#22c55e' : '#ef4444';
          }
        });
      }
    }

    // ============================================================
    // AGENTS
    // ============================================================
    function agentColor(slug) {
      var hash = 0;
      for (var i = 0; i < slug.length; i++) hash = slug.charCodeAt(i) + ((hash << 5) - hash);
      return AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length];
    }

    async function loadAgents(silent) {
      var data = await apiFetch('/agents');
      if (!data) return;
      agentsData = data.agents || [];
      renderAgentGrid();
    }

    function renderAgentGrid() {
      var grid = document.getElementById('agentGrid');
      if (!agentsData.length) {
        grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;"><svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg><h3>No Agents Found</h3><p>Agent definitions will appear here once loaded.</p></div>';
        return;
      }

      var html = '';
      for (var i = 0; i < agentsData.length; i++) {
        var a = agentsData[i];
        var color = agentColor(a.slug);
        var eName = escapeStr(a.name);
        var eDesc = escapeStr(a.description);
        html += '<div class="agent-card" onclick="showAgentDetail(\\'' + escapeStr(a.slug) + '\\')">';
        if (a.taskCount > 0) html += '<div class="agent-badge">' + a.taskCount + '</div>';
        html += '<div class="avatar-sm" style="background:' + color + ';">' + eName.charAt(0).toUpperCase() + '</div>';
        html += '<div class="agent-name">' + eName + '</div>';
        html += '<div class="agent-desc">' + eDesc + '</div>';
        html += '</div>';
      }
      grid.innerHTML = html;
    }

    async function showAgentDetail(slug) {
      var agent = agentsData.find(function(a) { return a.slug === slug; });
      if (!agent) return;

      if (window.Telegram && Telegram.WebApp && Telegram.WebApp.HapticFeedback) {
        Telegram.WebApp.HapticFeedback.impactOccurred('light');
      }

      var color = agentColor(slug);
      var container = document.getElementById('agentDetailContent');

      container.innerHTML = '<div class="loading"><div class="spinner"></div>Loading agent details...</div>';
      openDetail('agent');

      // Fetch tasks for this agent
      var tasksRes = await apiFetch('/agents/' + encodeURIComponent(slug) + '/tasks');
      var agentTasks = (tasksRes && tasksRes.tasks) || [];

      var successCount = agentTasks.filter(function(t) { return t.status === 'done' || t.status === 'completed'; }).length;
      var successRate = agentTasks.length > 0 ? Math.round((successCount / agentTasks.length) * 100) : 0;

      var html = '';
      html += '<div class="detail-header">';
      html += '<div class="avatar" style="background:' + color + ';">' + escapeStr(agent.name).charAt(0).toUpperCase() + '</div>';
      html += '<div><h2>' + escapeStr(agent.name) + '</h2><p>' + escapeStr(agent.description) + '</p></div>';
      html += '</div>';

      html += '<div class="stat-row">';
      html += '<div class="stat-item"><div class="stat-value">' + (agent.taskCount || 0) + '</div><div class="stat-label">Tasks</div></div>';
      html += '<div class="stat-item"><div class="stat-value">' + successRate + '%</div><div class="stat-label">Success</div></div>';
      html += '<div class="stat-item"><div class="stat-value">' + agentTasks.length + '</div><div class="stat-label">Recent</div></div>';
      html += '</div>';

      if (agentTasks.length > 0) {
        html += '<div class="detail-section"><h3>Recent Tasks</h3>';
        for (var i = 0; i < Math.min(agentTasks.length, 10); i++) {
          var t = agentTasks[i];
          var statusClass = normalizeStatus(t.status);
          html += '<div class="subtask-item">';
          html += '<div class="status-dot ' + statusClass + '"></div>';
          html += '<div style="flex:1;"><div style="font-size:14px;">' + escapeStr(t.description || t.task || 'Task') + '</div>';
          html += '<div style="font-size:12px;color:var(--hint);">' + timeAgo(t.created_at) + '</div></div>';
          html += '</div>';
        }
        html += '</div>';
      } else {
        html += '<div class="empty-state"><p>No tasks yet for this agent.</p></div>';
      }

      container.innerHTML = html;
    }

    // ============================================================
    // APPROVALS
    // ============================================================
    async function loadApprovals(silent) {
      var data = await apiFetch('/approvals');
      if (!data) return;
      approvalsData = data.approvals || [];
      renderApprovals();
    }

    function renderApprovals() {
      var container = document.getElementById('approvalList');
      if (!approvalsData.length) {
        container.innerHTML = '<div class="empty-state"><svg viewBox="0 0 24 24"><path d="M18 7l-1.41-1.41-6.34 6.34 1.41 1.41L18 7zm4.24-1.41L11.66 16.17 7.48 12l-1.41 1.41L11.66 19l12-12-1.42-1.41zM.41 13.41L6 19l1.41-1.41L1.83 12 .41 13.41z"/></svg><h3>No Pending Approvals</h3><p>All caught up! New approvals will appear here.</p></div>';
        return;
      }

      var html = '';
      for (var i = 0; i < approvalsData.length; i++) {
        var a = approvalsData[i];
        var id = a.id;
        var request = escapeStr(a.request || a.description || 'Pending approval');
        var summary = escapeStr(a.summary || '');
        var artifacts = a.artifacts || [];
        var artCount = Array.isArray(artifacts) ? artifacts.length : 0;

        html += '<div class="approval-card" id="approval-' + id + '">';
        html += '<div class="approval-request">' + request + '</div>';
        html += '<div class="approval-meta">';
        html += '<span>' + timeAgo(a.created_at) + '</span>';
        if (artCount > 0) html += '<span>' + artCount + ' artifact' + (artCount > 1 ? 's' : '') + '</span>';
        html += '</div>';

        if (summary) {
          html += '<div style="font-size:13px;color:var(--hint);margin-bottom:12px;cursor:pointer;" onclick="toggleExpand(\\'' + id + '\\')">';
          html += 'Show details &#9662;';
          html += '</div>';
          html += '<div class="approval-expand" id="expand-' + id + '">';
          html += '<div style="font-size:13px;margin-bottom:10px;">' + summary + '</div>';
          if (artCount > 0) {
            html += '<div style="margin-bottom:10px;">';
            for (var j = 0; j < artifacts.length; j++) {
              html += '<div class="tool-chip" style="display:inline-block;margin:2px;">' + escapeStr(String(artifacts[j])) + '</div>';
            }
            html += '</div>';
          }
          html += '</div>';
        }

        // Revise feedback input (hidden by default)
        html += '<div id="revise-' + id + '" style="display:none;margin-bottom:8px;">';
        html += '<textarea class="revise-input" id="feedback-' + id + '" placeholder="What should be changed?"></textarea>';
        html += '<button class="approval-btn" style="background:var(--btn);width:100%;" onclick="submitRevise(\\'' + id + '\\')">Submit Feedback</button>';
        html += '</div>';

        html += '<div class="approval-actions" id="actions-' + id + '">';
        html += '<button class="approval-btn approve" onclick="approveAction(\\'' + id + '\\', \\'approve\\')">Approve</button>';
        html += '<button class="approval-btn revise" onclick="showReviseInput(\\'' + id + '\\')">Revise</button>';
        html += '<button class="approval-btn cancel" onclick="approveAction(\\'' + id + '\\', \\'cancel\\')">Cancel</button>';
        html += '</div>';
        html += '</div>';
      }
      container.innerHTML = html;
    }

    function toggleExpand(id) {
      var el = document.getElementById('expand-' + id);
      if (el) el.classList.toggle('open');
    }

    function showReviseInput(id) {
      var el = document.getElementById('revise-' + id);
      var actions = document.getElementById('actions-' + id);
      if (el) el.style.display = 'block';
      if (actions) actions.style.display = 'none';
      if (window.Telegram && Telegram.WebApp && Telegram.WebApp.HapticFeedback) {
        Telegram.WebApp.HapticFeedback.impactOccurred('light');
      }
    }

    async function submitRevise(id) {
      var feedback = document.getElementById('feedback-' + id).value.trim();
      if (!feedback) {
        showToast('Please enter feedback', 'error');
        return;
      }
      var res = await apiFetch('/approvals/' + id + '/revise', { method: 'POST', body: { feedback: feedback } });
      if (res) {
        showToast('Revision submitted', 'success');
        if (window.Telegram && Telegram.WebApp && Telegram.WebApp.HapticFeedback) {
          Telegram.WebApp.HapticFeedback.notificationOccurred('success');
        }
        loadApprovals(true);
      }
    }

    async function approveAction(id, action) {
      if (window.Telegram && Telegram.WebApp && Telegram.WebApp.HapticFeedback) {
        Telegram.WebApp.HapticFeedback.impactOccurred('medium');
      }
      var res = await apiFetch('/approvals/' + id + '/' + action, { method: 'POST' });
      if (res) {
        var msg = action === 'approve' ? 'Approved' : 'Cancelled';
        showToast(msg, 'success');
        if (window.Telegram && Telegram.WebApp && Telegram.WebApp.HapticFeedback) {
          Telegram.WebApp.HapticFeedback.notificationOccurred('success');
        }
        loadApprovals(true);
      }
    }

    // ============================================================
    // TASK HISTORY
    // ============================================================
    async function loadTasks(silent) {
      var data = await apiFetch('/tasks');
      if (!data) return;
      tasksData = data.tasks || [];
      renderTasks();
    }

    function normalizeStatus(status) {
      if (!status) return 'pending';
      var s = status.toLowerCase();
      if (s === 'done' || s === 'completed') return 'done';
      if (s === 'blocked' || s === 'failed' || s === 'error') return 'blocked';
      if (s === 'in_progress' || s === 'running' || s === 'executing') return 'in_progress';
      return 'pending';
    }

    function setFilter(filter) {
      currentFilter = filter;
      document.querySelectorAll('.filter-chip').forEach(function(c) {
        c.classList.toggle('active', c.getAttribute('data-filter') === filter);
      });
      renderTasks();
      if (window.Telegram && Telegram.WebApp && Telegram.WebApp.HapticFeedback) {
        Telegram.WebApp.HapticFeedback.selectionChanged();
      }
    }

    function renderTaskRow(t) {
      var statusClass = normalizeStatus(t.status);
      var color = agentColor(t.agent || 'default');
      var desc = escapeStr(t.description || t.task || 'Task');
      var agentName = escapeStr(t.agent || 'general');
      var duration = '';
      if (t.started_at && t.completed_at) {
        var ms = new Date(t.completed_at) - new Date(t.started_at);
        if (ms < 60000) duration = Math.round(ms / 1000) + 's';
        else if (ms < 3600000) duration = Math.round(ms / 60000) + 'm';
        else duration = Math.round(ms / 3600000) + 'h';
      }

      var html = '<div class="task-item" onclick="showTaskDetail(\\'' + t.id + '\\')">';
      html += '<div class="task-header">';
      html += '<div class="status-dot ' + statusClass + '"></div>';
      html += '<div class="task-desc">' + desc + '</div>';
      html += '<div class="task-agent-badge" style="background:' + color + ';">' + agentName + '</div>';
      html += '</div>';
      html += '<div class="task-meta">';
      html += '<span>' + timeAgo(t.created_at) + '</span>';
      if (duration) html += '<span>' + duration + '</span>';
      if (t.subtask_total > 0) {
        var pct = t.subtask_total > 0 ? Math.round((t.subtask_done / t.subtask_total) * 100) : 0;
        html += '<span class="subtask-progress"><span class="progress-track"><span class="progress-fill" style="width:' + pct + '%;"></span></span>' + t.subtask_done + '/' + t.subtask_total + '</span>';
      }
      html += '</div>';
      html += '</div>';
      return html;
    }

    function renderTasks() {
      var container = document.getElementById('taskList');
      var filtered = tasksData;
      if (currentFilter !== 'all') {
        filtered = tasksData.filter(function(t) { return normalizeStatus(t.status) === currentFilter; });
      }

      if (!filtered.length) {
        var label = currentFilter === 'all' ? 'No tasks yet' : 'No ' + currentFilter.replace('_', ' ') + ' tasks';
        container.innerHTML = '<div class="empty-state"><svg viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm-1 7V3.5L18.5 9H13zM7 17h5v-1H7v1zm7-4H7v-1h7v1zm-3-4h-4v1h4V9z"/></svg><h3>' + label + '</h3><p>Tasks will appear here as agents work.</p></div>';
        return;
      }

      // Group into active and completed
      var active = [];
      var completed = [];
      for (var i = 0; i < filtered.length; i++) {
        var ns = normalizeStatus(filtered[i].status);
        if (ns === 'done') completed.push(filtered[i]);
        else active.push(filtered[i]);
      }

      var html = '';
      if (currentFilter === 'all' || currentFilter === 'pending' || currentFilter === 'in_progress' || currentFilter === 'blocked') {
        if (active.length > 0) {
          if (completed.length > 0 || currentFilter === 'all') html += '<div class="section-divider">Active</div>';
          for (var j = 0; j < active.length; j++) html += renderTaskRow(active[j]);
        }
      }
      if (currentFilter === 'all' || currentFilter === 'done') {
        if (completed.length > 0) {
          if (active.length > 0 || currentFilter === 'all') html += '<div class="section-divider">Completed</div>';
          for (var k = 0; k < completed.length; k++) html += renderTaskRow(completed[k]);
        }
      }
      container.innerHTML = html;
    }

    async function showTaskDetail(taskId) {
      if (window.Telegram && Telegram.WebApp && Telegram.WebApp.HapticFeedback) {
        Telegram.WebApp.HapticFeedback.impactOccurred('light');
      }

      var container = document.getElementById('taskDetailContent');
      container.innerHTML = '<div class="loading"><div class="spinner"></div>Loading task...</div>';
      openDetail('task');

      var data = await apiFetch('/tasks/' + encodeURIComponent(taskId));
      if (!data || !data.task) {
        container.innerHTML = '<div class="empty-state"><h3>Task not found</h3></div>';
        return;
      }

      var t = data.task;
      var subtasks = data.subtasks || [];
      var artifacts = data.artifacts || [];
      var statusClass = normalizeStatus(t.status);
      var color = agentColor(t.agent || 'default');

      var html = '';
      html += '<div class="detail-header">';
      html += '<div class="avatar-sm" style="background:' + color + ';">' + escapeStr(t.agent || '?').charAt(0).toUpperCase() + '</div>';
      html += '<div><h2>' + escapeStr(t.description || t.task || 'Task') + '</h2>';
      html += '<p>' + escapeStr(t.agent || 'general') + ' &middot; <span class="status-dot ' + statusClass + '" style="display:inline-block;vertical-align:middle;"></span> ' + escapeStr(t.status || 'pending') + '</p></div>';
      html += '</div>';

      // Timestamps
      html += '<div class="card">';
      html += '<div style="font-size:13px;color:var(--hint);">';
      html += '<div>Created: ' + formatDate(t.created_at) + '</div>';
      if (t.started_at) html += '<div>Started: ' + formatDate(t.started_at) + '</div>';
      if (t.completed_at) html += '<div>Completed: ' + formatDate(t.completed_at) + '</div>';
      html += '</div></div>';

      // Result preview
      if (t.result) {
        html += '<div class="detail-section"><h3>Result</h3>';
        html += '<div class="card" style="font-size:13px;white-space:pre-wrap;word-break:break-word;">' + escapeStr(String(t.result).substring(0, 2000)) + '</div>';
        html += '</div>';
      }

      // Subtasks
      if (subtasks.length > 0) {
        var doneCount = subtasks.filter(function(s) { var ns = normalizeStatus(s.status); return ns === 'done'; }).length;
        html += '<div class="detail-section"><h3>Subtasks (' + doneCount + '/' + subtasks.length + ')</h3>';
        for (var i = 0; i < subtasks.length; i++) {
          var st = subtasks[i];
          var stStatus = normalizeStatus(st.status);
          html += '<div class="subtask-item">';
          html += '<div class="status-dot ' + stStatus + '"></div>';
          html += '<div style="flex:1;">';
          html += '<div style="font-size:14px;">' + escapeStr(st.description || st.task || 'Subtask') + '</div>';
          html += '<div style="font-size:12px;color:var(--hint);">' + escapeStr(st.agent || '') + ' &middot; ' + escapeStr(st.status || '') + '</div>';
          html += '</div></div>';
        }
        html += '</div>';
      }

      // Artifacts
      if (artifacts.length > 0) {
        html += '<div class="detail-section"><h3>Artifacts (' + artifacts.length + ')</h3>';
        for (var ai = 0; ai < artifacts.length; ai++) {
          var a = artifacts[ai];
          var typeIcon = {file:'📄',image:'🖼',document:'📋',project:'📁',code:'💻'}[a.artifact_type] || '📎';
          html += '<div class="artifact-item">';
          html += '<div class="artifact-icon">' + typeIcon + '</div>';
          html += '<div style="flex:1;min-width:0;">';
          html += '<div style="font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeStr(a.file_name || a.description || 'Artifact') + '</div>';
          html += '<div class="artifact-badges">';
          if (a.file_size) html += '<span class="artifact-badge pending-badge">' + formatFileSize(a.file_size) + '</span>';
          if (a.verified) html += '<span class="artifact-badge verified">Verified</span>';
          else html += '<span class="artifact-badge pending-badge">Unverified</span>';
          if (a.delivered) html += '<span class="artifact-badge delivered">Delivered</span>';
          html += '</div>';
          if (a.description && a.file_name) html += '<div style="font-size:12px;color:var(--hint);margin-top:2px;">' + escapeStr(a.description) + '</div>';
          html += '</div></div>';
        }
        html += '</div>';
      }

      container.innerHTML = html;
    }

    // ============================================================
    // DASHBOARD
    // ============================================================
    async function loadDashboard() {
      var data = await apiFetch('/dashboard');
      if (!data) return;
      renderDashboard(data);
    }

    function renderDashboard(d) {
      var container = document.getElementById('dashboardContent');
      var successRate = d.calls_total > 0 ? ((d.calls_success / d.calls_total) * 100).toFixed(0) : 'N/A';
      var avgSec = (d.avg_duration_ms / 1000).toFixed(1);

      var html = '';
      html += '<div class="stat-row">';
      html += '<div class="stat-item"><div class="stat-value">' + (d.uptime_hours || '0') + 'h</div><div class="stat-label">Uptime</div></div>';
      html += '<div class="stat-item"><div class="stat-value">' + d.calls_total + '</div><div class="stat-label">Total Calls</div></div>';
      html += '<div class="stat-item"><div class="stat-value">' + successRate + '%</div><div class="stat-label">Success</div></div>';
      html += '</div>';

      html += '<div class="card">';
      html += '<div class="toggle-row"><div class="toggle-label">Active Slots</div><div style="color:var(--accent);font-weight:600;">' + d.active_slots + '/' + d.max_slots + '</div></div>';
      html += '<div class="toggle-row"><div class="toggle-label">Queue Depth</div><div style="color:var(--accent);font-weight:600;">' + d.queue_depth + '</div></div>';
      html += '<div class="toggle-row"><div class="toggle-label">Active Tasks</div><div style="color:var(--accent);font-weight:600;">' + d.active_tasks + '</div></div>';
      html += '<div class="toggle-row"><div class="toggle-label">Pending Approvals</div><div style="color:var(--accent);font-weight:600;">' + d.pending_approvals + '</div></div>';
      html += '<div class="toggle-row"><div class="toggle-label">Avg Response</div><div style="color:var(--accent);font-weight:600;">' + avgSec + 's</div></div>';
      html += '<div class="toggle-row"><div class="toggle-label">Rate Limit Hits</div><div style="color:var(--accent);font-weight:600;">' + d.rate_limit_hits + '</div></div>';
      html += '</div>';

      // Model breakdown
      var models = d.calls_by_model || {};
      var modelKeys = Object.keys(models);
      if (modelKeys.length > 0) {
        html += '<div class="section-header">Calls by Model</div><div class="card">';
        for (var i = 0; i < modelKeys.length; i++) {
          var m = modelKeys[i];
          html += '<div class="toggle-row"><div class="toggle-label">' + escapeStr(m) + '</div><div style="color:var(--accent);font-weight:600;">' + models[m] + '</div></div>';
        }
        html += '</div>';
      }

      if (d.updated_at) {
        html += '<div style="text-align:center;font-size:12px;color:var(--hint);margin-top:12px;">Updated ' + timeAgo(d.updated_at) + '</div>';
      }
      container.innerHTML = html;
    }

    // ============================================================
    // INTEGRATIONS
    // ============================================================
    var PROVIDER_INFO = {
      'google-personal': { name: 'Google Personal', icon: '\uD83D\uDCE7', color: '#4285F4' },
      'google-work': { name: 'Google Work', icon: '\uD83C\uDFE2', color: '#0F9D58' },
      'notion': { name: 'Notion', icon: '\uD83D\uDCDD', color: '#000000' },
      'zoom': { name: 'Zoom', icon: '\uD83C\uDFA5', color: '#2D8CFF' },
      'gohighlevel': { name: 'Go High Level', icon: '\uD83C\uDFE2', color: '#FF6B35', apiKey: true },
      'clickup': { name: 'ClickUp', icon: '\u2705', color: '#7B68EE', apiKey: true }
    };

    async function loadIntegrations() {
      var data = await apiFetch('/integrations');
      if (!data) return;
      renderIntegrations(data.integrations || []);
    }

    function renderIntegrations(integrations) {
      var container = document.getElementById('integrationsList');
      if (!integrations.length) {
        container.innerHTML = '<div class="empty-state"><h3>No integrations available</h3></div>';
        return;
      }

      var html = '';
      for (var i = 0; i < integrations.length; i++) {
        var intg = integrations[i];
        var info = PROVIDER_INFO[intg.provider] || { name: intg.provider, icon: '\uD83D\uDD17', color: '#666' };
        var connected = intg.status === 'connected';
        var pending = intg.status === 'pending';
        var statusText = connected ? 'Connected' : pending ? 'Pending...' : intg.status === 'error' ? 'Error' : 'Not connected';
        var statusColor = connected ? '#22c55e' : pending ? '#f59e0b' : intg.status === 'error' ? '#ef4444' : 'var(--hint)';
        var accountInfo = intg.metadata && intg.metadata.email ? intg.metadata.email : (intg.metadata && intg.metadata.workspace_name ? intg.metadata.workspace_name : (intg.metadata && intg.metadata.location_id ? 'Location: ' + intg.metadata.location_id : ''));

        html += '<div class="card" style="display:flex;flex-direction:column;gap:10px;">';
        html += '<div style="display:flex;align-items:center;gap:14px;">';
        html += '<div class="avatar-sm" style="background:' + info.color + ';font-size:20px;">' + info.icon + '</div>';
        html += '<div style="flex:1;">';
        html += '<div style="font-weight:600;font-size:15px;">' + escapeStr(info.name) + '</div>';
        html += '<div style="font-size:12px;color:' + statusColor + ';">' + statusText + '</div>';
        if (accountInfo) html += '<div style="font-size:11px;color:var(--hint);">' + escapeStr(accountInfo) + '</div>';
        html += '</div>';

        if (connected) {
          html += '<button class="approval-btn cancel" style="flex:0 0 auto;padding:8px 16px;font-size:13px;" onclick="doDisconnect(\\'' + intg.provider + '\\')">Disconnect</button>';
        } else if (!pending && !info.apiKey) {
          html += '<button class="approval-btn approve" style="flex:0 0 auto;padding:8px 16px;font-size:13px;" onclick="doConnect(\\'' + intg.provider + '\\')">Connect</button>';
        }
        html += '</div>';

        // API-key providers: show input form when not connected
        if (info.apiKey && !connected) {
          html += '<div id="apikey-form-' + intg.provider + '" style="display:flex;flex-direction:column;gap:8px;padding-top:4px;">';
          if (intg.provider === 'gohighlevel') {
            html += '<input type="password" id="ghl-bearer-token" placeholder="Bearer Token" style="padding:10px 12px;border-radius:10px;border:1px solid var(--divider);background:var(--secondary-bg);color:var(--text);font-size:14px;" />';
            html += '<input type="text" id="ghl-location-id" placeholder="Location ID" style="padding:10px 12px;border-radius:10px;border:1px solid var(--divider);background:var(--secondary-bg);color:var(--text);font-size:14px;" />';
          }
          if (intg.provider === 'clickup') {
            html += '<input type="password" id="clickup-api-token" placeholder="API Token (pk_...)" style="padding:10px 12px;border-radius:10px;border:1px solid var(--divider);background:var(--secondary-bg);color:var(--text);font-size:14px;" />';
          }
          html += '<button class="approval-btn approve" style="padding:10px 16px;font-size:14px;width:100%;" onclick="doSaveApiKey(\\'' + intg.provider + '\\')">Save</button>';
          html += '</div>';
        }

        html += '</div>';
      }
      container.innerHTML = html;
    }

    async function doConnect(provider) {
      var data = await apiFetch('/integrations/' + encodeURIComponent(provider) + '/connect', { method: 'POST' });
      if (data && data.error) {
        showToast(data.error, 'error');
        return;
      }
      if (data && data.url) {
        // Telegram WebApp blocks window.open — use openLink instead
        if (window.Telegram && Telegram.WebApp && Telegram.WebApp.openLink) {
          Telegram.WebApp.openLink(data.url);
        } else {
          window.open(data.url, '_blank');
        }
        showToast('Complete the authorization in the browser', 'success');
        // Poll for status change
        var pollCount = 0;
        var pollInterval = setInterval(async function() {
          pollCount++;
          if (pollCount > 60) { clearInterval(pollInterval); return; } // 5 min timeout
          await loadIntegrations();
        }, 5000);
      }
    }

    async function doDisconnect(provider) {
      if (window.Telegram && Telegram.WebApp && Telegram.WebApp.HapticFeedback) {
        Telegram.WebApp.HapticFeedback.impactOccurred('medium');
      }
      var data = await apiFetch('/integrations/' + encodeURIComponent(provider) + '/disconnect', { method: 'POST' });
      if (data && data.success) {
        showToast('Disconnected', 'success');
        loadIntegrations();
      }
    }

    async function doSaveApiKey(provider) {
      var body = {};
      if (provider === 'gohighlevel') {
        var token = document.getElementById('ghl-bearer-token');
        var locId = document.getElementById('ghl-location-id');
        if (!token || !token.value.trim()) { showToast('Bearer Token is required', 'error'); return; }
        if (!locId || !locId.value.trim()) { showToast('Location ID is required', 'error'); return; }
        body = { bearer_token: token.value.trim(), location_id: locId.value.trim() };
      }
      if (provider === 'clickup') {
        var cuToken = document.getElementById('clickup-api-token');
        if (!cuToken || !cuToken.value.trim()) { showToast('API Token is required', 'error'); return; }
        body = { api_token: cuToken.value.trim() };
      }
      var data = await apiFetch('/integrations/' + encodeURIComponent(provider) + '/save-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (data && data.error) {
        showToast(data.error, 'error');
        return;
      }
      if (data && data.success) {
        showToast('Connected!', 'success');
        if (window.Telegram && Telegram.WebApp && Telegram.WebApp.HapticFeedback) {
          Telegram.WebApp.HapticFeedback.notificationOccurred('success');
        }
        loadIntegrations();
      }
    }

    // ============================================================
    // WHATSAPP
    // ============================================================
    var waPollingInterval = null;

    async function loadWhatsApp() {
      var data = await apiFetch('/whatsapp/status');
      if (!data) return;
      renderWhatsApp(data);
    }

    function renderWhatsApp(status) {
      var container = document.getElementById('whatsappCard');
      if (!container) return;

      var state = status.state || 'disconnected';
      var html = '<div class="card" style="display:flex;flex-direction:column;gap:10px;">';
      html += '<div style="display:flex;align-items:center;gap:14px;">';
      html += '<div class="avatar-sm" style="background:#25D366;font-size:20px;">\\uD83D\\uDCAC</div>';
      html += '<div style="flex:1;">';
      html += '<div style="font-weight:600;font-size:15px;">WhatsApp</div>';

      if (state === 'connected') {
        html += '<div style="font-size:12px;color:#22c55e;">Connected</div>';
        if (status.phoneNumber) html += '<div style="font-size:11px;color:var(--hint);">+' + escapeStr(status.phoneNumber) + '</div>';
        html += '</div>';
        html += '<button class="approval-btn cancel" style="flex:0 0 auto;padding:8px 16px;font-size:13px;" onclick="waDisconnect()">Disconnect</button>';
      } else if (state === 'pairing_code') {
        html += '<div style="font-size:12px;color:#f59e0b;">Enter code in WhatsApp</div>';
        html += '</div></div>';
        if (status.pairingCode) {
          html += '<div style="text-align:center;padding:20px;background:rgba(255,255,255,0.055);border:1px solid rgba(255,255,255,0.10);border-radius:14px;">';
          html += '<div style="font-size:36px;font-weight:700;letter-spacing:8px;color:#fff;font-family:monospace;">' + escapeStr(status.pairingCode) + '</div>';
          html += '</div>';
          html += '<div style="font-size:12px;color:var(--hint);text-align:center;margin-top:8px;">Open WhatsApp > Settings > Linked Devices > Link a Device > Link with phone number instead</div>';
        } else {
          html += '<div style="text-align:center;padding:16px;color:var(--hint);font-size:13px;">Requesting pairing code...</div>';
        }
        if (!waPollingInterval) {
          waPollingInterval = setInterval(loadWhatsApp, 3000);
        }
      } else if (state === 'qr_pending') {
        html += '<div style="font-size:12px;color:#f59e0b;">Scan QR Code</div>';
        html += '</div></div>';
        if (status.qrDataUrl) {
          html += '<div style="text-align:center;padding:12px;background:rgba(255,255,255,0.95);border-radius:12px;">';
          html += '<img src="' + status.qrDataUrl + '" style="width:240px;height:240px;" alt="QR Code" />';
          html += '</div>';
          html += '<div style="font-size:12px;color:var(--hint);text-align:center;">Open WhatsApp > Settings > Linked Devices > Link a Device</div>';
        }
        if (!waPollingInterval) {
          waPollingInterval = setInterval(loadWhatsApp, 5000);
        }
      } else {
        html += '<div style="font-size:12px;color:var(--hint);">Not connected</div>';
        html += '</div>';
        html += '<div style="display:flex;gap:8px;align-items:center;margin-top:4px;">';
        html += '<input type="tel" id="waPhoneInput" placeholder="+1 555 123 4567" style="flex:1;padding:10px 12px;border-radius:8px;border:1px solid rgba(255,255,255,0.10);background:rgba(255,255,255,0.055);color:var(--text);font-size:14px;outline:none;" />';
        html += '<button class="approval-btn approve" style="flex:0 0 auto;padding:10px 16px;font-size:13px;" onclick="waConnect()">Connect</button>';
        html += '</div>';
      }

      if (state !== 'qr_pending' && state !== 'pairing_code') html += '</div>';

      // Management sections for connected state
      if (state === 'connected') {
        html += '<div style="border-top:1px solid var(--hint);padding-top:10px;margin-top:4px;">';
        html += '<div style="display:flex;gap:8px;">';
        html += '<button class="approval-btn" style="flex:1;padding:8px;font-size:13px;background:var(--secondary-bg);color:var(--text);border:1px solid var(--hint);" onclick="waShowContacts()">Manage Contacts</button>';
        html += '<button class="approval-btn" style="flex:1;padding:8px;font-size:13px;background:var(--secondary-bg);color:var(--text);border:1px solid var(--hint);" onclick="waShowGroups()">Manage Groups</button>';
        html += '</div></div>';
      }

      html += '</div>';

      // Contacts/Groups management panels
      html += '<div id="waContactsPanel" style="display:none;margin-top:8px;"></div>';
      html += '<div id="waGroupsPanel" style="display:none;margin-top:8px;"></div>';

      container.innerHTML = html;

      // Stop polling if connected or disconnected
      if (state !== 'qr_pending' && state !== 'pairing_code' && waPollingInterval) {
        clearInterval(waPollingInterval);
        waPollingInterval = null;
      }
    }

    async function waConnect() {
      var phoneInput = document.getElementById('waPhoneInput');
      var phone = phoneInput ? phoneInput.value.replace(/[^0-9+]/g, '') : '';
      if (!phone) { showToast('Enter your WhatsApp phone number', 'error'); return; }
      showToast('Connecting WhatsApp...', 'success');
      var data = await apiFetch('/whatsapp/connect', { method: 'POST', body: { phone: phone } });
      if (data && data.error) { showToast(data.error, 'error'); return; }
      renderWhatsApp(data);
    }

    async function waDisconnect() {
      if (window.Telegram && Telegram.WebApp && Telegram.WebApp.HapticFeedback) {
        Telegram.WebApp.HapticFeedback.impactOccurred('medium');
      }
      var data = await apiFetch('/whatsapp/disconnect', { method: 'POST' });
      if (data && data.success) {
        showToast('WhatsApp disconnected', 'success');
        loadWhatsApp();
      }
    }

    async function waShowContacts() {
      var panel = document.getElementById('waContactsPanel');
      if (!panel) return;
      if (panel.style.display !== 'none') { panel.style.display = 'none'; return; }
      document.getElementById('waGroupsPanel').style.display = 'none';
      panel.style.display = 'block';
      panel.innerHTML = '<div class="loading"><div class="spinner"></div>Loading...</div>';

      var data = await apiFetch('/whatsapp/contacts');
      var contacts = (data && data.contacts) || [];

      var html = '<div class="card" style="padding:12px;">';
      html += '<div style="font-weight:600;margin-bottom:10px;">WhatsApp Contacts</div>';

      // Add form
      html += '<div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap;">';
      html += '<input type="text" id="wa-c-phone" placeholder="+1555..." style="flex:1;min-width:100px;padding:8px;border-radius:8px;border:1px solid var(--hint);background:var(--secondary-bg);color:var(--text);font-size:13px;" />';
      html += '<input type="text" id="wa-c-name" placeholder="Name" style="flex:1;min-width:80px;padding:8px;border-radius:8px;border:1px solid var(--hint);background:var(--secondary-bg);color:var(--text);font-size:13px;" />';
      html += '<select id="wa-c-role" style="padding:8px;border-radius:8px;border:1px solid var(--hint);background:var(--secondary-bg);color:var(--text);font-size:13px;">';
      html += '<option value="allowed">Allowed</option><option value="vip">VIP</option><option value="blocked">Blocked</option></select>';
      html += '<button class="approval-btn approve" style="padding:8px 12px;font-size:13px;" onclick="waAddContact()">Add</button>';
      html += '</div>';

      // Contact list
      if (contacts.length === 0) {
        html += '<div style="color:var(--hint);font-size:13px;text-align:center;padding:12px;">No contacts. Add contacts to control who can message Nova via your WhatsApp.</div>';
      } else {
        for (var i = 0; i < contacts.length; i++) {
          var c = contacts[i];
          var roleColor = c.role === 'vip' ? '#f59e0b' : c.role === 'blocked' ? '#ef4444' : '#22c55e';
          html += '<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--secondary-bg);">';
          html += '<div style="flex:1;"><div style="font-size:14px;">' + escapeStr(c.name || c.phone) + '</div>';
          html += '<div style="font-size:11px;color:var(--hint);">' + escapeStr(c.phone) + '</div></div>';
          html += '<span style="font-size:11px;color:' + roleColor + ';text-transform:uppercase;">' + c.role + '</span>';
          html += '<button style="background:none;border:none;color:var(--destructive);font-size:16px;cursor:pointer;padding:4px;" onclick="waDeleteContact(\\'' + escapeStr(c.phone) + '\\')">&times;</button>';
          html += '</div>';
        }
      }
      html += '</div>';
      panel.innerHTML = html;
    }

    async function waAddContact() {
      var phone = document.getElementById('wa-c-phone').value.trim();
      var name = document.getElementById('wa-c-name').value.trim();
      var role = document.getElementById('wa-c-role').value;
      if (!phone) { showToast('Phone number required', 'error'); return; }
      var data = await apiFetch('/whatsapp/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone, name: name || null, role: role, permissions: { calendar: true, tasks: true, memory_public: true, memory_private: false, schedule_events: role === 'vip', support: true } })
      });
      if (data && data.error) { showToast(data.error, 'error'); return; }
      showToast('Contact added', 'success');
      waShowContacts(); waShowContacts(); // toggle off then on to refresh
    }

    async function waDeleteContact(phone) {
      var data = await apiFetch('/whatsapp/contacts/' + encodeURIComponent(phone), { method: 'DELETE' });
      if (data && data.success) { showToast('Contact removed', 'success'); waShowContacts(); waShowContacts(); }
    }

    async function waShowGroups() {
      var panel = document.getElementById('waGroupsPanel');
      if (!panel) return;
      if (panel.style.display !== 'none') { panel.style.display = 'none'; return; }
      document.getElementById('waContactsPanel').style.display = 'none';
      panel.style.display = 'block';
      panel.innerHTML = '<div class="loading"><div class="spinner"></div>Loading...</div>';

      var data = await apiFetch('/whatsapp/groups');
      var groups = (data && data.groups) || [];

      var html = '<div class="card" style="padding:12px;">';
      html += '<div style="font-weight:600;margin-bottom:10px;">Whitelisted Groups</div>';

      // Add form
      html += '<div style="display:flex;gap:6px;margin-bottom:10px;">';
      html += '<input type="text" id="wa-g-jid" placeholder="Group JID (e.g. 120363...@g.us)" style="flex:2;padding:8px;border-radius:8px;border:1px solid var(--hint);background:var(--secondary-bg);color:var(--text);font-size:13px;" />';
      html += '<input type="text" id="wa-g-name" placeholder="Name" style="flex:1;padding:8px;border-radius:8px;border:1px solid var(--hint);background:var(--secondary-bg);color:var(--text);font-size:13px;" />';
      html += '<button class="approval-btn approve" style="padding:8px 12px;font-size:13px;" onclick="waAddGroup()">Add</button>';
      html += '</div>';

      if (groups.length === 0) {
        html += '<div style="color:var(--hint);font-size:13px;text-align:center;padding:12px;">No groups whitelisted. Nova will only respond in whitelisted groups when @mentioned.</div>';
      } else {
        for (var i = 0; i < groups.length; i++) {
          var g = groups[i];
          html += '<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--secondary-bg);">';
          html += '<div style="flex:1;"><div style="font-size:14px;">' + escapeStr(g.name || g.group_jid) + '</div>';
          html += '<div style="font-size:11px;color:var(--hint);">' + escapeStr(g.group_jid) + '</div></div>';
          html += '<span style="font-size:11px;color:' + (g.active ? '#22c55e' : '#ef4444') + ';">' + (g.active ? 'Active' : 'Inactive') + '</span>';
          html += '<button style="background:none;border:none;color:var(--destructive);font-size:16px;cursor:pointer;padding:4px;" onclick="waDeleteGroup(\\'' + escapeStr(g.group_jid) + '\\')">&times;</button>';
          html += '</div>';
        }
      }
      html += '</div>';
      panel.innerHTML = html;
    }

    async function waAddGroup() {
      var jid = document.getElementById('wa-g-jid').value.trim();
      var name = document.getElementById('wa-g-name').value.trim();
      if (!jid) { showToast('Group JID required', 'error'); return; }
      var data = await apiFetch('/whatsapp/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_jid: jid, name: name || null, active: true })
      });
      if (data && data.error) { showToast(data.error, 'error'); return; }
      showToast('Group added', 'success');
      waShowGroups(); waShowGroups();
    }

    async function waDeleteGroup(jid) {
      var data = await apiFetch('/whatsapp/groups/' + encodeURIComponent(jid), { method: 'DELETE' });
      if (data && data.success) { showToast('Group removed', 'success'); waShowGroups(); waShowGroups(); }
    }

    // ============================================================
    // SCHEDULES
    // ============================================================
    async function loadSchedules() {
      var data = await apiFetch('/schedules');
      if (!data) return;
      renderSchedules(data.schedules || []);
    }

    function renderSchedules(schedules) {
      var container = document.getElementById('schedulesList');
      if (!schedules.length) {
        container.innerHTML = '<div class="empty-state"><svg viewBox="0 0 24 24"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg><h3>No Scheduled Tasks</h3><p>Scheduled reminders and recurring tasks will appear here.</p></div>';
        return;
      }

      var html = '';
      for (var i = 0; i < schedules.length; i++) {
        var s = schedules[i];
        var recurText = s.recurrence ? s.recurrence : 'one-time';
        var triggerText = s.trigger_at ? new Date(s.trigger_at).toLocaleString() : 'not scheduled';
        var creator = s.created_by === 'nova' ? ' (Nova)' : '';

        html += '<div class="card" style="position:relative;">';
        html += '<div style="font-weight:600;font-size:15px;">' + escapeStr(s.title || 'Task') + '<span style="color:var(--hint);font-size:12px;">' + creator + '</span></div>';
        html += '<div style="font-size:13px;color:var(--hint);margin-top:4px;">' + escapeStr(triggerText) + ' &middot; ' + escapeStr(recurText) + '</div>';
        if (s.condition) {
          html += '<div style="font-size:12px;color:var(--accent);margin-top:4px;">IF: ' + escapeStr(s.condition) + '</div>';
        }
        if (s.instructions) {
          html += '<div style="font-size:12px;color:var(--hint);margin-top:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">' + escapeStr(s.instructions) + '</div>';
        }
        html += '<button class="approval-btn cancel" style="position:absolute;top:12px;right:12px;padding:6px 12px;font-size:12px;" onclick="doCancelSchedule(\\'' + s.id + '\\')">Cancel</button>';
        html += '</div>';
      }
      container.innerHTML = html;
    }

    async function doCancelSchedule(id) {
      if (window.Telegram && Telegram.WebApp && Telegram.WebApp.HapticFeedback) {
        Telegram.WebApp.HapticFeedback.impactOccurred('medium');
      }
      var data = await apiFetch('/schedules/' + encodeURIComponent(id) + '/cancel', { method: 'POST' });
      if (data && data.success) {
        showToast('Schedule cancelled', 'success');
        loadSchedules();
      }
    }

    // ============================================================
    // USERS (admin)
    // ============================================================
    var isAdmin = false;

    async function loadUsers() {
      var data = await apiFetch('/users');
      if (!data) {
        // Hide add form if not admin
        document.getElementById('addUserForm').style.display = 'none';
        return;
      }
      isAdmin = true;
      renderUsers(data.users || []);
    }

    function renderUsers(users) {
      var container = document.getElementById('usersList');
      if (!users.length) {
        container.innerHTML = '<div class="empty-state"><h3>No users</h3></div>';
        return;
      }

      var html = '';
      for (var i = 0; i < users.length; i++) {
        var u = users[i];
        var statusDot = u.active ? '#22c55e' : 'var(--hint)';
        html += '<div class="card" style="display:flex;align-items:center;gap:12px;">';
        html += '<div style="width:10px;height:10px;border-radius:50%;background:' + statusDot + ';flex-shrink:0;"></div>';
        html += '<div style="flex:1;">';
        html += '<div style="font-weight:600;font-size:15px;">' + escapeStr(u.name) + '</div>';
        html += '<div style="font-size:12px;color:var(--hint);">' + escapeStr(u.telegram_id) + ' &middot; ' + escapeStr(u.role) + ' &middot; ' + escapeStr(u.timezone || 'UTC') + '</div>';
        html += '</div>';
        if (u.active) {
          html += '<button class="approval-btn cancel" style="flex:0 0 auto;padding:6px 12px;font-size:12px;" onclick="doDeactivateUser(\\'' + u.id + '\\', \\'' + escapeStr(u.name) + '\\')">Remove</button>';
        }
        html += '</div>';
      }
      container.innerHTML = html;
    }

    async function addNewUser() {
      var telegramId = document.getElementById('newUserTelegramId').value.trim();
      var name = document.getElementById('newUserName').value.trim();
      var timezone = document.getElementById('newUserTimezone').value.trim() || 'UTC';
      if (!telegramId || !name) { showToast('Telegram ID and name are required', 'error'); return; }

      var data = await apiFetch('/users', { method: 'POST', body: { telegram_id: telegramId, name: name, timezone: timezone } });
      if (data && data.user) {
        showToast('User added', 'success');
        document.getElementById('newUserTelegramId').value = '';
        document.getElementById('newUserName').value = '';
        loadUsers();
      }
    }

    async function doDeactivateUser(id, name) {
      if (window.Telegram && Telegram.WebApp && Telegram.WebApp.HapticFeedback) {
        Telegram.WebApp.HapticFeedback.impactOccurred('medium');
      }
      var data = await apiFetch('/users/' + encodeURIComponent(id), { method: 'DELETE' });
      if (data && data.success) {
        showToast(name + ' deactivated', 'success');
        loadUsers();
      }
    }

    // ============================================================
    // UTILITY
    // ============================================================
    function escapeStr(str) {
      if (!str) return '';
      var div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    function timeAgo(dateStr) {
      if (!dateStr) return '';
      var now = Date.now();
      var then = new Date(dateStr).getTime();
      var diff = Math.max(0, now - then);
      var secs = Math.floor(diff / 1000);
      if (secs < 60) return 'just now';
      var mins = Math.floor(secs / 60);
      if (mins < 60) return mins + 'm ago';
      var hours = Math.floor(mins / 60);
      if (hours < 24) return hours + 'h ago';
      var days = Math.floor(hours / 24);
      if (days < 7) return days + 'd ago';
      return new Date(dateStr).toLocaleDateString();
    }

    function formatDate(dateStr) {
      if (!dateStr) return '-';
      return new Date(dateStr).toLocaleString();
    }

    function formatFileSize(bytes) {
      if (!bytes || bytes <= 0) return '0 B';
      var units = ['B', 'KB', 'MB', 'GB'];
      var i = 0;
      var size = bytes;
      while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
      return (i === 0 ? size : size.toFixed(1)) + ' ' + units[i];
    }
  </script>
</body>
</html>`;
}

// ============================================================
// SERVER
// ============================================================

// Load agents on startup
await loadAgents();

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // CORS preflight
    if (method === "OPTIONS") {
      return corsResponse();
    }

    // Health check
    if (path === "/health") {
      return jsonResponse({ status: "ok", service: "nova-miniapp", uptime: Math.floor((Date.now() - startTime) / 1000) });
    }

    // Serve SPA
    if (path === "/" || path === "/index.html") {
      return new Response(renderMiniApp(), {
        headers: {
          "Content-Type": "text/html",
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://telegram.org; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'",
        },
      });
    }

    // ---- OAuth callback (no auth required — comes from provider) ----
    if (path === "/api/integrations/callback" && method === "GET") {
      const stateParam = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        return new Response(renderOAuthResult(false, `OAuth error: ${error}`), {
          headers: { "Content-Type": "text/html" },
        });
      }

      if (!stateParam || !code) {
        return new Response(renderOAuthResult(false, "Missing state or code"), {
          headers: { "Content-Type": "text/html" },
        });
      }

      try {
        const state = verifyOAuthState(stateParam);

        if (!state) {
          return new Response(renderOAuthResult(false, "Invalid or tampered callback state"), {
            headers: { "Content-Type": "text/html" },
          });
        }

        const { provider, userId } = state;

        if (!provider || !userId) {
          return new Response(renderOAuthResult(false, "Invalid callback state"), {
            headers: { "Content-Type": "text/html" },
          });
        }

        const result = await handleOAuthCallback(supabase, provider, code, userId);

        if (result.success) {
          return new Response(renderOAuthResult(true, `${provider} connected successfully!`), {
            headers: { "Content-Type": "text/html" },
          });
        } else {
          return new Response(renderOAuthResult(false, result.error || "Connection failed"), {
            headers: { "Content-Type": "text/html" },
          });
        }
      } catch (e: any) {
        return new Response(renderOAuthResult(false, e.message), {
          headers: { "Content-Type": "text/html" },
        });
      }
    }

    // ---- API routes (require auth) ----
    if (path.startsWith("/api/")) {
      const authResult = await authenticateRequest(req);
      if (authResult instanceof Response) return authResult;

      const { user } = authResult;
      const userId = user.id;

      // Profile
      if (path === "/api/profile" && method === "GET") {
        return jsonResponse(await getProfile(userId));
      }
      if (path === "/api/profile" && method === "PUT") {
        const body = await req.json().catch(() => ({}));
        return jsonResponse(await updateProfile(userId, body));
      }
      if (path === "/api/preferences" && method === "PUT") {
        const body = await req.json().catch(() => ({}));
        return jsonResponse(await updatePreferences(userId, body));
      }

      // AI Provider
      if (path === "/api/ai-provider" && method === "GET") {
        const currentUser = supabase.getUserById(userId);
        const providers = getAllProviders();
        const available: Record<string, boolean> = {};
        for (const p of providers) {
          available[p.name] = await p.isAvailable();
        }
        return jsonResponse({
          current: currentUser?.ai_provider || "claude",
          providers: providers.map(p => ({
            name: p.name,
            models: p.models,
            defaultModel: p.defaultModel,
            available: available[p.name] ?? false,
          })),
          smartAvailable: Object.values(available).filter(Boolean).length > 1,
        });
      }
      if (path === "/api/ai-provider" && method === "POST") {
        const body = await req.json().catch(() => ({}));
        const provider = body.provider;
        const validProviders = ["claude", "gemini", "codex", "smart"];
        if (!provider || !validProviders.includes(provider)) {
          return jsonResponse({ error: "Invalid provider. Choose: claude, gemini, codex, or smart" }, 400);
        }
        const updated = supabase.updateUser(userId, { ai_provider: provider });
        return jsonResponse({ ai_provider: updated?.ai_provider || provider });
      }

      // Agents
      if (path === "/api/agents" && method === "GET") {
        return jsonResponse(await getAgentsWithStats(userId));
      }

      // Agent tasks: /api/agents/:slug/tasks
      const agentTaskMatch = path.match(/^\/api\/agents\/([^/]+)\/tasks$/);
      if (agentTaskMatch && method === "GET") {
        return jsonResponse(await getAgentTasks(userId, decodeURIComponent(agentTaskMatch[1])));
      }

      // Approvals
      if (path === "/api/approvals" && method === "GET") {
        return jsonResponse(await getApprovals(userId));
      }

      // Approval actions: /api/approvals/:id/approve|cancel|revise
      const approvalMatch = path.match(/^\/api\/approvals\/([^/]+)\/(approve|cancel|revise)$/);
      if (approvalMatch && method === "POST") {
        const approvalId = decodeURIComponent(approvalMatch[1]);
        const action = approvalMatch[2];
        const statusMap: Record<string, "approved" | "cancelled" | "revised"> = {
          approve: "approved",
          cancel: "cancelled",
          revise: "revised",
        };
        let feedback: string | undefined;
        if (action === "revise") {
          const body = await req.json().catch(() => ({}));
          feedback = body.feedback;
        }
        return jsonResponse(await handleApprovalAction(userId, approvalId, statusMap[action], feedback));
      }

      // Task history
      if (path === "/api/tasks" && method === "GET") {
        return jsonResponse(await getTaskHistory(userId));
      }

      // Task detail: /api/tasks/:id
      const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
      if (taskMatch && method === "GET") {
        return jsonResponse(await getTaskDetail(userId, decodeURIComponent(taskMatch[1])));
      }

      // Dashboard
      if (path === "/api/dashboard" && method === "GET") {
        return jsonResponse(await getDashboard());
      }

      // Integrations
      if (path === "/api/integrations" && method === "GET") {
        return jsonResponse(await getIntegrations(userId));
      }

      // Connect integration: /api/integrations/:provider/connect
      const connectMatch = path.match(/^\/api\/integrations\/([^/]+)\/connect$/);
      if (connectMatch && method === "POST") {
        return jsonResponse(await connectIntegration(userId, decodeURIComponent(connectMatch[1])));
      }

      // Save API-key integration: /api/integrations/:provider/save-key
      const saveKeyMatch = path.match(/^\/api\/integrations\/([^/]+)\/save-key$/);
      if (saveKeyMatch && method === "POST") {
        return jsonResponse(await saveApiKeyHandler(userId, decodeURIComponent(saveKeyMatch[1]), req));
      }

      // Disconnect integration: /api/integrations/:provider/disconnect
      const disconnectMatch = path.match(/^\/api\/integrations\/([^/]+)\/disconnect$/);
      if (disconnectMatch && method === "POST") {
        return jsonResponse(await disconnectIntegrationHandler(userId, decodeURIComponent(disconnectMatch[1])));
      }

      // WhatsApp
      if (path === "/api/whatsapp/connect" && method === "POST") {
        const body = await req.json().catch(() => ({}));
        return jsonResponse(await whatsappConnect(userId, body.phone));
      }
      if (path === "/api/whatsapp/status" && method === "GET") {
        return jsonResponse(await whatsappStatus(userId));
      }
      if (path === "/api/whatsapp/disconnect" && method === "POST") {
        return jsonResponse(await whatsappDisconnect(userId));
      }
      if (path === "/api/whatsapp/contacts" && method === "GET") {
        return jsonResponse(await whatsappGetContacts(userId));
      }
      if (path === "/api/whatsapp/contacts" && method === "POST") {
        const body = await req.json().catch(() => ({}));
        return jsonResponse(await whatsappUpsertContact(userId, body));
      }
      const waContactDelete = path.match(/^\/api\/whatsapp\/contacts\/(.+)$/);
      if (waContactDelete && method === "DELETE") {
        return jsonResponse(await whatsappDeleteContact(userId, waContactDelete[1]));
      }
      if (path === "/api/whatsapp/groups" && method === "GET") {
        return jsonResponse(await whatsappGetGroups(userId));
      }
      if (path === "/api/whatsapp/groups" && method === "POST") {
        const body = await req.json().catch(() => ({}));
        return jsonResponse(await whatsappUpsertGroup(userId, body));
      }
      const waGroupDelete = path.match(/^\/api\/whatsapp\/groups\/(.+)$/);
      if (waGroupDelete && method === "DELETE") {
        return jsonResponse(await whatsappDeleteGroup(userId, waGroupDelete[1]));
      }

      // Schedules
      if (path === "/api/schedules" && method === "GET") {
        return jsonResponse(await getSchedules(userId));
      }

      // Cancel schedule: /api/schedules/:id/cancel
      const scheduleCancelMatch = path.match(/^\/api\/schedules\/([^/]+)\/cancel$/);
      if (scheduleCancelMatch && method === "POST") {
        return jsonResponse(await cancelSchedule(userId, decodeURIComponent(scheduleCancelMatch[1])));
      }

      // Users (admin only)
      if (path === "/api/users" && method === "GET") {
        if (user.role !== "admin") return jsonResponse({ error: "Admin only" }, 403);
        return jsonResponse(await listUsers());
      }
      if (path === "/api/users" && method === "POST") {
        if (user.role !== "admin") return jsonResponse({ error: "Admin only" }, 403);
        const body = await req.json().catch(() => ({}));
        return jsonResponse(await addUser(body));
      }

      // Delete/deactivate user: /api/users/:id
      const userDeleteMatch = path.match(/^\/api\/users\/([^/]+)$/);
      if (userDeleteMatch && method === "DELETE") {
        if (user.role !== "admin") return jsonResponse({ error: "Admin only" }, 403);
        return jsonResponse(await deactivateUser(decodeURIComponent(userDeleteMatch[1])));
      }

      return jsonResponse({ error: "Not found" }, 404);
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Nova Mini App running on http://localhost:${PORT}`);
console.log("Routes:");
console.log("  GET  /                                    — Mini App SPA (8 tabs)");
console.log("  GET  /health                              — Health check");
console.log("  GET  /api/dashboard                       — System status metrics");
console.log("  GET  /api/profile                         — User profile + preferences");
console.log("  PUT  /api/profile                         — Update profile fields");
console.log("  PUT  /api/preferences                     — Update preference fields");
console.log("  GET  /api/ai-provider                     — Current AI provider + availability");
console.log("  POST /api/ai-provider                     — Set AI provider (claude/gemini/smart)");
console.log("  GET  /api/integrations                    — Integration statuses");
console.log("  POST /api/integrations/:provider/connect  — Start OAuth flow");
console.log("  POST /api/integrations/:provider/save-key  — Save API-key integration");
console.log("  POST /api/integrations/:provider/disconnect — Disconnect");
console.log("  GET  /api/integrations/callback           — OAuth callback");
console.log("  POST /api/whatsapp/connect                — Start WhatsApp session");
console.log("  GET  /api/whatsapp/status                 — WhatsApp connection status");
console.log("  POST /api/whatsapp/disconnect             — Disconnect WhatsApp");
console.log("  GET  /api/whatsapp/contacts               — List WhatsApp contacts");
console.log("  POST /api/whatsapp/contacts               — Upsert WhatsApp contact");
console.log("  DELETE /api/whatsapp/contacts/:phone      — Delete WhatsApp contact");
console.log("  GET  /api/whatsapp/groups                 — List WhatsApp groups");
console.log("  POST /api/whatsapp/groups                 — Upsert WhatsApp group");
console.log("  DELETE /api/whatsapp/groups/:jid          — Delete WhatsApp group");
console.log("  GET  /api/agents                          — Agent list with stats");
console.log("  GET  /api/agents/:slug/tasks              — Agent task history");
console.log("  GET  /api/schedules                       — Active scheduled tasks");
console.log("  POST /api/schedules/:id/cancel            — Cancel scheduled task");
console.log("  GET  /api/users                           — List users (admin)");
console.log("  POST /api/users                           — Add user (admin)");
console.log("  DELETE /api/users/:id                     — Deactivate user (admin)");
console.log("  GET  /api/approvals                       — Pending approvals");
console.log("  POST /api/approvals/:id/approve           — Approve");
console.log("  POST /api/approvals/:id/cancel            — Cancel");
console.log("  POST /api/approvals/:id/revise            — Revise with feedback");
console.log("  GET  /api/tasks                           — Task history");
console.log("  GET  /api/tasks/:id                       — Task detail with subtasks");
