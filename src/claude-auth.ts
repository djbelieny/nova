/**
 * Claude Authentication Handler
 *
 * Implements the full PKCE OAuth flow for Claude CLI credentials — no TTY needed.
 * The relay builds the auth URL itself, sends it to the user via Telegram, and
 * waits for them to send back the authorization code (shown on the callback page).
 *
 * Auth endpoints discovered from the claude CLI bundle:
 *   Authorize: https://claude.ai/oauth/authorize
 *   Token:     https://platform.claude.com/v1/oauth/token
 *   Client ID: 22422756-60c9-4084-8eb7-27705fd5cf9a  (Claude.ai subscription)
 *
 * Flow:
 *   1. buildOAuthUrl()  → generate PKCE pair + state, return auth URL
 *   2. Send URL to user via Telegram
 *   3. User visits URL, logs in, lands on callback page showing a code/URL
 *   4. User pastes that code/URL back into Telegram
 *   5. extractCodeFromReply() → pull the authorization code
 *   6. exchangeCodeForToken() → POST to token endpoint, get access token
 *   7. writeCredentials() → save to ~/.claude/.credentials.json
 *   8. relay now works — no container restart needed
 */

import { join } from "path";
import { writeFile } from "fs/promises";
import { NOVA_NAME } from "./identity.ts";

// ── OAuth constants (from claude CLI bundle) ─────────────────────────────────

const CLAUDE_AI_ORIGIN = "https://claude.ai";
const PLATFORM_ORIGIN = "https://platform.claude.com";
const CLIENT_ID = "22422756-60c9-4084-8eb7-27705fd5cf9a"; // Claude.ai subscription
const REDIRECT_URI = `${PLATFORM_ORIGIN}/oauth/code/callback`;
const AUTHORIZE_URL = `${CLAUDE_AI_ORIGIN}/oauth/authorize`;
const TOKEN_URL = `${PLATFORM_ORIGIN}/v1/oauth/token`;

const CREDENTIALS_PATH = join(
  process.env.HOME || "/root",
  ".claude",
  ".credentials.json",
);

// ── Types ────────────────────────────────────────────────────────────────────

export type SendFn = (chatId: string, payload: { text: string }) => Promise<void>;

// ── State ────────────────────────────────────────────────────────────────────

let _pendingVerifier: string | null = null;
let _pendingState: string | null = null;
let _pendingChatId: string | null = null;
let _pendingSend: SendFn | null = null;
let _authComplete = process.env.ANTHROPIC_API_KEY ? true : false;

// ── PKCE helpers ─────────────────────────────────────────────────────────────

function b64url(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function generateVerifier(): Promise<string> {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return b64url(buf);
}

async function generateChallenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return b64url(new Uint8Array(hash));
}

// ── Auth error detection ─────────────────────────────────────────────────────

/**
 * Two auth failure modes from ClaudeProvider:
 *   A) Non-zero exit with auth-related stderr keywords
 *   B) Exit 0 with empty stdout — CLI tried to open browser, no TTY, silently quit
 */
export function isAuthError(stderr: string, exitCode: number, stdout = ""): boolean {
  // Mode B — silent exit 0, no output
  if (exitCode === 0 && stdout.trim() === "") return true;
  if (exitCode === 0) return false;

  // Mode A — non-zero with auth keywords
  const lower = stderr.toLowerCase();
  return (
    lower.includes("not authenticated") ||
    lower.includes("authentication required") ||
    lower.includes("please log in") ||
    lower.includes("sign in") ||
    lower.includes("oauth") ||
    lower.includes("login") ||
    lower.includes("authorize") ||
    lower.includes("credentials") ||
    lower.includes("401") ||
    lower.includes("403") ||
    stderr.trim() === ""
  );
}

export function isAuthPending(): boolean {
  return _pendingVerifier !== null;
}

// ── Auth test ─────────────────────────────────────────────────────────────────

/**
 * Fires a minimal claude call. Returns true only if it exits 0 AND produces
 * non-empty output (exit 0 + empty stdout = auth failed silently).
 */
export async function testClaudeAuth(): Promise<boolean> {
  if (_authComplete) return true;
  if (process.env.ANTHROPIC_API_KEY) {
    _authComplete = true;
    return true;
  }

  try {
    const { spawn } = await import("bun");
    const proc = spawn(
      ["claude", "-p", "Reply with: OK", "--output-format", "text", "--max-turns", "1"],
      { stdout: "pipe", stderr: "pipe" },
    );

    const stdoutPromise = new Response(proc.stdout).text().catch(() => "");
    const timedOut = await Promise.race<boolean>([
      proc.exited.then(() => false),
      new Promise<boolean>((r) => setTimeout(() => r(true), 20_000)),
    ]);

    if (timedOut) {
      proc.kill();
      return false;
    }

    const stdout = await stdoutPromise;
    const ok = proc.exitCode === 0 && stdout.trim().length > 0;
    if (ok) _authComplete = true;
    return ok;
  } catch {
    return false;
  }
}

// ── OAuth flow ────────────────────────────────────────────────────────────────

/**
 * Builds the PKCE authorization URL and sends it to the user via Telegram.
 * Stores the code verifier so that handleAuthCodeReply() can complete the flow.
 */
export async function startOAuthFlow(send: SendFn, chatId: string): Promise<void> {
  if (_pendingVerifier) {
    await send(chatId, {
      text:
        "An authorization link was already sent. " +
        "Visit the link and paste the code back here.",
    });
    return;
  }

  if (_authComplete) {
    await send(chatId, { text: "Claude is already authenticated." });
    return;
  }

  console.log("[claude-auth] Starting PKCE OAuth flow");

  const codeVerifier = await generateVerifier();
  const codeChallenge = await generateChallenge(codeVerifier);
  const state = crypto.randomUUID();

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });

  const authUrl = `${AUTHORIZE_URL}?${params}`;

  _pendingVerifier = codeVerifier;
  _pendingState = state;
  _pendingChatId = chatId;
  _pendingSend = send;

  await send(chatId, {
    text:
      `⚠️ *${NOVA_NAME} needs to authenticate with Claude.*\n\n` +
      `1️⃣ Open this link in your browser:\n${authUrl}\n\n` +
      `2️⃣ Log in with your Claude account\n\n` +
      `3️⃣ After authorizing, you'll see a page with a code or URL — ` +
      `paste the *full URL* (or just the code) back here and ${NOVA_NAME} will finish authenticating.`,
  });
}

/**
 * Call this from the relay message handler when _pendingVerifier is set.
 * If the message looks like an auth code or callback URL, complete the exchange.
 * Returns true if the message was consumed as an auth code.
 */
export async function handleAuthCodeReply(message: string): Promise<boolean> {
  if (!_pendingVerifier || !_pendingChatId || !_pendingSend) return false;

  const code = extractCode(message.trim());
  if (!code) {
    // Not recognizable as a code — let the message through normally
    return false;
  }

  const send = _pendingSend;
  const chatId = _pendingChatId;
  const verifier = _pendingVerifier;

  // Clear pending state immediately so new messages aren't intercepted
  _pendingVerifier = null;
  _pendingState = null;
  _pendingChatId = null;
  _pendingSend = null;

  console.log("[claude-auth] Received code, exchanging for token...");
  await send(chatId, { text: "Got it — exchanging code for token..." });

  try {
    const token = await exchangeCode(code, verifier);
    await writeCredentials(token);
    _authComplete = true;
    console.log("[claude-auth] OAuth complete — credentials written");
    await send(chatId, {
      text: `✅ Claude authenticated! ${NOVA_NAME} is ready. Send your first message.`,
    });
    return true;
  } catch (err) {
    console.error("[claude-auth] Token exchange failed:", err);
    await send(chatId, {
      text:
        `Authentication failed: ${err}\n\n` +
        `Try again with \`/auth\` or restart and try the link again.`,
    });
    return true; // consumed the message even if failed
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

function extractCode(input: string): string | null {
  // Full callback URL: https://platform.claude.com/oauth/code/callback?code=xxx&state=yyy
  try {
    const url = new URL(input);
    const code = url.searchParams.get("code");
    if (code) return code;
  } catch {}

  // Raw code (no spaces, looks like an OAuth code: letters/digits/- 20+ chars)
  if (/^[A-Za-z0-9_\-./+]{20,}$/.test(input) && !input.includes(" ")) {
    return input;
  }

  // code=xxx pattern anywhere in the text
  const match = input.match(/[?&]?code=([A-Za-z0-9_\-./+%]+)/);
  if (match) return decodeURIComponent(match[1]);

  return null;
}

async function exchangeCode(code: string, codeVerifier: string): Promise<any> {
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }

  return resp.json();
}

async function writeCredentials(token: any): Promise<void> {
  const credentials = {
    claudeAiOauth: {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
      expiresAt: token.expires_in
        ? Date.now() + token.expires_in * 1000
        : null,
      scopes: typeof token.scope === "string" ? token.scope.split(" ") : [],
      subscriptionType: token.subscription_type ?? null,
      rateLimitTier: token.rate_limit_tier ?? null,
    },
  };

  await writeFile(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2), "utf-8");
  console.log(`[claude-auth] Credentials written to ${CREDENTIALS_PATH}`);
}

// ── runClaudeOAuthFlow (compat shim) ──────────────────────────────────────────
// Kept for the startup check in relay.ts — just delegates to startOAuthFlow

export async function runClaudeOAuthFlow(send: SendFn, chatId: string): Promise<void> {
  return startOAuthFlow(send, chatId);
}
