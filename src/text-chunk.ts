/**
 * Shared text extraction + chunking for RAG pipelines (CS knowledge + Nova Knowledge).
 * Extracted so both stores call one chunker — DRY.
 */

/**
 * Chunk text into ~maxTokens pieces with token overlap, preferring paragraph boundaries.
 * Token count is approximated as chars/4. Chunks shorter than 50 chars are dropped.
 */
export function chunkText(text: string, maxTokens = 512, overlapTokens = 50): string[] {
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

/** Normalize extracted text: form-feeds → newlines, collapse long runs of spaces. */
export function cleanText(text: string): string {
  return text.replace(/\f/g, '\n').replace(/[ \t]{3,}/g, '  ').trim();
}

/** Extract plain text from a document buffer based on its mime type. */
export async function extractText(buffer: Buffer, mimeType: string): Promise<string> {
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

/** Map a filename or mime to a KB source_type tag. */
export function sourceTypeFromName(name: string, mimeType?: string): 'pdf' | 'docx' | 'md' | 'txt' | 'url' {
  const lower = name.toLowerCase();
  if (lower.startsWith('http://') || lower.startsWith('https://')) return 'url';
  if (lower.endsWith('.pdf') || mimeType?.includes('pdf')) return 'pdf';
  if (lower.endsWith('.docx') || mimeType?.includes('officedocument') || mimeType?.includes('docx')) return 'docx';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'md';
  return 'txt';
}

/** Map a source_type back to a mime type for extraction. */
export function mimeFromSourceType(sourceType: string): string {
  switch (sourceType) {
    case 'pdf': return 'application/pdf';
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    default: return 'text/plain';
  }
}
