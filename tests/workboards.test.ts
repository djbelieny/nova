import { test, expect } from "bun:test";
import { validateCardFields, planMove, positionBetween, resolveStage, diffSchema, parseWorkboardTag, type FieldDef, type StageDef, type WorkboardDef } from "../src/workboards.ts";

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

// ── parseWorkboardTag ──

const PURCHASING_TAG =
  "purchasing | Track purchase orders | FIELDS: vendor:text*, po_number:text, amount:money, " +
  "due_date:date, status:select(draft|sent|paid) | STAGES: draft > sent > paid";

test("the full example round-trips: name, purpose, five fields, three ordered stages", () => {
  const r = parseWorkboardTag(PURCHASING_TAG);
  expect(r.errors).toEqual([]);
  expect(r.name).toBe("purchasing");
  expect(r.purpose).toBe("Track purchase orders");

  expect(r.fields.map((f) => f.key)).toEqual(["vendor", "po_number", "amount", "due_date", "status"]);
  expect(r.fields.map((f) => f.type)).toEqual(["text", "text", "money", "date", "select"]);
  expect(r.fields[0].required).toBe(true);
  expect(r.fields[0].primary).toBe(true);
  expect(r.fields.slice(1).every((f) => !f.required)).toBe(true);
  expect(r.fields[4].options).toEqual(["draft", "sent", "paid"]);

  expect(r.stages.map((s) => s.key)).toEqual(["draft", "sent", "paid"]);
  expect(r.stages.map((s) => s.order)).toEqual([0, 1, 2]);
});

test("a select's pipe-separated options do not break the top-level | split", () => {
  const r = parseWorkboardTag(
    "orders | | FIELDS: name:text*, status:select(a|b|c|d) | STAGES: new > done"
  );
  expect(r.errors).toEqual([]);
  expect(r.name).toBe("orders");
  expect(r.fields.map((f) => f.key)).toEqual(["name", "status"]);
  expect(r.fields[1].options).toEqual(["a", "b", "c", "d"]);
  expect(r.stages.map((s) => s.key)).toEqual(["new", "done"]);
});

test("two select fields each with piped options both survive the split", () => {
  const r = parseWorkboardTag(
    "orders | desc | FIELDS: status:select(a|b), priority:select(low|high) | STAGES: new > done"
  );
  expect(r.errors).toEqual([]);
  expect(r.fields[0].options).toEqual(["a", "b"]);
  expect(r.fields[1].options).toEqual(["low", "high"]);
});

test("an unknown field type is reported as an error, not silently accepted", () => {
  const r = parseWorkboardTag("board | desc | FIELDS: name:text*, weird:frobnicate | STAGES: a > b");
  expect(r.fields.map((f) => f.key)).toEqual(["name"]);
  expect(r.errors.some((e) => e.includes("frobnicate"))).toBe(true);
});

test("a malformed field is dropped and reported, the good fields still parse", () => {
  const r = parseWorkboardTag("board | desc | FIELDS: name:text*, ///not-a-field///, amount:money | STAGES: a > b");
  expect(r.fields.map((f) => f.key)).toEqual(["name", "amount"]);
  expect(r.errors.length).toBe(1);
  expect(r.errors[0]).toContain("malformed field spec");
});

test("stage key=Label syntax overrides the title-cased default", () => {
  const r = parseWorkboardTag("board | desc | FIELDS: name:text* | STAGES: new > in_progress=Working On It > done");
  expect(r.stages.map((s) => s.label)).toEqual(["New", "Working On It", "Done"]);
});

test("a bare stage key defaults to its title-cased form", () => {
  const r = parseWorkboardTag("board | desc | FIELDS: name:text* | STAGES: in_progress > done");
  expect(r.stages[0].label).toBe("In Progress");
});

test("a select field with no options is passed through — validateDefinition rejects it downstream", () => {
  const r = parseWorkboardTag("board | desc | FIELDS: name:text*, status:select | STAGES: a > b");
  expect(r.errors).toEqual([]);
  expect(r.fields[1].options).toBeUndefined();
});
