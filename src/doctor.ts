/**
 * Nova — Doctor.
 *
 * Re-runnable health checks that back both the setup wizard's preflight step and a
 * standalone `nova doctor` command, and feed the user-facing `/status` reply. Produces a
 * copyable diagnostics blob — the "send this to support" artifact when someone is stuck.
 *
 * Design: the pure parts (env-key checks, formatting) take their inputs as arguments so
 * they're trivially testable; the shell-touching parts accept an injectable runner.
 */

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** Plain-language fix shown when ok === false. */
  fix?: string;
}

/** Runs a shell command and returns trimmed stdout, or throws. Overridable in tests. */
export type Runner = (cmd: string) => Promise<string>;

const defaultRunner: Runner = async (cmd: string) => {
  const proc = Bun.spawn(["bash", "-lc", cmd], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error(`exit ${proc.exitCode}`);
  return out.trim();
};

/**
 * Pure check of the environment/config. Verifies a Telegram bot is configured and that
 * at least one AI provider is usable. `claude` uses CLI auth (no key), so its presence is
 * treated as "configured" here and validated separately by the command checks.
 */
export function runEnvChecks(env: Record<string, string | undefined>): Check[] {
  const checks: Check[] = [];

  const hasToken = Boolean(env.TELEGRAM_BOT_TOKEN);
  checks.push({
    name: "Telegram bot token",
    ok: hasToken,
    detail: hasToken ? "set" : "missing",
    fix: hasToken ? undefined : "Create a bot with @BotFather and run `bun run init` to save the token.",
  });

  const hasUser = Boolean(env.TELEGRAM_USER_ID);
  checks.push({
    name: "Telegram user ID",
    ok: hasUser,
    detail: hasUser ? "set" : "missing",
    fix: hasUser ? undefined : "Run `bun run init` — it can capture your user ID automatically.",
  });

  const provider = (env.AI_PROVIDER || env.NOVA_PROVIDER || "claude").toLowerCase();
  const providerOk =
    provider === "claude" || // CLI auth, validated by command checks
    Boolean(env.ANTHROPIC_API_KEY) ||
    Boolean(env.GEMINI_API_KEY) ||
    Boolean(env.OPENAI_API_KEY) ||
    Boolean(env.GROQ_API_KEY);
  checks.push({
    name: "AI provider",
    ok: providerOk,
    detail: providerOk ? `configured (${provider})` : "no provider key found",
    fix: providerOk ? undefined : "Run `bun run init` and connect Claude or add an API key.",
  });

  return checks;
}

/** Entropy-aware strength gate: requires 32+ chars AND 8+ distinct chars. Rejects degenerate keys like `"aaaa...aaa"`. */
function looksStrongKey(k: string): boolean {
  if (!k || k.length < 32) return false;
  return new Set(k).size >= 8;
}

/** Pure security-posture checks. Reports on Fixes 1-3 flags + deployment hygiene. */
export function runSecurityChecks(env: Record<string, string | undefined>): Check[] {
  const checks: Check[] = [];
  const off = (v?: string) => ["off", "false", "0", "no"].includes((v || "").toLowerCase());

  const key = env.NOVA_ENCRYPTION_KEY || "";
  checks.push({
    name: "Encryption key",
    ok: looksStrongKey(key),
    detail: !key ? "missing" : looksStrongKey(key) ? "set (strong)" : "weak / too short",
    fix: looksStrongKey(key) ? undefined : "Set NOVA_ENCRYPTION_KEY to `openssl rand -hex 32` and restart.",
  });

  const dashHost = env.DASHBOARD_HOST || "127.0.0.1";
  const exposed = !/^(127\.|localhost|::1)/.test(dashHost);
  const hasPass = Boolean(env.DASHBOARD_PASS);
  checks.push({
    name: "Dashboard auth",
    ok: hasPass || !exposed,
    detail: !exposed ? "loopback-only" : hasPass ? "password set" : "EXPOSED without a password",
    fix: hasPass || !exposed ? undefined : "Set DASHBOARD_PASS or bind DASHBOARD_HOST to 127.0.0.1.",
  });

  checks.push({
    name: "Leak firewall",
    ok: !off(env.NOVA_LEAK_FIREWALL),
    detail: off(env.NOVA_LEAK_FIREWALL) ? "disabled" : "enabled",
    fix: off(env.NOVA_LEAK_FIREWALL) ? "Remove NOVA_LEAK_FIREWALL=off to redact/block leaked secrets." : undefined,
  });

  checks.push({
    name: "Least-privilege agent env",
    ok: env.NOVA_AGENT_ENV_STRICT !== "false",
    detail: env.NOVA_AGENT_ENV_STRICT === "false" ? "disabled (full env passthrough)" : "enabled",
    fix: env.NOVA_AGENT_ENV_STRICT === "false" ? "Remove NOVA_AGENT_ENV_STRICT=false so agents can't read unrelated secrets." : undefined,
  });

  checks.push({
    name: "Untrusted-input firewall",
    ok: !off(env.NOVA_UNTRUSTED_FIREWALL),
    detail: off(env.NOVA_UNTRUSTED_FIREWALL) ? "disabled" : "enabled",
    fix: off(env.NOVA_UNTRUSTED_FIREWALL) ? "Remove NOVA_UNTRUSTED_FIREWALL=off to neutralize injected content." : undefined,
  });

  const backend = (env.NOVA_SANDBOX_BACKEND || "local").toLowerCase();
  const untrustedOptIn = ["true", "1", "yes"].includes((env.NOVA_ALLOW_UNSANDBOXED_UNTRUSTED || "").toLowerCase());
  checks.push({
    name: "Sandbox posture",
    ok: backend === "docker" || untrustedOptIn,
    detail: backend === "docker" ? "docker" : untrustedOptIn ? "local (untrusted opt-in acknowledged)" : "local (untrusted flows unsandboxed)",
    fix: backend === "docker" || untrustedOptIn ? undefined : "Set NOVA_SANDBOX_BACKEND=docker for untrusted-triggered flows, or ack NOVA_ALLOW_UNSANDBOXED_UNTRUSTED=true.",
  });

  return checks;
}

/** Checks `.env` and the data directory aren't group/world-accessible. Uses `stat` via the injectable runner. */
export async function checkFilePerms(run: Runner = defaultRunner): Promise<Check[]> {
  const out: Check[] = [];
  const items: Array<[string, string, string]> = [
    ["Env file permissions", ".env", "600"],
    ["Data dir permissions", process.env.NOVA_DB_DIR || "data", "700"],
  ];
  for (const [name, path, want] of items) {
    try {
      const mode = (await run(`stat -c %a ${path} 2>/dev/null || stat -f %Lp ${path}`)).trim();
      const worldReadable = mode.length >= 3 && Number(mode[mode.length - 1]) !== 0;
      out.push({
        name, ok: !worldReadable,
        detail: `mode ${mode}`,
        fix: worldReadable ? `chmod ${want} ${path}` : undefined,
      });
    } catch {
      out.push({ name, ok: true, detail: "not present" });
    }
  }
  return out;
}

/** Checks a required CLI is present, returning its version string in `detail`. */
async function checkCommand(name: string, cmd: string, versionFlag: string, run: Runner): Promise<Check> {
  try {
    const version = await run(`${cmd} ${versionFlag}`);
    return { name, ok: true, detail: version.split("\n")[0] || "found" };
  } catch {
    return {
      name,
      ok: false,
      detail: "not found",
      fix: `Install ${name}. See the setup guide or re-run the installer (bootstrap.sh).`,
    };
  }
}

/**
 * RTK is an optional token saver — Nova works without it (raw command output). This check is
 * always `ok` so a missing binary never fails overall health; the detail just reports status.
 */
async function checkRtk(env: Record<string, string | undefined>, run: Runner): Promise<Check> {
  const off = ["off", "false", "0", "no"].includes((env.NOVA_RTK || "").toLowerCase());
  if (off) return { name: "RTK (token saver)", ok: true, detail: "disabled (NOVA_RTK)" };
  try {
    const version = await run("rtk --version");
    return { name: "RTK (token saver)", ok: true, detail: `${version.split("\n")[0] || "found"}, active` };
  } catch {
    return {
      name: "RTK (token saver)",
      ok: true,
      detail: "not installed (optional) — raw output",
      fix: "Optional: `brew install rtk` (or `cargo install --git https://github.com/rtk-ai/rtk`) for 60–90% smaller command output.",
    };
  }
}

/** Runs the full suite (tool presence + env config). Pass a fake runner in tests. */
export async function runAllChecks(
  env: Record<string, string | undefined> = process.env,
  run: Runner = defaultRunner
): Promise<Check[]> {
  const [bun, claude, git, rtk] = await Promise.all([
    checkCommand("Bun", "bun", "--version", run),
    checkCommand("Claude Code CLI", "claude", "--version", run),
    checkCommand("git", "git", "--version", run),
    checkRtk(env, run),
  ]);
  return [bun, claude, git, ...runEnvChecks(env), rtk];
}

/** Formats checks + versions into a copyable diagnostics blob. */
export function formatDiagnostics(checks: Check[], versions: Record<string, string> = {}): string {
  const lines: string[] = ["Nova Doctor — diagnostics", "========================="];
  for (const c of checks) {
    lines.push(`${c.ok ? "✅" : "❌"} ${c.name}: ${c.detail}`);
    if (c.fix) lines.push(`   → ${c.fix}`);
  }
  const vkeys = Object.keys(versions);
  if (vkeys.length > 0) {
    lines.push("", "Versions:");
    for (const k of vkeys) lines.push(`  ${k}: ${versions[k]}`);
  }
  const allOk = checks.every((c) => c.ok);
  lines.push("", allOk ? "All checks passed. Nova is ready. 🎉" : "Some checks failed — see the → fixes above.");
  return lines.join("\n");
}

if (import.meta.main) {
  const security = process.argv.includes("--security");
  if (security) {
    const checks = [...runSecurityChecks(process.env), ...(await checkFilePerms())];
    console.log(formatDiagnostics(checks, { platform: process.platform }));
    process.exit(checks.every((c) => c.ok) ? 0 : 1);
  }
  const checks = await runAllChecks();
  console.log(formatDiagnostics(checks, { platform: process.platform, node: process.version }));
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}
