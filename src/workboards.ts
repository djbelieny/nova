/**
 * Workboards — pure logic for agent-created boards of structured cards.
 *
 * Validation, stage resolution, move rules, and ordering live here with no DB or IO so they
 * stay testable. Persistence is the Database facade; dispatch is the automation engine.
 * Columns are "stages" — see StageDef.
 */

export type FieldType =
  | "text" | "longtext" | "number" | "money" | "date"
  | "email" | "url" | "select" | "checkbox" | "agent" | "link";

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: string[];
  primary?: boolean;
}

export interface StageDef {
  key: string;
  label: string;
  order: number;
  onEnter?: OnEnterAction;
}

export type OnEnterAction =
  | { playbook: string; vars?: Record<string, string> }
  | { agent: string; task: string };

export interface WorkboardDef {
  id: string;
  name: string;
  fields: FieldDef[];
  stages: StageDef[];
  reactive: boolean;
}

export type ValidationResult =
  | { ok: true; values: Record<string, unknown>; errors?: never }
  | { ok: false; errors: string[]; values?: never };

const NUMERIC: FieldType[] = ["number", "money"];

function coerce(def: FieldDef, raw: unknown): { value: unknown; error?: string } {
  if (raw === undefined || raw === null || raw === "") return { value: null };
  if (NUMERIC.includes(def.type)) {
    const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[$,\s]/g, ""));
    if (!Number.isFinite(n)) return { value: null, error: `field "${def.key}" expects a ${def.type}, got "${String(raw)}"` };
    return { value: n };
  }
  if (def.type === "checkbox") {
    if (typeof raw === "boolean") return { value: raw };
    const s = String(raw).toLowerCase();
    if (["true", "1", "yes"].includes(s)) return { value: true };
    if (["false", "0", "no"].includes(s)) return { value: false };
    return { value: null, error: `field "${def.key}" expects a checkbox value, got "${String(raw)}"` };
  }
  if (def.type === "select") {
    const s = String(raw);
    if (def.options && !def.options.includes(s)) {
      return { value: null, error: `field "${def.key}" must be one of: ${def.options.join(", ")} (got "${s}")` };
    }
    return { value: s };
  }
  return { value: String(raw) };
}

/** Validate and coerce a card's fields against the board's declared schema. */
export function validateCardFields(fields: FieldDef[], input: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];
  const values: Record<string, unknown> = {};
  const known = new Set(fields.map((f) => f.key));

  for (const key of Object.keys(input)) {
    if (!known.has(key)) errors.push(`unknown field "${key}" — this board declares: ${[...known].join(", ")}`);
  }

  for (const def of fields) {
    const { value, error } = coerce(def, input[def.key]);
    if (error) { errors.push(error); continue; }
    if (def.required && (value === null || value === "")) {
      errors.push(`field "${def.key}" is required`);
      continue;
    }
    values[def.key] = value;
  }

  return errors.length ? { ok: false, errors } : { ok: true, values };
}

/**
 * Force a stored card's values onto a (possibly changed) schema: keys the schema no longer
 * declares are dropped, surviving values are re-coerced to their declared type, and a value the
 * new type cannot take becomes null. Used after a destructive schema edit so every card still
 * validates — the pre-edit values are already snapshotted into the board's event history.
 */
export function conformCardFields(fields: FieldDef[], stored: Record<string, unknown>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const def of fields) {
    const { value, error } = coerce(def, stored[def.key]);
    values[def.key] = error ? null : value;
  }
  return values;
}

export interface MoveInput {
  board: WorkboardDef;
  card: { id: string; stageKey: string; archived: boolean };
  toStage: string;
}

export type MoveDecision =
  | { ok: true; fromStage: string; toStage: string; fires: OnEnterAction | null; error?: never }
  | { ok: false; error: string; fromStage?: never; toStage?: never; fires?: never };

/** Find a stage by key. */
export function resolveStage(stages: StageDef[], key: string): StageDef | null {
  return stages.find((s) => s.key === key) ?? null;
}

/**
 * Decide whether a move is legal and whether it arms an onEnter action.
 * `actorIsOnEnter` is the loop guard: a move caused by an onEnter action never fires another.
 */
export function planMove(input: MoveInput, actorIsOnEnter = false): MoveDecision {
  const { board, card, toStage } = input;
  if (card.archived) return { ok: false, error: `card ${card.id} is archived` };
  const target = resolveStage(board.stages, toStage);
  if (!target) {
    const keys = board.stages.map((s) => s.key).join(", ");
    return { ok: false, error: `unknown stage "${toStage}" — this board has: ${keys}` };
  }
  const sameStage = card.stageKey === toStage;
  const fires = !sameStage && !actorIsOnEnter && board.reactive && target.onEnter ? target.onEnter : null;
  return { ok: true, fromStage: card.stageKey, toStage, fires };
}

/**
 * True when a field keeps its key and type but stops accepting values it used to accept: a select
 * whose options shrank (or gained options where it had none), or a field that became required.
 * Cards already holding a now-rejected value fail validateCardFields on every later edit, so this
 * is as destructive as a removal — just through a narrower door.
 */
function narrows(before: FieldDef, after: FieldDef): boolean {
  if (after.type !== before.type) return false;
  if (!before.required && after.required) return true;
  if (after.type !== "select" || !after.options) return false;
  if (!before.options) return true;
  return before.options.some((o) => !after.options!.includes(o));
}

/** Compare two field schemas. Additions are safe; removals, retypes, and narrowed fields can
 * invalidate cards. */
export function diffSchema(before: FieldDef[], after: FieldDef[]) {
  const beforeByKey = new Map(before.map((f) => [f.key, f]));
  const afterByKey = new Map(after.map((f) => [f.key, f]));
  const added = after.filter((f) => !beforeByKey.has(f.key)).map((f) => f.key);
  const removed = before.filter((f) => !afterByKey.has(f.key)).map((f) => f.key);
  const retyped = before
    .filter((f) => afterByKey.has(f.key) && afterByKey.get(f.key)!.type !== f.type)
    .map((f) => f.key);
  const narrowed = before
    .filter((f) => afterByKey.has(f.key) && narrows(f, afterByKey.get(f.key)!))
    .map((f) => f.key);
  return {
    added, removed, retyped, narrowed,
    destructive: removed.length > 0 || retyped.length > 0 || narrowed.length > 0,
  };
}

/** Fractional ordering: a position strictly between two neighbours (or outside a single one). */
export function positionBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return 1;
  if (before === null) return (after as number) - 1;
  if (after === null) return before + 1;
  return (before + after) / 2;
}

// ── Chat-authored board tag ──
//
// [WORKBOARD: <name> | <purpose> | FIELDS: <field-list> | STAGES: <stage-list>]
//
// e.g. [WORKBOARD: purchasing | Track purchase orders | FIELDS: vendor:text*, po_number:text,
//   amount:money, due_date:date, status:select(draft|sent|paid) | STAGES: draft > sent > paid]
//
// `|` separates the four top-level segments AND separates a select's options inside
// `select(a|b|c)`, so the split has to track paren depth instead of running straight through.

const FIELD_TYPES: FieldType[] = [
  "text", "longtext", "number", "money", "date",
  "email", "url", "select", "checkbox", "agent", "link",
];

/** Split on `delimiter` at paren-depth 0 only — a delimiter inside `(...)` stays put. */
function splitOutsideParens(input: string, delimiter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of input) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === delimiter && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/** "in_progress" → "In Progress"; "po_number" → "Po Number". */
function titleCase(key: string): string {
  return key
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

type FieldSpecResult = { field: FieldDef; error?: never } | { field?: never; error: string };

/** Parse one `key:type[(opt|opt)][*]` field spec. */
function parseFieldSpec(spec: string): FieldSpecResult {
  const m = spec.match(/^([a-zA-Z_][\w-]*)\s*:\s*([a-zA-Z]+)\s*(\(([^)]*)\))?\s*(\*)?$/);
  if (!m) return { error: `malformed field spec "${spec}" — expected key:type[(opt|opt)][*]` };
  const [, key, rawType, , rawOptions, star] = m;
  const type = rawType as FieldType;
  if (!FIELD_TYPES.includes(type)) {
    return { error: `unknown field type "${rawType}" — expected one of: ${FIELD_TYPES.join(", ")}` };
  }
  if (rawOptions !== undefined && type !== "select") {
    return { error: `field "${key}" declares options but is type "${type}", not select` };
  }
  const options = type === "select" && rawOptions !== undefined
    ? rawOptions.split("|").map((o) => o.trim()).filter(Boolean)
    : undefined;
  return {
    field: {
      key, label: titleCase(key), type,
      ...(star ? { required: true } : {}),
      ...(options ? { options } : {}),
    },
  };
}

type StageSpecResult = { stage: StageDef; error?: never } | { stage?: never; error: string };

/** Parse one `key` or `key=Label` stage spec. `order` is the position in the tag's stage list. */
function parseStageSpec(spec: string, order: number): StageSpecResult {
  const eq = spec.indexOf("=");
  const key = (eq >= 0 ? spec.slice(0, eq) : spec).trim();
  const label = eq >= 0 ? spec.slice(eq + 1).trim() : "";
  if (!key) return { error: `empty stage key in "${spec}"` };
  if (!/^[\w-]+$/.test(key)) return { error: `invalid stage key "${key}" — use letters, digits, _ or -` };
  return { stage: { key, label: label || titleCase(key), order } };
}

export interface WorkboardTagParse {
  name: string;
  purpose: string;
  fields: FieldDef[];
  stages: StageDef[];
  errors: string[];
}

/**
 * Parse a `[WORKBOARD: ...]` tag body (the text between `WORKBOARD:` and the closing `]`).
 *
 * A malformed field or stage is reported in `errors` and dropped — it never blocks the rest of
 * the tag from parsing. This module doesn't decide whether the board actually gets created from
 * a partial result; that call belongs to whoever holds the DB (see workboard-service.ts's
 * validateDefinition, which already rejects an empty field/stage list, duplicate keys, and a
 * select with no options). Keeping this function permissive is the point of choosing a bracket
 * tag over JSON: one bad clause reports itself instead of killing the whole board.
 */
export function parseWorkboardTag(raw: string): WorkboardTagParse {
  const errors: string[] = [];
  const top = splitOutsideParens(raw, "|").map((p) => p.trim());
  const name = top[0] ?? "";
  const purpose = top[1] ?? "";
  const fieldsPart = top.find((p) => /^FIELDS:/i.test(p));
  const stagesPart = top.find((p) => /^STAGES:/i.test(p));

  if (!name) errors.push("board name is required");
  if (!fieldsPart) errors.push("missing FIELDS: section");
  if (!stagesPart) errors.push("missing STAGES: section");

  const fields: FieldDef[] = [];
  if (fieldsPart) {
    const body = fieldsPart.replace(/^FIELDS:\s*/i, "");
    for (const item of splitOutsideParens(body, ",").map((s) => s.trim()).filter(Boolean)) {
      const parsed = parseFieldSpec(item);
      if (parsed.error) errors.push(parsed.error);
      else fields.push(parsed.field);
    }
    // The first successfully-parsed field becomes the card title. The tag grammar has no way to
    // mark a different one as primary, so "first" is the whole rule — documented, not guessed.
    if (fields.length) fields[0].primary = true;
  }

  const stages: StageDef[] = [];
  if (stagesPart) {
    const body = stagesPart.replace(/^STAGES:\s*/i, "");
    body.split(">").map((s) => s.trim()).filter(Boolean).forEach((item, i) => {
      const parsed = parseStageSpec(item, i);
      if (parsed.error) errors.push(parsed.error);
      else stages.push(parsed.stage);
    });
  }

  return { name, purpose, fields, stages, errors };
}
