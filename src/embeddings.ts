/**
 * Local embedding generation and semantic search.
 *
 * Replaces Supabase Edge Functions (embed + search) with direct
 * OpenAI API calls from the VPS. Requires OPENAI_API_KEY in .env.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

const EMBEDDING_MODEL = "text-embedding-3-small";

let openaiKey: string | undefined;

function getOpenAIKey(): string | undefined {
  if (!openaiKey) {
    openaiKey = process.env.OPENAI_API_KEY;
  }
  return openaiKey;
}

/**
 * Generate an embedding vector for a text string.
 * Returns null if OPENAI_API_KEY is not configured or the call fails.
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  const key = getOpenAIKey();
  if (!key) return null;

  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: text }),
    });

    if (!res.ok) {
      console.warn(`[embeddings] OpenAI error ${res.status}:`, await res.text());
      return null;
    }

    const { data } = await res.json();
    return data[0].embedding;
  } catch (error) {
    console.warn("[embeddings] Failed to generate embedding:", error);
    return null;
  }
}

/**
 * Semantic search: embed the query locally, then call the pgvector
 * match function via Supabase RPC.
 */
export async function semanticSearch(
  supabase: SupabaseClient,
  query: string,
  opts: {
    table?: "messages" | "memory";
    matchCount?: number;
    matchThreshold?: number;
    userId?: string;
  } = {}
): Promise<any[]> {
  const {
    table = "messages",
    matchCount = 10,
    matchThreshold = 0.7,
    userId,
  } = opts;

  const embedding = await generateEmbedding(query);
  if (!embedding) return [];

  const rpcName = table === "memory" ? "match_memory" : "match_messages";

  const { data, error } = await supabase.rpc(rpcName, {
    query_embedding: embedding,
    p_user_id: userId,
    match_threshold: matchThreshold,
    match_count: matchCount,
  });

  if (error) {
    console.warn(`[embeddings] Semantic search error:`, error.message);
    return [];
  }

  return data || [];
}
