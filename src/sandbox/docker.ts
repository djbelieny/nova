import { spawn } from "bun";
import { homedir } from "os";
import { realpathSync, existsSync } from "fs";
import type { SandboxBackend, SandboxExecOpts, WrappedCommand } from "./index.ts";

export const BLOCKED_BIND_ROOTS = [
  ".ssh", ".aws", ".gnupg", ".config/gcloud", ".config/gh", ".kube", ".docker",
  ".claude", ".netrc", ".npmrc", ".git-credentials", ".nova/credentials",
].map((p) => `${homedir()}/${p}`);

function withSlash(p: string): string {
  return p.endsWith("/") ? p : `${p}/`;
}

export function validateBind(bind: string): void {
  const hostPath = bind.split(":")[0];
  const resolved = existsSync(hostPath) ? realpathSync(hostPath) : hostPath;
  for (const root of BLOCKED_BIND_ROOTS) {
    // Block when the bind IS a credential root, is UNDER one, or is an ANCESTOR
    // of one (mounting $HOME or / would expose the credential root inside it).
    if (
      resolved === root ||
      resolved.startsWith(`${root}/`) ||
      withSlash(root).startsWith(withSlash(resolved))
    ) {
      throw new Error(`Sandbox bind '${bind}' is blocked: '${resolved}' exposes credential root '${root}'`);
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
    // Credential mounts are curated by src/sandbox/auth.ts (never user input);
    // they intentionally bypass the blocklist but are forced read-only.
    const credMounts = (opts.credentialMounts ?? []).map((m) =>
      m.endsWith(":ro") ? m : `${m}:ro`,
    );
    const envFlags = (opts.envPassthrough ?? []).flatMap((name) => ["-e", name]);
    const envSetFlags = Object.entries(opts.envSet ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const wrapped = [
      "docker", "run", "--rm",
      "--network", opts.network ?? "none",
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", process.env.NOVA_SANDBOX_PIDS_LIMIT || "512",
      "--memory", process.env.NOVA_SANDBOX_MEMORY || "2g",
      "--cpus", process.env.NOVA_SANDBOX_CPUS || "2",
      "--tmpfs", "/tmp:size=512m",
      "-v", workspaceBind,
      "-w", "/workspace",
      "-e", "HOME=/workspace",
      ...envFlags,
      ...envSetFlags,
      ...binds.flatMap((b) => ["-v", b]),
      ...credMounts.flatMap((m) => ["-v", m]),
      this.image,
      ...argv,
    ];
    return { argv: wrapped, cwd: opts.cwd };
  }
}
