/**
 * Structured document → data extraction.
 *
 * Given a field schema and a document (bytes or text), extract strict JSON, coerce/validate
 * against the field types, store it, and optionally route to a destination. Complements RAG
 * (retrieval) with capture. Reuses text-chunk extractors + defensive JSON parsing.
 */

import { extractText, cleanText, mimeFromSourceType } from './text-chunk';
import { logError } from './error-handler';
import type { Database, ExtractField, ExtractSchema } from './db';

export type ExtractLLM = (prompt: string) => Promise<string>;

/** Extract the first balanced JSON object from arbitrary LLM output. Returns null on failure. */
export function parseJsonLoose(raw: string): any {
  if (!raw) return null;
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(raw.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

/** Coerce a raw value to a declared field type. */
export function coerceValue(value: any, type: ExtractField['type']): any {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'number': { const n = Number(String(value).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; }
    case 'boolean': return typeof value === 'boolean' ? value : /^(true|yes|1|paid|y)$/i.test(String(value).trim());
    case 'array': return Array.isArray(value) ? value : String(value).split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
    case 'date': { const d = new Date(value); return isNaN(d.getTime()) ? String(value) : d.toISOString().slice(0, 10); }
    default: return String(value);
  }
}

export interface ValidationResult { data: Record<string, any>; missing: string[]; }

/** Coerce + validate an extracted object against the schema fields. */
export function validateExtraction(fields: ExtractField[], raw: Record<string, any>): ValidationResult {
  const data: Record<string, any> = {};
  const missing: string[] = [];
  for (const f of fields) {
    const val = raw?.[f.name];
    const coerced = coerceValue(val, f.type);
    if ((coerced === null || coerced === '') && f.required) missing.push(f.name);
    data[f.name] = coerced;
  }
  return { data, missing };
}

/** Build the extraction prompt for a field schema + document text. */
export function buildExtractionPrompt(schema: ExtractSchema, text: string): string {
  const fieldList = schema.fields.map(f => `- ${f.name} (${f.type || 'string'})${f.required ? ' [required]' : ''}${f.description ? `: ${f.description}` : ''}`).join('\n');
  return [
    `Extract the following fields from the document below and respond with ONLY a strict JSON object — no prose, no markdown fences.`,
    `Fields:`,
    fieldList,
    `Rules: use null for anything not present; do not invent values; numbers as numbers; dates as YYYY-MM-DD.`,
    ``,
    `DOCUMENT:`,
    text.slice(0, 12000),
    ``,
    `JSON:`,
  ].join('\n');
}

export interface ExtractInput {
  db: Database;
  userId: string;
  schema: ExtractSchema;
  source?: string;
  sourceType?: string;
  bytes?: Buffer;
  text?: string;
  callLLM: ExtractLLM;
  store?: boolean; // default true
}

export interface ExtractResult {
  id: string | null;
  data: Record<string, any>;
  missing: string[];
  status: 'extracted' | 'incomplete' | 'error';
  error?: string;
}

/** Extract structured data from a document against a schema. */
export async function extractStructured(input: ExtractInput): Promise<ExtractResult> {
  const { db, userId, schema } = input;
  let text: string;
  try {
    if (input.text != null) text = input.text;
    else if (input.bytes) text = await extractText(input.bytes, mimeFromSourceType(input.sourceType || 'txt'));
    else throw new Error('no bytes or text provided');
  } catch (err) {
    logError(err, 'extract-text', userId);
    return { id: null, data: {}, missing: [], status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
  const cleaned = cleanText(text);
  if (!cleaned || cleaned.length < 5) return { id: null, data: {}, missing: [], status: 'error', error: 'no extractable text' };

  let rawJson: any = null;
  try {
    const out = await input.callLLM(buildExtractionPrompt(schema, cleaned));
    rawJson = parseJsonLoose(out);
  } catch (err) {
    logError(err, 'extract-llm', userId);
    return { id: null, data: {}, missing: [], status: 'error', error: 'extraction model failed' };
  }
  if (!rawJson || typeof rawJson !== 'object') return { id: null, data: {}, missing: [], status: 'error', error: 'model did not return JSON' };

  const { data, missing } = validateExtraction(schema.fields, rawJson);
  const status: ExtractResult['status'] = missing.length ? 'incomplete' : 'extracted';

  let id: string | null = null;
  if (input.store !== false) {
    const row = db.insertExtraction(userId, { schemaId: schema.id, schemaName: schema.name, source: input.source ?? null, data, status });
    id = row.id;
  }
  return { id, data, missing, status };
}

/**
 * Detect an "extract this document as <schema>" intent in a caption. Returns the schema name.
 *   "extract as invoice" · "extract this as an invoice" · "/extract invoice"
 */
export function parseExtractCaption(caption: string): { wants: boolean; schema: string | null } {
  const c = (caption || '').trim();
  let m = c.match(/^\/extract\s+([\w-]+)/i)
    || c.match(/\bextract\s+(?:this\s+)?(?:document\s+)?as\s+(?:an?\s+)?([\w-]+)/i)
    || c.match(/\bextract\s+(?:the\s+)?([\w-]+)\s+(?:fields|data)\b/i);
  if (m) return { wants: true, schema: m[1].toLowerCase() };
  return { wants: false, schema: null };
}

/** Render a list of extractions as CSV (for export). */
export function extractionsToCsv(fields: ExtractField[], rows: Array<{ data: Record<string, any> }>): string {
  const header = fields.map(f => f.name);
  const escape = (v: any) => { const s = v == null ? '' : Array.isArray(v) ? v.join('; ') : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [header.join(',')];
  for (const r of rows) lines.push(header.map(h => escape(r.data[h])).join(','));
  return lines.join('\n');
}
