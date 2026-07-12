// tests/credential-resolution.test.ts
import { test, expect } from "bun:test";
import { existsSync, rmSync } from "fs";
import { resolveCredential, getModelApiKey } from "../src/shared-credentials.ts";
import { regenerateMcpConfig, getUserMcpConfigPath, getUserDir } from "../src/integrations.ts";
import { getDb } from "../src/db.ts";

const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("resolveCredential prefers the user's own integration, then shared, then null", () => {
  const db = getDb();
  // no user, no shared -> null
  db.upsertIntegration({ user_id: U, provider: "clickup", status: "disconnected", credentials: {} });
  db.deleteSharedCredential("clickup");
  expect(resolveCredential(db, U, "clickup")).toBeNull();
  // shared only -> shared
  db.upsertSharedCredential({ provider: "clickup", kind: "api_key", credentials: { api_token: "shared-tok" }, created_by: "admin" });
  expect(resolveCredential(db, U, "clickup")).toEqual({ credentials: { api_token: "shared-tok" }, source: "shared" });
  // user's own wins
  db.upsertIntegration({ user_id: U, provider: "clickup", status: "connected", credentials: { api_token: "user-tok" } });
  expect(resolveCredential(db, U, "clickup")).toEqual({ credentials: { api_token: "user-tok" }, source: "user" });
});

test("regen credential source falls back to shared notion token", () => {
  const db = getDb();
  db.upsertSharedCredential({ provider: "notion", kind: "oauth", credentials: { access_token: "shared-notion" }, created_by: "admin" });
  try {
    const r = resolveCredential(db, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "notion");
    expect(r).toEqual({ credentials: { access_token: "shared-notion" }, source: "shared" });
  } finally {
    db.deleteSharedCredential("notion");
  }
});

test("regenerateMcpConfig injects shared notion server when user has no notion integration", async () => {
  const db = getDb();
  const userId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  // User has NO notion integration row; admin sets a shared notion credential.
  db.upsertSharedCredential({ provider: "notion", kind: "oauth", credentials: { access_token: "shared-notion" }, created_by: "admin" });
  const configPath = getUserMcpConfigPath(userId);
  if (existsSync(configPath)) rmSync(configPath);

  try {
    await regenerateMcpConfig(db, userId);

    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(await Bun.file(configPath).text());
    expect(config.mcpServers.notion).toBeDefined();
    // The shared token must be carried into the notion server config.
    expect(JSON.stringify(config.mcpServers.notion)).toContain("shared-notion");
  } finally {
    // Idempotent cleanup: remove generated config + shared credential + user dir.
    if (existsSync(configPath)) rmSync(configPath);
    db.deleteSharedCredential("notion");
    try { rmSync(getUserDir(userId), { recursive: true, force: true }); } catch {}
  }
});

test("regenerateMcpConfig injects clickup server when integration has api_token (UI save-key field)", async () => {
  // This test verifies Fix 2: the save-key UI sends {api_token:key} for clickup,
  // and regenerateMcpConfig reads creds.api_token to build the clickup MCP server.
  const db = getDb();
  const userId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const configPath = getUserMcpConfigPath(userId);
  if (existsSync(configPath)) rmSync(configPath);

  // Simulate the corrected UI sending {credentials:{api_token:"ut"}} for clickup
  db.upsertIntegration({ user_id: userId, provider: "clickup", status: "connected", credentials: { api_token: "ut" } });

  try {
    await regenerateMcpConfig(db, userId);
    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(await Bun.file(configPath).text());
    expect(config.mcpServers.clickup).toBeDefined();
    expect(JSON.stringify(config.mcpServers.clickup)).toContain("ut");
  } finally {
    db.upsertIntegration({ user_id: userId, provider: "clickup", status: "disconnected", credentials: {} });
    if (existsSync(configPath)) rmSync(configPath);
    try { rmSync(getUserDir(userId), { recursive: true, force: true }); } catch {}
  }
});

test("getModelApiKey prefers shared model_key over env", () => {
  const db = getDb();
  const savedGroq = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "env-groq";
  db.deleteSharedCredential("groq");
  expect(getModelApiKey(db, "groq")).toBe("env-groq");
  db.upsertSharedCredential({ provider: "groq", kind: "model_key", credentials: { api_key: "shared-groq" }, created_by: "admin" });
  expect(getModelApiKey(db, "groq")).toBe("shared-groq");
  if (savedGroq === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = savedGroq;
});
