import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  PROVIDERS,
  providerEnvVar,
  selectStarterAgents,
  validateAnswers,
  parseEnvVars,
  buildEnvContent,
  applyAnswersToEnv,
  buildMinimalMcpConfig,
  starterAgentsConfig,
  writeConfigFiles,
  answersToEnvVars,
  type WizardAnswers,
} from "../src/setup-wizard.ts";

const VALID: WizardAnswers = {
  telegramToken: "123456789:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKKlll",
  telegramUserId: "987654321",
  provider: "gemini",
  providerKey: "AIzaSy-test-key",
  userName: "Jake",
  timezone: "America/New_York",
};

test("selectStarterAgents returns three sensible starter agents", () => {
  const agents = selectStarterAgents();
  expect(agents.length).toBe(3);
  expect(agents).toEqual(["kai", "pixel", "athena"]);
});

test("providerEnvVar maps providers; claude CLI needs no key", () => {
  expect(providerEnvVar("gemini")).toBe("GEMINI_API_KEY");
  expect(providerEnvVar("groq")).toBe("GROQ_API_KEY");
  expect(providerEnvVar("anthropic")).toBe("ANTHROPIC_API_KEY");
  expect(providerEnvVar("claude")).toBeNull();
  expect(PROVIDERS.claude.envVar).toBeNull();
});

test("validateAnswers accepts a good answer set", () => {
  expect(validateAnswers(VALID)).toEqual({ ok: true, errors: [] });
});

test("validateAnswers rejects bad token, non-numeric user id, missing provider key", () => {
  const bad = validateAnswers({ telegramToken: "nope", telegramUserId: "abc", provider: "gemini" });
  expect(bad.ok).toBe(false);
  expect(bad.errors.length).toBeGreaterThanOrEqual(3);
});

test("validateAnswers allows claude provider with no key", () => {
  const r = validateAnswers({ ...VALID, provider: "claude", providerKey: undefined });
  expect(r.ok).toBe(true);
});

test("buildEnvContent writes the provider key to its env var and sets essentials", () => {
  const env = buildEnvContent(VALID);
  const vars = parseEnvVars(env);
  expect(vars.TELEGRAM_BOT_TOKEN).toBe(VALID.telegramToken);
  expect(vars.TELEGRAM_USER_ID).toBe(VALID.telegramUserId);
  expect(vars.GEMINI_API_KEY).toBe("AIzaSy-test-key");
  expect(vars.AI_PROVIDER).toBe("gemini");
  expect(vars.USER_NAME).toBe("Jake");
  expect(env).toContain("OPTIONAL NEXT STEPS");
});

test("buildEnvContent for claude does not emit a key line", () => {
  const env = buildEnvContent({ ...VALID, provider: "claude", providerKey: undefined });
  const vars = parseEnvVars(env);
  expect(vars.ANTHROPIC_API_KEY).toBeUndefined();
  expect(vars.AI_PROVIDER).toBe("claude");
});

test("answersToEnvVars omits provider key when empty", () => {
  const vars = answersToEnvVars({ ...VALID, provider: "claude", providerKey: "" });
  expect(vars.GEMINI_API_KEY).toBeUndefined();
  expect(vars.ANTHROPIC_API_KEY).toBeUndefined();
});

test("applyAnswersToEnv is non-destructive: updates keys, keeps unrelated lines and comments", () => {
  const existing = [
    "# my custom header",
    "TELEGRAM_BOT_TOKEN=old_token",
    "CUSTOM_FLAG=keepme",
    "USER_TIMEZONE=UTC",
  ].join("\n");
  const merged = applyAnswersToEnv(existing, VALID);
  expect(merged).toContain("# my custom header");
  expect(merged).toContain("CUSTOM_FLAG=keepme");
  const vars = parseEnvVars(merged);
  expect(vars.TELEGRAM_BOT_TOKEN).toBe(VALID.telegramToken);
  expect(vars.USER_TIMEZONE).toBe("America/New_York");
  expect(vars.CUSTOM_FLAG).toBe("keepme");
  expect(vars.GEMINI_API_KEY).toBe("AIzaSy-test-key");
});

test("buildMinimalMcpConfig includes only the zero-credential playwright server", () => {
  const example = JSON.stringify({
    mcpServers: {
      playwright: { command: "npx", args: ["-y", "@playwright/mcp"] },
      notion: { command: "npx", args: ["notion"], env: { X: "${X}" } },
    },
  });
  const cfg = buildMinimalMcpConfig(example);
  expect(Object.keys(cfg.mcpServers)).toEqual(["playwright"]);
});

test("buildMinimalMcpConfig tolerates malformed example json", () => {
  const cfg = buildMinimalMcpConfig("{not json");
  expect(cfg.mcpServers).toEqual({});
});

test("starterAgentsConfig records the enabled starter agents and provider", () => {
  const cfg = starterAgentsConfig(VALID);
  expect(cfg.enabled).toEqual(["kai", "pixel", "athena"]);
  expect(cfg.provider).toBe("gemini");
  expect(typeof cfg.generatedAt).toBe("string");
});

test("writeConfigFiles creates fresh .env, .mcp.json, and starter-agents.json", () => {
  const root = mkdtempSync(join(tmpdir(), "nova-wiz-"));
  writeFileSync(join(root, ".mcp.example.json"), JSON.stringify({ mcpServers: { playwright: { command: "npx" } } }));
  const report = writeConfigFiles(root, VALID);
  expect(report.envWritten).toBe(true);
  expect(report.envReason).toBe("created");
  expect(report.mcpWritten).toBe(true);
  expect(existsSync(join(root, ".env"))).toBe(true);
  expect(existsSync(join(root, "config", "starter-agents.json"))).toBe(true);
  const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf-8"));
  expect(Object.keys(mcp.mcpServers)).toEqual(["playwright"]);
});

test("writeConfigFiles is non-destructive on an existing .env (merges, never clobbers)", () => {
  const root = mkdtempSync(join(tmpdir(), "nova-wiz-"));
  writeFileSync(join(root, ".env"), "CUSTOM_FLAG=keepme\nTELEGRAM_BOT_TOKEN=old");
  writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { notion: {} } }));
  const report = writeConfigFiles(root, VALID);
  expect(report.envReason).toContain("merged");
  expect(report.mcpWritten).toBe(false);
  const env = readFileSync(join(root, ".env"), "utf-8");
  expect(env).toContain("CUSTOM_FLAG=keepme");
  expect(parseEnvVars(env).TELEGRAM_BOT_TOKEN).toBe(VALID.telegramToken);
  // existing .mcp.json left untouched
  const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf-8"));
  expect(Object.keys(mcp.mcpServers)).toEqual(["notion"]);
});

test("writeConfigFiles overwrites when force is set", () => {
  const root = mkdtempSync(join(tmpdir(), "nova-wiz-"));
  writeFileSync(join(root, ".env"), "OLD=1");
  writeFileSync(join(root, ".mcp.example.json"), JSON.stringify({ mcpServers: { playwright: {} } }));
  const report = writeConfigFiles(root, VALID, { force: true });
  expect(report.envReason).toContain("overwritten");
  const vars = parseEnvVars(readFileSync(join(root, ".env"), "utf-8"));
  expect(vars.OLD).toBeUndefined();
  expect(vars.TELEGRAM_BOT_TOKEN).toBe(VALID.telegramToken);
});
