/**
 * Nova — Configure systemd (Linux/VPS)
 *
 * Reads daemon/*.service templates, replaces path placeholders with
 * detected values, installs to /etc/systemd/system/, enables, and starts.
 *
 * Usage: sudo bun run setup/configure-systemd.ts [--service all|nova|nova-voice|...]
 */

import { readdir, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

const PROJECT_ROOT = dirname(import.meta.dir);
const HOME = homedir();
const DAEMON_DIR = join(PROJECT_ROOT, "daemon");

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const PASS = green("✓");
const FAIL = red("✗");

function detectBun(): string {
  const candidates = [
    join(HOME, ".bun", "bin", "bun"),
    "/usr/local/bin/bun",
    "/opt/homebrew/bin/bun",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  try {
    return execSync("which bun", { encoding: "utf-8" }).trim();
  } catch {
    return "bun";
  }
}

function detectUser(): string {
  try {
    return execSync("whoami", { encoding: "utf-8" }).trim();
  } catch {
    return "nova";
  }
}

async function installService(serviceFile: string, bunPath: string, user: string): Promise<boolean> {
  const serviceName = serviceFile.replace(".service", "");
  const templatePath = join(DAEMON_DIR, serviceFile);
  const destPath = `/etc/systemd/system/${serviceFile}`;

  let content = await readFile(templatePath, "utf-8");

  content = content
    .replaceAll("YOUR_USERNAME", user)
    .replaceAll("/home/nova", HOME)
    .replaceAll("/home/YOUR_USERNAME", HOME)
    .replaceAll("/opt/nova", PROJECT_ROOT)
    .replaceAll("/usr/local/bin/bun", bunPath)
    .replaceAll("User=nova", `User=${user}`)
    .replaceAll("Group=nova", `Group=${user}`);

  await writeFile(destPath, content);
  console.log(`  ${PASS} Written: ${destPath}`);

  try {
    execSync(`systemctl daemon-reload`, { stdio: "pipe" });
    execSync(`systemctl enable ${serviceName}`, { stdio: "pipe" });
    execSync(`systemctl start ${serviceName}`, { stdio: "pipe" });
    console.log(`  ${PASS} Enabled and started: ${serviceName}`);
    return true;
  } catch (err: any) {
    console.log(`  ${FAIL} Failed to start ${serviceName}: ${err.message}`);
    return false;
  }
}

async function main() {
  if (process.platform === "darwin") {
    console.log(`\n  This script is for Linux only. On macOS, use:`);
    console.log(`      ${dim("bun run setup/configure-launchd.ts")}`);
    process.exit(1);
  }

  if (process.getuid?.() !== 0) {
    console.log(`\n  ${FAIL} Must run as root: sudo bun run setup/configure-systemd.ts`);
    process.exit(1);
  }

  const bunPath = detectBun();
  const user = detectUser() === "root" ? "nova" : detectUser();

  const args = process.argv.slice(2);
  const serviceIdx = args.indexOf("--service");
  const serviceArg = serviceIdx !== -1 ? args[serviceIdx + 1] : "all";

  console.log(`\n${bold("  Configure systemd Services")}`);
  console.log(dim(`  Bun: ${bunPath}`));
  console.log(dim(`  User: ${user}`));
  console.log(dim(`  Project: ${PROJECT_ROOT}\n`));

  const allServices = (await readdir(DAEMON_DIR)).filter(f => f.endsWith(".service"));

  const toInstall = serviceArg === "all"
    ? allServices
    : [`${serviceArg}.service`].filter(f => allServices.includes(f));

  if (toInstall.length === 0) {
    console.log(`  ${FAIL} No matching service files found in daemon/`);
    console.log(`      ${dim("Available: " + allServices.map(f => f.replace(".service", "")).join(", "))}`);
    process.exit(1);
  }

  let allOk = true;
  for (const f of toInstall) {
    const ok = await installService(f, bunPath, user);
    if (!ok) allOk = false;
  }

  console.log("");
  if (allOk) {
    console.log(`  ${green("Done!")} All services installed and running.`);
    console.log(`\n  ${dim("Check status:")}  systemctl status nova`);
    console.log(`  ${dim("View logs:")}     journalctl -u nova -f`);
  }
  console.log("");
}

main().catch(err => {
  console.error(`\n  ${red("Error:")} ${err.message}`);
  process.exit(1);
});
