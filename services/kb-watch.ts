/**
 * Knowledge folder watcher — auto-ingests files dropped into ~/.nova/knowledge/.
 *
 *   ~/.nova/knowledge/              → personal (admin user)
 *   ~/.nova/knowledge/team/         → team scope
 *   ~/.nova/knowledge/agents/<slug>/→ that agent's pack
 *
 * Drop a PDF/DOCX/MD/TXT into a folder and it's chunked + embedded automatically.
 * Deleting the file removes its doc from the knowledge base.
 */

import { watch, existsSync, mkdirSync } from "fs";
import { basename, join, relative, sep } from "path";
import { homedir } from "os";
import { getDb } from "../src/db.ts";
import { ingestDocument } from "../src/knowledge.ts";
import { sourceTypeFromName } from "../src/text-chunk.ts";
import type { KbScope } from "../src/db.ts";

const KB_ROOT = join(homedir(), ".nova", "knowledge");
const SUPPORTED = new Set([".pdf", ".docx", ".md", ".markdown", ".txt"]);
const debounce = new Map<string, ReturnType<typeof setTimeout>>();

/** Map a file's path (relative to KB_ROOT) to its scope + agent slug. */
export function scopeForPath(relPath: string): { scope: KbScope; agentSlug?: string } {
  const parts = relPath.split(sep);
  if (parts[0] === "team") return { scope: "team" };
  if (parts[0] === "agents" && parts[1]) return { scope: "agent", agentSlug: parts[1] };
  return { scope: "personal" };
}

function isSupported(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot >= 0 && SUPPORTED.has(name.slice(dot).toLowerCase());
}

async function ingestPath(absPath: string): Promise<void> {
  if (!isSupported(absPath)) return;
  const db = getDb();
  const admin = db.getUsersByRole("admin")[0];
  const rel = relative(KB_ROOT, absPath);
  const { scope, agentSlug } = scopeForPath(rel);
  const userId = scope === "personal" ? admin?.id : (admin?.id || "watcher");
  if (!userId) { console.warn("[kb-watch] no admin user yet; skipping", rel); return; }

  if (!existsSync(absPath)) {
    // File deleted — remove any doc pointing at it.
    const docs = db.listKbDocsVisible(admin?.id || "watcher", agentSlug).filter(d => d.source === absPath);
    for (const d of docs) db.deleteKbDoc(d.scope, d.userId, d.id);
    if (docs.length) console.log(`[kb-watch] removed ${docs.length} doc(s) for deleted ${rel}`);
    return;
  }

  try {
    const file = Bun.file(absPath);
    const sourceType = sourceTypeFromName(absPath);
    const buf = Buffer.from(await file.arrayBuffer());
    const text = (sourceType === "md" || sourceType === "txt") ? buf.toString("utf8") : undefined;
    const bytes = text == null ? buf : undefined;
    const r = await ingestDocument({ db, userId, scope, agentSlug, title: basename(absPath), source: absPath, sourceType, bytes, text });
    if (r.status === "ready") console.log(`[kb-watch] ingested ${rel} → ${scope}${agentSlug ? `/${agentSlug}` : ""} (${r.chunkCount} chunks)`);
    else console.warn(`[kb-watch] failed ${rel}: ${r.error}`);
  } catch (err) {
    console.warn(`[kb-watch] error on ${rel}:`, err);
  }
}

/** Start watching the knowledge folder. No-op-safe: creates the folder if missing. */
export function startKbWatcher(): void {
  if (process.env.NOVA_KB_WATCH === "false") return;
  try {
    if (!existsSync(KB_ROOT)) mkdirSync(KB_ROOT, { recursive: true });
    mkdirSync(join(KB_ROOT, "team"), { recursive: true });
    mkdirSync(join(KB_ROOT, "agents"), { recursive: true });
  } catch {}

  try {
    watch(KB_ROOT, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const abs = join(KB_ROOT, filename);
      const prev = debounce.get(abs);
      if (prev) clearTimeout(prev);
      debounce.set(abs, setTimeout(() => { debounce.delete(abs); ingestPath(abs).catch(() => {}); }, 600));
    });
    console.log(`[kb-watch] watching ${KB_ROOT} (drop files to add to the knowledge base)`);
  } catch (err) {
    console.warn("[kb-watch] could not start watcher:", err);
  }
}
