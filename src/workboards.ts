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
