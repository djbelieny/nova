/**
 * Claude Authentication Handler
 *
 * Detects when the Claude CLI is not authenticated, triggers the OAuth device
 * flow, and surfaces the login URL (plus verification code if present) to the
 * user via Telegram so they can authorize without touching the server terminal.
 *
 * Flow:
 *   1. testClaudeAuth() — quick sanity call; returns false on auth failure
 *   2. runClaudeOAuthFlow(send, chatId) — spawns `claude auth login`, reads
 *      stdout/stderr until it finds the auth URL, sends it to the user, then
 *      waits for the subprocess to complete (it polls the auth server itself)
 *   3. When auth completes, sends a "ready" confirmation
 *
 * Auth-error detection helpers are exported so callAI can surface the flow
 * mid-conversation instead of returning a generic error.
 */

import { spawn } from "bun";
import { NOVA_NAME } from "./identity.ts";

// ── Types ────────────────────────────────────────────────────────────────────

export type SendFn = (chatId: string, payload: { text: string }) => Promise<void>;

// ── Module-level state ───────────────────────────────────────────────────────

let _authInProgress = false;
let _authComplete = process.env.ANTHROPIC_API_KEY ? true : false; // API key → no OAuth needed

// ── Auth error detection ─────────────────────────────────────────────────────

/**
 * Returns true when stderr / exit code combo strongly suggests an auth failure
 * rather than a runtime error.
 */
/**
 * stdout is the text the provider returned (empty string if no output).
 * stderr is whatever the CLI printed to stderr.
 * exitCode is the process exit code.
 *
 * Two auth failure modes:
 *   A) Non-zero exit with auth-related stderr keywords
 *   B) Exit 0 but stdout is empty — the CLI opened (or tried to open) a
 *      browser auth flow, had nothing to write to stdout, and exited quietly
 */
export function isAuthError(stderr: string, exitCode: number, stdout = ""): boolean {
  const lower = stderr.toLowerCase();

  // Mode B: silent exit 0 with no output
  if (exitCode === 0 && stdout.trim() === "") return true;

  if (exitCode === 0) return false;

  // Mode A: non-zero with known auth keywords
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
    stderr.trim() === "" // non-zero exit, empty stderr = silent failure
  );
}

// ── Quick auth check ─────────────────────────────────────────────────────────

/**
 * Fires a minimal claude call and returns true if it succeeds.
 * Uses a 20s timeout so startup never hangs forever.
 */
export async function testClaudeAuth(): Promise<boolean> {
  if (_authComplete) return true;
  if (process.env.ANTHROPIC_API_KEY) {
    _authComplete = true;
    return true;
  }

  try {
    const proc = spawn(
      ["claude", "-p", "Reply with: OK", "--output-format", "text", "--max-turns", "1", "--no-mcp"],
      { stdout: "pipe", stderr: "pipe" },
    );

    // Collect stdout while also enforcing a timeout
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
    // Must exit 0 AND return non-empty text — empty stdout with exit 0 means
    // the CLI tried to open a browser auth flow and got no TTY (auth needed)
    const ok = proc.exitCode === 0 && stdout.trim().length > 0;
    if (ok) _authComplete = true;
    return ok;
  } catch {
    return false;
  }
}

// ── OAuth flow ───────────────────────────────────────────────────────────────

/**
 * Spawns `claude auth login`, captures the OAuth URL (and optional device
 * verification code) from stdout/stderr, sends it to the user via Telegram,
 * then waits for the subprocess to finish polling the auth server.
 *
 * Safe to call concurrently — only one flow runs at a time.
 */
export async function runClaudeOAuthFlow(send: SendFn, chatId: string): Promise<void> {
  if (_authInProgress) {
    await send(chatId, {
      text: "Authentication already in progress. Check for the previous login message.",
    });
    return;
  }

  if (_authComplete) {
    await send(chatId, { text: "Claude is already authenticated." });
    return;
  }

  _authInProgress = true;
  console.log("[claude-auth] Starting OAuth flow");

  // Try `claude auth login` first; if it's not a valid subcommand the binary
  // will still print the auth URL when invoked non-interactively.
  const proc = spawn(["claude", "auth", "login"], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "null",
    env: {
      ...process.env,
      // Ensure the CLI knows it's non-interactive and should print the URL
      NO_COLOR: "1",
      TERM: "dumb",
    },
  });

  const decoder = new TextDecoder();
  let buffer = "";
  let urlSent = false;

  const processChunk = async (text: string) => {
    buffer += text;
    process.stdout.write(text); // mirror to server logs

    if (urlSent) return;

    // Look for a https URL — this is the auth URL or device verification URL
    const urlMatch = buffer.match(/https:\/\/[^\s\n"'<>]+/);
    if (!urlMatch) return;

    urlSent = true;
    const url = urlMatch[1] ?? urlMatch[0];

    // Some device-code flows also print a short verification code
    const codeMatch =
      buffer.match(/code[:\s]+([A-Z0-9]{4}-[A-Z0-9]{4})/i) ||
      buffer.match(/enter[:\s]+([A-Z0-9]{6,10})\b/i);

    let msg =
      `⚠️ *${NOVA_NAME} needs to authenticate with Claude.*\n\n` +
      `Open this URL in your browser to log in:\n${url}`;

    if (codeMatch) {
      msg +=
        `\n\n*Verification code:* \`${codeMatch[1]}\`\n` +
        `_(Enter this code on the page if prompted, then send it back here to confirm.)_`;
    } else {
      msg += `\n\n_${NOVA_NAME} will continue automatically once you've authorized._`;
    }

    await send(chatId, { text: msg }).catch(console.error);
  };

  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await processChunk(decoder.decode(value));
    }
  };

  await Promise.all([drain(proc.stdout), drain(proc.stderr)]);

  const exitCode = await proc.exited;
  _authInProgress = false;

  if (exitCode === 0) {
    _authComplete = true;
    console.log("[claude-auth] OAuth flow completed successfully");
    await send(chatId, {
      text: `✅ Claude authenticated! ${NOVA_NAME} is ready.`,
    }).catch(console.error);
  } else {
    console.error(`[claude-auth] OAuth flow failed (exit ${exitCode})`);
    await send(chatId, {
      text:
        `Authentication failed (exit ${exitCode}). ` +
        `You can also authenticate manually:\n\n` +
        `\`docker compose exec -it relay claude\`\n\n` +
        `Then restart: \`docker compose restart relay\``,
    }).catch(console.error);
  }
}

// ── isAuthPending helper ─────────────────────────────────────────────────────

export function isAuthPending(): boolean {
  return _authInProgress;
}
