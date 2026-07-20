import { generateEmbedding } from './embeddings';
import { logError } from './error-handler';
import type { Database } from './db';

// Chunk text into ~512 token pieces with 50-token overlap
function chunkText(text: string, maxTokens = 512, overlapTokens = 50): string[] {
  const maxChars = maxTokens * 4;
  const overlapChars = overlapTokens * 4;
  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = '';
  for (const para of paragraphs) {
    if ((current + para).length > maxChars && current) {
      chunks.push(current.trim());
      current = current.slice(-overlapChars) + '\n\n' + para;
    } else {
      current = current ? current + '\n\n' + para : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(c => c.length > 50);
}

// Extract text from buffer based on mimeType
async function extractText(buffer: Buffer, mimeType: string): Promise<string> {
  if (mimeType === 'application/pdf' || mimeType.includes('pdf')) {
    const pdfParse = await import('pdf-parse');
    const parser = (pdfParse as any).default || pdfParse;
    const result = await parser(buffer);
    return result.text;
  }
  if (mimeType.includes('officedocument') || mimeType.includes('docx')) {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  // TXT / MD — direct
  return buffer.toString('utf8');
}

export async function ingestDocument(db: Database, docId: string, buffer: Buffer, mimeType: string): Promise<void> {
  try {
    const text = await extractText(buffer, mimeType);
    const cleaned = text.replace(/\f/g, '\n').replace(/[ \t]{3,}/g, '  ').trim();
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
