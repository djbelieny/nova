import type { SandboxBackend, SandboxExecOpts, WrappedCommand } from "./index.ts";

export class DockerBackend implements SandboxBackend {
  readonly name = "docker";
  async isAvailable(): Promise<boolean> { return false; }
  wrapCommand(argv: string[], opts: SandboxExecOpts): WrappedCommand {
    return { argv, cwd: opts.cwd };
  }
}
