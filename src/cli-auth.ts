/**
 * CLI Auth Monitor
 *
 * Detects when subscription CLI providers (Claude, Gemini) are unauthenticated
 * at startup, triggers their OAuth login flow with browser suppressed, captures
 * the auth URL from stdout/stderr, and delivers it to the admin via Telegram.
 *
 * Strategy per provider:
 *   Claude  — `claude auth status --output-format json` → parse `loggedIn`
 *             `claude auth login` with BROWSER=echo to print URL instead of opening
 *   Gemini  — read ~/.gemini/oauth_creds.json, check expiry_date > now
 *             `gemini auth login` with BROWSER=echo
 */

import { spawn } from "bun";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const HOME = process.env.HOME || "~";
const GEMINI_CREDS = join(HOME, ".gemini", "oauth_creds.json");

// URL capture timeout — kill the login process after this many ms if no URL found
const AUTH_FLOW_TIMEOUT_MS = 20_000;

// ── Auth detection ─────────────────────────────────────────────────────────

async function resolveBinary(envVar: string, fallback: string): Promise<string> {
  const fromEnv = process.env[envVar];
  if (fromEnv) {
    // Verify the configured path exists; if not, fall back to PATH lookup
    try {
      const check = spawn([fromEnv, "--version"], { stdout: "pipe", stderr: "pipe" });
      await check.exited;
      return fromEnv;
    } catch {
      console.warn(`[cli-auth] ${envVar}=${fromEnv} not found — falling back to "${fallback}" in PATH`);
    }
  }
  return fallback;
}

export async function isClaudeAuthenticated(): Promise<boolean> {
  const binaryPath = await resolveBinary("CLAUDE_PATH", "claude");
  try {
    const proc = spawn([binaryPath, "auth", "status"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    const data = JSON.parse(stdout.trim());
    return data?.loggedIn === true;
  } catch {
    return false;
  }
}

export function isGeminiAuthenticated(): boolean {
  if (!existsSync(GEMINI_CREDS)) return false;
  try {
    const creds = JSON.parse(readFileSync(GEMINI_CREDS, "utf-8"));
    const expiryMs = Number(creds.expiry_date ?? 0);
    // Require at least 5 minutes of validity remaining
    return expiryMs > Date.now() + 5 * 60 * 1000;
  } catch {
    return false;
  }
}

// ── Auth URL capture ───────────────────────────────────────────────────────

/**
 * Spawns the CLI's login command with BROWSER=echo so the browser-open call
 * instead prints the URL to stdout. Returns the first https:// URL found,
 * or null if none found within the timeout.
 */
async function captureAuthUrl(args: string[], extraEnv?: Record<string, string>): Promise<string | null> {
  // Only match real Google OAuth URLs, not docs/help links printed in headless mode
  const URL_PATTERN = /https:\/\/accounts\.google\.com\/[^\s"'<>]+/g;

  try {
    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        // Suppress real browser open; make the CLI call `echo <url>` instead
        BROWSER: "echo",
        NO_BROWSER: "1",
        ...extraEnv,
      },
    });

    // Race: collect output vs timeout
    const collected = { text: "" };
    let foundUrl: string | null = null;

    const readStream = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        collected.text += chunk;
        const match = collected.text.match(URL_PATTERN);
        if (match) {
          foundUrl = match[0];
          break;
        }
      }
    };

    const timeout = new Promise<void>((resolve) => setTimeout(resolve, AUTH_FLOW_TIMEOUT_MS));

    await Promise.race([
      Promise.all([readStream(proc.stdout), readStream(proc.stderr)]),
      timeout,
    ]);

    // Kill the login process — it would otherwise block waiting for browser callback
    try { proc.kill(); } catch {}

    return foundUrl;
  } catch {
    return null;
  }
}

export async function triggerClaudeAuth(): Promise<string | null> {
  const binaryPath = await resolveBinary("CLAUDE_PATH", "claude");
  return captureAuthUrl([binaryPath, "auth", "login"]);
}

export async function triggerGeminiAuth(): Promise<string | null> {
  const binaryPath = await resolveBinary("GEMINI_PATH", "gemini");
  return captureAuthUrl([binaryPath, "auth", "login"]);
}

// ── Main entry point ───────────────────────────────────────────────────────

export interface AuthIssue {
  provider: string;
  authUrl: string | null;
}

/**
 * Checks all CLI providers that support subscription auth. For any that are
 * unauthenticated, attempts to capture the OAuth URL and invokes `notify`
 * with a human-readable message. Non-blocking — errors are swallowed.
 */
export async function checkCliAuth(
  notify: (message: string) => Promise<void>,
): Promise<void> {
  const checks: Array<{
    name: string;
    check: () => boolean | Promise<boolean>;
    trigger: () => Promise<string | null>;
  }> = [
    {
      name: "claude",
      check: isClaudeAuthenticated,
      trigger: triggerClaudeAuth,
    },
    {
      name: "gemini",
      check: isGeminiAuthenticated,
      trigger: triggerGeminiAuth,
    },
  ];

  for (const { name, check, trigger } of checks) {
    try {
      const authed = await check();
      if (authed) continue;

      console.log(`[cli-auth] ${name} is not authenticated — capturing auth URL...`);

      const url = await trigger();

      if (url) {
        console.log(`[cli-auth] ${name} auth URL captured`);
        await notify(
          `⚠️ *${name.charAt(0).toUpperCase() + name.slice(1)} CLI needs re-authentication*\n\nOpen this link to authorize:\n${url}`,
        ).catch(() => {});
      } else {
        console.warn(`[cli-auth] ${name} unauthenticated but could not capture auth URL`);
        await notify(
          `⚠️ *${name.charAt(0).toUpperCase() + name.slice(1)} CLI needs re-authentication*\n\nCould not capture the auth URL automatically. Please run \`${name} auth login\` manually.`,
        ).catch(() => {});
      }
    } catch (err) {
      console.warn(`[cli-auth] Error checking ${name} auth:`, err);
    }
  }
}
