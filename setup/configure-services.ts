/**
 * Nova — Configure Services (Windows/Linux)
 *
 * Sets up PM2 or Docker for process management on non-macOS systems.
 *
 * Usage: bun run setup/configure-services.ts [--service core|checkin|briefing|all] [--runtime pm2|docker]
 */

import { existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

const PROJECT_ROOT = dirname(import.meta.dir);
const LOGS_DIR = join(PROJECT_ROOT, "logs");

// Colors
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const PASS = green("✓");
const FAIL = red("✗");

async function run(cmd: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(cmd, { cwd: PROJECT_ROOT, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch {
    return { ok: false, stdout: "", stderr: "Command not found" };
  }
}

interface ServiceDef {
  name: string;
  script: string;
  cron?: string;
  description: string;
}

const SERVICES: Record<string, ServiceDef> = {
  core: {
    name: "nova",
    script: "src/relay.ts",
    description: "Main bot (always running)",
  },
  relay: {
    name: "nova",
    script: "src/relay.ts",
    description: "Main bot (always running)",
  },
  checkin: {
    name: "nova-smart-checkin",
    script: "services/smart-checkin.ts",
    cron: "*/30 9-18 * * *",
    description: "Smart check-ins (every 30 min, 9am-6pm)",
  },
  briefing: {
    name: "nova-morning-briefing",
    script: "services/morning-briefing.ts",
    cron: "0 9 * * *",
    description: "Morning briefing (daily at 9am)",
  },
};

async function checkPm2(): Promise<boolean> {
  const result = await run(["npx", "pm2", "--version"]);
  if (result.ok) {
    console.log(`  ${PASS} PM2: v${result.stdout}`);
    return true;
  }
  console.log(`  ${FAIL} PM2 not found`);
  console.log(`      ${dim("Install: npm install -g pm2")}`);
  return false;
}

async function installService(config: ServiceDef): Promise<boolean> {
  if (config.cron) {
    // Scheduled service — show cron instructions
    console.log(`  ${PASS} ${config.name}: add to crontab manually`);
    console.log(`      ${dim(`${config.cron} cd ${PROJECT_ROOT} && bun run ${config.script}`)}`);
    return true;
  }

  // Always-on service — use PM2
  // Stop existing first
  await run(["npx", "pm2", "delete", config.name]);

  const result = await run([
    "npx", "pm2", "start", config.script,
    "--interpreter", "bun",
    "--name", config.name,
    "--cwd", PROJECT_ROOT,
    "-o", join(LOGS_DIR, `${config.name}.log`),
    "-e", join(LOGS_DIR, `${config.name}.error.log`),
  ]);

  if (result.ok) {
    console.log(`  ${PASS} ${config.name} started — ${config.description}`);
    return true;
  }
  console.log(`  ${FAIL} Failed to start ${config.name}: ${result.stderr}`);
  return false;
}

async function checkDocker(): Promise<boolean> {
  const docker = await run(["docker", "--version"]);
  if (!docker.ok) {
    console.log(`  ${FAIL} Docker not found`);
    console.log(`      ${dim("Install: https://docs.docker.com/get-docker/")}`);
    return false;
  }
  console.log(`  ${PASS} Docker: ${docker.stdout.split(",")[0]}`);

  const compose = await run(["docker", "compose", "version"]);
  if (!compose.ok) {
    console.log(`  ${FAIL} Docker Compose not found`);
    console.log(`      ${dim("Install: https://docs.docker.com/compose/install/")}`);
    return false;
  }
  console.log(`  ${PASS} Compose: ${compose.stdout}`);
  return true;
}

async function installDocker(): Promise<boolean> {
  // Check for docker-compose.yml
  const composeFile = join(PROJECT_ROOT, "docker-compose.yml");
  if (!existsSync(composeFile)) {
    console.log(`  ${FAIL} docker-compose.yml not found in project root`);
    return false;
  }

  // Check for .env
  const envFile = join(PROJECT_ROOT, ".env");
  if (!existsSync(envFile)) {
    console.log(`  ${FAIL} .env not found — run ${dim("bun run setup")} first`);
    return false;
  }

  console.log("");
  console.log(`  Building and starting containers...`);

  const build = await run(["docker", "compose", "up", "--build", "-d"]);
  if (!build.ok) {
    console.log(`  ${FAIL} Docker build failed: ${build.stderr}`);
    return false;
  }
  console.log(`  ${PASS} Nova container started`);
  return true;
}

async function main() {
  if (process.platform === "darwin") {
    console.log(`\n  You're on macOS. Use launchd instead:`);
    console.log(`      ${dim("bun run setup/configure-launchd.ts")}`);
    console.log(`      ${dim("Or use --runtime docker for Docker deployment")}`);
  }

  // Parse flags
  const args = process.argv.slice(2);
  const serviceIdx = args.indexOf("--service");
  const serviceArg = serviceIdx !== -1 ? args[serviceIdx + 1] : "core";
  const runtimeIdx = args.indexOf("--runtime");
  const runtime = runtimeIdx !== -1 ? args[runtimeIdx + 1] : "pm2";

  // --- Docker runtime ---
  if (runtime === "docker") {
    console.log("");
    console.log(bold("  Configure Services (Docker)"));
    console.log("");

    const dockerOk = await checkDocker();
    if (!dockerOk) process.exit(1);

    const ok = await installDocker();
    if (!ok) process.exit(1);

    console.log("");
    console.log(`  ${dim("Check status:")}  docker compose ps`);
    console.log(`  ${dim("View logs:")}     docker compose logs -f`);
    console.log(`  ${dim("Stop:")}          docker compose down`);
    console.log(`  ${dim("Restart:")}       docker compose restart`);
    console.log("");
    return;
  }

  // --- PM2 runtime (default) ---
  if (process.platform === "darwin" && runtime !== "pm2") {
    process.exit(0);
  }

  const toInstall = serviceArg === "all" ? Object.keys(SERVICES) : [serviceArg];

  console.log("");
  console.log(bold("  Configure Services (PM2)"));
  console.log("");

  const pm2Ok = await checkPm2();
  if (!pm2Ok) process.exit(1);

  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

  console.log("");
  for (const name of toInstall) {
    const config = SERVICES[name];
    if (!config) {
      console.log(`  ${FAIL} Unknown service: ${name}`);
      continue;
    }
    await installService(config);
  }

  // Save PM2 config for auto-restart on reboot
  await run(["npx", "pm2", "save"]);
  console.log("");
  console.log(`  ${dim("Auto-start on boot:")} npx pm2 startup`);
  console.log(`  ${dim("Check status:")}        npx pm2 status`);
  console.log(`  ${dim("View logs:")}           npx pm2 logs`);
  console.log("");
}

main().catch((err) => {
  console.error(`\n  ${red("Error:")} ${err.message}`);
  process.exit(1);
});
