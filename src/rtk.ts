/**
 * RTK (Rust Token Killer) integration — https://github.com/rtk-ai/rtk (Apache-2.0).
 *
 * RTK is a single Rust binary that compresses the output of common dev commands (git, build,
 * test, grep, docker, …) by 60–90% before it re-enters an LLM's context. It's the same idea as
 * mcp2cli (mcp2cli trims tool *schemas*; RTK trims command *output*).
 *
 * Two integration surfaces:
 *  1. The AI CLIs (Claude Code, …) get RTK via its own PreToolUse hook (`rtk init -g`, installed
 *     by bootstrap). That covers agents driven by those CLIs automatically — no code here.
 *  2. Nova's OWN bash path (the OpenAI-compatible provider loop + mcp2cli tool calls in
 *     api-agent-loop.ts) bypasses those hooks, so we wrap commands here.
 *
 * On by default; disable with NOVA_RTK=off. Skipped under the Docker sandbox (the rtk binary
 * isn't inside the container) and when rtk isn't installed (graceful passthrough).
 */

/** RTK is enabled unless explicitly turned off, and only when not running in the Docker sandbox. */
export function rtkEnabled(): boolean {
  const v = (process.env.NOVA_RTK || "").toLowerCase();
  if (v === "off" || v === "false" || v === "0" || v === "no") return false;
  if ((process.env.NOVA_SANDBOX_BACKEND || "local").toLowerCase() === "docker") return false;
  return true;
}

let _available: boolean | null = null;

/** Whether the `rtk` binary is on PATH (cached). */
export async function isRtkAvailable(): Promise<boolean> {
  if (_available !== null) return _available;
  try {
    const proc = Bun.spawn(["sh", "-lc", "command -v rtk"], { stdout: "ignore", stderr: "ignore" });
    _available = (await proc.exited) === 0;
  } catch {
    _available = false;
  }
  return _available;
}

/** Reset the availability cache (tests). */
export function resetRtkAvailability(value: boolean | null = null): void {
  _available = value;
}

// Shell control operators that make naive `rtk`-prefixing of a full command string unsafe.
const SHELL_OPS = /[|&;<>`\n]|\$\(/;
// Shell builtins / no-output commands where prefixing `rtk` is meaningless or harmful.
const NON_WRAPPABLE = new Set([
  "cd", "export", "source", ".", "eval", "exec", "set", "unset", "alias", "pushd", "popd", ":", "rtk",
]);

/**
 * Prefix a single, simple command with `rtk` so its output is filtered. `rtk <cmd>` is
 * "always safe" — it filters commands it knows and passes the rest through unchanged. We only
 * wrap operator-free commands (compound/piped commands are left for RTK's own CLI hook path)
 * and skip shell builtins. Pure — no environment checks.
 */
export function wrapCommandWithRtk(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return command;
  if (SHELL_OPS.test(trimmed)) return command;
  const first = trimmed.split(/\s+/)[0];
  if (NON_WRAPPABLE.has(first)) return command;
  return `rtk ${trimmed}`;
}

/** Wrap a command with RTK when enabled and available; otherwise return it unchanged. */
export async function maybeWrapWithRtk(command: string): Promise<string> {
  if (!rtkEnabled()) return command;
  if (!(await isRtkAvailable())) return command;
  return wrapCommandWithRtk(command);
}
