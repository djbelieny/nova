/**
 * nova connect — transport layer
 *
 * Pure, dependency-light HTTP helpers that talk to a running Nova over the
 * existing dashboard endpoints. No import of the relay/orchestrator — this
 * module is a standalone client and every function accepts an injectable
 * `fetchImpl` so it can be unit-tested without touching the network.
 *
 * Endpoints reused (all already on the server):
 *   POST /login                    — obtain the `nova_session` cookie
 *   GET  /api/profile              — resolve the logged-in user's id
 *   POST /api/chat                 — send a message
 *   GET  /api/messages             — history
 *   GET  /api/activity/stream      — SSE live event stream
 *   POST /api/approvals/resolve    — approve / revise / cancel a pending approval
 */

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { NovaEvent } from "../events.ts";

export type FetchImpl = typeof fetch;

export interface Session {
  baseUrl: string;
  cookie: string;
  userId?: string;
}

export interface ChatMessage {
  role: string;
  content: string;
  channel?: string;
  created_at?: string;
  [k: string]: unknown;
}

// ============================================================
// Session persistence — ~/.nova/connect.json (0600)
// ============================================================

export function sessionPath(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.NOVA_CONNECT_PATH) return process.env.NOVA_CONNECT_PATH;
  const home = process.env.HOME || homedir();
  return join(home, ".nova", "connect.json");
}

export async function loadSession(path?: string): Promise<Session | null> {
  try {
    const raw = await readFile(sessionPath(path), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.baseUrl === "string" && typeof parsed.cookie === "string") {
      return parsed as Session;
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveSession(session: Session, path?: string): Promise<void> {
  const file = sessionPath(path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(session, null, 2), { mode: 0o600 });
}

// ============================================================
// Auth
// ============================================================

function readSetCookie(headers: Headers): string | null {
  // Prefer getSetCookie() (returns an array) when available, fall back to get().
  const anyHeaders = headers as unknown as { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") {
    const all = anyHeaders.getSetCookie();
    if (all && all.length) return all.join("\n");
  }
  return headers.get("set-cookie");
}

/** Extract the `nova_session=…` pair from a raw Set-Cookie header value. */
export function extractSessionCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const match = setCookie.match(/nova_session=([^;\s]+)/);
  return match ? `nova_session=${match[1]}` : null;
}

/**
 * Log in against `POST /login` (form-encoded username/password) and return the
 * session cookie. The dashboard replies with a 302 + Set-Cookie, so we disable
 * redirect following to read the cookie off the first response.
 */
export async function login(
  baseUrl: string,
  password: string,
  user = "admin",
  fetchImpl: FetchImpl = fetch,
): Promise<{ cookie: string }> {
  const body = new URLSearchParams({ username: user, password }).toString();
  const res = await fetchImpl(joinUrl(baseUrl, "/login"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
  });

  const cookie = extractSessionCookie(readSetCookie(res.headers));
  if (!cookie) {
    // A 200 with no cookie means the login page was re-rendered → bad credentials.
    throw new Error(res.status === 429 ? "Too many login attempts, try again later" : "Login failed: invalid credentials");
  }
  return { cookie };
}

/** Resolve the logged-in user's id via `GET /api/profile`. Returns null for the master account (no DB row). */
export async function whoami(
  baseUrl: string,
  cookie: string,
  fetchImpl: FetchImpl = fetch,
): Promise<{ userId: string | null; name?: string }> {
  const res = await fetchImpl(joinUrl(baseUrl, "/api/profile"), {
    headers: { Cookie: cookie },
  });
  const data = await res.json().catch(() => ({}));
  const u = (data as any)?.user;
  return { userId: u?.id ?? null, name: u?.name };
}

// ============================================================
// Chat + history
// ============================================================

/** Send a message via `POST /api/chat`. The server needs a userId in the body. */
export async function sendChat(
  baseUrl: string,
  cookie: string,
  text: string,
  userId?: string,
  fetchImpl: FetchImpl = fetch,
): Promise<{ success?: boolean; error?: string }> {
  const res = await fetchImpl(joinUrl(baseUrl, "/api/chat"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ role: "user", content: text, userId }),
  });
  return res.json().catch(() => ({ success: false, error: "Invalid response" }));
}

/** Fetch recent messages via `GET /api/messages`. */
export async function fetchHistory(
  baseUrl: string,
  cookie: string,
  limit = 20,
  userId?: string,
  fetchImpl: FetchImpl = fetch,
): Promise<ChatMessage[]> {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (userId) qs.set("user_id", userId);
  const res = await fetchImpl(joinUrl(baseUrl, `/api/messages?${qs.toString()}`), {
    headers: { Cookie: cookie },
  });
  const data = await res.json().catch(() => ({ messages: [] }));
  return Array.isArray((data as any)?.messages) ? (data as any).messages : [];
}

// ============================================================
// Approvals — reuses the existing POST /api/approvals/resolve route
// ============================================================

export type ApprovalAction = "approve" | "revise" | "cancel";

export async function approve(
  baseUrl: string,
  cookie: string,
  approvalId: string,
  action: ApprovalAction,
  feedback?: string,
  fetchImpl: FetchImpl = fetch,
): Promise<{ success?: boolean; error?: string }> {
  const res = await fetchImpl(joinUrl(baseUrl, "/api/approvals/resolve"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ id: approvalId, action, feedback }),
  });
  return res.json().catch(() => ({ success: false, error: "Invalid response" }));
}

// ============================================================
// SSE parsing + streaming
// ============================================================

/**
 * Parse a single SSE line into a NovaEvent.
 * - `data: {…}` → the parsed event
 * - `:` comments / keepalives / blank lines / malformed JSON → null
 */
export function parseSseLine(line: string): NovaEvent | null {
  const trimmed = line.replace(/\r$/, "");
  if (!trimmed || trimmed.startsWith(":")) return null;
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload);
    if (parsed && typeof parsed === "object" && typeof (parsed as any).type === "string") {
      return parsed as NovaEvent;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Open `GET /api/activity/stream` and drive `onEvent` for each parsed event.
 * Uses fetch + a ReadableStream reader so it works headless (no browser
 * EventSource). Resolves when the stream ends or the abort signal fires.
 */
export async function connectActivityStream(
  baseUrl: string,
  cookie: string,
  onEvent: (event: NovaEvent) => void,
  opts: { fetchImpl?: FetchImpl; signal?: AbortSignal } = {},
): Promise<void> {
  const fetchImpl = opts.fetchImpl || fetch;
  const res = await fetchImpl(joinUrl(baseUrl, "/api/activity/stream"), {
    headers: { Cookie: cookie, Accept: "text/event-stream" },
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`activity stream failed: HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const event = parseSseLine(line);
        if (event) onEvent(event);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }
}

// ============================================================
// Helpers
// ============================================================

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/** Pull an approvalId + action set out of a chat.reply event's inline keyboard, if present. */
export function extractApprovalFromEvent(event: NovaEvent): { approvalId: string } | null {
  const markup = (event?.data as any)?.options?.reply_markup;
  const rows = markup?.inline_keyboard;
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (const btn of row) {
      const cb = typeof btn?.callback_data === "string" ? btn.callback_data : "";
      const m = cb.match(/^apv:([^:]+):(approve|revise|cancel)$/);
      if (m) return { approvalId: m[1] };
    }
  }
  return null;
}
