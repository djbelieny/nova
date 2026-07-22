// tests/data-sources.test.ts
import { test, expect } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { tmpdir } from "os";
import { join } from "path";
import { getDb } from "../src/db.ts";
import { queryDataSource, parseCsv } from "../src/data-sources.ts";

let seq = 0;
function newUser() {
  const db = getDb();
  const u = db.upsertUser({ telegram_id: `ds-${Date.now()}-${seq++}`, name: "DS", role: "member" });
  return { db, userId: u.id };
}

test("parseCsv handles quoted fields", () => {
  const rows = parseCsv('name,amount\n"Acme, Inc",100\nBeta,50');
  expect(rows).toHaveLength(2);
  expect(rows[0]).toEqual({ name: "Acme, Inc", amount: "100" });
  expect(rows[1].name).toBe("Beta");
});

test("http source parses a JSON array (mocked fetch)", async () => {
  const { db, userId } = newUser();
  const src = db.upsertDataSource(userId, { name: "sales", kind: "http", config: { url: "https://x/api", rowsPath: "data" } });
  const fetchImpl = (async () => ({ ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify({ data: [{ region: "NA", rev: 100 }, { region: "EU", rev: 80 }] }) })) as any;
  const r = await queryDataSource(db, src, { fetchImpl });
  expect(r.rows).toHaveLength(2);
  expect(r.columns).toContain("region");
  expect(r.rows[0].rev).toBe(100);
});

test("http source parses CSV by content-type", async () => {
  const { db, userId } = newUser();
  const src = db.upsertDataSource(userId, { name: "csvsrc", kind: "http", config: { url: "https://x/report.csv" } });
  const fetchImpl = (async () => ({ ok: true, status: 200, headers: { get: () => "text/csv" }, text: async () => "a,b\n1,2\n3,4" })) as any;
  const r = await queryDataSource(db, src, { fetchImpl });
  expect(r.rows).toEqual([{ a: "1", b: "2" }, { a: "3", b: "4" }]);
});

test("sqlite source runs a read-only SELECT", async () => {
  const { db, userId } = newUser();
  const path = join(tmpdir(), `ds-test-${Date.now()}-${seq++}.db`);
  const ext = new BunDatabase(path);
  ext.run("CREATE TABLE metrics (day TEXT, revenue REAL)");
  ext.run("INSERT INTO metrics VALUES ('mon', 100), ('tue', 150)");
  ext.close();
  const src = db.upsertDataSource(userId, { name: "warehouse", kind: "sqlite", config: { path, query: "SELECT day, revenue FROM metrics ORDER BY revenue DESC" } });
  const r = await queryDataSource(db, src);
  expect(r.rows).toHaveLength(2);
  expect(r.rows[0]).toEqual({ day: "tue", revenue: 150 });
});

test("sqlite source rejects non-SELECT queries", async () => {
  const { db, userId } = newUser();
  const path = join(tmpdir(), `ds-test-${Date.now()}-${seq++}.db`);
  new BunDatabase(path).close();
  const src = db.upsertDataSource(userId, { name: "danger", kind: "sqlite", config: { path } });
  await expect(queryDataSource(db, src, { query: "DELETE FROM metrics" })).rejects.toThrow("read-only");
});

test("db: data source upsert + list + delete", () => {
  const { db, userId } = newUser();
  db.upsertDataSource(userId, { name: "s1", kind: "http", config: { url: "u" } });
  db.upsertDataSource(userId, { name: "s1", kind: "http", config: { url: "u2" } }); // upsert
  expect(db.getDataSource(userId, "s1")!.config.url).toBe("u2");
  expect(db.listDataSources(userId)).toHaveLength(1);
  db.deleteDataSource(userId, "s1");
  expect(db.listDataSources(userId)).toHaveLength(0);
});
