import { test, expect, afterEach } from "bun:test";
import { writeFileSync, rmSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  parseProviderProfiles,
  readConfigProfiles,
  loadProviderProfiles,
} from "../src/provider-registry.ts";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("parses valid profiles from a { providers: [...] } wrapper", () => {
  const profiles = parseProviderProfiles(JSON.stringify({
    providers: [
      {
        name: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKeyEnv: "OPENROUTER_API_KEY",
        models: ["meta-llama/llama-3.3-70b"],
        defaultModel: "meta-llama/llama-3.3-70b",
        costClass: "cheap-api",
      },
    ],
  }));
  expect(profiles).toHaveLength(1);
  expect(profiles[0].name).toBe("openrouter");
});

test("accepts a bare array of profiles", () => {
  const profiles = parseProviderProfiles(JSON.stringify([
    {
      name: "local",
      baseUrl: "http://localhost:11434/v1",
      apiKeyEnv: "OLLAMA_API_KEY",
      models: ["qwen2.5"],
      defaultModel: "qwen2.5",
      costClass: "cheap-api",
    },
  ]));
  expect(profiles).toHaveLength(1);
  expect(profiles[0].name).toBe("local");
});

test("skips entries missing required fields or with a bad costClass", () => {
  const profiles = parseProviderProfiles(JSON.stringify({
    providers: [
      { name: "no-key", baseUrl: "https://x/v1", models: ["m"], defaultModel: "m", costClass: "cheap-api" },
      { name: "bad-cost", baseUrl: "https://x/v1", apiKeyEnv: "K", models: ["m"], defaultModel: "m", costClass: "nope" },
      { name: "good", baseUrl: "https://x/v1", apiKeyEnv: "K", models: ["m"], defaultModel: "m", costClass: "standard-api" },
    ],
  }));
  expect(profiles.map((p) => p.name)).toEqual(["good"]);
});

test("readConfigProfiles: missing file → []", () => {
  expect(readConfigProfiles(join(tmpdir(), "does-not-exist-providers.json"))).toEqual([]);
});

test("readConfigProfiles: invalid JSON → []", () => {
  const dir = mkdtempSync(join(tmpdir(), "nova-prov-"));
  const p = join(dir, "providers.json");
  writeFileSync(p, "{ not valid json ");
  try {
    expect(readConfigProfiles(p)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadProviderProfiles bundles kimi even with no config file", () => {
  const profiles = loadProviderProfiles(join(tmpdir(), "missing.json"));
  expect(profiles.some((p) => p.name === "kimi")).toBe(true);
});

test("loadProviderProfiles({ includeBundled:false }) on missing file → []", () => {
  expect(loadProviderProfiles(join(tmpdir(), "missing.json"), { includeBundled: false })).toEqual([]);
});

test("config entries override a bundled profile of the same name", () => {
  const dir = mkdtempSync(join(tmpdir(), "nova-prov-"));
  const p = join(dir, "providers.json");
  writeFileSync(p, JSON.stringify({
    providers: [
      { name: "kimi", baseUrl: "https://custom/v1", apiKeyEnv: "KIMI_API_KEY", models: ["kimi-x"], defaultModel: "kimi-x", costClass: "cheap-api" },
    ],
  }));
  try {
    const kimi = loadProviderProfiles(p).find((x) => x.name === "kimi");
    expect(kimi?.baseUrl).toBe("https://custom/v1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenAICompatibleProvider is a non-agentic api provider with merged capabilities", () => {
  const provider = new OpenAICompatibleProvider({
    name: "t",
    baseUrl: "https://x/v1",
    apiKeyEnv: "T_KEY",
    models: ["m"],
    defaultModel: "m",
    costClass: "cheap-api",
    capabilities: { tools: false },
  });
  expect(provider.kind).toBe("api");
  expect(provider.capabilities).toEqual({ tools: false, mcp: false, streaming: false });
});

test("isAvailable gates on the profile's env var", async () => {
  const provider = new OpenAICompatibleProvider({
    name: "envtest",
    baseUrl: "https://x/v1",
    apiKeyEnv: "NOVA_TEST_PROVIDER_KEY",
    models: ["m"],
    defaultModel: "m",
    costClass: "cheap-api",
  });
  delete process.env.NOVA_TEST_PROVIDER_KEY;
  expect(await provider.isAvailable()).toBe(false);
  process.env.NOVA_TEST_PROVIDER_KEY = "secret";
  expect(await provider.isAvailable()).toBe(true);
  delete process.env.NOVA_TEST_PROVIDER_KEY;
});

test("mapModelTier prefers tierModels then falls back to defaultModel", () => {
  const provider = new OpenAICompatibleProvider({
    name: "tiers",
    baseUrl: "https://x/v1",
    apiKeyEnv: "K",
    models: ["fast-m", "std-m"],
    defaultModel: "std-m",
    costClass: "cheap-api",
    tierModels: { fast: "fast-m" },
  });
  expect(provider.mapModelTier("fast")).toBe("fast-m");
  expect(provider.mapModelTier("premium")).toBe("std-m");
});

test("call() hits chat/completions and computes cost from prices (kimi-parity)", async () => {
  process.env.KIMI_API_KEY = "test-key";
  let capturedUrl = "";
  let capturedBody: any = null;
  let capturedAuth = "";
  globalThis.fetch = (async (url: any, init: any) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(init.body);
    capturedAuth = init.headers.Authorization;
    return new Response(JSON.stringify({
      choices: [{ message: { content: "hello from kimi" } }],
      usage: { prompt_tokens: 1000, completion_tokens: 500 },
    }), { status: 200 });
  }) as any;

  const provider = new OpenAICompatibleProvider({
    name: "kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    apiKeyEnv: "KIMI_API_KEY",
    models: ["kimi-k2-5"],
    defaultModel: "kimi-k2-5",
    costClass: "cheap-api",
    pricePerMTokIn: 1.5,
    pricePerMTokOut: 2.0,
  });

  const result = await provider.call({ prompt: "hi", systemPrompt: "be brief", noMcp: true });

  expect(capturedUrl).toBe("https://api.moonshot.cn/v1/chat/completions");
  expect(capturedAuth).toBe("Bearer test-key");
  expect(capturedBody.messages).toEqual([
    { role: "system", content: "be brief" },
    { role: "user", content: "hi" },
  ]);
  expect(capturedBody.temperature).toBe(0.3);
  expect(result.text).toBe("hello from kimi");
  expect(result.provider).toBe("kimi");
  expect(result.usage).toEqual({ input_tokens: 1000, output_tokens: 500 });
  // (1000/1e6)*1.5 + (500/1e6)*2.0 = 0.0015 + 0.001 = 0.0025
  expect(result.cost_usd).toBeCloseTo(0.0025, 6);
  delete process.env.KIMI_API_KEY;
});

test("call() expands ${ENV} in custom headers and merges extraBody", async () => {
  process.env.OR_KEY = "or-secret";
  process.env.NOVA_REFERER = "https://mynova.space";
  let capturedHeaders: any = null;
  let capturedBody: any = null;
  globalThis.fetch = (async (_url: any, init: any) => {
    capturedHeaders = init.headers;
    capturedBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: {} }), { status: 200 });
  }) as any;

  const provider = new OpenAICompatibleProvider({
    name: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OR_KEY",
    models: ["m"],
    defaultModel: "m",
    costClass: "cheap-api",
    headers: { "HTTP-Referer": "${NOVA_REFERER}" },
    extraBody: { top_p: 0.9 },
  });

  await provider.call({ prompt: "hi", noMcp: true });
  expect(capturedHeaders["HTTP-Referer"]).toBe("https://mynova.space");
  expect(capturedBody.top_p).toBe(0.9);
  delete process.env.OR_KEY;
  delete process.env.NOVA_REFERER;
});

test("call() with no price fields leaves cost_usd undefined", async () => {
  process.env.NOPRICE_KEY = "k";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "x" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 })) as any;
  const provider = new OpenAICompatibleProvider({
    name: "noprice",
    baseUrl: "https://x/v1",
    apiKeyEnv: "NOPRICE_KEY",
    models: ["m"],
    defaultModel: "m",
    costClass: "cheap-api",
  });
  const result = await provider.call({ prompt: "hi", noMcp: true });
  expect(result.cost_usd).toBeUndefined();
  delete process.env.NOPRICE_KEY;
});
