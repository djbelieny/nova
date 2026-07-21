/**
 * Weekly ROI digest — DMs each active user a summary of value delivered (tasks automated,
 * hours saved, $ influenced vs. cost). Best-effort; disable with NOVA_ROI_DIGEST=false.
 */

import { getDb, type Database } from "../src/db.ts";
import { rollupRoi, formatRoiDigest } from "../src/roi.ts";

export type RoiSendFn = (userId: string, message: string) => Promise<void>;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function startRoiDigest(db: Database, send: RoiSendFn): void {
  if (process.env.NOVA_ROI_DIGEST === "false") return;
  const intervalMs = Math.max(3600_000, Number(process.env.NOVA_ROI_DIGEST_MS) || WEEK_MS);

  async function tick(): Promise<void> {
    try {
      const users = db.getUsersByRole("admin").concat(db.getUsersByRole("member"));
      for (const u of users) {
        const r = rollupRoi(db, u.id, 7);
        // Only send when there's something to report.
        if (r.tasksAutomated === 0 && r.valueUsd === 0 && r.hoursSaved === 0) continue;
        await send(u.id, formatRoiDigest(r)).catch(() => {});
      }
    } catch (err) {
      console.warn("[roi-digest] tick error:", (err as Error).message);
    }
  }

  setInterval(() => { tick().catch(() => {}); }, intervalMs);
  console.log(`[roi-digest] started (every ${Math.round(intervalMs / 3600000)}h)`);
}
