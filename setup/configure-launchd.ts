/**
 * Nova — Configure launchd (macOS)
 *
 * Generates and loads launchd plist files with correct paths
 * for the current user and project location.
 *
 * Usage: bun run setup/configure-launchd.ts [--service core|checkin|briefing|memory-review|all]
 */

import { writeFile, readFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

const PROJECT_ROOT = dirname(import.meta.dir);
const HOME = homedir();
const USERNAME = HOME.split("/").pop() || "user";
const LAUNCH_AGENTS = join(HOME, "Library", "LaunchAgents");
const LOGS_DIR = join(PROJECT_ROOT, "logs");

// Colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const PASS = green("✓");
const FAIL = red("✗");

// Find bun path
async function findBun(): Promise<string> {
  const candidates = [
    join(HOME, ".bun", "bin", "bun"),
    "/usr/local/bin/bun",
    "/opt/homebrew/bin/bun",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Fallback: which bun
  const proc = Bun.spawn(["which", "bun"], { stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  return out.trim() || "bun";
}

function generatePlist(opts: {
  label: string;
  script: string;
  keepAlive: boolean;
  calendarIntervals?: { Hour: number; Minute: number }[];
  startInterval?: number;
  extraArgs?: string[];
  envFile?: string;
  pythonCommand?: string[];
}): string {
  const bunPath = findBunSync;

  let scheduling = "";
  if (opts.calendarIntervals) {
    scheduling = `
    <key>StartCalendarInterval</key>
    <array>${opts.calendarIntervals
      .map(
        (ci) => `
        <dict>
            <key>Hour</key>
            <integer>${ci.Hour}</integer>
            <key>Minute</key>
            <integer>${ci.Minute}</integer>
        </dict>`
      )
      .join("")}
    </array>`;
  } else if (opts.startInterval) {
    scheduling = `
    <key>StartInterval</key>
    <integer>${opts.startInterval}</integer>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${opts.label}</string>

    <key>ProgramArguments</key>
    <array>${
  opts.pythonCommand
    ? opts.pythonCommand.map(a => `\n        <string>${a}</string>`).join("")
    : [
        `\n        <string>${bunPath}</string>`,
        `\n        <string>run</string>`,
        ...(opts.envFile
          ? [
              `\n        <string>--env-file</string>`,
              `\n        <string>${PROJECT_ROOT}/${opts.envFile}</string>`,
              `\n        <string>--env-file</string>`,
              `\n        <string>${PROJECT_ROOT}/.env</string>`,
            ]
          : []),
        `\n        <string>${opts.script}</string>`,
        ...(opts.extraArgs ?? []).map((a: string) => `\n        <string>${a}</string>`),
      ].join("")
}
    </array>

    <key>WorkingDirectory</key>
    <string>${PROJECT_ROOT}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${HOME}/.bun/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>${HOME}</string>
    </dict>
${opts.keepAlive ? `
    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>10</integer>
` : ""}${scheduling}
    <key>StandardOutPath</key>
    <string>${LOGS_DIR}/${opts.label}.log</string>

    <key>StandardErrorPath</key>
    <string>${LOGS_DIR}/${opts.label}.error.log</string>
</dict>
</plist>`;
}

let findBunSync = "";

interface ServiceConfig {
  label: string;
  script: string;
  keepAlive: boolean;
  calendarIntervals?: { Hour: number; Minute: number }[];
  startInterval?: number;
  description: string;
  extraArgs?: string[];
  envFile?: string;
  pythonCommand?: string[];
}

const SERVICES: Record<string, ServiceConfig> = {
  core: {
    label: "com.nova.core",
    script: "src/relay.ts",
    keepAlive: true,
    description: "Main bot (always running, restarts on crash)",
  },
  relay: {
    label: "com.nova.core",
    script: "src/relay.ts",
    keepAlive: true,
    description: "Main bot (always running, restarts on crash)",
  },
  checkin: {
    label: "com.nova.smart-checkin",
    script: "services/smart-checkin.ts",
    keepAlive: false,
    calendarIntervals: [
      { Hour: 9, Minute: 0 },
      { Hour: 10, Minute: 30 },
      { Hour: 12, Minute: 0 },
      { Hour: 14, Minute: 0 },
      { Hour: 16, Minute: 0 },
      { Hour: 18, Minute: 0 },
    ],
    description: "Smart check-ins (runs during work hours)",
  },
  briefing: {
    label: "com.nova.morning-briefing",
    script: "services/morning-briefing.ts",
    keepAlive: false,
    calendarIntervals: [{ Hour: 9, Minute: 0 }],
    description: "Morning briefing (daily at 9am)",
  },
  "memory-review": {
    label: "com.nova.memory-review",
    script: "services/memory-review.ts",
    keepAlive: false,
    calendarIntervals: [{ Hour: 3, Minute: 0 }],
    description: "Memory cleanup (daily at 3am)",
  },
  dispatcher: {
    label: "com.nova.task-dispatcher",
    script: "services/task-dispatcher.ts",
    keepAlive: false,
    startInterval: 60,
    description: "Scheduled task dispatcher (runs every 60s)",
  },
  "health-monitor": {
    label: "com.nova.health-monitor",
    script: "services/health-monitor.ts",
    keepAlive: false,
    startInterval: 1800,
    description: "Health monitor and self-healing (runs every 30min)",
  },
  voice: {
    label: "com.nova.voice",
    script: "src/voice-server.ts",
    keepAlive: true,
    description: "Voice server — Twilio + ElevenLabs",
  },
  dashboard: {
    label: "com.nova.dashboard",
    script: "src/dashboard.ts",
    keepAlive: true,
    description: "Admin dashboard (port 3033)",
  },
  memwright: {
    label: "com.nova.memwright",
    script: "",
    keepAlive: true,
    description: "Memwright memory service (port 8765)",
  },
  "exec-ceo": {
    label: "com.nova.exec-ceo",
    script: "src/executive-node.ts",
    keepAlive: true,
    extraArgs: ["--role", "ceo"],
    envFile: ".env.ceo",
    description: "Executive CEO node",
  },
  "exec-cfo": {
    label: "com.nova.exec-cfo",
    script: "src/executive-node.ts",
    keepAlive: true,
    extraArgs: ["--role", "cfo"],
    envFile: ".env.cfo",
    description: "Executive CFO node",
  },
  "exec-cmo": {
    label: "com.nova.exec-cmo",
    script: "src/executive-node.ts",
    keepAlive: true,
    extraArgs: ["--role", "cmo"],
    envFile: ".env.cmo",
    description: "Executive CMO node",
  },
  "exec-cto": {
    label: "com.nova.exec-cto",
    script: "src/executive-node.ts",
    keepAlive: true,
    extraArgs: ["--role", "cto"],
    envFile: ".env.cto",
    description: "Executive CTO node",
  },
  "exec-coo": {
    label: "com.nova.exec-coo",
    script: "src/executive-node.ts",
    keepAlive: true,
    extraArgs: ["--role", "coo"],
    envFile: ".env.coo",
    description: "Executive COO node",
  },
  "exec-research": {
    label: "com.nova.exec-research",
    script: "src/executive-node.ts",
    keepAlive: true,
    extraArgs: ["--role", "research"],
    envFile: ".env.research",
    description: "Executive Research node",
  },
  "exec-critic": {
    label: "com.nova.exec-critic",
    script: "src/executive-node.ts",
    keepAlive: true,
    extraArgs: ["--role", "critic"],
    envFile: ".env.critic",
    description: "Executive Critic node",
  },
  backup: {
    label: "com.nova.backup",
    script: "scripts/backup.ts",
    keepAlive: false,
    calendarIntervals: [{ Hour: 2, Minute: 0 }],
    description: "Daily backup (runs at 2am, keeps last 7)",
  },
};

async function installService(name: string, config: ServiceConfig): Promise<boolean> {
  const plistPath = join(LAUNCH_AGENTS, `${config.label}.plist`);

  // Memwright is a Python/uvicorn service — build the command from the venv
  if (name === "memwright") {
    const python = join(PROJECT_ROOT, ".venv-memwright", "bin", "uvicorn");
    config = {
      ...config,
      pythonCommand: [
        python,
        "agent_memory.api:app",
        "--host", "127.0.0.1",
        "--port", "8765",
      ],
    };
  }

  // Generate plist
  const content = generatePlist({
    label: config.label,
    script: config.script,
    keepAlive: config.keepAlive,
    calendarIntervals: config.calendarIntervals,
    startInterval: config.startInterval,
    extraArgs: config.extraArgs,
    envFile: config.envFile,
    pythonCommand: config.pythonCommand,
  });
  await writeFile(plistPath, content);
  console.log(`  ${PASS} Generated ${config.label}.plist`);

  // Unload if already loaded
  const unload = Bun.spawn(["launchctl", "unload", plistPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await unload.exited;

  // Load
  const load = Bun.spawn(["launchctl", "load", plistPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const loadErr = await new Response(load.stderr).text();
  const loadCode = await load.exited;

  if (loadCode !== 0) {
    console.log(`  ${FAIL} Failed to load: ${loadErr.trim()}`);
    return false;
  }

  console.log(`  ${PASS} Loaded — ${config.description}`);
  return true;
}

/**
 * Generate a newsyslog.conf for macOS log rotation.
 *
 * Install path: ~/.config/nova/newsyslog.conf
 * Activate:     sudo cp ~/.config/nova/newsyslog.conf /etc/newsyslog.d/nova.conf
 *               sudo newsyslog -nvf /etc/newsyslog.d/nova.conf
 *
 * Format columns: logfilename [owner:group] mode count size when flags
 *   count  — number of rotated archives to keep
 *   size   — rotate when file exceeds N KB (* = size-independent)
 *   when   — @T02 = daily at 02:00
 *   flags  — J = gzip-compress rotated file
 */
export async function configureLogRotation(home: string): Promise<void> {
  const configDir = join(home, ".config", "nova");
  await mkdir(configDir, { recursive: true });

  const logFiles = [
    "com.nova.core",
    "com.nova.backup",
    "com.nova.exec-ceo",
    "com.nova.exec-cfo",
    "com.nova.exec-cmo",
    "com.nova.exec-cto",
    "com.nova.exec-coo",
    "com.nova.exec-research",
    "com.nova.exec-critic",
    "com.nova.smart-checkin",
    "com.nova.morning-briefing",
    "com.nova.memory-review",
    "com.nova.task-dispatcher",
    "com.nova.health-monitor",
    "com.nova.voice",
    "com.nova.dashboard",
    "com.nova.memwright",
  ];

  const header = `# Nova log rotation — newsyslog format
# Generated by: bun run setup:logrotate
#
# To activate on macOS:
#   sudo cp ${configDir}/newsyslog.conf /etc/newsyslog.d/nova.conf
#   sudo newsyslog -nvf /etc/newsyslog.d/nova.conf
#
# Columns: logfilename [owner:group] mode count size when flags
#   count  = rotated archives to keep
#   size   = * (size-independent — rotate on schedule only)
#   when   = @T02 (daily at 02:00 local time)
#   flags  = J (gzip compress rotated file)
#
`;

  const projectLogsDir = join(PROJECT_ROOT, "logs");
  const lines = logFiles.flatMap((label) => [
    `${projectLogsDir}/${label}.log         644  7     *    @T02   J`,
    `${projectLogsDir}/${label}.error.log   644  7     *    @T02   J`,
  ]);

  const content = header + lines.join("\n") + "\n";
  const confPath = join(configDir, "newsyslog.conf");
  await writeFile(confPath, content);

  console.log(`  ${PASS} Written: ${confPath}`);
  console.log(`  ${dim("To activate:")}`);
  console.log(`      sudo cp ${confPath} /etc/newsyslog.d/nova.conf`);
  console.log(`      sudo newsyslog -nvf /etc/newsyslog.d/nova.conf`);
}

async function main() {
  if (process.platform !== "darwin") {
    console.log(`\n  ${FAIL} This script is for macOS only.`);
    console.log(`      ${dim("On Linux/Windows, use: bun run setup/configure-services.ts")}`);
    process.exit(1);
  }

  findBunSync = await findBun();

  // Parse flags
  const args = process.argv.slice(2);

  // --logrotate: only generate newsyslog.conf, then exit
  if (args.includes("--logrotate")) {
    console.log("");
    console.log(bold("  Configure Log Rotation (newsyslog)"));
    console.log(dim(`  Project: ${PROJECT_ROOT}`));
    console.log("");
    await configureLogRotation(HOME);
    console.log("");
    return;
  }

  const serviceIdx = args.indexOf("--service");
  const serviceArg = serviceIdx !== -1 ? args[serviceIdx + 1] : "core";

  const toInstall = serviceArg === "all" ? Object.keys(SERVICES) : [serviceArg];

  console.log("");
  console.log(bold("  Configure launchd Services"));
  console.log(dim(`  Bun: ${findBunSync}`));
  console.log(dim(`  Project: ${PROJECT_ROOT}`));
  console.log("");

  // Ensure logs directory exists
  if (!existsSync(LOGS_DIR)) {
    const { mkdirSync } = await import("fs");
    mkdirSync(LOGS_DIR, { recursive: true });
  }

  let allOk = true;
  for (const name of toInstall) {
    const config = SERVICES[name];
    if (!config) {
      console.log(`  ${FAIL} Unknown service: ${name}`);
      console.log(`      ${dim("Available: core, checkin, briefing, memory-review, dispatcher, health-monitor, voice, dashboard, memwright, exec-ceo, exec-cfo, exec-cmo, exec-cto, exec-coo, exec-research, exec-critic, backup, all (relay is accepted as alias for core)")}`);
      allOk = false;
      continue;
    }
    const ok = await installService(name, config);
    if (!ok) allOk = false;
  }

  console.log("");
  if (allOk) {
    console.log(`  ${green("Done!")} Services are running.`);
    console.log("");
    console.log(`  ${dim("Check status:")}  launchctl list | grep com.nova`);
    console.log(`  ${dim("View logs:")}     tail -f ${LOGS_DIR}/com.nova.core.log`);
    console.log(`  ${dim("Stop all:")}      bun run setup/configure-launchd.ts --unload`);
  }
  console.log("");
}

main().catch((err) => {
  console.error(`\n  ${red("Error:")} ${err.message}`);
  process.exit(1);
});
