/**
 * Local Embedding Generation & Semantic Search
 *
 * Uses @huggingface/transformers with all-MiniLM-L6-v2 (384-dim, ~23MB)
 * for fast local embeddings (5-30ms per embed). Zero external API cost.
 *
 * Replaces OpenAI API + Supabase RPC with local model + SQLite vec.
 */

import { getDb } from "./db.ts";

let pipeline: any = null;
let pipelineLoading: Promise<any> | null = null;

/**
 * Lazily load the embedding pipeline. First call downloads the model (~23MB),
 * subsequent calls return the cached pipeline instantly.
 */
async function getEmbeddingPipeline(): Promise<any> {
  if (pipeline) return pipeline;

  if (pipelineLoading) return pipelineLoading;

  pipelineLoading = (async () => {
    const { pipeline: createPipeline } = await import("@huggingface/transformers");
    pipeline = await createPipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2",
    );
    console.log("[embeddings] Model loaded: all-MiniLM-L6-v2 (384-dim)");
    return pipeline;
  })();

  return pipelineLoading;
}

/**
 * Generate an embedding vector for a text string.
 * Returns a 384-dim float array, or null on failure.
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    const pipe = await getEmbeddingPipeline();
    const output = await pipe(text, { pooling: "mean", normalize: true });
    return Array.from(output.data as Float32Array);
  } catch (error) {
    console.warn("[embeddings] Failed to generate embedding:", error);
    return null;
  }
}

/**
 * Warm up the embedding model. Call at startup (non-blocking).
 */
export function warmUpEmbeddings(): void {
  generateEmbedding("warm up").catch(() => {});
}

/**
 * Semantic search: embed the query locally, then use sqlite-vec for similarity.
 */
export async function semanticSearch(
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

  if (!userId) return [];

  const embedding = await generateEmbedding(query);
  if (!embedding) return [];

  const db = getDb();

  if (table === "memory") {
    return db.matchMemory(embedding, userId, {
      matchThreshold,
      matchCount,
    });
  }

  return db.matchMessages(embedding, userId, {
    matchThreshold,
    matchCount,
  });
}
