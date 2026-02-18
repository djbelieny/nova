/**
 * Shared Cost Tracking Module
 *
 * Tracks API usage and costs across all providers:
 * Claude, OpenAI, Groq, ElevenLabs, Ultravox, Fal.ai, HeyGen
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type Provider = "claude" | "openai" | "groq" | "elevenlabs" | "ultravox" | "fal" | "heygen";

export interface CostEntry {
  provider: Provider;
  model: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  cost_usd?: number;
  duration_ms?: number;
  session_id?: string;
  user_id?: string;
  metadata?: Record<string, unknown>;
}

let _supabase: SupabaseClient | null = null;

/** Initialize cost tracker with a shared Supabase client. */
export function initCostTracker(supabase: SupabaseClient | null): void {
  _supabase = supabase;
}

export async function trackCost(entry: CostEntry): Promise<void> {
  if (!_supabase) return;
  try {
    await _supabase.from("cost_tracking").insert({
      provider: entry.provider,
      model: entry.model,
      input_tokens: entry.input_tokens || 0,
      output_tokens: entry.output_tokens || 0,
      cache_read_tokens: entry.cache_read_tokens || 0,
      cache_creation_tokens: entry.cache_creation_tokens || 0,
      cost_usd: entry.cost_usd || 0,
      duration_ms: entry.duration_ms || 0,
      session_id: entry.session_id || null,
      user_id: entry.user_id || null,
      metadata: entry.metadata || {},
    });
  } catch (e) {
    console.error("Cost tracking insert error:", e);
  }
}
