#!/usr/bin/env bun
/**
 * Nova — unified CLI (`nova <command> [args]`).
 *
 * A thin dispatcher over Nova's entry points so users type `nova connect`,
 * `nova providers add`, `nova doctor`, etc. instead of `bun run …`. Each command
 * runs its existing module unchanged (from the project root), so this adds a front
 * door without a parallel system. The `bun run …` scripts stay for compatibility.
 */

import { spawn } from "bun";
import { dirname, join } from "path";

const PROJECT_ROOT = dirname(import.meta.dir); // src/cli.ts → src → repo root

export interface RunSpec {
  kind: "run";
  file: string;               // path relative to project root
  args: string[];             // args passed to the script
  env?: Record<string, string>;
  bunFlags?: string[];        // flags for `bun run` (e.g. --watch)
  description: string;
}
export type Resolved =
  | RunSpec
  | { kind: "update"; description: string }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "unknown"; cmd: string };

/** The user-facing command surface. Order here is the order shown in help. */
const COMMANDS: Record<string, Omit<RunSpec, "kind" | "args"> & { aliases?: string[] }> = {
  init:      { file: "src/setup-wizard.ts", description: "Run the guided setup wizard", aliases: ["setup"] },
  start:     { file: "src/relay.ts", description: "Start Nova (the always-on relay)" },
  dev:       { file: "src/relay.ts", bunFlags: ["--watch"], description: "Start Nova with auto-reload" },
  chat:      { file: "src/relay.ts", env: { NOVA_CHANNELS: "cli", NOVA_CLI: "1" }, description: "Chat with Nova in this terminal" },
  connect:   { file: "src/connect/index.tsx", description: "Connect to a running Nova (local or remote)" },
  dashboard: { file: "src/dashboard.ts", description: "Start the web dashboard" },
  doctor:    { file: "src/doctor.ts", description: "Health check + diagnostics" },
  providers: { file: "src/cli-manage.ts", description: "Manage AI models (list/add/remove/test/default)" },
  invite:    { file: "src/cli-manage.ts", description: "Create a pairing invite code" },
  kb:        { file: "src/cli-kb.ts", description: "Manage the knowledge base (list/add/remove/search/reindex)" },
  playbook:  { file: "src/cli-playbook.ts", description: "Manage playbooks (list/seed/show/remove)" },
  automation:{ file: "src/cli-automation.ts", description: "Manage automations (event → workflow)" },
  process:   { file: "src/cli-process.ts", description: "Manage durable processes (list/show/cancel/start)" },
  extract:   { file: "src/cli-extract.ts", description: "Extract structured data from documents" },
  policy:    { file: "src/cli-policy.ts", description: "Manage compliance policies (spend/approval/content)" },
  roi:       { file: "src/cli-roi.ts", description: "Show ROI: tasks automated, hours saved, value vs cost" },
  connector: { file: "src/cli-connector.ts", description: "Manage business connectors (Stripe/Shopify/Zendesk/HubSpot)" },
  voice:     { file: "src/voice-server.ts", description: "Start the voice-call server" },
  backup:    { file: "scripts/backup.ts", description: "Back up data, config, and .env" },
};

/** Pure resolver (testable): maps argv (after `nova`) to what to run. */
export function resolveCommand(argv: string[]): Resolved {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return { kind: "help" };
  if (cmd === "version" || cmd === "--version" || cmd === "-v") return { kind: "version" };
  if (cmd === "update") return { kind: "update", description: "Pull the latest and reinstall" };

  // Resolve aliases → canonical name.
  const canonical = Object.keys(COMMANDS).find(
    (name) => name === cmd || COMMANDS[name].aliases?.includes(cmd),
  );
  if (!canonical) return { kind: "unknown", cmd };

  const spec = COMMANDS[canonical];
  // `providers` / `invite` are subcommands of cli-manage: prepend the group name.
  const leadingArgs = canonical === "providers" || canonical === "invite" ? [canonical] : [];
  return {
    kind: "run",
    file: spec.file,
    args: [...leadingArgs, ...rest],
    env: spec.env,
    bunFlags: spec.bunFlags,
    description: spec.description,
  };
}

function helpText(): string {
  const lines = ["Nova — your AI team. Usage: nova <command> [options]", "", "Commands:"];
  for (const [name, spec] of Object.entries(COMMANDS)) {
    const label = spec.aliases?.length ? `${name} (${spec.aliases.join(", ")})` : name;
    lines.push(`  ${label.padEnd(20)} ${spec.description}`);
  }
  lines.push(`  ${"update".padEnd(20)} Pull the latest and reinstall`);
  lines.push(`  ${"help".padEnd(20)} Show this help`);
  lines.push(`  ${"version".padEnd(20)} Show the Nova version`);
  lines.push("", "Advanced scripts remain available via `bun run <script>`.");
  return lines.join("\n");
}

async function readVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(await Bun.file(join(PROJECT_ROOT, "package.json")).text());
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<number> {
  const resolved = resolveCommand(process.argv.slice(2));

  if (resolved.kind === "help") {
    console.log(helpText());
    return 0;
  }
  if (resolved.kind === "version") {
    console.log(`nova ${await readVersion()}`);
    return 0;
  }
  if (resolved.kind === "unknown") {
    console.error(`Unknown command: ${resolved.cmd}\n`);
    console.error(helpText());
    return 1;
  }
  if (resolved.kind === "update") {
    const proc = spawn(["bash", "-lc", "git pull --ff-only && bun install"], {
      cwd: PROJECT_ROOT,
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await proc.exited;
    if (code === 0) console.log("Nova updated. Restart it to apply: nova start (or restart the service).");
    return code;
  }

  const argv = ["bun", "run", ...(resolved.bunFlags || []), resolved.file, ...resolved.args];
  const proc = spawn(argv, {
    cwd: PROJECT_ROOT,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, ...(resolved.env || {}) },
  });
  return await proc.exited;
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}
