import { generateEmbedding } from './embeddings';
import { logError } from './error-handler';
import { chunkText, cleanText, extractText } from './text-chunk';
import type { Database } from './db';

export async function ingestDocument(db: Database, docId: string, buffer: Buffer, mimeType: string): Promise<void> {
  try {
    const text = await extractText(buffer, mimeType);
    const cleaned = cleanText(text);
    const chunks = chunkText(cleaned);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = await generateEmbedding(chunk);
      if (!embedding) continue;
      const { randomUUID } = await import('crypto');
      db.insertCsKnowledgeChunk(
        randomUUID(),
        docId,
        chunk,
        new Float32Array(embedding),
        i,
        Math.ceil(chunk.length / 4)
      );
    }
    db.updateCsDocumentStatus(docId, 'ready', chunks.length);
  } catch (err) {
    logError(err, 'cs-rag-ingest');
    db.updateCsDocumentStatus(docId, 'error', 0, err instanceof Error ? err.message : String(err));
  }
}

export async function searchKnowledge(db: Database, query: string, limit = 5): Promise<Array<{id: string; chunkText: string; similarity: number}>> {
  const embedding = await generateEmbedding(query);
  if (!embedding) return [];
  const rows = db.searchCsKnowledge(new Float32Array(embedding), limit);
  return rows.map(r => ({ id: r.id, chunkText: r.chunk_text, similarity: r.similarity }));
}

export function buildKnowledgeContext(chunks: Array<{chunkText: string; similarity: number}>, threshold = 0.65): string {
  const relevant = chunks.filter(c => c.similarity >= threshold);
  if (relevant.length === 0) return '';
  return relevant.map((c, i) => `[${i + 1}] ${c.chunkText}`).join('\n\n');
}
