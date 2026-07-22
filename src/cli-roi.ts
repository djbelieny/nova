/**
 * Nova — ROI CLI (`nova roi [--period <days>]`)
 * Shows tasks automated, hours saved, and $ influenced vs. AI cost over a window.
 */

import { getDb, type DatabaseType } from "./db.ts";
import { rollupRoi, formatRoiDigest, rankAgentsByValue, rankDepartmentsByValue } from "./roi.ts";

function adminId(db: DatabaseType): string {
  const admin = db.getUsersByRole("admin")[0];
  if (!admin) throw new Error("No user found — run `nova init` first.");
  return admin.id;
}

export function runRoiCli(argv: string[]): number {
  const i = argv.indexOf("--period");
  const days = i >= 0 ? Number(argv[i + 1]) || 7 : 7;
  const db = getDb();
  const userId = adminId(db);

  if (argv.includes("--by-agent")) {
    const rows = rankAgentsByValue(db, userId, days);
    console.log(`Agents by value — last ${days} days`);
    if (!rows.length) console.log("  (no ROI events)");
    for (const r of rows) console.log(`  · ${r.agent}: $${r.valueUsd.toLocaleString()} / ${r.hoursSaved}h`);
    return 0;
  }

  if (argv.includes("--by-department")) {
    const rows = rankDepartmentsByValue(db, userId, days);
    console.log(`Departments by value — last ${days} days`);
    if (!rows.length) console.log("  (no ROI events)");
    for (const r of rows) console.log(`  · ${r.department}: $${r.valueUsd.toLocaleString()} / ${r.hoursSaved}h`);
    return 0;
  }

  const r = rollupRoi(db, userId, days);
  // Plain-text (strip Markdown asterisks) for the terminal.
  console.log(formatRoiDigest(r).replace(/\*/g, ""));
  return 0;
}

if (import.meta.main) {
  try { process.exit(runRoiCli(process.argv.slice(2))); }
  catch (err: any) { console.error(`\n  Error: ${err?.message || err}`); process.exit(1); }
}
