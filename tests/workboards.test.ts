import { test, expect } from "bun:test";
import { validateCardFields, planMove, positionBetween, resolveStage, diffSchema, type FieldDef, type StageDef, type WorkboardDef } from "../src/workboards.ts";

const FIELDS: FieldDef[] = [
  { key: "vendor", label: "Vendor", type: "text", required: true, primary: true },
  { key: "amount", label: "Amount", type: "money" },
  { key: "due_date", label: "Due", type: "date" },
  { key: "status", label: "Status", type: "select", options: ["draft", "sent", "paid"] },
  { key: "urgent", label: "Urgent", type: "checkbox" },
];

test("validateCardFields accepts a well-formed record and coerces types", () => {
  const r = validateCardFields(FIELDS, { vendor: "Acme", amount: "1250.50", urgent: "true" });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.values.amount).toBe(1250.5);
    expect(r.values.urgent).toBe(true);
    expect(r.values.vendor).toBe("Acme");
  }
});

test("validateCardFields reports a missing required field by key", () => {
  const r = validateCardFields(FIELDS, { amount: 10 });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.join(" ")).toContain("vendor");
});

test("validateCardFields rejects a select value outside its options", () => {
  const r = validateCardFields(FIELDS, { vendor: "Acme", status: "archived" });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.join(" ")).toContain("status");
});

test("validateCardFields rejects unknown fields", () => {
  const r = validateCardFields(FIELDS, { vendor: "Acme", nonsense: 1 });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.join(" ")).toContain("nonsense");
});

test("validateCardFields rejects a non-numeric money value", () => {
  const r = validateCardFields(FIELDS, { vendor: "Acme", amount: "not-a-number" });
  expect(r.ok).toBe(false);
});

test("validateCardFields fills absent optional fields with null", () => {
  const r = validateCardFields(FIELDS, { vendor: "Acme" });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.values.due_date).toBe(null);
});

const STAGES: StageDef[] = [
  { key: "new", label: "New", order: 0 },
  { key: "qualified", label: "Qualified", order: 1 },
  { key: "nurture", label: "Nurture", order: 2, onEnter: { playbook: "lead-follow-up", vars: { lead: "{{card.company}}" } } },
];

const BOARD = (over: Partial<WorkboardDef> = {}): WorkboardDef => ({
  id: "b1", name: "Leads", fields: FIELDS, stages: STAGES, reactive: true, ...over,
});

const CARD = (over: Partial<{ id: string; stageKey: string; archived: boolean }> = {}) =>
  ({ id: "c1", stageKey: "new", archived: false, ...over });

test("resolveStage finds a stage by key and returns null for unknown", () => {
  expect(resolveStage(STAGES, "qualified")?.label).toBe("Qualified");
  expect(resolveStage(STAGES, "nope")).toBe(null);
});

test("planMove rejects an unknown target stage", () => {
  const d = planMove({ board: BOARD(), card: CARD(), toStage: "nope" });
  expect(d.ok).toBe(false);
  if (!d.ok) expect(d.error).toContain("nope");
});

test("planMove rejects moving an archived card", () => {
  const d = planMove({ board: BOARD(), card: CARD({ archived: true }), toStage: "qualified" });
  expect(d.ok).toBe(false);
});

test("planMove on a reactive board returns the onEnter action to fire", () => {
  const d = planMove({ board: BOARD(), card: CARD(), toStage: "nurture" });
  expect(d.ok).toBe(true);
  if (d.ok) expect(d.fires).toEqual({ playbook: "lead-follow-up", vars: { lead: "{{card.company}}" } });
});

test("planMove on a non-reactive board never fires", () => {
  const d = planMove({ board: BOARD({ reactive: false }), card: CARD(), toStage: "nurture" });
  expect(d.ok).toBe(true);
  if (d.ok) expect(d.fires).toBe(null);
});

test("loop guard: a move made by an onEnter action does not fire another onEnter", () => {
  const d = planMove({ board: BOARD(), card: CARD(), toStage: "nurture" }, true);
  expect(d.ok).toBe(true);
  if (d.ok) expect(d.fires).toBe(null);
});

test("planMove into the same stage is a no-op that does not fire", () => {
  const d = planMove({ board: BOARD(), card: CARD({ stageKey: "nurture" }), toStage: "nurture" });
  expect(d.ok).toBe(true);
  if (d.ok) expect(d.fires).toBe(null);
});

test("positionBetween produces a value strictly between its neighbours", () => {
  const p = positionBetween(1, 2);
  expect(p).toBeGreaterThan(1);
  expect(p).toBeLessThan(2);
  expect(positionBetween(null, 1)).toBeLessThan(1);
  expect(positionBetween(5, null)).toBeGreaterThan(5);
  expect(positionBetween(null, null)).toBe(1);
});

test("diffSchema reports a pure addition as non-destructive", () => {
  const after = [...FIELDS, { key: "owner", label: "Owner", type: "text" as const }];
  const d = diffSchema(FIELDS, after);
  expect(d.added).toEqual(["owner"]);
  expect(d.destructive).toBe(false);
});

test("diffSchema flags a removed field as destructive", () => {
  const d = diffSchema(FIELDS, FIELDS.filter((f) => f.key !== "amount"));
  expect(d.removed).toEqual(["amount"]);
  expect(d.destructive).toBe(true);
});

test("diffSchema flags a retyped field as destructive", () => {
  const after = FIELDS.map((f) => (f.key === "amount" ? { ...f, type: "text" as const } : f));
  const d = diffSchema(FIELDS, after);
  expect(d.retyped).toEqual(["amount"]);
  expect(d.destructive).toBe(true);
});

test("diffSchema flags a select that drops an option as destructive — cards holding it stop validating", () => {
  const after = FIELDS.map((f) => (f.key === "status" ? { ...f, options: ["draft", "sent"] } : f));
  const d = diffSchema(FIELDS, after);
  expect(d.narrowed).toEqual(["status"]);
  expect(d.destructive).toBe(true);
});

test("diffSchema treats a select that only gains an option as safe", () => {
  const after = FIELDS.map((f) => (f.key === "status" ? { ...f, options: ["draft", "sent", "paid", "void"] } : f));
  const d = diffSchema(FIELDS, after);
  expect(d.narrowed).toEqual([]);
  expect(d.destructive).toBe(false);
});

test("diffSchema flags a field that becomes required as destructive", () => {
  const after = FIELDS.map((f) => (f.key === "amount" ? { ...f, required: true } : f));
  const d = diffSchema(FIELDS, after);
  expect(d.narrowed).toEqual(["amount"]);
  expect(d.destructive).toBe(true);
});

test("diffSchema treats dropping a required flag as safe", () => {
  const after = FIELDS.map((f) => (f.key === "vendor" ? { ...f, required: false } : f));
  const d = diffSchema(FIELDS, after);
  expect(d.narrowed).toEqual([]);
  expect(d.destructive).toBe(false);
});

test("diffSchema flags a select that gains options where it had none as destructive", () => {
  const before: FieldDef[] = [{ key: "tier", label: "Tier", type: "select" }];
  const d = diffSchema(before, [{ key: "tier", label: "Tier", type: "select", options: ["gold"] }]);
  expect(d.narrowed).toEqual(["tier"]);
  expect(d.destructive).toBe(true);
});
