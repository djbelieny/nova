import { existsSync, symlinkSync, rmSync } from "fs";
import { homedir } from "os";
import { basename } from "path";

export type SandboxProvider = "claude" | "gemini" | "codex";

// How each provider's subscription (OAuth) auth is shared into the container.
// Credential files mount at a TOP-LEVEL /nova-auth/<p> dir (never nested inside
// /workspace — nested binds fail on Docker Desktop's virtiofs). The CLI is then
// pointed at that dir via its config-dir env, or (gemini, which is HOME-based
// with no override) via a symlink from $HOME/.gemini in the workspace.
interface AuthSpec {
  files: string[];                    // host paths relative to $HOME
  containerDir: string;               // top-level mount dir in the container
  envSet?: Record<string, string>;    // explicit -e NAME=VALUE config pointers
  homeSymlink?: string;               // workspace-relative link -> containerDir
  apiKeyEnv: string[];                // keys that would override subscription
  tokenEnv: string[];                 // OAuth token envs (headless subscription)
}

const AUTH: Record<SandboxProvider, AuthSpec> = {
  claude: {
    files: [".claude/.credentials.json"],
    containerDir: "/nova-auth/claude",
    envSet: { CLAUDE_CONFIG_DIR: "/nova-auth/claude" },
    apiKeyEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
    tokenEnv: ["CLAUDE_CODE_OAUTH_TOKEN"],
  },
  gemini: {
    files: [".gemini/oauth_creds.json", ".gemini/google_accounts.json"],
    containerDir: "/nova-auth/gemini",
    homeSymlink: ".gemini",
    apiKeyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    tokenEnv: [],
  },
  codex: {
    files: [".codex/auth.json"],
    containerDir: "/nova-auth/codex",
    envSet: { CODEX_HOME: "/nova-auth/codex" },
    apiKeyEnv: ["OPENAI_API_KEY"],
    tokenEnv: [],
  },
};

const BASE_ENV: Record<SandboxProvider, string[]> = {
  claude: ["ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "PATH"],
  gemini: ["PATH"],
  codex: ["PATH"],
};

export function shareAuthEnabled(): boolean {
  return process.env.NOVA_SANDBOX_SHARE_AUTH !== "false";
}

export interface SandboxAuthPlan {
  credentialMounts: string[];                       // "host:/nova-auth/..:ro"
  envPassthrough: string[];                         // -e NAME (from host env)
  envSet: Record<string, string>;                   // -e NAME=VALUE
  workspaceSymlinks: Array<{ link: string; target: string }>;
  warning: string | null;
}

/**
 * Decide how a containerized provider CLI authenticates.
 *
 * Subscription-first (share-auth on, default): mount the host OAuth credential
 * files read-only and point the CLI at them; do NOT forward plain API keys, so
 * the CLI uses the same subscription it uses on the host instead of switching
 * to per-token billing.
 *
 * Strict isolation (NOVA_SANDBOX_SHARE_AUTH=false): forward API keys only, no
 * host credential mounts.
 */
export function planSandboxAuth(provider: SandboxProvider): SandboxAuthPlan {
  const spec = AUTH[provider];
  if (!shareAuthEnabled()) {
    return {
      credentialMounts: [],
      envPassthrough: [...spec.apiKeyEnv, ...BASE_ENV[provider]],
      envSet: {},
      workspaceSymlinks: [],
      warning: null,
    };
  }

  const home = homedir();
  const credentialMounts: string[] = [];
  for (const rel of spec.files) {
    const host = `${home}/${rel}`;
    if (existsSync(host)) credentialMounts.push(`${host}:${spec.containerDir}/${basename(rel)}:ro`);
  }
  const hasCreds = credentialMounts.length > 0;
  const hasToken = spec.tokenEnv.some((n) => process.env[n]);

  let warning: string | null = null;
  if (!hasCreds && !hasToken) {
    warning =
      `docker sandbox: no subscription credential found for ${provider} ` +
      `(host OAuth file absent, no token env). ` +
      (provider === "claude" ? "Run `claude setup-token` and export CLAUDE_CODE_OAUTH_TOKEN, " : "") +
      `or set NOVA_SANDBOX_SHARE_AUTH=false to use API keys.`;
  }

  return {
    credentialMounts,
    envPassthrough: [...spec.tokenEnv, ...BASE_ENV[provider]],
    envSet: hasCreds && spec.envSet ? spec.envSet : {},
    workspaceSymlinks: hasCreds && spec.homeSymlink ? [{ link: spec.homeSymlink, target: spec.containerDir }] : [],
    warning,
  };
}

/**
 * Create the in-workspace symlinks a provider needs so a HOME-relative config
 * dir resolves to the top-level credential mount. Runs on the host workspace
 * dir (bound to /workspace) before `docker run`.
 */
export function prepareAuthWorkspace(workspaceDir: string, plan: SandboxAuthPlan): void {
  for (const { link, target } of plan.workspaceSymlinks) {
    const path = `${workspaceDir}/${link}`;
    try { rmSync(path, { recursive: true, force: true }); } catch {}
    try { symlinkSync(target, path); } catch {}
  }
}
