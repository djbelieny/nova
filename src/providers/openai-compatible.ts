/**
 * OpenAI-Compatible API Provider
 *
 * A single provider class driven by a declarative ProviderProfile. Covers any
 * backend that speaks the OpenAI chat-completions API — OpenRouter, OpenAI,
 * DeepSeek, xAI, Groq-chat, Moonshot/Kimi, local Ollama/vLLM, etc.
 *
 * Phase 1: call() is a single chat-completions fetch (system + user message,
 * temperature 0.3). Tool loops arrive in Phase 2.
 */

import type {
  AIProvider,
  AIProviderCallOpts,
  AIProviderResult,
  ModelTier,
  ProviderCapabilities,
  ProviderCostClass,
  ProviderKind,
} from "../ai-provider.ts";

export interface ProviderProfile {
  name: string;
  baseUrl: string;
  apiKeyEnv: string;
  models: string[];
  defaultModel: string;
  tierModels?: Partial<Record<ModelTier, string>>;
  costClass: ProviderCostClass;
  capabilities?: Partial<ProviderCapabilities>;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  pricePerMTokIn?: number;
  pricePerMTokOut?: number;
}

const DEFAULT_CAPABILITIES: ProviderCapabilities = { tools: true, mcp: false, streaming: false };

function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name) => process.env[name] ?? "");
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly kind: ProviderKind = "api";
  readonly name: string;
  readonly models: string[];
  readonly defaultModel: string;
  readonly costClass: ProviderCostClass;
  readonly supportedTiers: ModelTier[];
  readonly capabilities: ProviderCapabilities;

  constructor(private profile: ProviderProfile) {
    this.name = profile.name;
    this.models = profile.models;
    this.defaultModel = profile.defaultModel;
    this.costClass = profile.costClass;
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...profile.capabilities };
    this.supportedTiers = profile.tierModels
      ? (Object.keys(profile.tierModels) as ModelTier[])
      : ["fast", "standard", "premium"];
  }

  mapModelTier(tier: ModelTier): string {
    return this.profile.tierModels?.[tier] ?? this.profile.defaultModel;
  }

  async isAvailable(): Promise<boolean> {
    return !!process.env[this.profile.apiKeyEnv];
  }

  async call(opts: AIProviderCallOpts): Promise<AIProviderResult> {
    const apiKey = process.env[this.profile.apiKeyEnv];
    if (!apiKey) throw new Error(`${this.profile.apiKeyEnv} not set`);

    const model = opts.model ?? this.profile.defaultModel;
    const startMs = performance.now();

    const messages: { role: string; content: string }[] = [];
    if (opts.systemPrompt) messages.push({ role: "system", content: opts.systemPrompt });
    messages.push({ role: "user", content: opts.prompt });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    };
    if (this.profile.headers) {
      for (const [k, v] of Object.entries(this.profile.headers)) {
        headers[k] = expandEnv(v);
      }
    }

    const url = `${this.profile.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.3,
        ...this.profile.extraBody,
      }),
    });

    const durationMs = performance.now() - startMs;

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${this.name} API error ${res.status}: ${body.slice(0, 300)}`);
    }

    const json = (await res.json()) as any;
    const text: string = json?.choices?.[0]?.message?.content ?? "";
    const inputTokens: number = json?.usage?.prompt_tokens ?? 0;
    const outputTokens: number = json?.usage?.completion_tokens ?? 0;

    let costUsd: number | undefined;
    if (this.profile.pricePerMTokIn != null || this.profile.pricePerMTokOut != null) {
      costUsd =
        (inputTokens / 1_000_000) * (this.profile.pricePerMTokIn ?? 0) +
        (outputTokens / 1_000_000) * (this.profile.pricePerMTokOut ?? 0);
    }

    return {
      text,
      model,
      provider: this.name,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      },
      cost_usd: costUsd,
      duration_ms: Math.round(durationMs),
    };
  }
}
