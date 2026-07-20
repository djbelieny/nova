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

/** Runs the full suite (tool presence + env config). Pass a fake runner in tests. */
export async function runAllChecks(
  env: Record<string, string | undefined> = process.env,
  run: Runner = defaultRunner
): Promise<Check[]> {
  const [bun, claude, git] = await Promise.all([
    checkCommand("Bun", "bun", "--version", run),
    checkCommand("Claude Code CLI", "claude", "--version", run),
    checkCommand("git", "git", "--version", run),
  ]);
  return [bun, claude, git, ...runEnvChecks(env)];
}

/** Formats checks + versions into a copyable diagnostics blob. */
export function formatDiagnostics(checks: Check[], versions: Record<string, string> = {}): string {
  const lines: string[] = ["Nova Doctor — diagnostics", "========================="];
  for (const c of checks) {
    lines.push(`${c.ok ? "✅" : "❌"} ${c.name}: ${c.detail}`);
    if (!c.ok && c.fix) lines.push(`   → ${c.fix}`);
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
  const checks = await runAllChecks();
  console.log(formatDiagnostics(checks, { platform: process.platform, node: process.version }));
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}
