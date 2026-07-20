import { generateEmbedding } from "./embeddings.ts";
import { getRelevantContext } from "./memory.ts";
import type { Database } from "./db.ts";

export interface PredictedQuery {
  query: string;
  embedding: number[];
  confidence: number;
  preloadedContext?: string;
  draftResponse?: string;
  cachedAt: number;
}

const PREDICTION_TTL_MS = 30 * 60 * 1000;
const CONTEXT_HIT_THRESHOLD = 0.85;
const DRAFT_HIT_THRESHOLD = 0.92;

const cache = new Map<string, PredictedQuery[]>();

function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

function isExpired(p: PredictedQuery): boolean {
  return Date.now() - p.cachedAt > PREDICTION_TTL_MS;
}

export function triggerPredictions(
  db: Database,
  userId: string,
  recentHistory: Array<{ role: string; content: string }>,
  lastResponse: string,
  callFast: (prompt: string) => Promise<string>,
): void {
  const historyText = recentHistory
    .slice(-6)
    .map(m => `${m.role}: ${m.content}`)
    .join("\n");

  const predictionPrompt = `Given this conversation context, what are the 3 most likely next messages the user will send? Return as a JSON array of strings with no other text.

CONVERSATION:
${historyText}
LAST NOVA RESPONSE: ${lastResponse.slice(0, 500)}`;

  Promise.resolve().then(async () => {
    try {
      const raw = await callFast(predictionPrompt);
      const match = raw.match(/\[[\s\S]*\]/);
      if (!match) return;

      const queries: string[] = JSON.parse(match[0]);
      if (!Array.isArray(queries)) return;

      const predictions: PredictedQuery[] = [];

      for (const query of queries.slice(0, 3)) {
        if (typeof query !== "string" || !query.trim()) continue;

        const embedding = await generateEmbedding(query);
        if (!embedding) continue;

        const preloadedContext = await getRelevantContext(db, query, userId).catch(() => "");

        predictions.push({
          query,
          embedding,
          confidence: 1 / (predictions.length + 1),
          preloadedContext: preloadedContext || undefined,
          cachedAt: Date.now(),
        });
      }

      cache.set(userId, predictions);
    } catch {
      // fire-and-forget — swallow errors silently
    }
  });
}

export async function checkPredictionCache(
  userId: string,
  query: string,
): Promise<{ contextHit: boolean; draftHit: boolean; preloadedContext?: string; draftResponse?: string }> {
  const predictions = cache.get(userId);
  if (!predictions?.length) return { contextHit: false, draftHit: false };

  const live = predictions.filter(p => !isExpired(p));
  if (!live.length) {
    cache.delete(userId);
    return { contextHit: false, draftHit: false };
  }

  const queryEmbedding = await generateEmbedding(query);
  if (!queryEmbedding) return { contextHit: false, draftHit: false };

  let bestSim = -1;
  let bestPrediction: PredictedQuery | null = null;

  for (const p of live) {
    const sim = cosineSim(queryEmbedding, p.embedding);
    if (sim > bestSim) {
      bestSim = sim;
      bestPrediction = p;
    }
  }

  if (!bestPrediction || bestSim < CONTEXT_HIT_THRESHOLD) {
    return { contextHit: false, draftHit: false };
  }

  if (bestSim >= DRAFT_HIT_THRESHOLD && bestPrediction.draftResponse) {
    return {
      contextHit: true,
      draftHit: true,
      preloadedContext: bestPrediction.preloadedContext,
      draftResponse: bestPrediction.draftResponse,
    };
  }

  return {
    contextHit: true,
    draftHit: false,
    preloadedContext: bestPrediction.preloadedContext,
  };
}

export function clearPredictions(userId: string): void {
  cache.delete(userId);
}
