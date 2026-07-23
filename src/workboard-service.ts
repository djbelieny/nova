/**
 * Workboard service — joins the pure logic in workboards.ts to the Database facade.
 * The CLI and the dashboard API both call this, so validation and event logging happen once.
 *
 * Event writes are best-effort: each facade call carries its own transaction, so a mutation that
 * succeeds is not rolled back if its audit event fails to write. The events feed the card history
 * panel, not anything that must balance.
 */

import { validateCardFields, planMove, positionBetween, type FieldDef, type StageDef, type OnEnterAction, type WorkboardDef } from "./workboards.ts";
import type { CardOrigin, DatabaseType, Workboard, WorkboardCard } from "./db.ts";
import { emit } from "./events.ts";

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
  emit({
    type: "workboard.cards.created", level: "info", userId,
    data: { boardId: board.id, stageKey, count: cards.length, cardIds: cards.map((c) => c.id) },
  });
  return { ok: true, value: cards };
}

/** Highest position in the target stage plus one, or 1 when the stage is empty. */
function appendPosition(db: DatabaseType, userId: string, board: Workboard, toStage: string): number {
  const cards = db.listWorkboardCards(board.scope, userId, board.id, { stageKey: toStage });
  if (!cards.length) return 1;
  return Math.max(...cards.map((c) => c.position)) + 1;
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
  // With a drop hint, slot between the neighbours. Without one, a card changing stage keeps a
  // position that ranked it in its OLD stage, so append it to the end of the new one instead.
  const position = before !== null || after !== null
    ? positionBetween(before, after)
    : decision.fromStage === toStage
      ? undefined
      : appendPosition(db, userId, board, toStage);

  const updated = db.updateWorkboardCard(board.scope, userId, cardId, {
    stageKey: toStage, ...(position === undefined ? {} : { position }),
  });
  if (!updated) return { ok: false, errors: [`failed to move card ${cardId}`] };

  db.insertWorkboardEvent(board.scope, userId, {
    boardId: board.id, cardId, kind: "moved", fromStage: decision.fromStage, toStage, actor,
  });
  emit({
    type: "workboard.card.moved", level: "info", userId,
    data: { boardId: board.id, cardId, fromStage: decision.fromStage, toStage },
  });
  return { ok: true, value: { card: updated, fires: decision.fires } };
}

export interface UpdateCardInput { fields?: Record<string, unknown>; title?: string; }

/** Validates and applies a field/title edit. Card writes and their history/notification always
 * accompany each other, so callers should not build their own version of this. */
export function updateCard(
  db: DatabaseType, userId: string, board: Workboard, card: WorkboardCard,
  input: UpdateCardInput, actor: string
): ServiceResult<WorkboardCard> {
  const merged = { ...card.fields, ...(input.fields ?? {}) };
  const result = validateCardFields(board.fields, merged);
  if (!result.ok) return { ok: false, errors: result.errors };

  const updated = db.updateWorkboardCard(board.scope, userId, card.id, {
    fields: result.values,
    title: deriveTitle(board.fields, result.values, input.title),
  });
  if (!updated) return { ok: false, errors: [`failed to update card ${card.id}`] };

  db.insertWorkboardEvent(board.scope, userId, {
    boardId: board.id, cardId: card.id, kind: "updated", actor, detail: { before: card.fields },
  });
  emit({
    type: "workboard.card.updated", level: "info", userId,
    data: { boardId: board.id, cardId: card.id, title: updated.title },
  });
  return { ok: true, value: updated };
}

/** Soft-deletes a card. Distinct from updateCard: no field validation, and the audit kind stays
 * "archived" so the card history panel can tell the two apart. */
export function archiveCard(
  db: DatabaseType, userId: string, board: Workboard, cardId: string, actor: string
): ServiceResult<WorkboardCard> {
  const updated = db.updateWorkboardCard(board.scope, userId, cardId, { archived: true });
  if (!updated) return { ok: false, errors: [`failed to archive card ${cardId}`] };

  db.insertWorkboardEvent(board.scope, userId, { boardId: board.id, cardId, kind: "archived", actor });
  emit({
    type: "workboard.card.updated", level: "info", userId,
    data: { boardId: board.id, cardId, archived: true },
  });
  return { ok: true, value: updated };
}
