import { test, expect } from "bun:test";
import { validateCardFields, type FieldDef } from "../src/workboards.ts";

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
