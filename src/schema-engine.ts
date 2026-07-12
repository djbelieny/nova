import { generateEmbedding } from "./embeddings.ts";
import type { Database } from "./db.ts";

export const SCHEMA_MATCH_THRESHOLD = 0.85;

export interface TaskSchema {
  id: string;
  name: string;
  triggerEmbedding: Buffer;
  compressedContext: string;
  expectedTools: string[];
  executionTemplate: string;
  successRate: number;
  useCount: number;
  lastUsed: string | null;
  createdAt: string;
}

function cosineSimilarity(a: Buffer, b: Buffer): number {
  const fa = new Float32Array(a.buffer, a.byteOffset, a.byteLength / 4);
  const fb = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  let dot = 0;
  for (let i = 0; i < fa.length; i++) {
    dot += fa[i] * fb[i];
  }
  return dot;
}

function rowToSchema(row: any): TaskSchema {
  return {
    id: row.id,
    name: row.name,
    triggerEmbedding: row.trigger_embedding,
    compressedContext: row.compressed_context,
    expectedTools: JSON.parse(row.expected_tools || "[]"),
    executionTemplate: row.execution_template,
    successRate: row.success_rate,
    useCount: row.use_count,
    lastUsed: row.last_used,
    createdAt: row.created_at,
  };
}

export async function matchSchema(
  db: Database,
  userId: string,
  query: string,
): Promise<TaskSchema | null> {
  const queryEmbedding = await generateEmbedding(query);
  if (!queryEmbedding) return null;

  const queryBlob = Buffer.from(new Float32Array(queryEmbedding).buffer);
  const schemas = await getUserSchemas(db, userId);

  let bestMatch: TaskSchema | null = null;
  let bestSimilarity = -1;

  for (const schema of schemas) {
    const sim = cosineSimilarity(queryBlob, schema.triggerEmbedding);
    if (sim > bestSimilarity) {
      bestSimilarity = sim;
      bestMatch = schema;
    }
  }

  if (bestMatch && bestSimilarity >= SCHEMA_MATCH_THRESHOLD) {
    return bestMatch;
  }
  return null;
}

export async function saveSchema(
  db: Database,
  userId: string,
  schema: Omit<TaskSchema, "id" | "createdAt">,
): Promise<string> {
  return db.insertTaskSchema(userId, {
    name: schema.name,
    trigger_embedding: schema.triggerEmbedding,
    compressed_context: schema.compressedContext,
    expected_tools: JSON.stringify(schema.expectedTools),
    execution_template: schema.executionTemplate,
    success_rate: schema.successRate,
    use_count: schema.useCount,
    last_used: schema.lastUsed,
  });
}

export async function recordSchemaExecution(
  db: Database,
  schemaId: string,
  success: boolean,
): Promise<void> {
  db.updateSchemaExecution(schemaId, success);
}

export async function getUserSchemas(
  db: Database,
  userId: string,
): Promise<TaskSchema[]> {
  const rows = db.getTaskSchemas(userId);
  return rows.map(rowToSchema);
}
