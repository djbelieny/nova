/**
 * AI Smart Router
 *
 * Decides which AI provider to use for each call based on:
 * 1. User force-override (/claude or /gemini prefix)
 * 2. User default preference (stored in DB)
 * 3. Task hint (research → Gemini, code → Claude, etc.)
 * 4. MCP dependency (tasks needing MCP tools prefer Claude)
 * 5. Rate limit state (fallback to secondary if primary is limited)
 * 6. Model tier (fast-tier calls go to cheapest available)
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
const RATE_LIMIT_COOLDOWN_MS = 60_000; // avoid a provider for 60s after rate limit

export function recordRateLimit(providerName: string): void {
  rateLimitTimestamps.set(providerName, Date.now());
}

function isRecentlyRateLimited(providerName: string): boolean {
  const ts = rateLimitTimestamps.get(providerName);
  if (!ts) return false;
  return (Date.now() - ts) < RATE_LIMIT_COOLDOWN_MS;
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

/**
 * Select the best provider + model for a given call.
 */
export function selectProvider(opts: RouteRequest): RouteResult {
  // 1. User force-override
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

  // 2. User default preference
  const preferredName = opts.userDefaultProvider || "claude";
  const preferred = getProvider(preferredName);

  // 3. Check rate limit state — if preferred is rate-limited, try alternatives
  if (preferred && isRecentlyRateLimited(preferred.name)) {
    const alt = findAlternativeProvider(preferred.name);
    if (alt) {
      return {
        provider: alt,
        model: alt.mapModelTier(opts.tier),
        reason: `fallback:${preferred.name}-rate-limited`,
      };
    }
  }

  // 4. Hint-based routing
  if (opts.hint && preferred) {
    const hintRoute = routeByHint(opts.hint, opts.tier, preferred, opts.hasMcpConfig);
    if (hintRoute) return hintRoute;
  }

  // 5. Default: use preferred provider
  if (preferred) {
    return {
      provider: preferred,
      model: preferred.mapModelTier(opts.tier),
      reason: `default:${preferred.name}`,
    };
  }

  // 6. Ultimate fallback
  const fallback = getDefaultProvider();
  return {
    provider: fallback,
    model: fallback.mapModelTier(opts.tier),
    reason: "fallback:default",
  };
}

function routeByHint(
  hint: string,
  tier: ModelTier,
  preferred: AIProvider,
  hasMcpConfig?: boolean,
): RouteResult | null {
  const h = hint.toLowerCase();

  // MCP-heavy tasks prefer Claude (native --mcp-config support)
  if (hasMcpConfig && (h.includes("calendar") || h.includes("email") || h.includes("notion") || h.includes("crm"))) {
    const claude = getProvider("claude");
    if (claude && !isRecentlyRateLimited("claude")) {
      return {
        provider: claude,
        model: claude.mapModelTier(tier),
        reason: "hint:mcp-tools→claude",
      };
    }
  }

  // Web research → Gemini (free tier, good at synthesis)
  if (h.includes("research") || h.includes("search") || h.includes("web")) {
    const gemini = getProvider("gemini");
    if (gemini && !isRecentlyRateLimited("gemini")) {
      return {
        provider: gemini,
        model: gemini.mapModelTier(tier),
        reason: "hint:research→gemini",
      };
    }
  }

  // Fast-tier classification → cheapest available (Gemini Flash is free)
  if (tier === "fast") {
    const gemini = getProvider("gemini");
    if (gemini && !isRecentlyRateLimited("gemini")) {
      return {
        provider: gemini,
        model: gemini.mapModelTier("fast"),
        reason: "tier:fast→gemini-flash",
      };
    }
  }

  return null;
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
