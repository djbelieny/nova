import { test, expect, afterEach } from "bun:test";
import { writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildAgentEnv, mcpEnvVars } from "../src/agent-env.ts";

afterEach(() => {
  delete process.env.NOVA_AGENT_ENV_STRICT;
  delete process.env.NOVA_AGENT_ENV_PASSTHROUGH;
  delete process.env.STRIPE_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.MY_MCP_TOKEN;
});

test("strict (default): includes base + provider auth, excludes unrelated secrets", () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-x";
  process.env.STRIPE_API_KEY = "sk_live_x";
  const env = buildAgentEnv({ provider: "claude" });
  expect(env.PATH).toBeDefined();
  expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-x");
  expect(env.STRIPE_API_KEY).toBeUndefined();
});

test("includes vars referenced by the MCP config", () => {
  process.env.MY_MCP_TOKEN = "tok";
  const dir = mkdtempSync(join(tmpdir(), "mcp-"));
  const p = join(dir, "mcp.json");
  writeFileSync(p, JSON.stringify({ mcpServers: { x: { command: "y", env: { MY_MCP_TOKEN: "${MY_MCP_TOKEN}" } } } }));
  expect(mcpEnvVars(p)).toContain("MY_MCP_TOKEN");
  expect(buildAgentEnv({ mcpConfigPath: p }).MY_MCP_TOKEN).toBe("tok");
});

test("extra merges last; undefined clears (e.g. CLAUDECODE)", () => {
  process.env.CLAUDECODE = "1";
  const env = buildAgentEnv({ extra: { CLAUDECODE: undefined, HOME: "/tmp/x" } });
  expect(env.CLAUDECODE).toBeUndefined();
  expect(env.HOME).toBe("/tmp/x");
  delete process.env.CLAUDECODE;
});

test("NOVA_AGENT_ENV_PASSTHROUGH adds explicit extra vars", () => {
  process.env.STRIPE_API_KEY = "sk_live_x";
  process.env.NOVA_AGENT_ENV_PASSTHROUGH = "STRIPE_API_KEY";
  expect(buildAgentEnv({}).STRIPE_API_KEY).toBe("sk_live_x");
});

test("strict=false restores full passthrough", () => {
  process.env.NOVA_AGENT_ENV_STRICT = "false";
  process.env.STRIPE_API_KEY = "sk_live_x";
  expect(buildAgentEnv({}).STRIPE_API_KEY).toBe("sk_live_x");
});
