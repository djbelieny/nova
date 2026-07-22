/**
 * Nova — Connected-data CLI (`nova data …`)
 *
 *   nova data add sales --kind http --url https://api/report.json --rows-path data
 *   nova data add wh --kind sqlite --path /data/warehouse.db --query "SELECT * FROM metrics"
 *   nova data add pays --kind connector --connector stripe --action list_charges --rows-path data
 *   nova data list | describe <name> | query <name> [--query "SELECT …"] | remove <name>
 *
 * Query registered data sources (HTTP JSON/CSV, read-only SQLite, or a connector read action)
 * for recurring analytical reads. Read-only; connector write actions are refused.
 */

import { getDb, type DatabaseType } from "./db.ts";
import { queryDataSource } from "./data-sources.ts";

function adminId(db: DatabaseType): string {
  const a = db.getUsersByRole("admin")[0];
  if (!a) throw new Error("No user found — run `nova init` first.");
  return a.id;
}

function flag(rest: string[], name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}

function runAdd(name: string, rest: string[]): number {
  const kind = flag(rest, "kind");
  if (!name || !kind) { console.error("  Usage: nova data add <name> --kind http|sqlite|connector …"); return 1; }
  const config: Record<string, any> = {};
  if (kind === "http") { config.url = flag(rest, "url"); config.rowsPath = flag(rest, "rows-path"); config.format = flag(rest, "format"); if (!config.url) { console.error("  --url is required for http"); return 1; } }
  else if (kind === "sqlite") { config.path = flag(rest, "path"); config.query = flag(rest, "query"); if (!config.path) { console.error("  --path is required for sqlite"); return 1; } }
  else if (kind === "connector") { config.connector = flag(rest, "connector"); config.action = flag(rest, "action"); config.rowsPath = flag(rest, "rows-path"); if (!config.connector || !config.action) { console.error("  --connector and --action are required"); return 1; } }
  else { console.error(`  Unknown kind "${kind}". Use http|sqlite|connector.`); return 1; }
  const db = getDb();
  db.upsertDataSource(adminId(db), { name, kind, config });
  console.log(`  ✓ Data source "${name}" (${kind}). Query it: nova data query ${name}`);
  return 0;
}

function runList(): number {
  const db = getDb();
  const sources = db.listDataSources(adminId(db));
  if (!sources.length) { console.log("  No data sources. Add one: nova data add <name> --kind http --url …"); return 0; }
  for (const s of sources) console.log(`  ${s.name} [${s.kind}] — ${JSON.stringify(s.config).slice(0, 120)}`);
  return 0;
}

function runDescribe(name: string): number {
  const db = getDb();
  const s = db.getDataSource(adminId(db), name);
  if (!s) { console.error(`  No data source "${name}"`); return 1; }
  console.log(`  ${s.name} [${s.kind}]`);
  console.log(`  config: ${JSON.stringify(s.config, null, 2)}`);
  return 0;
}

async function runQuery(name: string, rest: string[]): Promise<number> {
  const db = getDb();
  const s = db.getDataSource(adminId(db), name);
  if (!s) { console.error(`  No data source "${name}"`); return 1; }
  try {
    const r = await queryDataSource(db, s, { query: flag(rest, "query") });
    console.log(`  ${r.rows.length} row(s) · columns: ${r.columns.join(", ")}`);
    for (const row of r.rows.slice(0, 25)) console.log(`  ${JSON.stringify(row)}`);
    if (r.rows.length > 25) console.log(`  … ${r.rows.length - 25} more`);
    return 0;
  } catch (e: any) { console.error(`  ✗ ${e.message}`); return 1; }
}

function runRemove(name: string): number {
  const db = getDb();
  db.deleteDataSource(adminId(db), name);
  console.log(`  ✓ Removed data source "${name}"`);
  return 0;
}

export async function runDataCli(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const name = rest.find(a => !a.startsWith("--")) || "";
  switch (sub) {
    case "list": case undefined: return runList();
    case "add": return runAdd(name, rest);
    case "describe": return name ? runDescribe(name) : (console.error("  Usage: nova data describe <name>"), 1);
    case "query": return name ? runQuery(name, rest) : (console.error("  Usage: nova data query <name>"), 1);
    case "remove": case "rm": return name ? runRemove(name) : (console.error("  Usage: nova data remove <name>"), 1);
    default:
      console.error(`  Unknown subcommand: ${sub}\n  Usage: nova data list|add|describe|query|remove`);
      return 1;
  }
}

if (import.meta.main) {
  runDataCli(process.argv.slice(2)).then(c => process.exit(c)).catch(err => { console.error(`\n  Error: ${err?.message || err}`); process.exit(1); });
}
