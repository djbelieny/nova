/**
 * Nova Knowledge (RAG) — the scoped second brain.
 *
 * One ingestion pipeline (files, pre-extracted text, or URLs) → chunk → local
 * embedding → sqlite-vec. Hybrid retrieval: auto-injected context + an on-demand
 * search tool. Personal scope lives in the per-user db; team/agent in shared.db
 * (routing handled by the Database facade). Reuses embeddings.ts + the cs_knowledge
 * vector pattern + pdf-parse/mammoth via text-chunk.ts.
 */

import { createHash, randomUUID } from 'crypto';
import { generateEmbedding } from './embeddings';
import { chunkText, cleanText, extractText, mimeFromSourceType, sourceTypeFromName } from './text-chunk';
import { looksLikeInjection } from './learning-loop';
import { logError } from './error-handler';
import type { Database, KbChunkHit, KbScope } from './db';

export interface IngestInput {
  db: Database;
  userId: string;
  scope: KbScope;
  agentSlug?: string | null;
  title: string;
  /** Absolute path, URL, or 'telegram:<file_id>' — provenance only. */
  source: string;
  /** Inferred from title/source when omitted. */
  sourceType?: string;
  /** Raw file bytes (pdf/docx/etc). Mutually exclusive with `text`. */
  bytes?: Buffer;
  /** Pre-extracted text (md/txt drop, or already-scraped page). */
  text?: string;
}

export interface IngestResult {
  docId: string;
  status: 'ready' | 'error' | 'duplicate';
  chunkCount: number;
  title: string;
  error?: string;
}

/** Fetch a URL and reduce its HTML to readable text. Basic (no JS); good for docs/articles. */
export async function fetchUrlText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': 'NovaKnowledge/1.0' } });
  if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`);
  const html = await res.text();
  return htmlToText(html);
}

/** Minimal HTML → text: drop script/style/nav, strip tags, decode common entities. */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>(?=)/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = s
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Ingest one document into the knowledge base. Idempotent: re-ingesting identical
 * content (same sha256, same scope) replaces the prior doc rather than duplicating.
 */
export async function ingestDocument(input: IngestInput): Promise<IngestResult> {
  const { db, userId, scope, title, source } = input;
  const agentSlug = input.agentSlug ?? null;
  const sourceType = input.sourceType || sourceTypeFromName(source, undefined) || sourceTypeFromName(title);

  // 1. Resolve text
  let rawText: string;
  try {
    if (input.text != null) {
      rawText = input.text;
    } else if (sourceType === 'url') {
      rawText = await fetchUrlText(source);
    } else if (input.bytes) {
      rawText = await extractText(input.bytes, mimeFromSourceType(sourceType));
    } else {
      throw new Error('ingestDocument: no bytes, text, or url source provided');
    }
  } catch (err) {
    logError(err, 'kb-extract', userId);
    return { docId: '', status: 'error', chunkCount: 0, title, error: err instanceof Error ? err.message : String(err) };
  }

  const cleaned = cleanText(rawText);
  if (!cleaned || cleaned.length < 20) {
    return { docId: '', status: 'error', chunkCount: 0, title, error: 'no extractable text' };
  }
  const sha256 = createHash('sha256').update(cleaned).digest('hex');

  // 2. Dedupe — replace prior doc with identical content in this scope
  const existing = db.kbDocExistsBySha(scope, agentSlug, userId, sha256);
  if (existing) db.deleteKbDoc(scope, userId, existing);

  // 3. Insert doc (processing) + chunk + embed
  const docId = randomUUID();
  db.insertKbDoc({ id: docId, scope, agentSlug, userId, title, source, sourceType, sha256 });

  try {
    let chunks = chunkText(cleaned, 600, 90); // ~600 tokens, ~15% overlap
    // Short docs (a one-line fact, a brief note) fall under the chunker's min-length
    // floor — keep them as a single chunk instead of dropping the whole document.
    if (chunks.length === 0) chunks = [cleaned];
    let written = 0;
    for (let i = 0; i < chunks.length; i++) {
      const emb = await generateEmbedding(chunks[i]);
      if (!emb) throw new Error('embedding model unavailable');
      db.insertKbChunk({
        id: randomUUID(), docId, scope, agentSlug, userId,
        ordinal: i, text: chunks[i], embedding: new Float32Array(emb),
        tokenCount: Math.ceil(chunks[i].length / 4),
      });
      written++;
    }
    if (written === 0) {
      db.updateKbDocStatus(scope, userId, docId, 'error', 0, 'no chunks produced');
      return { docId, status: 'error', chunkCount: 0, title, error: 'no chunks produced' };
    }
    db.updateKbDocStatus(scope, userId, docId, 'ready', written);
    return { docId, status: 'ready', chunkCount: written, title };
  } catch (err) {
    logError(err, 'kb-ingest', userId);
    // Roll back partial chunks so the doc is never half-indexed
    db.deleteKbDoc(scope, userId, docId);
    return { docId, status: 'error', chunkCount: 0, title, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Detect a "add this file to my knowledge base" intent in a document caption, and
 * the target scope. Pure + tested. `wants=false` → treat the document normally.
 */
export function parseKbCaption(caption: string): { wants: boolean; scope: KbScope; agentSlug?: string } {
  const c = (caption || '').toLowerCase();
  const wants =
    /\b(add to (the )?knowledge|knowledge ?base|remember this (file|doc|document)|learn this (file|doc|document|page)?|add to kb|save to knowledge|ingest this)\b/.test(c) ||
    /^\/knowledge\b/.test(c);
  let scope: KbScope = 'personal';
  let agentSlug: string | undefined;
  if (/\bteam\b/.test(c)) scope = 'team';
  const m = c.match(/\bagent[:\s]+([a-z][a-z0-9-]*)/) || c.match(/\bfor ([a-z][a-z0-9-]*)(?:'s)? (?:knowledge|pack)\b/);
  if (m) { scope = 'agent'; agentSlug = m[1]; }
  return { wants, scope, agentSlug };
}

export interface SearchOpts {
  userId: string;
  agentSlug?: string;
  limit?: number;
  threshold?: number;
}

/** Embed the query and return scope-visible chunks above the similarity threshold. */
export async function searchKnowledge(db: Database, query: string, opts: SearchOpts): Promise<KbChunkHit[]> {
  const emb = await generateEmbedding(query);
  if (!emb) return [];
  const threshold = opts.threshold ?? 0.4;
  const hits = db.searchKb(new Float32Array(emb), { userId: opts.userId, agentSlug: opts.agentSlug, limit: opts.limit ?? 5 });
  return hits.filter(h => h.similarity >= threshold);
}

/**
 * Auto-inject block for prompt context. Returns a "KNOWLEDGE:" section with the top
 * chunks (above `threshold`), each cited by source title. Chunks that read as
 * injected instructions are dropped. Empty string when nothing clears the bar.
 */
export async function getKnowledgeContext(
  db: Database,
  query: string,
  userId: string,
  opts: { agentSlug?: string; topInject?: number; threshold?: number } = {}
): Promise<string> {
  try {
    // Skip the embedding call entirely when the user has nothing to retrieve.
    if (!db.hasKbDocs(userId, opts.agentSlug)) return '';
    const hits = await searchKnowledge(db, query, {
      userId,
      agentSlug: opts.agentSlug,
      limit: opts.topInject ?? 2,
      threshold: opts.threshold ?? 0.45,
    });
    const safe = hits.filter(h => !looksLikeInjection(h.text));
    if (!safe.length) return '';
    return (
      'KNOWLEDGE (from your knowledge base — cite the source when you use it):\n' +
      safe.map(h => `- [${h.title}] ${h.text.replace(/\s+/g, ' ').trim()}`).join('\n')
    );
  } catch (err) {
    logError(err, 'kb-context', userId);
    return '';
  }
}
