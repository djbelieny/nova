import type { SandboxBackend, SandboxExecOpts, WrappedCommand } from "./index.ts";

export class LocalBackend implements SandboxBackend {
  readonly name = "local";
  async isAvailable(): Promise<boolean> { return true; }
  wrapCommand(argv: string[], opts: SandboxExecOpts): WrappedCommand {
    return { argv, cwd: opts.cwd };
  }
}
