/**
 * Connected-data layer — query registered data sources so agents, automations, and recurring
 * reports can read from the systems where a business's data actually lives.
 *
 * Kinds (zero new heavy deps):
 *   http      — GET a JSON or CSV endpoint; rows = the array (optionally at `rowsPath`).
 *   sqlite    — run a read-only SELECT against a SQLite file (bun:sqlite, readonly).
 *   connector — call a connector READ action and shape its result into rows.
 *
 * Writes are never performed here; a connector write action is rejected.
 */

import { Database as BunDatabase } from "bun:sqlite";
import { getByPath } from "./automation-engine";
import type { Database } from "./db";

export interface QueryResult { columns: string[]; rows: Record<string, any>[]; source: string; }

/** Parse simple CSV (quoted fields, comma/newline) into row objects keyed by the header. */
export function parseCsv(text: string): Record<string, any>[] {
  const lines: string[][] = [];
  let field = "", row: string[] = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQ = false;
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(field); if (row.some(c => c !== "")) lines.push(row); field = ""; row = []; }
    else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some(c => c !== "")) lines.push(row); }
  if (!lines.length) return [];
  const header = lines[0];
  return lines.slice(1).map(cols => Object.fromEntries(header.map((h, i) => [h, cols[i] ?? ""])));
}

function columnsOf(rows: Record<string, any>[]): string[] {
  const set = new Set<string>();
  for (const r of rows.slice(0, 50)) for (const k of Object.keys(r || {})) set.add(k);
  return [...set];
}

async function queryHttp(source: any, fetchImpl: typeof fetch): Promise<Record<string, any>[]> {
  const cfg = source.config || {};
  const res = await fetchImpl(cfg.url, { method: cfg.method || "GET", headers: cfg.headers || {} });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${cfg.url}`);
  const ct = res.headers.get("content-type") || "";
  const text = await res.text();
  if (ct.includes("csv") || cfg.format === "csv") return parseCsv(text);
  let json: any; try { json = JSON.parse(text); } catch { return parseCsv(text); }
  const data = cfg.rowsPath ? getByPath(json, cfg.rowsPath) : json;
  return Array.isArray(data) ? data : (data ? [data] : []);
}

function querySqlite(source: any, overrideQuery?: string, params: any[] = []): Record<string, any>[] {
  const cfg = source.config || {};
  const query = (overrideQuery || cfg.query || "").trim();
  if (!query) throw new Error("sqlite data source needs a query");
  if (!/^select\b/i.test(query) && !/^with\b/i.test(query)) throw new Error("only read-only SELECT/WITH queries are allowed");
  const db = new BunDatabase(cfg.path, { readonly: true });
  try { return db.query(query).all(...params) as Record<string, any>[]; }
  finally { db.close(); }
}

async function queryConnector(db: Database, source: any, input: Record<string, any>): Promise<Record<string, any>[]> {
  const cfg = source.config || {};
  const { getConnector, runConnectorAction } = await import("./connectors/registry");
  const connector = getConnector(cfg.connector);
  const action = connector?.actions[cfg.action];
  if (!connector || !action) throw new Error(`unknown connector action ${cfg.connector}.${cfg.action}`);
  if (action.write) throw new Error("data sources may only use read actions");
  const r = await runConnectorAction(db, cfg.connector, cfg.action, { ...(cfg.input || {}), ...input });
  if (!r.ok) throw new Error(r.error);
  const data = cfg.rowsPath ? getByPath(r.data, cfg.rowsPath) : r.data;
  return Array.isArray(data) ? data : (data ? [data] : []);
}

/** Query a registered data source. `opts.query` overrides a sqlite source's query; `opts.input` extends a connector source's input. */
export async function queryDataSource(
  db: Database,
  source: DataSourceLike,
  opts: { query?: string; params?: any[]; input?: Record<string, any>; fetchImpl?: typeof fetch } = {}
): Promise<QueryResult> {
  let rows: Record<string, any>[];
  if (source.kind === "http") rows = await queryHttp(source, opts.fetchImpl || fetch);
  else if (source.kind === "sqlite") rows = querySqlite(source, opts.query, opts.params);
  else if (source.kind === "connector") rows = await queryConnector(db, source, opts.input || {});
  else throw new Error(`unknown data source kind: ${source.kind}`);
  return { columns: columnsOf(rows), rows, source: source.name };
}

export interface DataSourceLike { name: string; kind: string; config: Record<string, any>; }
