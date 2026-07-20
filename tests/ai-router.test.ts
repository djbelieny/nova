import { test, expect, beforeEach } from "bun:test";
import { selectProvider } from "../src/ai-router.ts";
import {
  registerProvider,
  type AIProvider,
  type ModelTier,
  type ProviderKind,
  type ProviderCapabilities,
} from "../src/ai-provider.ts";

function mock(
  name: string,
  kind: ProviderKind,
  tiers: ModelTier[],
  available: boolean,
  capabilities: ProviderCapabilities,
): AIProvider & { _available: boolean } {
  const p = {
    name,
    kind,
    models: [name],
    defaultModel: name,
    costClass: kind === "agentic-cli" ? ("subscription-cli" as const) : ("cheap-api" as const),
    supportedTiers: tiers,
    capabilities,
    _available: available,
    mapModelTier: () => name,
    async isAvailable() {
      return this._available;
    },
    async call() {
      return { text: "", model: name, provider: name, duration_ms: 0 };
    },
  };
  return p as any;
}

const CLI_CAPS: ProviderCapabilities = { tools: true, mcp: true, streaming: false };
const API_CAPS: ProviderCapabilities = { tools: true, mcp: false, streaming: false };

let codex: any, gemini: any, claude: any, kimi: any;

beforeEach(() => {
  codex = mock("codex", "agentic-cli", ["fast", "standard"], false, CLI_CAPS);
  gemini = mock("gemini", "agentic-cli", ["fast", "standard"], false, CLI_CAPS);
  claude = mock("claude", "agentic-cli", ["fast", "standard", "premium"], false, CLI_CAPS);
  kimi = mock("kimi", "api", ["fast", "standard", "premium"], false, API_CAPS);
  registerProvider(codex);
  registerProvider(gemini);
  registerProvider(claude);
  registerProvider(kimi);
});

test("tool-requiring route never selects an api provider (Phase 1)", async () => {
  kimi._available = true; // only the api provider is available
  const route = await selectProvider({ tier: "fast", requiresTools: true, hasMcpConfig: true });
  expect(route.provider.kind).not.toBe("api");
  expect(route.provider.name).not.toBe("kimi");
});

test("a text route can select an api provider when no CLI is available", async () => {
  kimi._available = true;
  const route = await selectProvider({ tier: "fast", requiresTools: false });
  expect(route.provider.name).toBe("kimi");
});

test("subscription CLIs are ordered before api providers on a text route", async () => {
  codex._available = true;
  kimi._available = true;
  const route = await selectProvider({ tier: "fast", requiresTools: false });
  expect(route.provider.name).toBe("codex");
});

test("premium tier stays claude-only, never api", async () => {
  claude._available = true;
  kimi._available = true;
  const route = await selectProvider({ tier: "premium", requiresTools: false });
  expect(route.provider.name).toBe("claude");
});

test("force-override wins even for a tool-requiring route", async () => {
  claude._available = true;
  const route = await selectProvider({ tier: "fast", requiresTools: true, forceProvider: "kimi" });
  expect(route.provider.name).toBe("kimi");
  expect(route.reason).toBe("forced:kimi");
});
