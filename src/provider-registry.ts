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

import { readFileSync } from "fs";
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
