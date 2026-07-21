/**
 * Nova — Extraction CLI (`nova extract …`)
 *
 *   nova extract schema add invoice --field invoice_number:string:required --field total:number:required --field due_date:date
 *   nova extract schema list | show <name> | remove <name>
 *   nova extract <file> --schema invoice        run an extraction (prints the JSON)
 *   nova extract list [--schema invoice]
 *   nova extract export <schema>                CSV of stored extractions
 */

import { basename } from "path";
import { getDb, type DatabaseType, type ExtractField } from "./db.ts";
import { extractStructured, extractionsToCsv, type ExtractLLM } from "./extraction.ts";
import { sourceTypeFromName } from "./text-chunk.ts";

function adminId(db: DatabaseType): string {
  const admin = db.getUsersByRole("admin")[0];
  if (!admin) throw new Error("No user found — run `nova init` first.");
  return admin.id;
}

function parseFields(rest: string[]): ExtractField[] {
  const fields: ExtractField[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--field" && rest[i + 1]) {
      const [name, type, req] = rest[++i].split(":");
      fields.push({ name, type: (type as any) || "string", required: req === "required" || req === "req" });
    }
  }
  return fields;
}

async function providerLLM(): Promise<ExtractLLM> {
  const { registerProvider, getProvider, getDefaultProvider } = await import("./ai-provider.ts");
  let claude = getProvider("claude");
  if (!claude) {
    const { ClaudeProvider } = await import("./providers/claude.ts");
    try { registerProvider(new ClaudeProvider()); } catch { /* already */ }
    claude = getProvider("claude") ?? getDefaultProvider();
  }
  return async (prompt) => (await claude!.call({ prompt, model: claude!.mapModelTier("standard"), maxTurns: 1, outputFormat: "text" })).text;
}

function schemaCmd(rest: string[]): number {
  const [sub, name, ...tail] = rest;
  const db = getDb();
  const userId = adminId(db);
  if (sub === "add") {
    if (!name) { console.error("  Usage: nova extract schema add <name> --field name:type[:required] …"); return 1; }
    const fields = parseFields(tail);
    if (!fields.length) { console.error("  At least one --field is required."); return 1; }
    db.upsertExtractSchema(userId, { name, fields });
    console.log(`  ✓ Schema "${name}" (${fields.map(f => f.name).join(", ")})`);
    return 0;
  }
  if (sub === "list") {
    const schemas = db.listExtractSchemas(userId);
    if (!schemas.length) { console.log("  No schemas. Add one: nova extract schema add <name> --field …"); return 0; }
    for (const s of schemas) console.log(`  ${s.name}: ${s.fields.map(f => `${f.name}(${f.type})${f.required ? "*" : ""}`).join(", ")}`);
    return 0;
  }
  if (sub === "show") {
    const s = db.getExtractSchema(userId, name || "");
    if (!s) { console.error(`  No schema "${name}"`); return 1; }
    console.log(`  ${s.name}`);
    for (const f of s.fields) console.log(`   - ${f.name} (${f.type})${f.required ? " [required]" : ""}${f.description ? `: ${f.description}` : ""}`);
    return 0;
  }
  if (sub === "remove" || sub === "rm") {
    if (!name) { console.error("  Usage: nova extract schema remove <name>"); return 1; }
    db.deleteExtractSchema(userId, name);
    console.log(`  ✓ Removed schema "${name}"`);
    return 0;
  }
  console.error("  Usage: nova extract schema add|list|show|remove");
  return 1;
}

async function runExtract(file: string, schemaName: string): Promise<number> {
  const db = getDb();
  const userId = adminId(db);
  const schema = db.getExtractSchema(userId, schemaName);
  if (!schema) { console.error(`  No schema "${schemaName}". Define it: nova extract schema add ${schemaName} --field …`); return 1; }
  const f = Bun.file(file);
  if (!(await f.exists())) { console.error(`  File not found: ${file}`); return 1; }
  const sourceType = sourceTypeFromName(file);
  const buf = Buffer.from(await f.arrayBuffer());
  const isText = sourceType === "md" || sourceType === "txt";
  console.log(`  Extracting "${schemaName}" from ${basename(file)} …`);
  const callLLM = await providerLLM();
  const r = await extractStructured({ db, userId, schema, source: file, sourceType, bytes: isText ? undefined : buf, text: isText ? buf.toString("utf8") : undefined, callLLM });
  if (r.status === "error") { console.error(`  ✗ ${r.error}`); return 1; }
  console.log(JSON.stringify(r.data, null, 2));
  if (r.missing.length) console.log(`  ⚠ missing required: ${r.missing.join(", ")}`);
  return 0;
}

function listCmd(schemaName?: string): number {
  const db = getDb();
  const rows = db.listExtractions(adminId(db), schemaName);
  if (!rows.length) { console.log("  No extractions yet."); return 0; }
  for (const r of rows) console.log(`  [${r.schemaName || "?"}] ${r.status}  ${r.source || ""}  ${JSON.stringify(r.data).slice(0, 120)}`);
  return 0;
}

function exportCmd(schemaName: string): number {
  const db = getDb();
  const userId = adminId(db);
  const schema = db.getExtractSchema(userId, schemaName);
  if (!schema) { console.error(`  No schema "${schemaName}"`); return 1; }
  const rows = db.listExtractions(userId, schemaName, 10000);
  console.log(extractionsToCsv(schema.fields, rows));
  return 0;
}

export async function runExtractCli(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "schema") return schemaCmd(rest);
  if (sub === "list") { const i = rest.indexOf("--schema"); return listCmd(i >= 0 ? rest[i + 1] : undefined); }
  if (sub === "export") return rest[0] ? exportCmd(rest[0]) : (console.error("  Usage: nova extract export <schema>"), 1);
  // default: `nova extract <file> --schema <name>`
  if (sub && !sub.startsWith("--")) {
    const i = argv.indexOf("--schema");
    if (i < 0) { console.error("  Usage: nova extract <file> --schema <name>"); return 1; }
    return runExtract(sub, argv[i + 1]);
  }
  console.error("  Usage: nova extract <file> --schema <name> | schema … | list | export <schema>");
  return 1;
}

if (import.meta.main) {
  runExtractCli(process.argv.slice(2)).then(c => process.exit(c)).catch(err => { console.error(`\n  Error: ${err?.message || err}`); process.exit(1); });
}
