/**
 * Groq Direct API Provider
 *
 * Uses the Groq SDK directly (no CLI, no CLAUDECODE conflict).
 * Ideal for background services like smart-checkin and morning-briefing
 * that need reliable LLM calls without spawning a child CLI process.
 *
 * Models: llama-3.3-70b-versatile (standard/premium), llama-3.1-8b-instant (fast)
 */

import type { AIProvider, AIProviderCallOpts, AIProviderResult, ModelTier, ProviderCostClass, ProviderKind, ProviderCapabilities } from "../ai-provider.ts";

const MODEL_MAP: Record<string, string> = {
  fast: "llama-3.1-8b-instant",
  standard: "llama-3.3-70b-versatile",
  premium: "llama-3.3-70b-versatile",
};

export class GroqProvider implements AIProvider {
  readonly name = "groq";
  readonly models = ["llama-3.1-8b-instant", "llama-3.3-70b-versatile"];
  readonly defaultModel = "llama-3.1-8b-instant";
  readonly costClass: ProviderCostClass = "standard-api";
  readonly supportedTiers: ModelTier[] = ["fast", "standard", "premium"];
  readonly kind: ProviderKind = "api";
  readonly capabilities: ProviderCapabilities = { tools: false, mcp: false, streaming: false };

  mapModelTier(tier: ModelTier): string {
    return MODEL_MAP[tier] ?? this.defaultModel;
  }

  async isAvailable(): Promise<boolean> {
    if (process.env.GROQ_API_KEY) return true;
    const { getModelApiKey } = await import("../shared-credentials.ts");
    const { getDb } = await import("../db.ts");
    return !!getModelApiKey(getDb(), "groq");
  }

  async call(opts: AIProviderCallOpts): Promise<AIProviderResult> {
    const Groq = (await import("groq-sdk")).default;
    const { getModelApiKey } = await import("../shared-credentials.ts");
    const { getDb } = await import("../db.ts");
    const apiKey = getModelApiKey(getDb(), "groq") || process.env.GROQ_API_KEY;
    const groq = new Groq(apiKey ? { apiKey } : undefined);

    const model = opts.model && this.models.includes(opts.model)
      ? opts.model
      : this.defaultModel;

    const startTime = Date.now();

    const completion = await groq.chat.completions.create({
      model,
      messages: [{ role: "user", content: opts.prompt }],
      temperature: 0.3,
    });

    const durationMs = Date.now() - startTime;
    const choice = completion.choices[0];
    const text = choice?.message?.content ?? "";

    return {
      text,
      model: completion.model ?? model,
      provider: this.name,
      usage: completion.usage ? {
        input_tokens: completion.usage.prompt_tokens,
        output_tokens: completion.usage.completion_tokens,
      } : undefined,
      duration_ms: durationMs,
    };
  }
}
