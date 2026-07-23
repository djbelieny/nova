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
  /** Passed through verbatim to the connector's read action — e.g. { limit: 100 } to raise a
   *  connector's default page size. Pull does not paginate; this only widens a single page. */
  input?: Record<string, any>;
}

export interface MappedRecord { externalId: string | null; fields: Record<string, unknown>; }

/** One record skipped during a pull, and why — distinct from a fatal error that stops the pull. */
export interface SkipDetail {
  externalId: string | null;
  reason: string;
}

/**
 * A fatal outcome (board not bound, no stages, connector read failed) means nothing was written
 * and the caller should treat this as a failure. A successful outcome may still carry skipped
 * records — those are per-record and never stop the pull from writing everything else — so the
 * two cases get separate shapes rather than sharing one `errors` field the caller has to infer
 * severity from.
 */
export type PullOutcome =
  | {
      ok: true;
      created: number;
      updated: number;
      skipped: SkipDetail[];
      truncated: boolean;
      warning?: string;
      error?: never;
    }
  | { ok: false; error: string; created?: never; updated?: never; skipped?: never; truncated?: never; warning?: never };

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

/** Page sizes common enough as connector defaults that hitting them exactly is suspicious. */
const ROUND_PAGE_SIZES = [10, 20, 25, 50, 100];

export async function pullBoard(
  db: DatabaseType,
  userId: string,
  board: Workboard,
  opts: { runAction?: typeof runConnectorAction } = {}
): Promise<PullOutcome> {
  const binding = board.connectorBinding as ConnectorBinding | null;
  if (!binding) return { ok: false, error: `board "${board.name}" is not bound to a connector` };

  const firstStage = board.stages[0]?.key;
  if (!firstStage) return { ok: false, error: `board "${board.name}" has no stages to receive cards` };

  const run = opts.runAction ?? runConnectorAction;
  const res = await run(db, binding.connector, binding.readAction, binding.input ?? {});
  if (!res.ok) {
    const error = res.error ?? "connector read failed";
    db.insertWorkboardEvent(board.scope, userId, {
      boardId: board.id, kind: "sync", actor: "connector", detail: { error },
    });
    return { ok: false, error };
  }

  const records: any[] = Array.isArray(res.data) ? res.data : (res.data?.results ?? []);
  const mapped = records.map((r) => mapRemoteRecord(binding, r));
  const existing = db.listWorkboardCards(board.scope, userId, board.id, { limit: 5000 });
  const plan = planUpsert(existing, mapped);
  const skipped: SkipDetail[] = [];

  // A record that fails field validation is skipped, not fatal — one bad remote record must not
  // abort the pull or block the good records around it.
  const creatable: Array<{ externalId: string | null; values: Record<string, unknown>; title: string }> = [];
  for (const rec of plan.create) {
    const v = validateCardFields(board.fields, rec.fields);
    if (!v.ok) { skipped.push({ externalId: rec.externalId, reason: v.errors.join("; ") }); continue; }
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
    if (!v.ok) { skipped.push({ externalId: card.externalId, reason: v.errors.join("; ") }); continue; }
    db.updateWorkboardCard(board.scope, userId, u.id, { fields: v.values });
    updated++;
  }

  // Truncation heuristic: pull does not paginate (that is the connector's job), so it only ever
  // sees the one page a read action returns. If the read returned exactly the page size the
  // caller asked for via binding.input.limit, the connector very likely had more to give and
  // stopped at the limit. With no limit given, we cannot know what was requested, so instead we
  // flag a suspiciously round total (20, 50, 100, …) — the shape a default page size leaves
  // behind — while accepting this will also warn on a remote that genuinely has that many
  // records. False positives here are cheap; a silent truncation is not.
  const requestedLimit = typeof binding.input?.limit === "number" ? binding.input.limit : undefined;
  const truncated = requestedLimit !== undefined
    ? records.length === requestedLimit
    : ROUND_PAGE_SIZES.includes(records.length);
  const warning = truncated
    ? `pull returned ${records.length} record${records.length === 1 ? "" : "s"} from ${binding.connector}.${binding.readAction} — this may be only the first page (bind an "input" with a higher limit if the connector supports one)`
    : undefined;

  // Recorded as a single kind:"sync" event, not one skipped/failed event per record the way the
  // queue drainer does for its per-card rows. The drainer's rows are already discrete units of
  // work with their own card identity; a pull is one batch call over up to 5000 records, and
  // giving each skipped record its own board-level event would flood the history from a single
  // CLI invocation. Richer detail on the one event is enough to answer "what happened".
  db.insertWorkboardEvent(board.scope, userId, {
    boardId: board.id, kind: "sync", actor: "connector",
    detail: {
      created: creatable.length, updated,
      skipped: skipped.length, reasons: skipped.map((s) => s.reason),
      truncated, ...(warning ? { warning } : {}),
    },
  });
  return { ok: true, created: creatable.length, updated, skipped, truncated, warning };
}

/** Set a nested value by dot path, merging into (not replacing) any object already at the path's
 *  root: setByPath({ id: "1" }, "properties.lifecycle", "customer") ===
 *  { id: "1", properties: { lifecycle: "customer" } }. The mirror of getByPath's read side. */
export function setByPath(obj: Record<string, any>, path: string, value: unknown): Record<string, any> {
  const keys = path.split(".");
  const last = keys.pop() as string;
  let cursor = obj;
  for (const key of keys) {
    const existing = cursor[key];
    cursor[key] = existing && typeof existing === "object" ? existing : {};
    cursor = cursor[key];
  }
  cursor[last] = value;
  return obj;
}

/**
 * Describe the connector write a stage change implies. Nothing here performs it — a write to a
 * real external system is consequential, so the caller routes it through the approval gate.
 */
export function buildPush(
  binding: ConnectorBinding,
  card: WorkboardCard,
  toStage: string
): { connector: string; action: string; input: Record<string, any> } | { skip: string } {
  if (!binding.writeAction) return { skip: "binding is pull-only (no writeAction)" };
  if (!card.externalId) return { skip: `card ${card.id} has no external id to write back to` };
  if (!binding.stageField) return { skip: "binding declares no stageField" };
  const remoteValue = binding.stageMap?.[toStage];
  if (remoteValue === undefined) return { skip: `stage "${toStage}" has no remote equivalent in stageMap` };
  return {
    connector: binding.connector,
    action: binding.writeAction,
    input: setByPath({ id: card.externalId }, binding.stageField, remoteValue),
  };
}
