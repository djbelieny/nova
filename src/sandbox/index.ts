import { LocalBackend } from "./local.ts";

export interface SandboxExecOpts {
  cwd: string;
  network?: "none" | "bridge";
  workspaceAccess?: "rw" | "ro";
  extraBinds?: string[];
}
export interface WrappedCommand { argv: string[]; cwd: string; }
export interface SandboxBackend {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  wrapCommand(argv: string[], opts: SandboxExecOpts): WrappedCommand;
}

let resolved: SandboxBackend | null = null;
let warning: string | null = null;

export function getSandboxWarning(): string | null { return warning; }
export function resetSandboxForTests(): void { resolved = null; warning = null; }

export async function resolveSandboxBackend(): Promise<SandboxBackend> {
  if (resolved) return resolved;
  const requested = (process.env.NOVA_SANDBOX_BACKEND || "local").toLowerCase();
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
