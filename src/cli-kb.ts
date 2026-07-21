/**
 * Nova — Knowledge CLI (`nova kb …`)
 *
 * Feed and manage Nova's knowledge base (the second brain) from the terminal:
 *
 *   nova kb list [--scope personal|team|agent] [--agent <slug>]
 *   nova kb add <file|url> [--scope personal|team|agent] [--agent <slug>]
 *   nova kb remove <id> [--scope <s>]
 *   nova kb search <query...> [--agent <slug>]
 *   nova kb reindex <id|--all> [--scope <s>]
 *
 * Personal docs attach to the admin user; team/agent are shared across the team.
 */

import { basename } from "path";
import { getDb, type DatabaseType, type KbScope } from "./db.ts";
import { ingestDocument, searchKnowledge } from "./knowledge.ts";
import { sourceTypeFromName } from "./text-chunk.ts";

export interface KbFlags {
  positional: string[];
  scope: KbScope;
  agent?: string;
  all: boolean;
}

/** Pure arg parser (unit-tested). Defaults scope to 'personal'. */
export function parseKbArgs(rest: string[]): KbFlags {
  const positional: string[] = [];
  let scope: KbScope = "personal";
  let agent: string | undefined;
  let all = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--scope") { const v = rest[++i]; if (v === "personal" || v === "team" || v === "agent") scope = v; }
    else if (a === "--agent") { agent = rest[++i]; scope = "agent"; }
    else if (a === "--all") all = true;
    else positional.push(a);
  }
  return { positional, scope, agent, all };
}

function resolveUserId(db: DatabaseType, scope: KbScope): string {
  const admin = db.getUsersByRole("admin")[0];
  if (scope === "personal") {
    if (!admin) throw new Error("No user found — run `nova init` first (personal docs attach to your account).");
    return admin.id;
  }
  // team/agent are stored in shared.db; the uploader id is only a tag. Fall back to the
  // admin id when present, else a synthetic non-UUID tag (never used to open a per-user db).
  return admin?.id || "cli";
}

/** The admin user's id, or undefined on a fresh install (personal scope simply absent). */
function optionalUserId(db: DatabaseType): string | undefined {
  return db.getUsersByRole("admin")[0]?.id;
}

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

async function runAdd(rest: string[]): Promise<number> {
  const flags = parseKbArgs(rest);
  const target = flags.positional[0];
  if (!target) { console.error("  Usage: nova kb add <file|url> [--scope personal|team|agent] [--agent <slug>]"); return 1; }
  if (flags.scope === "agent" && !flags.agent) { console.error("  --agent <slug> is required for agent scope"); return 1; }

  const db = getDb();
  const userId = resolveUserId(db, flags.scope);

  let title: string;
  let source: string;
  let sourceType: string;
  let bytes: Buffer | undefined;
  let text: string | undefined;

  if (isUrl(target)) {
    title = target;
    source = target;
    sourceType = "url";
  } else {
    const file = Bun.file(target);
    if (!(await file.exists())) { console.error(`  File not found: ${target}`); return 1; }
    title = basename(target);
    source = target;
    sourceType = sourceTypeFromName(target);
    const buf = Buffer.from(await file.arrayBuffer());
    if (sourceType === "md" || sourceType === "txt") text = buf.toString("utf8");
    else bytes = buf;
  }

  console.log(`  Ingesting "${title}" → ${flags.scope}${flags.agent ? `/${flags.agent}` : ""} …`);
  const r = await ingestDocument({ db, userId, scope: flags.scope, agentSlug: flags.agent, title, source, sourceType, bytes, text });
  if (r.status === "ready") { console.log(`  ✓ Added "${r.title}" (${r.chunkCount} chunks) — id ${r.docId}`); return 0; }
  console.error(`  ✗ Failed: ${r.error || "unknown error"}`);
  return 1;
}

function runList(rest: string[]): number {
  const flags = parseKbArgs(rest);
  const db = getDb();
  let docs = db.listKbDocsVisible(optionalUserId(db), flags.agent);
  if (flags.positional.length === 0 && rest.includes("--scope")) docs = docs.filter(d => d.scope === flags.scope);
  if (!docs.length) { console.log("  No knowledge documents yet. Add one: nova kb add <file|url>"); return 0; }
  for (const d of docs) {
    const tag = d.scope === "agent" ? `agent/${d.agentSlug}` : d.scope;
    const status = d.status === "ready" ? `${d.chunkCount} chunks` : d.status;
    console.log(`  [${tag}] ${d.title}  (${status})  id=${d.id}`);
  }
  return 0;
}

function runRemove(rest: string[]): number {
  const flags = parseKbArgs(rest);
  const id = flags.positional[0];
  if (!id) { console.error("  Usage: nova kb remove <id> [--scope <s>]"); return 1; }
  const db = getDb();
  const userId = resolveUserId(db, flags.scope);
  const doc = db.getKbDoc(flags.scope, userId, id);
  if (!doc) { console.error(`  No doc ${id} in scope ${flags.scope} (pass --scope if it's team/agent)`); return 1; }
  db.deleteKbDoc(flags.scope, userId, id);
  console.log(`  ✓ Removed "${doc.title}"`);
  return 0;
}

async function runSearch(rest: string[]): Promise<number> {
  const flags = parseKbArgs(rest);
  const query = flags.positional.join(" ");
  if (!query) { console.error("  Usage: nova kb search <query> [--agent <slug>]"); return 1; }
  const db = getDb();
  const hits = await searchKnowledge(db, query, { userId: optionalUserId(db), agentSlug: flags.agent, limit: 5 });
  if (!hits.length) { console.log("  No matches."); return 0; }
  hits.forEach((h, i) => {
    console.log(`  ${i + 1}. [${h.title}] (${(h.similarity * 100).toFixed(0)}%) ${h.text.replace(/\s+/g, " ").slice(0, 160)}…`);
  });
  return 0;
}

async function runReindex(rest: string[]): Promise<number> {
  const flags = parseKbArgs(rest);
  const db = getDb();
  const userId = resolveUserId(db, flags.scope);
  const targets = flags.all
    ? db.listKbDocsVisible(userId, flags.agent).filter(d => d.sourceType !== "url" ? true : true)
    : (() => { const d = db.getKbDoc(flags.scope, userId, flags.positional[0]); return d ? [d] : []; })();
  if (!targets.length) { console.error("  Nothing to reindex (pass an id or --all)."); return 1; }
  let ok = 0;
  for (const d of targets) {
    if (d.source.startsWith("telegram:")) { console.log(`  ↷ skip "${d.title}" (uploaded via Telegram — re-drop to refresh)`); continue; }
    const exists = isUrl(d.source) || (await Bun.file(d.source).exists());
    if (!exists) { console.log(`  ↷ skip "${d.title}" (source missing: ${d.source})`); continue; }
    let bytes: Buffer | undefined; let text: string | undefined;
    if (!isUrl(d.source)) {
      const buf = Buffer.from(await Bun.file(d.source).arrayBuffer());
      if (d.sourceType === "md" || d.sourceType === "txt") text = buf.toString("utf8"); else bytes = buf;
    }
    const r = await ingestDocument({ db, userId: d.userId, scope: d.scope, agentSlug: d.agentSlug, title: d.title, source: d.source, sourceType: d.sourceType, bytes, text });
    if (r.status === "ready") { ok++; console.log(`  ✓ reindexed "${d.title}" (${r.chunkCount} chunks)`); }
    else console.log(`  ✗ "${d.title}": ${r.error}`);
  }
  console.log(`  Done — ${ok} reindexed.`);
  return 0;
}

export async function runKb(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "add": return runAdd(rest);
    case "list": case undefined: return runList(rest);
    case "remove": case "rm": return runRemove(rest);
    case "search": return runSearch(rest);
    case "reindex": return runReindex(rest);
    default:
      console.error(`  Unknown subcommand: ${sub}\n  Usage: nova kb list|add <file|url>|remove <id>|search <query>|reindex <id|--all>`);
      return 1;
  }
}

if (import.meta.main) {
  runKb(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => { console.error(`\n  Error: ${err?.message || err}`); process.exit(1); });
}
