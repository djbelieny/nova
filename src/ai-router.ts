/**
 * AI Smart Router
 *
 * Decides which AI provider to use for each call based on:
 * 1. User force-override (/claude or /gemini prefix)
 * 2. Cost-ordered candidate list (subscription CLIs first)
 * 3. Daily soft-limit tracking per subscription CLI
 * 4. Rate limit state (skip recently limited providers)
 * 5. Model tier (fast → cheapest available, premium → claude only)
 */

import {
  type ModelTier,
  type AIProvider,
  getProvider,
  getDefaultProvider,
  getAllProviders,
} from "./ai-provider.ts";

/** Track recent rate limit hits per provider for fallback routing */
const rateLimitTimestamps = new Map<string, number>();
const RATE_LIMIT_COOLDOWN_MS = 60_000;

export function recordRateLimit(providerName: string): void {
  rateLimitTimestamps.set(providerName, Date.now());
}

function isRecentlyRateLimited(providerName: string): boolean {
  const ts = rateLimitTimestamps.get(providerName);
  if (!ts) return false;
  return (Date.now() - ts) < RATE_LIMIT_COOLDOWN_MS;
}

/** Daily usage tracking for subscription CLI soft-limits */
const dailyUsage = new Map<string, { count: number; tokens: number; date: string }>();
const SOFT_LIMITS: Record<string, { calls: number; tokens: number }> = {
  'codex':  { calls: 500,  tokens: 2_000_000 },
  'gemini': { calls: 1000, tokens: 5_000_000 },
  'claude': { calls: 500,  tokens: 2_000_000 },
};

function isNearSoftLimit(name: string): boolean {
  const usage = dailyUsage.get(name);
  const limit = SOFT_LIMITS[name];
  if (!usage || !limit) return false;
  const today = new Date().toISOString().slice(0, 10);
  if (usage.date !== today) return false;
  return usage.count > limit.calls * 0.9 || usage.tokens > limit.tokens * 0.9;
}

export function recordUsage(providerName: string, tokens: number): void {
  const today = new Date().toISOString().slice(0, 10);
  const existing = dailyUsage.get(providerName);
  if (!existing || existing.date !== today) {
    dailyUsage.set(providerName, { count: 1, tokens, date: today });
  } else {
    existing.count++;
    existing.tokens += tokens;
  }
}

export interface RouteRequest {
  tier: ModelTier;
  hint?: string;
  userId?: string;
  forceProvider?: string;
  hasMcpConfig?: boolean;
  userDefaultProvider?: string;
}

export interface RouteResult {
  provider: AIProvider;
  model: string;
  reason: string;
}

function buildCandidateList(tier: ModelTier, hint?: string, hasMcpConfig?: boolean): AIProvider[] {
  if (tier === 'fast') {
    return [
      getProvider('codex'),
      getProvider('gemini'),
      getProvider('claude'),
      getProvider('kimi'),
    ].filter(Boolean) as AIProvider[];
  }

  if (tier === 'standard') {
    const list: AIProvider[] = [];
    if (!hasMcpConfig) {
      const g = getProvider('gemini');
      if (g) list.push(g);
    }
    const c = getProvider('claude');
    if (c) list.push(c);
    return list;
  }

  // premium tier: claude only
  const claude = getProvider('claude');
  return claude ? [claude] : [];
}

/**
 * Select the best provider + model for a given call.
 */
export async function selectProvider(opts: RouteRequest): Promise<RouteResult> {
  // 1. Force override
  if (opts.forceProvider) {
    const forced = getProvider(opts.forceProvider);
    if (forced) {
      return {
        provider: forced,
        model: forced.mapModelTier(opts.tier),
        reason: `forced:${opts.forceProvider}`,
      };
    }
    console.warn(`[router] Forced provider "${opts.forceProvider}" not found, falling back`);
  }

  // 2. Build cost-ordered candidates for this tier
  const candidates = buildCandidateList(opts.tier, opts.hint, opts.hasMcpConfig);

  // 3. Pick first available, non-rate-limited, not near soft limit
  for (const candidate of candidates) {
    if (isRecentlyRateLimited(candidate.name)) continue;
    if (isNearSoftLimit(candidate.name)) continue;
    if (!(await candidate.isAvailable())) continue;
    return {
      provider: candidate,
      model: candidate.mapModelTier(opts.tier),
      reason: `cost-aware:${candidate.name}`,
    };
  }

  // 4. Fallback: first available regardless of soft limits
  for (const candidate of candidates) {
    if (isRecentlyRateLimited(candidate.name)) continue;
    if (!(await candidate.isAvailable())) continue;
    return {
      provider: candidate,
      model: candidate.mapModelTier(opts.tier),
      reason: `fallback:${candidate.name}`,
    };
  }

  // 5. Ultimate fallback
  const fallback = getDefaultProvider();
  return {
    provider: fallback,
    model: fallback.mapModelTier(opts.tier),
    reason: 'fallback:default',
  };
}

function findAlternativeProvider(excludeName: string): AIProvider | null {
  for (const p of getAllProviders()) {
    if (p.name !== excludeName && !isRecentlyRateLimited(p.name)) {
      return p;
    }
  }
  return null;
}

/**
 * Parse a message for provider force-override prefix.
 * Returns { provider, message } if prefix found, null otherwise.
 */
export function parseProviderPrefix(text: string): { provider: string; message: string } | null {
  const match = text.match(/^\/(claude|gemini|codex)\s+(.+)/s);
  if (!match) return null;
  return { provider: match[1], message: match[2] };
}

/**
 * Analyze an image file using the Gemini REST API (gemini-2.0-flash — fast and cheap).
 * Uses inline base64 multimodal input — bypasses the CLI which doesn't support image files.
 */
export async function analyzeImage(imagePath: string, question?: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return "[Image analysis unavailable — GEMINI_API_KEY not set]";
  }

  const q = question || "Describe what you see in this image in detail. If it's a screenshot, describe the UI, content, key text, and any notable elements.";

  try {
    const { readFileSync } = await import("fs");
    const imageBytes = readFileSync(imagePath);
    const base64Data = imageBytes.toString("base64");

    const ext = imagePath.toLowerCase().split(".").pop();
    const mimeType =
      ext === "jpg" || ext === "jpeg" ? "image/jpeg" :
      ext === "webp" ? "image/webp" :
      ext === "gif" ? "image/gif" :
      "image/png";

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: q },
              { inlineData: { mimeType, data: base64Data } },
            ],
          }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
        }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      return `[Image analysis failed: HTTP ${response.status} — ${err.slice(0, 200)}]`;
    }

    const json = await response.json() as any;
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return text.trim() || "[Image analysis returned empty response]";
  } catch (err) {
    return `[Image analysis failed: ${err}]`;
  }
}
