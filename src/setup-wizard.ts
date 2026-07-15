/**
 * Nova — Setup Wizard (`nova init`)
 *
 * Radical onboarding: first value in ~10 minutes. Collects a Telegram bot token and
 * ONE AI provider key, writes a minimal valid .env + .mcp.json, enables three sensible
 * starter agents, and verifies the setup. Everything else (exec board, extra MCPs) is
 * left as clearly-marked optional next steps.
 *
 * Runs interactively (prompts on a TTY) or env-driven (docker/CI) via NOVA_INIT_* vars.
 * Non-destructive: never overwrites an existing .env / .mcp.json without --force.
 *
 * Usage:
 *   bun run init
 *   NOVA_INIT_TELEGRAM_TOKEN=... NOVA_INIT_TELEGRAM_USER_ID=... \
 *     NOVA_INIT_PROVIDER=gemini NOVA_INIT_PROVIDER_KEY=... bun run init
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";

export type ProviderKey = "claude" | "anthropic" | "gemini" | "groq" | "openai";

export interface ProviderInfo {
  label: string;
  /** Env var the key is written to, or null when the provider needs no key (CLI auth). */
  envVar: string | null;
  hint: string;
}

export const PROVIDERS: Record<ProviderKey, ProviderInfo> = {
  claude: {
    label: "Claude (CLI subscription — no API key needed)",
    envVar: null,
    hint: "Uses the `claude` CLI logged into your Claude Pro/Max subscription.",
  },
  anthropic: {
    label: "Claude (Anthropic API key)",
    envVar: "ANTHROPIC_API_KEY",
    hint: "Get a key from console.anthropic.com.",
  },
  gemini: {
    label: "Google Gemini",
    envVar: "GEMINI_API_KEY",
    hint: "Get a key from aistudio.google.com/apikey.",
  },
  groq: {
    label: "Groq",
    envVar: "GROQ_API_KEY",
    hint: "Get a free key from console.groq.com.",
  },
  openai: {
    label: "OpenAI / Codex",
    envVar: "OPENAI_API_KEY",
    hint: "Get a key from platform.openai.com.",
  },
};

/** Three broadly-useful starter agents that need no extra credentials to be valuable. */
export const STARTER_AGENTS = ["kai", "pixel", "athena"] as const;

export interface WizardAnswers {
  telegramToken: string;
  telegramUserId: string;
  provider: ProviderKey;
  providerKey?: string;
  userName?: string;
  timezone?: string;
  botName?: string;
}

export function providerEnvVar(provider: ProviderKey): string | null {
  return PROVIDERS[provider]?.envVar ?? null;
}

export function selectStarterAgents(): string[] {
  return [...STARTER_AGENTS];
}

export function validateAnswers(answers: Partial<WizardAnswers>): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const token = (answers.telegramToken || "").trim();
  // BotFather tokens look like "<digits>:<35 char base64ish>".
  if (!token || token === "your_bot_token_from_botfather") {
    errors.push("Telegram bot token is required (get one from @BotFather).");
  } else if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
    errors.push("Telegram bot token does not look valid (expected <id>:<secret>).");
  }

  const userId = (answers.telegramUserId || "").trim();
  if (!userId || userId === "your_telegram_user_id") {
    errors.push("Telegram user ID is required (get yours from @userinfobot).");
  } else if (!/^\d+$/.test(userId)) {
    errors.push("Telegram user ID must be numeric.");
  }

  const provider = answers.provider;
  if (!provider || !(provider in PROVIDERS)) {
    errors.push(`Provider must be one of: ${Object.keys(PROVIDERS).join(", ")}.`);
  } else if (providerEnvVar(provider) && !(answers.providerKey || "").trim()) {
    errors.push(`An API key is required for provider "${provider}".`);
  }

  return { ok: errors.length === 0, errors };
}

/** Parse a .env file body into a flat key→value map (ignores comments/blanks). */
export function parseEnvVars(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return vars;
}

/** Map answers → the concrete env keys they set (excludes empty provider keys). */
export function answersToEnvVars(answers: WizardAnswers): Record<string, string> {
  const vars: Record<string, string> = {
    BOT_NAME: answers.botName || "Nova",
    TELEGRAM_BOT_TOKEN: answers.telegramToken.trim(),
    TELEGRAM_USER_ID: answers.telegramUserId.trim(),
    USER_NAME: answers.userName || "Your Name",
    USER_TIMEZONE: answers.timezone || "UTC",
    AI_PROVIDER: answers.provider,
  };
  const envVar = providerEnvVar(answers.provider);
  if (envVar && answers.providerKey) vars[envVar] = answers.providerKey.trim();
  return vars;
}

/** Build a minimal, clearly-sectioned .env from scratch. */
export function buildEnvContent(answers: WizardAnswers): string {
  const vars = answersToEnvVars(answers);
  const provider = PROVIDERS[answers.provider];
  const providerLine = provider.envVar
    ? `${provider.envVar}=${vars[provider.envVar] || ""}`
    : `# ${answers.provider}: no API key needed — the \`claude\` CLI uses your subscription`;

  return `# ============================================================
# Nova — Environment (generated by \`nova init\`)
# ============================================================
# Minimal config to get your first value. Optional integrations are
# listed at the bottom as next steps — add them progressively.
# ============================================================

# --- BOT IDENTITY ---
BOT_NAME=${vars.BOT_NAME}

# --- CHANNEL: Telegram ---
TELEGRAM_BOT_TOKEN=${vars.TELEGRAM_BOT_TOKEN}
TELEGRAM_USER_ID=${vars.TELEGRAM_USER_ID}

# --- AI PROVIDER (${provider.label}) ---
AI_PROVIDER=${answers.provider}
${providerLine}

# --- PERSONALIZATION ---
USER_NAME=${vars.USER_NAME}
USER_TIMEZONE=${vars.USER_TIMEZONE}

# ============================================================
# OPTIONAL NEXT STEPS (progressive — add when you need them)
# ============================================================
# Dashboard (governance control plane):
#   DASHBOARD_USER=admin
#   DASHBOARD_PASS=set-a-strong-password   # required to enable the dashboard
#
# Extra AI providers:  GEMINI_API_KEY=   GROQ_API_KEY=   OPENAI_API_KEY=
# Extra MCP servers:   see .mcp.example.json (notion, google-workspace, gohighlevel, …)
# Executive board:     bun run exec:ceo  (needs .env.ceo etc. — see docs/ARCHITECTURE.md)
# OAuth token encryption (needed for integrations): NOVA_ENCRYPTION_KEY=  # openssl rand -hex 32
`;
}

/**
 * Non-destructive merge: apply answers onto an existing .env body, updating keys in place
 * and appending any that are missing. Comments and unrelated keys are preserved.
 */
export function applyAnswersToEnv(existing: string, answers: WizardAnswers): string {
  const updates = answersToEnvVars(answers);
  const remaining = new Set(Object.keys(updates));
  const lines = existing.split("\n");

  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const eq = trimmed.indexOf("=");
    if (eq === -1) return line;
    const key = trimmed.slice(0, eq).trim();
    if (updates[key] !== undefined) {
      remaining.delete(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });

  const appended: string[] = [];
  for (const key of remaining) appended.push(`${key}=${updates[key]}`);
  if (appended.length) {
    out.push("", "# --- added by `nova init` ---", ...appended);
  }
  return out.join("\n");
}

/**
 * Minimal .mcp.json: only servers that work with zero extra credentials (playwright).
 * The rest of .mcp.example.json is left for progressive setup.
 */
export function buildMinimalMcpConfig(exampleJson: string): { mcpServers: Record<string, unknown> } {
  let parsed: any = {};
  try {
    parsed = JSON.parse(exampleJson);
  } catch {
    parsed = {};
  }
  const servers = parsed?.mcpServers || {};
  const minimal: Record<string, unknown> = {};
  if (servers.playwright) minimal.playwright = servers.playwright;
  return { mcpServers: minimal };
}

export function starterAgentsConfig(answers: WizardAnswers): {
  enabled: string[];
  provider: ProviderKey;
  generatedAt: string;
} {
  return {
    enabled: selectStarterAgents(),
    provider: answers.provider,
    generatedAt: new Date().toISOString(),
  };
}

export interface WriteReport {
  envWritten: boolean;
  envReason?: string;
  mcpWritten: boolean;
  mcpReason?: string;
  starterAgentsWritten: boolean;
}

/**
 * Write .env, .mcp.json and config/starter-agents.json under `root`. Non-destructive:
 * an existing .env / .mcp.json is only replaced when `force` is set.
 */
export function writeConfigFiles(
  root: string,
  answers: WizardAnswers,
  opts: { force?: boolean } = {}
): WriteReport {
  const report: WriteReport = { envWritten: false, mcpWritten: false, starterAgentsWritten: false };

  const envPath = join(root, ".env");
  if (existsSync(envPath) && !opts.force) {
    // Non-destructive: merge onto the existing file rather than clobber it.
    const merged = applyAnswersToEnv(readFileSync(envPath, "utf-8"), answers);
    writeFileSync(envPath, merged);
    report.envWritten = true;
    report.envReason = "merged into existing .env (non-destructive)";
  } else {
    writeFileSync(envPath, buildEnvContent(answers));
    report.envWritten = true;
    report.envReason = existsSync(envPath) && opts.force ? "overwritten (--force)" : "created";
  }

  const mcpPath = join(root, ".mcp.json");
  if (existsSync(mcpPath) && !opts.force) {
    report.mcpWritten = false;
    report.mcpReason = "left untouched (already exists)";
  } else {
    const examplePath = join(root, ".mcp.example.json");
    const example = existsSync(examplePath) ? readFileSync(examplePath, "utf-8") : "{}";
    writeFileSync(mcpPath, JSON.stringify(buildMinimalMcpConfig(example), null, 2) + "\n");
    report.mcpWritten = true;
    report.mcpReason = existsSync(mcpPath) && opts.force ? "overwritten (--force)" : "created";
  }

  const configDir = join(root, "config");
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "starter-agents.json"),
    JSON.stringify(starterAgentsConfig(answers), null, 2) + "\n"
  );
  report.starterAgentsWritten = true;

  return report;
}

/** Verify the Telegram bot token via getMe. Injectable fetch keeps this testable. */
export async function verifyTelegram(
  token: string,
  userId: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; username?: string; error?: string }> {
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await res.json()) as any;
    if (!data.ok) return { ok: false, error: data.description || "Invalid bot token" };
    return { ok: true, username: data.result?.username };
  } catch (err: any) {
    return { ok: false, error: err?.message || "Could not reach Telegram API" };
  }
}

// ── IO shell (not unit-tested) ───────────────────────────────────────────────

const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

function ask(question: string, fallback = ""): string {
  const suffix = fallback ? c.dim(` [${fallback}]`) : "";
  const answer = (globalThis as any).prompt?.(`  ${question}${suffix}`) ?? "";
  return (answer || fallback).trim();
}

/** Collect answers: env vars first (docker/CI), then interactive prompts on a TTY. */
export function readAnswers(): WizardAnswers {
  const envProvider = (process.env.NOVA_INIT_PROVIDER || "").toLowerCase();
  const provider: ProviderKey = envProvider in PROVIDERS ? (envProvider as ProviderKey) : "claude";

  // Env-driven path (non-interactive) — used by docker/CI.
  if (process.env.NOVA_INIT_TELEGRAM_TOKEN) {
    return {
      telegramToken: process.env.NOVA_INIT_TELEGRAM_TOKEN || "",
      telegramUserId: process.env.NOVA_INIT_TELEGRAM_USER_ID || "",
      provider,
      providerKey: process.env.NOVA_INIT_PROVIDER_KEY || "",
      userName: process.env.NOVA_INIT_USER_NAME || undefined,
      timezone: process.env.NOVA_INIT_TIMEZONE || undefined,
      botName: process.env.NOVA_INIT_BOT_NAME || undefined,
    };
  }

  // Interactive path.
  console.log(c.dim("\n  Get a bot token from @BotFather, and your user ID from @userinfobot.\n"));
  const telegramToken = ask("Telegram bot token:");
  const telegramUserId = ask("Your Telegram user ID:");
  console.log(c.dim("\n  Choose one AI provider:"));
  const keys = Object.keys(PROVIDERS) as ProviderKey[];
  keys.forEach((k, i) => console.log(`    ${i + 1}) ${PROVIDERS[k].label}`));
  const pick = ask("Provider number:", "1");
  const chosen = keys[Math.max(0, Math.min(keys.length - 1, parseInt(pick || "1", 10) - 1))] || "claude";
  let providerKey = "";
  const envVar = providerEnvVar(chosen);
  if (envVar) {
    console.log(c.dim(`  ${PROVIDERS[chosen].hint}`));
    providerKey = ask(`${envVar}:`);
  } else {
    console.log(c.dim(`  ${PROVIDERS[chosen].hint}`));
  }
  const userName = ask("Your first name:", "Your Name");
  const timezone = ask("Your timezone (IANA):", "UTC");

  return { telegramToken, telegramUserId, provider: chosen, providerKey, userName, timezone };
}

async function main(): Promise<void> {
  const root = dirname(import.meta.dir);
  const force = process.argv.includes("--force");

  console.log("");
  console.log(c.bold("  Nova — nova init"));
  console.log(c.dim("  Minimal setup: Telegram + one AI provider + three starter agents.\n"));

  const answers = readAnswers();
  const { ok, errors } = validateAnswers(answers);
  if (!ok) {
    console.log(c.red("\n  Setup incomplete:"));
    for (const e of errors) console.log(`    ${c.red("✗")} ${e}`);
    process.exit(1);
  }

  const report = writeConfigFiles(root, answers, { force });
  console.log(`\n${c.cyan("  Config written:")}`);
  console.log(`    ${c.green("✓")} .env — ${report.envReason}`);
  console.log(`    ${report.mcpWritten ? c.green("✓") : c.yellow("!")} .mcp.json — ${report.mcpReason}`);
  console.log(`    ${c.green("✓")} config/starter-agents.json — ${selectStarterAgents().join(", ")}`);

  console.log(`\n${c.cyan("  Verifying Telegram…")}`);
  const check = await verifyTelegram(answers.telegramToken, answers.telegramUserId);
  if (check.ok) {
    console.log(`    ${c.green("✓")} Bot reachable: @${check.username}`);
  } else {
    console.log(`    ${c.yellow("!")} Could not verify token: ${check.error}`);
    console.log(c.dim("      Fix the token in .env, then run: bun run test:telegram"));
  }

  console.log(`\n${c.bold("  Next steps:")}`);
  console.log(`    1. Start Nova:        ${c.cyan("bun run start")}`);
  console.log(`    2. Message your bot on Telegram to confirm it responds.`);
  console.log(c.dim("    3. Optional: enable the dashboard (DASHBOARD_PASS in .env), then bun run dashboard"));
  console.log(c.dim("    4. Optional: add more MCP servers from .mcp.example.json, or the exec board."));
  console.log("");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`\n  ${c.red("Error:")} ${err?.message || err}`);
    process.exit(1);
  });
}
