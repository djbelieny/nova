// tests/extraction.test.ts
import { test, expect } from "bun:test";
import { getDb } from "../src/db.ts";
import { parseJsonLoose, coerceValue, validateExtraction, buildExtractionPrompt, extractStructured, extractionsToCsv, parseExtractCaption } from "../src/extraction.ts";
import type { ExtractField, ExtractSchema } from "../src/db.ts";

let seq = 0;
function newUser() {
  const db = getDb();
  const u = db.upsertUser({ telegram_id: `ex-${Date.now()}-${seq++}`, name: "EX", role: "member" });
  return { db, userId: u.id };
}

const invoiceFields: ExtractField[] = [
  { name: "invoice_number", type: "string", required: true },
  { name: "total", type: "number", required: true },
  { name: "due_date", type: "date" },
  { name: "paid", type: "boolean" },
  { name: "line_items", type: "array" },
];
const schema = (over: Partial<ExtractSchema> = {}): ExtractSchema => ({ id: "s1", userId: "u", name: "invoice", fields: invoiceFields, destination: null, ...over });

test("parseJsonLoose extracts JSON from messy output", () => {
  expect(parseJsonLoose('Here you go: {"a": 1, "b": "x"} thanks')).toEqual({ a: 1, b: "x" });
  expect(parseJsonLoose('no json here')).toBeNull();
  expect(parseJsonLoose('{"nested": {"x": 1}}')).toEqual({ nested: { x: 1 } });
});

test("coerceValue coerces by type", () => {
  expect(coerceValue("$1,234.50", "number")).toBe(1234.5);
  expect(coerceValue("Paid", "boolean")).toBe(true);
  expect(coerceValue("a, b; c", "array")).toEqual(["a", "b", "c"]);
  expect(coerceValue("2026-08-01T00:00:00Z", "date")).toBe("2026-08-01");
});

test("validateExtraction coerces + flags missing required", () => {
  const { data, missing } = validateExtraction(invoiceFields, { invoice_number: "INV-1", total: "$90.00" });
  expect(data.total).toBe(90);
  expect(data.invoice_number).toBe("INV-1");
  expect(missing).toEqual([]); // due_date/paid not required
  const r2 = validateExtraction(invoiceFields, { total: "50" });
  expect(r2.missing).toContain("invoice_number");
});

test("buildExtractionPrompt lists fields + document", () => {
  const p = buildExtractionPrompt(schema(), "INV-42 total 100");
  expect(p).toContain("invoice_number");
  expect(p).toContain("[required]");
  expect(p).toContain("INV-42");
});

test("extractStructured (stubbed LLM) stores a validated extraction", async () => {
  const { db, userId } = newUser();
  const s = db.upsertExtractSchema(userId, { name: "invoice", fields: invoiceFields });
  const callLLM = async () => 'Result: {"invoice_number":"INV-7","total":"$250.00","due_date":"2026-09-01","paid":"yes","line_items":"widget, gadget"}';
  const r = await extractStructured({ db, userId, schema: s, text: "invoice text here", source: "test.pdf", callLLM });
  expect(r.status).toBe("extracted");
  expect(r.data.total).toBe(250);
  expect(r.data.paid).toBe(true);
  expect(r.data.line_items).toEqual(["widget", "gadget"]);
  expect(r.id).not.toBeNull();
  const stored = db.listExtractions(userId, "invoice");
  expect(stored).toHaveLength(1);
});

test("extractStructured flags incomplete when a required field is missing", async () => {
  const { db, userId } = newUser();
  const s = db.upsertExtractSchema(userId, { name: "invoice", fields: invoiceFields });
  const callLLM = async () => '{"total": 10}';
  const r = await extractStructured({ db, userId, schema: s, text: "x y z content", callLLM });
  expect(r.status).toBe("incomplete");
  expect(r.missing).toContain("invoice_number");
});

test("extractStructured errors when the model returns no JSON", async () => {
  const { db, userId } = newUser();
  const s = db.upsertExtractSchema(userId, { name: "invoice", fields: invoiceFields });
  const r = await extractStructured({ db, userId, schema: s, text: "some content here", callLLM: async () => "sorry, cannot" });
  expect(r.status).toBe("error");
});

test("parseExtractCaption detects schema", () => {
  expect(parseExtractCaption("extract as invoice")).toEqual({ wants: true, schema: "invoice" });
  expect(parseExtractCaption("extract this as an invoice")).toEqual({ wants: true, schema: "invoice" });
  expect(parseExtractCaption("/extract receipt")).toEqual({ wants: true, schema: "receipt" });
  expect(parseExtractCaption("just analyze this").wants).toBe(false);
});

test("db: schema upsert + list + extraction CSV", () => {
  const { db, userId } = newUser();
  db.upsertExtractSchema(userId, { name: "receipt", fields: [{ name: "vendor" }, { name: "amount", type: "number" }] });
  db.upsertExtractSchema(userId, { name: "receipt", fields: [{ name: "vendor" }, { name: "amount", type: "number" }, { name: "date", type: "date" }] });
  const s = db.getExtractSchema(userId, "receipt")!;
  expect(s.fields).toHaveLength(3); // upsert replaced
  const csv = extractionsToCsv(s.fields, [{ data: { vendor: "Acme, Inc", amount: 5, date: "2026-01-01" } }]);
  expect(csv.split("\n")[0]).toBe("vendor,amount,date");
  expect(csv).toContain('"Acme, Inc"');
});
