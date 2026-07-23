/**
 * Connector-bound workboards — pull remote records onto cards, and push stage changes back.
 *
 * Pull is upsert-only: a record the remote stops returning is left alone rather than deleted, so
 * a transient API failure can never clear a board. Push is a consequential write to a real
 * system, so it is prepared here and executed behind the approval gate.
 */

import { getByPath } from "./automation-engine.ts";
import { runConnectorAction } from "./connectors/registry.ts";
import { validateCardFields } from "./workboards.ts";
import type { DatabaseType, Workboard, WorkboardCard } from "./db.ts";

export interface ConnectorBinding {
  connector: string;
  readAction: string;
  writeAction?: string;
  externalIdPath: string;
  fieldMap: Record<string, string>;
  stageField?: string;
  stageMap?: Record<string, string>;
}

export interface MappedRecord { externalId: string | null; fields: Record<string, unknown>; }

export function mapRemoteRecord(binding: ConnectorBinding, record: any): MappedRecord {
  const fields: Record<string, unknown> = {};
  for (const [key, path] of Object.entries(binding.fieldMap)) {
    const v = getByPath(record, path);
    if (v !== undefined) fields[key] = v;
  }
  const ext = getByPath(record, binding.externalIdPath);
  return { externalId: ext === undefined || ext === null ? null : String(ext), fields };
}

export function planUpsert(existing: WorkboardCard[], incoming: MappedRecord[]) {
  const byExternal = new Map(existing.filter((c) => c.externalId).map((c) => [c.externalId as string, c]));
  const create: MappedRecord[] = [];
  const update: Array<{ id: string; fields: Record<string, unknown> }> = [];
  for (const rec of incoming) {
    const match = rec.externalId ? byExternal.get(rec.externalId) : undefined;
    if (match) update.push({ id: match.id, fields: rec.fields });
    else create.push(rec);
  }
  return { create, update };
}

export async function pullBoard(
  db: DatabaseType,
  userId: string,
  board: Workboard,
  opts: { runAction?: typeof runConnectorAction } = {}
): Promise<{ created: number; updated: number; errors: string[] }> {
  const binding = board.connectorBinding as ConnectorBinding | null;
  if (!binding) return { created: 0, updated: 0, errors: [`board "${board.name}" is not bound to a connector`] };

  const firstStage = board.stages[0]?.key;
  if (!firstStage) return { created: 0, updated: 0, errors: [`board "${board.name}" has no stages to receive cards`] };

  const run = opts.runAction ?? runConnectorAction;
  const res = await run(db, binding.connector, binding.readAction, {});
  if (!res.ok) {
    db.insertWorkboardEvent(board.scope, userId, {
      boardId: board.id, kind: "sync", actor: "connector", detail: { error: res.error },
    });
    return { created: 0, updated: 0, errors: [res.error ?? "connector read failed"] };
  }

  const records: any[] = Array.isArray(res.data) ? res.data : (res.data?.results ?? []);
  const mapped = records.map((r) => mapRemoteRecord(binding, r));
  const existing = db.listWorkboardCards(board.scope, userId, board.id, { limit: 5000 });
  const plan = planUpsert(existing, mapped);
  const errors: string[] = [];

  // A record that fails field validation is skipped, not fatal — one bad remote record must not
  // abort the pull or block the good records around it.
  const creatable: Array<{ externalId: string | null; values: Record<string, unknown>; title: string }> = [];
  for (const rec of plan.create) {
    const v = validateCardFields(board.fields, rec.fields);
    if (!v.ok) { errors.push(...v.errors); continue; }
    const primary = board.fields.find((f) => f.primary) ?? board.fields[0];
    creatable.push({ externalId: rec.externalId, values: v.values, title: String(v.values[primary.key] ?? "Untitled") });
  }

  if (creatable.length) {
    db.insertWorkboardCards(board.scope, userId, creatable.map((c) => ({
      boardId: board.id, stageKey: firstStage, title: c.title, fields: c.values,
      origin: "connector" as const, externalId: c.externalId,
    })));
  }

  let updated = 0;
  for (const u of plan.update) {
    const card = db.getWorkboardCard(board.scope, userId, u.id);
    if (!card) continue;
    const merged = { ...card.fields, ...u.fields };
    const v = validateCardFields(board.fields, merged);
    if (!v.ok) { errors.push(...v.errors); continue; }
    db.updateWorkboardCard(board.scope, userId, u.id, { fields: v.values });
    updated++;
  }

  db.insertWorkboardEvent(board.scope, userId, {
    boardId: board.id, kind: "sync", actor: "connector",
    detail: { created: creatable.length, updated },
  });
  return { created: creatable.length, updated, errors };
}
