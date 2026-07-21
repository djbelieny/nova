/**
 * Nova — ROI CLI (`nova roi [--period <days>]`)
 * Shows tasks automated, hours saved, and $ influenced vs. AI cost over a window.
 */

import { getDb, type DatabaseType } from "./db.ts";
import { rollupRoi, formatRoiDigest } from "./roi.ts";

function adminId(db: DatabaseType): string {
  const admin = db.getUsersByRole("admin")[0];
  if (!admin) throw new Error("No user found — run `nova init` first.");
  return admin.id;
}

export function runRoiCli(argv: string[]): number {
  const i = argv.indexOf("--period");
  const days = i >= 0 ? Number(argv[i + 1]) || 7 : 7;
  const db = getDb();
  const r = rollupRoi(db, adminId(db), days);
  // Plain-text (strip Markdown asterisks) for the terminal.
  console.log(formatRoiDigest(r).replace(/\*/g, ""));
  return 0;
}

if (import.meta.main) {
  try { process.exit(runRoiCli(process.argv.slice(2))); }
  catch (err: any) { console.error(`\n  Error: ${err?.message || err}`); process.exit(1); }
}
