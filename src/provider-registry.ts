/**
 * Provider Registry Loader
 *
 * Reads declarative OpenAI-compatible provider profiles from config/providers.json
 * (idiomatic JSON, same style as .mcp.json). Tolerant: a missing or invalid file
 * yields an empty list plus a warning. Secrets are referenced by env-var name.
 *
 * A small set of bundled profiles (currently kimi) is always available so existing
 * router references keep resolving even without a config file.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import type { ProviderProfile } from "./providers/openai-compatible.ts";

const PROJECT_ROOT = dirname(import.meta.dir);
const DEFAULT_CONFIG_PATH = join(PROJECT_ROOT, "config", "providers.json");

const VALID_COST_CLASSES = new Set(["subscription-cli", "cheap-api", "standard-api", "premium-api"]);

const BUNDLED_PROFILES: ProviderProfile[] = [
  {
    name: "kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    apiKeyEnv: "KIMI_API_KEY",
    models: ["kimi-k2-5"],
    defaultModel: "kimi-k2-5",
    costClass: "cheap-api",
    pricePerMTokIn: 1.5,
    pricePerMTokOut: 2.0,
  },
];

function isValidProfile(p: any): p is ProviderProfile {
  if (!p || typeof p !== "object") return false;
  if (typeof p.name !== "string" || !p.name) return false;
  if (typeof p.baseUrl !== "string" || !p.baseUrl) return false;
  if (typeof p.apiKeyEnv !== "string" || !p.apiKeyEnv) return false;
  if (!Array.isArray(p.models) || p.models.length === 0) return false;
  if (typeof p.defaultModel !== "string" || !p.defaultModel) return false;
  if (typeof p.costClass !== "string" || !VALID_COST_CLASSES.has(p.costClass)) return false;
  return true;
}

export function parseProviderProfiles(raw: string): ProviderProfile[] {
  const data = JSON.parse(raw);
  const entries = Array.isArray(data) ? data : data?.providers;
  if (!Array.isArray(entries)) {
    console.warn("[provider-registry] config has no 'providers' array; ignoring");
    return [];
  }
  const valid: ProviderProfile[] = [];
  for (const entry of entries) {
    if (isValidProfile(entry)) {
      valid.push(entry);
    } else {
      console.warn(`[provider-registry] skipping invalid provider profile: ${JSON.stringify(entry).slice(0, 120)}`);
    }
  }
  return valid;
}

export function readConfigProfiles(path: string = DEFAULT_CONFIG_PATH): ProviderProfile[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  try {
    return parseProviderProfiles(raw);
  } catch (err) {
    console.warn(`[provider-registry] failed to parse ${path}: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

export function loadProviderProfiles(
  path: string = DEFAULT_CONFIG_PATH,
  opts: { includeBundled?: boolean } = {},
): ProviderProfile[] {
  const includeBundled = opts.includeBundled ?? true;
  const byName = new Map<string, ProviderProfile>();
  if (includeBundled) {
    for (const p of BUNDLED_PROFILES) byName.set(p.name, p);
  }
  for (const p of readConfigProfiles(path)) byName.set(p.name, p);
  return Array.from(byName.values());
}

/**
 * Return a human-readable validation error for a profile, or null if valid.
 * Same required-field rules the loader enforces, but with field-level messages
 * so writers (dashboard/CLI) can surface actionable errors.
 */
export function validateProfile(p: any): string | null {
  if (!p || typeof p !== "object") return "profile must be an object";
  if (typeof p.name !== "string" || !p.name.trim()) return "name is required";
  if (typeof p.baseUrl !== "string" || !p.baseUrl.trim()) return "baseUrl is required";
  if (typeof p.apiKeyEnv !== "string" || !p.apiKeyEnv.trim()) return "apiKeyEnv is required";
  if (!Array.isArray(p.models) || p.models.length === 0) return "models must be a non-empty array";
  if (p.models.some((m: any) => typeof m !== "string" || !m.trim())) return "models must be non-empty strings";
  if (typeof p.defaultModel !== "string" || !p.defaultModel.trim()) return "defaultModel is required";
  if (typeof p.costClass !== "string" || !VALID_COST_CLASSES.has(p.costClass)) {
    return `costClass must be one of: ${Array.from(VALID_COST_CLASSES).join(", ")}`;
  }
  return null;
}

/**
 * Atomically write the full set of provider profiles to config/providers.json in
 * the `{ providers: [...] }` shape the loader reads. Validates every profile first,
 * then writes to a temp file and renames into place so readers never see a partial file.
 */
export function writeProviderProfiles(
  profiles: ProviderProfile[],
  path: string = DEFAULT_CONFIG_PATH,
): void {
  for (const p of profiles) {
    const err = validateProfile(p);
    if (err) throw new Error(`invalid provider profile "${p?.name ?? "?"}": ${err}`);
  }
  const json = JSON.stringify({ providers: profiles }, null, 2) + "\n";
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, json, "utf8");
  renameSync(tmp, path);
}

/**
 * Add or replace (by name) a single profile in config/providers.json.
 * Load → mutate → validate → write. Returns the new full list.
 */
export function upsertProviderProfile(
  profile: ProviderProfile,
  path: string = DEFAULT_CONFIG_PATH,
): ProviderProfile[] {
  const err = validateProfile(profile);
  if (err) throw new Error(`invalid provider profile "${profile?.name ?? "?"}": ${err}`);
  const existing = readConfigProfiles(path);
  const next = existing.filter((p) => p.name !== profile.name);
  next.push(profile);
  writeProviderProfiles(next, path);
  return next;
}

/**
 * Remove a profile by name from config/providers.json. Returns the new full list.
 * Removing a name that isn't present is a no-op (still rewrites the file).
 */
export function removeProviderProfile(
  name: string,
  path: string = DEFAULT_CONFIG_PATH,
): ProviderProfile[] {
  const existing = readConfigProfiles(path);
  const next = existing.filter((p) => p.name !== name);
  writeProviderProfiles(next, path);
  return next;
}

/** The default config path, exported so callers can honor an env override consistently. */
export function providerConfigPath(): string {
  return process.env.NOVA_PROVIDERS_CONFIG || DEFAULT_CONFIG_PATH;
}
