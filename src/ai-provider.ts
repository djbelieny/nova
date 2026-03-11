/**
 * AI Provider Interface & Registry
 *
 * Abstracts CLI-based AI backends (Claude Code, Gemini CLI, etc.) behind
 * a common interface. Each provider knows how to spawn its CLI, parse its
 * output, and map generic model tiers to provider-specific model names.
 */

export type ModelTier = "fast" | "standard" | "premium";

export interface AIProviderCallOpts {
  prompt: string;
  model?: string;
  mcpConfigPath?: string;
  noMcp?: boolean;
  useMcp2cli?: boolean;
  maxTurns?: number;
  cwd?: string;
  outputFormat?: "json" | "text";
  userId?: string;
  traceId?: string;
}

export interface AIProviderResult {
  text: string;
  model: string;
  provider: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
  };
  cost_usd?: number;
  duration_ms: number;
  session_id?: string;
  num_turns?: number;
  raw?: any;
}

export interface AIProvider {
  readonly name: string;
  readonly models: string[];
  readonly defaultModel: string;

  call(opts: AIProviderCallOpts): Promise<AIProviderResult>;
  isAvailable(): Promise<boolean>;
  mapModelTier(tier: ModelTier): string;
}

// ============================================================
// PROVIDER REGISTRY
// ============================================================

const providers = new Map<string, AIProvider>();
let defaultProviderName = "claude";

export function registerProvider(provider: AIProvider): void {
  providers.set(provider.name, provider);
}

export function getProvider(name: string): AIProvider | undefined {
  return providers.get(name);
}

export function getDefaultProvider(): AIProvider {
  const p = providers.get(defaultProviderName);
  if (!p) {
    // Fallback to first registered provider
    const first = providers.values().next().value;
    if (!first) throw new Error("No AI providers registered");
    return first;
  }
  return p;
}

export function setDefaultProvider(name: string): void {
  if (!providers.has(name)) {
    throw new Error(`Provider "${name}" not registered`);
  }
  defaultProviderName = name;
}

export function getAllProviders(): AIProvider[] {
  return Array.from(providers.values());
}

export function getAvailableProviderNames(): string[] {
  return Array.from(providers.keys());
}
