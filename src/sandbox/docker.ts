import { spawn } from "bun";
import { homedir } from "os";
import { realpathSync, existsSync } from "fs";
import type { SandboxBackend, SandboxExecOpts, WrappedCommand } from "./index.ts";

export const BLOCKED_BIND_ROOTS = [
  ".ssh", ".aws", ".gnupg", ".config/gcloud", ".kube", ".docker", ".nova/credentials",
].map((p) => `${homedir()}/${p}`);

export function validateBind(bind: string): void {
  const hostPath = bind.split(":")[0];
  const resolved = existsSync(hostPath) ? realpathSync(hostPath) : hostPath;
  for (const root of BLOCKED_BIND_ROOTS) {
    if (resolved === root || resolved.startsWith(`${root}/`)) {
      throw new Error(`Sandbox bind '${bind}' is blocked: '${resolved}' is a credential root`);
    }
  }
}

export class DockerBackend implements SandboxBackend {
  readonly name = "docker";

  constructor(private image = process.env.NOVA_SANDBOX_IMAGE || "nova-sandbox:latest") {}

  async isAvailable(): Promise<boolean> {
    try {
      const proc = spawn(["docker", "info"], { stdout: "ignore", stderr: "ignore" });
      return (await proc.exited) === 0;
    } catch {
      return false;
    }
  }

  wrapCommand(argv: string[], opts: SandboxExecOpts): WrappedCommand {
    const workspaceBind = `${opts.cwd}:/workspace:${opts.workspaceAccess ?? "rw"}`;
    validateBind(workspaceBind);
    const binds = opts.extraBinds ?? [];
    for (const bind of binds) validateBind(bind);
    const wrapped = [
      "docker", "run", "--rm",
      "--network", opts.network ?? "none",
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--tmpfs", "/tmp",
      "-v", workspaceBind,
      "-w", "/workspace",
      "-e", "HOME=/workspace",
      ...binds.flatMap((b) => ["-v", b]),
      this.image,
      ...argv,
    ];
    return { argv: wrapped, cwd: opts.cwd };
  }
}
