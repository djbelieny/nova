/**
 * Nova — Management CLI (`nova providers`, `nova invite`)
 *
 * A thin, arg-parsed CLI over the same provider-registry + db helpers the dashboard
 * uses — no parallel config system. Commands:
 *
 *   nova providers list
 *   nova providers add            (interactive prompts, reuses the wizard's ask())
 *   nova providers remove <name>
 *   nova providers test <name>
 *   nova providers default <name>
 *   nova invite [member|admin]
 *
 * Secrets are never printed: only the env-var name + whether it is currently set.
 */

import {
  readConfigProfiles,
  loadProviderProfiles,
  upsertProviderProfile,
  removeProviderProfile,
  validateProfile,
  providerConfigPath,
} from "./provider-registry.ts";
import type { ProviderProfile } from "./providers/openai-compatible.ts";
import { getDb, type DatabaseType } from "./db.ts";
import { ask, PROVIDERS } from "./setup-wizard.ts";

const VALID_COST_CLASSES = ["subscription-cli", "cheap-api", "standard-api", "premium-api"] as const;

// ─── Pure handlers (unit-tested; no process side effects beyond file/db) ──────

/** Render the configured providers (config file only) as a human-readable string. */
export function renderProviders(configPath: string, defaultName?: string | null): string {
  const profiles = readConfigProfiles(configPath);
  if (!profiles.length) return "No custom providers configured. Add one with: nova providers add";
  const lines = profiles.map((p) => {
    const set = !!process.env[p.apiKeyEnv];
    const marker = defaultName && p.name === defaultName ? "*" : " ";
    const key = `${set ? "✓" : "✗"} ${p.apiKeyEnv}`;
    return `${marker} ${p.name}  ${p.baseUrl}  [${key}]  model=${p.defaultModel}  ${p.costClass}`;
  });
  return lines.join("\n");
}

/** Validate + persist a profile to the config file. Returns the new full list. */
export function addProvider(profile: ProviderProfile, configPath: string = providerConfigPath()): ProviderProfile[] {
  const err = validateProfile(profile);
  if (err) throw new Error(err);
  return upsertProviderProfile(profile, configPath);
}

/** Remove a profile by name from the config file. Returns the new full list. */
export function removeProvider(name: string, configPath: string = providerConfigPath()): ProviderProfile[] {
  return removeProviderProfile(name, configPath);
}

/**
 * Set the default provider preference on every admin user (the source of truth the
 * relay reads on boot). Returns the number of admin rows updated.
 */
export function setDefaultProviderPref(name: string, db: DatabaseType): number {
  const admins = db.getUsersByRole("admin");
  for (const a of admins) db.updateUser(a.id, { ai_provider: name });
  return admins.length;
}

/** Create a 24h pairing code for the given role via the admin user. Returns the code. */
export function createInvite(db: DatabaseType, role: "member" | "admin" = "member"): string {
  const adminId = db.getUsersByRole("admin")[0]?.id || "__master__";
  return db.createPairingCode(adminId, role, 24 * 60);
}

// ─── Interactive add flow ─────────────────────────────────────────────────────

function promptForProfile(): ProviderProfile {
  console.log("\n  Add an OpenAI-compatible AI model provider.\n");
  const name = ask("Provider name (e.g. openrouter):");
  const baseUrl = ask("Base URL (…/v1):");
  const apiKeyEnv = ask("API key env var (e.g. OPENROUTER_API_KEY):");
  const modelsRaw = ask("Models (comma-separated):");
  const models = modelsRaw.split(",").map((m) => m.trim()).filter(Boolean);
  const defaultModel = ask("Default model:", models[0] || "");
  console.log("\n  Cost class:");
  VALID_COST_CLASSES.forEach((cc, i) => console.log(`    ${i + 1}) ${cc}`));
  const pick = ask("Cost class number:", "2");
  const costClass = VALID_COST_CLASSES[Math.max(0, Math.min(VALID_COST_CLASSES.length - 1, parseInt(pick || "2", 10) - 1))];
  return { name, baseUrl, apiKeyEnv, models, defaultModel, costClass };
}

// ─── CLI entry ────────────────────────────────────────────────────────────────

async function runProviders(args: string[]): Promise<number> {
  const sub = args[0] || "list";
  const configPath = providerConfigPath();

  if (sub === "list") {
    const db = getDb();
    const def = db.getUsersByRole("admin")[0]?.ai_provider || null;
    console.log(renderProviders(configPath, def));
    return 0;
  }

  if (sub === "add") {
    const profile = promptForProfile();
    const err = validateProfile(profile);
    if (err) { console.error(`  Error: ${err}`); return 1; }
    addProvider(profile, configPath);
    const set = !!process.env[profile.apiKeyEnv];
    console.log(`\n  ✓ Added "${profile.name}" → ${configPath}`);
    if (!set) console.log(`  ! ${profile.apiKeyEnv} is not set — add it to .env before use.`);
    return 0;
  }

  if (sub === "remove") {
    const name = args[1];
    if (!name) { console.error("  Usage: nova providers remove <name>"); return 1; }
    removeProvider(name, configPath);
    console.log(`  ✓ Removed "${name}"`);
    return 0;
  }

  if (sub === "test") {
    const name = args[1];
    if (!name) { console.error("  Usage: nova providers test <name>"); return 1; }
    const profile = loadProviderProfiles(configPath).find((p) => p.name === name);
    if (!profile) { console.error(`  Unknown provider: ${name}`); return 1; }
    const { OpenAICompatibleProvider } = await import("./providers/openai-compatible.ts");
    const prov = new OpenAICompatibleProvider(profile);
    if (!(await prov.isAvailable())) { console.error(`  ✗ ${profile.apiKeyEnv} is not set`); return 1; }
    const start = performance.now();
    try {
      const r = await prov.call({ prompt: "ping", noMcp: true, maxTurns: 1 });
      console.log(`  ✓ ${name} ok (${Math.round(performance.now() - start)}ms): ${String(r.text || "").slice(0, 120)}`);
      return 0;
    } catch (e: any) {
      console.error(`  ✗ ${name}: ${e.message}`);
      return 1;
    }
  }

  if (sub === "default") {
    const name = args[1];
    if (!name) { console.error("  Usage: nova providers default <name>"); return 1; }
    const n = setDefaultProviderPref(name, getDb());
    console.log(`  ✓ Default model → ${name} (updated ${n} admin ${n === 1 ? "user" : "users"})`);
    return 0;
  }

  console.error(`  Unknown subcommand: ${sub}\n  Usage: nova providers list|add|remove <name>|test <name>|default <name>`);
  return 1;
}

async function runInvite(args: string[]): Promise<number> {
  const role = args[0] === "admin" ? "admin" : "member";
  const code = createInvite(getDb(), role);
  console.log(`\n  Invite code (${role}, valid 24h): ${code}`);
  console.log(`  Share it with your teammate — they send it to Nova (or "request access") to join.\n`);
  return 0;
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  let code = 0;
  if (command === "providers") code = await runProviders(rest);
  else if (command === "invite") code = await runInvite(rest);
  else {
    console.error("  Usage:\n    nova providers list|add|remove <name>|test <name>|default <name>\n    nova invite [member|admin]");
    code = 1;
  }
  process.exit(code);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`\n  Error: ${err?.message || err}`);
    process.exit(1);
  });
}
