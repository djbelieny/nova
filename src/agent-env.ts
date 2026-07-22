/**
 * Least-privilege environment for spawned agent subprocesses. Replaces `env: {...process.env}`
 * so a successful injection can't read every credential Nova holds. The allowlist is derived
 * from what a task legitimately needs: base non-secret vars + the provider's own auth (mirrors
 * sandbox/auth.ts) + the credential vars the task's MCP config references. On by default;
 * NOVA_AGENT_ENV_STRICT=false reverts to full passthrough.
 */
import { readFileSync } from "fs";

const BASE_ALLOW = [
  "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TERM",
  "TMPDIR", "TMP", "TEMP", "TZ", "SHELL",
  "NOVA_RTK", "NOVA_DB_DIR", "NOVA_SANDBOX_BACKEND", "NOVA_SANDBOX_IMAGE", "NOVA_SANDBOX_SHARE_AUTH",
  "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy", "ALL_PROXY",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
];

// Provider auth env, host-env form (mirrors AUTH + BASE_ENV in src/sandbox/auth.ts).
const PROVIDER_AUTH: Record<string, string[]> = {
  claude: ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"],
  codex: ["CODEX_HOME", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_PROJECT", "OPENAI_ORGANIZATION"],
};

export interface AgentEnvOpts {
  provider?: "claude" | "gemini" | "codex";
  mcpConfigPath?: string;
  extra?: Record<string, string | undefined>;
}

function strictMode(): boolean {
  return process.env.NOVA_AGENT_ENV_STRICT !== "false";
}

/** Credential vars an MCP config references: ${VAR} refs + each server's env keys. */
export function mcpEnvVars(mcpConfigPath?: string): string[] {
  if (!mcpConfigPath) return [];
  let raw: string;
  try { raw = readFileSync(mcpConfigPath, "utf8"); } catch { return []; }
  const vars = new Set<string>();
  for (const m of raw.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) vars.add(m[1]);
  try {
    const json = JSON.parse(raw);
    const servers = json.mcpServers || json.servers || {};
    for (const s of Object.values<any>(servers)) {
      if (s && typeof s.env === "object" && s.env) for (const k of Object.keys(s.env)) vars.add(k);
    }
  } catch { /* ${} scan already captured refs */ }
  return [...vars];
}

function applyExtra(env: Record<string, string>, extra?: Record<string, string | undefined>): Record<string, string> {
  if (!extra) return env;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

export function buildAgentEnv(opts: AgentEnvOpts = {}): Record<string, string> {
  const src = process.env;
  if (!strictMode()) {
    const full: Record<string, string> = {};
    for (const [k, v] of Object.entries(src)) if (v !== undefined) full[k] = v as string;
    return applyExtra(full, opts.extra);
  }
  const allow = new Set<string>(BASE_ALLOW);
  if (opts.provider) for (const k of PROVIDER_AUTH[opts.provider]) allow.add(k);
  for (const k of mcpEnvVars(opts.mcpConfigPath)) allow.add(k);
  for (const k of (src.NOVA_AGENT_ENV_PASSTHROUGH || "").split(",").map((s) => s.trim()).filter(Boolean)) allow.add(k);
  const out: Record<string, string> = {};
  for (const k of allow) { const v = src[k]; if (v !== undefined) out[k] = v as string; }
  return applyExtra(out, opts.extra);
}
