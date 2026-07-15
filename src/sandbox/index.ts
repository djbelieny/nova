import { LocalBackend } from "./local.ts";

export interface SandboxExecOpts {
  cwd: string;
  network?: "none" | "bridge";
  workspaceAccess?: "rw" | "ro";
  extraBinds?: string[];
  envPassthrough?: string[];
}
export interface WrappedCommand { argv: string[]; cwd: string; }
export interface SandboxBackend {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  wrapCommand(argv: string[], opts: SandboxExecOpts): WrappedCommand;
}

export interface WrapExecOpts {
  network?: "none" | "bridge";
  envPassthrough?: string[];
  workspaceDir?: string;
}

let resolved: SandboxBackend | null = null;
let warning: string | null = null;

export function getSandboxWarning(): string | null { return warning; }
export function getResolvedSandboxName(): string | null { return resolved?.name ?? null; }
export function resetSandboxForTests(): void { resolved = null; warning = null; }

export async function resolveSandboxBackend(): Promise<SandboxBackend> {
  if (resolved) return resolved;
  const requested = (process.env.NOVA_SANDBOX_BACKEND || "local").trim().toLowerCase();
  if (requested === "local") {
    resolved = new LocalBackend();
    return resolved;
  }
  if (requested === "docker") {
    const { DockerBackend } = await import("./docker.ts");
    const docker = new DockerBackend();
    if (await docker.isAvailable()) {
      resolved = docker;
      return resolved;
    }
    warning = "Sandbox backend 'docker' requested but Docker is not available — falling back to UNSANDBOXED local execution.";
    console.warn(`[sandbox] ${warning}`);
    resolved = new LocalBackend();
    return resolved;
  }
  warning = `Unknown sandbox backend '${requested}' — falling back to local execution.`;
  console.warn(`[sandbox] ${warning}`);
  resolved = new LocalBackend();
  return resolved;
}

/**
 * Wrap a provider CLI invocation for sandboxed execution. Classification and
 * no-tool calls (isToolExecution=false) are never wrapped. The local backend
 * is an identity passthrough. The docker backend containerizes the CLI with a
 * per-user workspace mount (never the repo/PROJECT_ROOT), bridge network so the
 * CLI can reach the model API, and a credential env allowlist.
 */
export async function wrapForExecution(
  argv: string[], cwd: string, isToolExecution: boolean, opts: WrapExecOpts = {},
): Promise<WrappedCommand> {
  if (!isToolExecution) return { argv, cwd };
  const backend = await resolveSandboxBackend();
  if (backend.name === "local") return backend.wrapCommand(argv, { cwd });
  return backend.wrapCommand(argv, {
    cwd: opts.workspaceDir ?? cwd,
    network: opts.network ?? "bridge",
    envPassthrough: opts.envPassthrough,
  });
}
