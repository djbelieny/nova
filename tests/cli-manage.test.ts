import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  writeProviderProfiles,
  upsertProviderProfile,
  removeProviderProfile,
  readConfigProfiles,
} from "../src/provider-registry.ts";
import {
  renderProviders,
  addProvider,
  removeProvider,
  setDefaultProviderPref,
  createInvite,
} from "../src/cli-manage.ts";
import { getDb } from "../src/db.ts";
import type { ProviderProfile } from "../src/providers/openai-compatible.ts";

const tmpDirs: string[] = [];
function tempConfigPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "nova-providers-"));
  tmpDirs.push(dir);
  return join(dir, "providers.json");
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

const sample: ProviderProfile = {
  name: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKeyEnv: "OPENROUTER_API_KEY",
  models: ["meta-llama/llama-3.3-70b"],
  defaultModel: "meta-llama/llama-3.3-70b",
  costClass: "cheap-api",
};

// ─── Registry writer round-trips ──────────────────────────────────────────────

test("writeProviderProfiles → readConfigProfiles round-trips in the { providers } shape", () => {
  const path = tempConfigPath();
  writeProviderProfiles([sample], path);
  expect(existsSync(path)).toBe(true);
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  expect(Array.isArray(parsed.providers)).toBe(true);
  const back = readConfigProfiles(path);
  expect(back).toHaveLength(1);
  expect(back[0].name).toBe("openrouter");
});

test("writeProviderProfiles rejects an invalid profile before writing", () => {
  const path = tempConfigPath();
  const bad = { ...sample, costClass: "nope" } as any;
  expect(() => writeProviderProfiles([bad], path)).toThrow();
  expect(existsSync(path)).toBe(false);
});

test("upsertProviderProfile adds then replaces by name", () => {
  const path = tempConfigPath();
  upsertProviderProfile(sample, path);
  expect(readConfigProfiles(path)).toHaveLength(1);
  // Replace (same name, new model) — should not duplicate.
  upsertProviderProfile({ ...sample, defaultModel: "meta-llama/llama-3.3-70b", models: ["m2"], }, path);
  const after = readConfigProfiles(path);
  expect(after).toHaveLength(1);
  expect(after[0].models).toEqual(["m2"]);
});

test("removeProviderProfile deletes by name", () => {
  const path = tempConfigPath();
  upsertProviderProfile(sample, path);
  upsertProviderProfile({ ...sample, name: "second" }, path);
  removeProviderProfile("openrouter", path);
  const after = readConfigProfiles(path);
  expect(after.map((p) => p.name)).toEqual(["second"]);
});

// ─── CLI pure handlers ────────────────────────────────────────────────────────

test("renderProviders: empty config → guidance line", () => {
  const path = tempConfigPath();
  const out = renderProviders(path, null);
  expect(out).toContain("No custom providers");
});

test("renderProviders: lists configured providers and marks the default", () => {
  const path = tempConfigPath();
  addProvider(sample, path);
  const out = renderProviders(path, "openrouter");
  expect(out).toContain("openrouter");
  expect(out).toContain("OPENROUTER_API_KEY");
  expect(out).toContain("*"); // default marker
});

test("addProvider writes a profile to the file", () => {
  const path = tempConfigPath();
  addProvider(sample, path);
  const back = readConfigProfiles(path);
  expect(back.map((p) => p.name)).toContain("openrouter");
});

test("addProvider validates before writing", () => {
  const path = tempConfigPath();
  expect(() => addProvider({ ...sample, name: "" } as any, path)).toThrow();
  expect(existsSync(path)).toBe(false);
});

test("removeProvider deletes it from the file", () => {
  const path = tempConfigPath();
  addProvider(sample, path);
  removeProvider("openrouter", path);
  expect(readConfigProfiles(path).map((p) => p.name)).not.toContain("openrouter");
});

test("setDefaultProviderPref updates the admin user's ai_provider", () => {
  const db = getDb();
  const admin = db.upsertUser({ telegram_id: "tg-cli-admin-1", name: "CLI Admin", role: "admin" });
  const updated = setDefaultProviderPref("openrouter", db);
  expect(updated).toBeGreaterThanOrEqual(1);
  const fresh = db.getUserById(admin.id);
  expect(fresh.ai_provider).toBe("openrouter");
});

test("createInvite produces a redeemable pairing code", () => {
  const db = getDb();
  db.upsertUser({ telegram_id: "tg-cli-admin-2", name: "CLI Admin 2", role: "admin" });
  const code = db.createPairingCode(db.getUsersByRole("admin")[0].id, "member", 60);
  expect(typeof code).toBe("string");
  const invite = createInvite(db, "member");
  expect(invite).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
});
