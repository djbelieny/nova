/**
 * Workboard service — joins the pure logic in workboards.ts to the Database facade.
 * The CLI and the dashboard API both call this, so validation and event logging happen once.
 */

import { validateCardFields, planMove, positionBetween, type FieldDef, type StageDef, type OnEnterAction, type WorkboardDef } from "./workboards.ts";
import type { CardOrigin, DatabaseType, Workboard, WorkboardCard } from "./db.ts";

export type ServiceResult<T> =
  | { ok: true; value: T; errors?: never }
  | { ok: false; errors: string[]; value?: never };
export interface CardRecord { title?: string; fields: Record<string, unknown>; }
export interface MoveOutcome { card: WorkboardCard; fires: OnEnterAction | null; }

export interface CreateBoardInput {
  name: string;
  purpose?: string | null;
  fields: FieldDef[];
  stages: StageDef[];
  reactive?: boolean;
  scope?: 'personal' | 'team';
}

/** Storage row → the shape the pure module works with. */
export function toDef(board: Workboard): WorkboardDef {
  return { id: board.id, name: board.name, fields: board.fields, stages: board.stages, reactive: board.reactive };
}

function validateDefinition(input: CreateBoardInput): string[] {
  const errors: string[] = [];
  if (!input.name?.trim()) errors.push("board name is required");
  if (!input.fields?.length) errors.push("a board needs at least one field");
  if (!input.stages?.length) errors.push("a board needs at least one stage");
  const fieldKeys = new Set<string>();
  for (const f of input.fields ?? []) {
    if (fieldKeys.has(f.key)) errors.push(`duplicate field key "${f.key}"`);
    fieldKeys.add(f.key);
    if (f.type === "select" && !f.options?.length) errors.push(`field "${f.key}" is a select but declares no options`);
  }
  const stageKeys = new Set<string>();
  for (const s of input.stages ?? []) {
    if (stageKeys.has(s.key)) errors.push(`duplicate stage key "${s.key}"`);
    stageKeys.add(s.key);
  }
  return errors;
}

export function createBoard(db: DatabaseType, userId: string, input: CreateBoardInput): ServiceResult<Workboard> {
  const errors = validateDefinition(input);
  if (errors.length) return { ok: false, errors };
  const scope = input.scope ?? "personal";
  if (db.findWorkboard(userId, input.name)) return { ok: false, errors: [`a board named "${input.name}" already exists`] };
  const board = db.insertWorkboard({
    scope, userId, name: input.name, purpose: input.purpose ?? null, source: "cards",
    fields: input.fields, stages: [...input.stages].sort((a, b) => a.order - b.order),
    reactive: input.reactive ?? false,
  });
  db.insertWorkboardEvent(scope, userId, { boardId: board.id, kind: "created", actor: userId, detail: { name: board.name } });
  return { ok: true, value: board };
}

/** Title falls back to the first primary field, then the first field, then "Untitled". */
export function deriveTitle(fields: FieldDef[], values: Record<string, unknown>, given?: string): string {
  if (given?.trim()) return given.trim();
  const primary = fields.find((f) => f.primary) ?? fields[0];
  const v = primary ? values[primary.key] : null;
  return v == null || v === "" ? "Untitled" : String(v);
}

export function addCards(
  db: DatabaseType, userId: string, board: Workboard, stageKey: string,
  records: CardRecord[], origin: CardOrigin, originRef?: string
): ServiceResult<WorkboardCard[]> {
  if (!board.stages.some((s) => s.key === stageKey)) {
    return { ok: false, errors: [`unknown stage "${stageKey}" — this board has: ${board.stages.map((s) => s.key).join(", ")}`] };
  }
  const errors: string[] = [];
  const prepared: { title: string; fields: Record<string, unknown> }[] = [];
  records.forEach((rec, i) => {
    const result = validateCardFields(board.fields, rec.fields ?? {});
    if (!result.ok) { errors.push(...result.errors.map((e) => `card ${i + 1}: ${e}`)); return; }
    prepared.push({ title: deriveTitle(board.fields, result.values, rec.title), fields: result.values });
  });
  if (errors.length) return { ok: false, errors };

  const cards = db.insertWorkboardCards(board.scope, userId, prepared.map((p) => ({
    boardId: board.id, stageKey, title: p.title, fields: p.fields, origin, originRef: originRef ?? null,
  })));
  for (const c of cards) {
    db.insertWorkboardEvent(board.scope, userId, {
      boardId: board.id, cardId: c.id, kind: "created", toStage: stageKey, actor: origin === "user" ? userId : origin,
    });
  }
  return { ok: true, value: cards };
}

export function moveCard(
  db: DatabaseType, userId: string, board: Workboard, cardId: string, toStage: string, actor: string,
  opts: { actorIsOnEnter?: boolean; beforeId?: string; afterId?: string } = {}
): ServiceResult<MoveOutcome> {
  const card = db.getWorkboardCard(board.scope, userId, cardId);
  if (!card) return { ok: false, errors: [`no card ${cardId}`] };

  const decision = planMove(
    { board: toDef(board), card: { id: card.id, stageKey: card.stageKey, archived: card.archived }, toStage },
    opts.actorIsOnEnter ?? false
  );
  if (!decision.ok) return { ok: false, errors: [decision.error] };

  const before = opts.beforeId ? db.getWorkboardCard(board.scope, userId, opts.beforeId)?.position ?? null : null;
  const after = opts.afterId ? db.getWorkboardCard(board.scope, userId, opts.afterId)?.position ?? null : null;
  const position = before === null && after === null ? undefined : positionBetween(before, after);

  const updated = db.updateWorkboardCard(board.scope, userId, cardId, {
    stageKey: toStage, ...(position === undefined ? {} : { position }),
  });
  if (!updated) return { ok: false, errors: [`failed to move card ${cardId}`] };

  db.insertWorkboardEvent(board.scope, userId, {
    boardId: board.id, cardId, kind: "moved", fromStage: decision.fromStage, toStage, actor,
  });
  return { ok: true, value: { card: updated, fires: decision.fires } };
}
