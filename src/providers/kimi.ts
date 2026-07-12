import type { AIProvider, AIProviderCallOpts, AIProviderResult, ModelTier } from "../ai-provider.ts";

const KIMI_API_URL = "https://api.moonshot.cn/v1/chat/completions";
const KIMI_MODEL = "kimi-k2-5";

export class KimiProvider implements AIProvider {
  readonly name = "kimi";
  readonly models = [KIMI_MODEL];
  readonly defaultModel = KIMI_MODEL;
  readonly costClass = "cheap-api";
  readonly supportedTiers: ModelTier[] = ["fast", "standard", "premium"];

  mapModelTier(_tier: ModelTier): string {
    return KIMI_MODEL;
  }

  async isAvailable(): Promise<boolean> {
    return !!process.env.KIMI_API_KEY;
  }

  async call(opts: AIProviderCallOpts): Promise<AIProviderResult> {
    const apiKey = process.env.KIMI_API_KEY;
    if (!apiKey) throw new Error("KIMI_API_KEY not set");

    const model = opts.model ?? KIMI_MODEL;
    const startMs = performance.now();

    const res = await fetch(KIMI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: opts.prompt }],
        temperature: 0.3,
      }),
    });

    const durationMs = performance.now() - startMs;

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Kimi API error ${res.status}: ${body.slice(0, 300)}`);
    }

    const json = await res.json() as any;
    const text: string = json?.choices?.[0]?.message?.content ?? "";
    const inputTokens: number = json?.usage?.prompt_tokens ?? 0;
    const outputTokens: number = json?.usage?.completion_tokens ?? 0;
    const costUsd = (inputTokens / 1000) * 0.0015 + (outputTokens / 1000) * 0.002;

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
