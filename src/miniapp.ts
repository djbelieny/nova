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
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { getAllAgents, loadAgents } from "./agent-router.ts";

// ============================================================
// CONFIGURATION
// ============================================================

const PORT = parseInt(process.env.MINIAPP_PORT || "3034", 10);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

const supabase: SupabaseClient | null =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

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
  if (!supabase) return null;
  try {
    const { data } = await supabase
      .from("users")
      .select("*")
      .eq("telegram_id", String(telegramUserId))
      .single();
    return data;
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
  if (!supabase) return { error: "Supabase not configured" };
  try {
    const [{ data: user, error: userErr }, { data: prefs, error: prefsErr }] = await Promise.all([
      supabase.from("users").select("*").eq("id", userId).single(),
      supabase.from("user_preferences").select("*").eq("user_id", userId).single(),
    ]);

    return {
      user: user || null,
      preferences: prefs || null,
      error: userErr?.message || prefsErr?.message || null,
    };
  } catch (e: any) {
    return { error: e.message };
  }
}

async function updateProfile(userId: string, fields: Record<string, any>): Promise<unknown> {
  if (!supabase) return { error: "Supabase not configured" };
  try {
    const allowed = ["name", "timezone", "phone"];
    const updates: Record<string, any> = {};
    for (const key of allowed) {
      if (fields[key] !== undefined) updates[key] = fields[key];
    }
    if (Object.keys(updates).length === 0) return { error: "No valid fields to update" };

    const { data, error } = await supabase
      .from("users")
      .update(updates)
      .eq("id", userId)
      .select()
      .single();

    if (error) return { error: error.message };
    return { user: data };
  } catch (e: any) {
    return { error: e.message };
  }
}

async function updatePreferences(userId: string, fields: Record<string, any>): Promise<unknown> {
  if (!supabase) return { error: "Supabase not configured" };
  try {
    const allowed = ["voice_responses", "notification_style", "language", "auto_approve"];
    const updates: Record<string, any> = {};
    for (const key of allowed) {
      if (fields[key] !== undefined) updates[key] = fields[key];
    }
    if (Object.keys(updates).length === 0) return { error: "No valid fields to update" };

    // Upsert: try update first, then insert if not found
    const { data: existing } = await supabase
      .from("user_preferences")
      .select("id")
      .eq("user_id", userId)
      .single();

    if (existing) {
      const { data, error } = await supabase
        .from("user_preferences")
        .update(updates)
        .eq("user_id", userId)
        .select()
        .single();
      if (error) return { error: error.message };
      return { preferences: data };
    } else {
      const { data, error } = await supabase
        .from("user_preferences")
        .insert({ user_id: userId, ...updates })
        .select()
        .single();
      if (error) return { error: error.message };
      return { preferences: data };
    }
  } catch (e: any) {
    return { error: e.message };
  }
}

async function getAgentsWithStats(userId: string): Promise<unknown> {
  const agentDefs = getAllAgents();
  if (!supabase) {
    return {
      agents: agentDefs.map((a) => ({
        name: a.name,
        slug: a.slug,
        description: a.description,
        taskCount: 0,
        successRate: 0,
      })),
    };
  }

  try {
    const { data: tasks } = await supabase
      .from("agent_tasks")
      .select("agent, status")
      .eq("user_id", userId);

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
  if (!supabase) return { tasks: [], error: "Supabase not configured" };
  try {
    const { data, error } = await supabase
      .from("agent_tasks")
      .select("*")
      .eq("user_id", userId)
      .eq("agent", agentSlug)
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) return { tasks: [], error: error.message };
    return { tasks: data || [] };
  } catch (e: any) {
    return { tasks: [], error: e.message };
  }
}

async function getApprovals(userId: string): Promise<unknown> {
  if (!supabase) return { approvals: [], error: "Supabase not configured" };
  try {
    const { data, error } = await supabase
      .from("pending_approvals")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "pending")
      .order("created_at", { ascending: false });

    if (error) return { approvals: [], error: error.message };
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
  if (!supabase) return { error: "Supabase not configured" };
  try {
    const updates: Record<string, any> = { status: action, updated_at: new Date().toISOString() };
    if (action === "revised" && feedback) {
      updates.feedback = feedback;
    }

    const { data, error } = await supabase
      .from("pending_approvals")
      .update(updates)
      .eq("id", approvalId)
      .eq("user_id", userId)
      .select()
      .single();

    if (error) return { error: error.message };
    return { approval: data };
  } catch (e: any) {
    return { error: e.message };
  }
}

async function getTaskHistory(userId: string): Promise<unknown> {
  if (!supabase) return { tasks: [], error: "Supabase not configured" };
  try {
    const { data, error } = await supabase
      .from("agent_tasks")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) return { tasks: [], error: error.message };
    return { tasks: data || [] };
  } catch (e: any) {
    return { tasks: [], error: e.message };
  }
}

async function getTaskDetail(userId: string, taskId: string): Promise<unknown> {
  if (!supabase) return { error: "Supabase not configured" };
  try {
    const [{ data: task, error: taskErr }, { data: subtasks, error: subErr }] = await Promise.all([
      supabase.from("agent_tasks").select("*").eq("id", taskId).eq("user_id", userId).single(),
      supabase
        .from("agent_tasks")
        .select("*")
        .eq("parent_task_id", taskId)
        .order("created_at", { ascending: true }),
    ]);

    if (taskErr) return { error: taskErr.message };
    return { task, subtasks: subtasks || [] };
  } catch (e: any) {
    return { error: e.message };
  }
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
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <title>Nova</title>
  <style>
    :root {
      --bg: var(--tg-theme-bg-color, #1a1a2e);
      --text: var(--tg-theme-text-color, #ffffff);
      --hint: var(--tg-theme-hint-color, #999999);
      --link: var(--tg-theme-link-color, #6ab2f2);
      --btn: var(--tg-theme-button-color, #5288c1);
      --btn-text: var(--tg-theme-button-text-color, #ffffff);
      --secondary-bg: var(--tg-theme-secondary-bg-color, #0f0f23);
      --section-bg: var(--tg-theme-section-bg-color, #1e1e3a);
      --accent: var(--tg-theme-accent-text-color, #6ab2f2);
      --subtitle: var(--tg-theme-subtitle-text-color, #999999);
      --destructive: var(--tg-theme-destructive-text-color, #ff4444);
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
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
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
      background: var(--secondary-bg);
      display: flex;
      align-items: center;
      justify-content: space-around;
      border-top: 1px solid rgba(255,255,255,0.06);
      z-index: 100;
      padding-bottom: env(safe-area-inset-bottom, 0);
    }

    .tab-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      flex: 1;
      height: 100%;
      cursor: pointer;
      color: var(--hint);
      font-size: 10px;
      gap: 2px;
      transition: color 0.2s;
      user-select: none;
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
    .field-input:focus { border-color: var(--accent); }
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
    .toggle.on { background: var(--btn); }
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
      background: var(--section-bg);
      border-radius: var(--card-radius);
      padding: 16px;
      cursor: pointer;
      transition: transform 0.15s, box-shadow 0.15s;
      position: relative;
      overflow: hidden;
    }
    .agent-card:active { transform: scale(0.97); }
    .agent-name { font-weight: 600; font-size: 14px; margin-top: 10px; }
    .agent-desc { font-size: 12px; color: var(--hint); margin-top: 4px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .agent-badge {
      position: absolute;
      top: 10px;
      right: 10px;
      background: var(--btn);
      color: var(--btn-text);
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 10px;
      min-width: 20px;
      text-align: center;
    }

    /* ---- Approval cards ---- */
    .approval-card {
      background: var(--section-bg);
      border-radius: var(--card-radius);
      padding: 16px;
      margin-bottom: 12px;
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
    .approval-btn.approve { background: #2ecc71; }
    .approval-btn.revise { background: #f39c12; }
    .approval-btn.cancel { background: var(--destructive); }
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
      background: var(--section-bg);
      border-radius: var(--card-radius);
      padding: 14px 16px;
      margin-bottom: 10px;
      cursor: pointer;
      transition: transform 0.15s;
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
    .status-dot.done { background: #2ecc71; }
    .status-dot.blocked { background: var(--destructive); }
    .status-dot.in_progress { background: #f39c12; }
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
      background: var(--section-bg);
      color: var(--hint);
      cursor: pointer;
      white-space: nowrap;
      border: 1px solid transparent;
      transition: all 0.2s;
      user-select: none;
    }
    .filter-chip.active {
      background: var(--btn);
      color: var(--btn-text);
      border-color: var(--btn);
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
      background: var(--section-bg);
      color: var(--text);
      padding: 12px 16px;
      border-radius: 12px;
      font-size: 14px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      animation: toastIn 0.3s ease, toastOut 0.3s ease 2.7s forwards;
      pointer-events: auto;
    }
    .toast.error { border-left: 3px solid var(--destructive); }
    .toast.success { border-left: 3px solid #2ecc71; }
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
      border-top-color: var(--accent);
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

    <!-- ======== PROFILE PAGE ======== -->
    <div class="content page active" id="pageProfile">
      <div class="ptr-indicator" id="ptrProfile">Pull to refresh</div>
      <div class="profile-header" id="profileHeader">
        <div class="avatar" id="profileAvatar" style="background:#5288c1;">?</div>
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
        <div class="filter-chip" data-filter="done" onclick="setFilter('done')">Done</div>
        <div class="filter-chip" data-filter="blocked" onclick="setFilter('blocked')">Blocked</div>
        <div class="filter-chip" data-filter="in_progress" onclick="setFilter('in_progress')">In Progress</div>
      </div>
      <div id="taskList">
        <div class="loading"><div class="spinner"></div>Loading tasks...</div>
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
      <div class="tab-item active" data-tab="pageProfile" onclick="switchTab('pageProfile')">
        <svg viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
        <span>Profile</span>
      </div>
      <div class="tab-item" data-tab="pageAgents" onclick="switchTab('pageAgents')">
        <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
        <span>Agents</span>
      </div>
      <div class="tab-item" data-tab="pageApprovals" onclick="switchTab('pageApprovals')">
        <svg viewBox="0 0 24 24"><path d="M18 7l-1.41-1.41-6.34 6.34 1.41 1.41L18 7zm4.24-1.41L11.66 16.17 7.48 12l-1.41 1.41L11.66 19l12-12-1.42-1.41zM.41 13.41L6 19l1.41-1.41L1.83 12 .41 13.41z"/></svg>
        <span>Approvals</span>
      </div>
      <div class="tab-item" data-tab="pageHistory" onclick="switchTab('pageHistory')">
        <svg viewBox="0 0 24 24"><path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>
        <span>History</span>
      </div>
    </div>
  </div>

  <script>
    // ============================================================
    // STATE
    // ============================================================
    const AGENT_COLORS = ['#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FFEAA7','#DDA0DD','#98D8C8','#F7DC6F','#BB8FCE','#85C1E9','#F0B27A','#82E0AA'];
    let initData = '';
    let currentTab = 'pageProfile';
    let currentFilter = 'all';
    let profileData = null;
    let prefsData = null;
    let agentsData = [];
    let approvalsData = [];
    let tasksData = [];
    let openDetailType = null; // 'agent' or 'task'
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

      loadProfile();
      loadAgents();
      loadApprovals();
      loadTasks();

      // Auto-refresh approvals every 10 seconds
      approvalRefreshInterval = setInterval(function() {
        if (currentTab === 'pageApprovals') loadApprovals(true);
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

      var profileFields = {
        name: document.getElementById('fieldName').value.trim(),
        timezone: document.getElementById('fieldTimezone').value,
        phone: document.getElementById('fieldPhone').value.trim()
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

    function renderTasks() {
      var container = document.getElementById('taskList');
      var filtered = tasksData;
      if (currentFilter !== 'all') {
        filtered = tasksData.filter(function(t) { return normalizeStatus(t.status) === currentFilter; });
      }

      if (!filtered.length) {
        var label = currentFilter === 'all' ? 'No tasks yet' : 'No ' + currentFilter.replace('_', ' ') + ' tasks';
        container.innerHTML = '<div class="empty-state"><svg viewBox="0 0 24 24"><path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg><h3>' + label + '</h3><p>Tasks will appear here as agents work.</p></div>';
        return;
      }

      var html = '';
      for (var i = 0; i < filtered.length; i++) {
        var t = filtered[i];
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

        html += '<div class="task-item" onclick="showTaskDetail(\\'' + t.id + '\\')">';
        html += '<div class="task-header">';
        html += '<div class="status-dot ' + statusClass + '"></div>';
        html += '<div class="task-desc">' + desc + '</div>';
        html += '<div class="task-agent-badge" style="background:' + color + ';">' + agentName + '</div>';
        html += '</div>';
        html += '<div class="task-meta">';
        html += '<span>' + timeAgo(t.created_at) + '</span>';
        if (duration) html += '<span>' + duration + '</span>';
        html += '</div>';
        html += '</div>';
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
        html += '<div class="detail-section"><h3>Subtasks (' + subtasks.length + ')</h3>';
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

      container.innerHTML = html;
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
          "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://telegram.org; style-src 'self' 'unsafe-inline'; connect-src 'self'",
        },
      });
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

      return jsonResponse({ error: "Not found" }, 404);
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Nova Mini App running on http://localhost:${PORT}`);
console.log("Routes:");
console.log("  GET  /                          — Mini App SPA");
console.log("  GET  /health                    — Health check");
console.log("  GET  /api/profile               — User profile + preferences");
console.log("  PUT  /api/profile               — Update profile fields");
console.log("  PUT  /api/preferences            — Update preference fields");
console.log("  GET  /api/agents                — Agent list with stats");
console.log("  GET  /api/agents/:slug/tasks    — Agent task history");
console.log("  GET  /api/approvals             — Pending approvals");
console.log("  POST /api/approvals/:id/approve — Approve");
console.log("  POST /api/approvals/:id/cancel  — Cancel");
console.log("  POST /api/approvals/:id/revise  — Revise with feedback");
console.log("  GET  /api/tasks                 — Task history");
console.log("  GET  /api/tasks/:id             — Task detail with subtasks");
