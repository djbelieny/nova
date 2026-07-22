/**
 * Business-outcome observability — the ROI ledger.
 *
 * Agents can quantify the value of what they did with a [VALUE: …] intent tag; Nova parses it,
 * records a roi_event, and strips it (like other intent tags). rollupRoi combines those with the
 * action_ledger (tasks automated, cost) into a value view: hours saved, $ influenced vs. cost.
 */

import { departmentForAgent } from './policy';
import type { Database } from './db';

export interface ValueTag { valueUsd: number; minutesSaved: number; department: string | null; note: string | null; }

/**
 * Parse a [VALUE: $500 | SAVED: 30min | DEPT: marketing | NOTE: closed a deal] tag.
 * All fields optional; returns null if the tag has no usable value/time.
 */
export function parseValueTag(text: string): ValueTag | null {
  const m = text.match(/\[VALUE:\s*([^\]]*)\]/i);
  if (!m) return null;
  const body = m[1];
  const usd = body.match(/\$?\s*([\d,]+(?:\.\d+)?)\s*(?:usd)?/i);
  const saved = body.match(/SAVED:\s*([\d.]+)\s*(?:min|minutes|hr|hrs|hours|h)?/i);
  const savedUnit = body.match(/SAVED:\s*[\d.]+\s*(hr|hrs|hours|h)\b/i);
  const dept = body.match(/DEPT:\s*([\w-]+)/i);
  const note = body.match(/NOTE:\s*([^|]+)/i);

  let valueUsd = 0;
  // Only treat a bare number as $ if it's the VALUE portion (before SAVED/DEPT/NOTE) or has a $.
  const valuePart = body.split(/SAVED:|DEPT:|NOTE:/i)[0];
  const vm = valuePart.match(/\$?\s*([\d,]+(?:\.\d+)?)/);
  if (vm) valueUsd = Number(vm[1].replace(/,/g, ''));
  else if (usd && body.includes('$')) valueUsd = Number(usd[1].replace(/,/g, ''));

  let minutesSaved = 0;
  if (saved) { const n = Number(saved[1]); minutesSaved = savedUnit ? n * 60 : n; }

  if (!valueUsd && !minutesSaved) return null;
  return { valueUsd, minutesSaved, department: dept ? dept[1].toLowerCase() : null, note: note ? note[1].trim() : null };
}

/** Remove all [VALUE: …] tags from text (before it reaches the user). */
export function stripValueTags(text: string): string {
  return text.replace(/\[VALUE:\s*[^\]]*\]/gi, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Parse a [VALUE:] tag from an agent response and record it. Returns the cleaned text. */
export function recordValueFromText(db: Database, userId: string, text: string, agent?: string): string {
  const tag = parseValueTag(text);
  if (tag) {
    db.insertRoiEvent(userId, {
      agent: agent ?? null,
      department: tag.department ?? (agent ? departmentForAgent(agent) : null),
      valueUsd: tag.valueUsd,
      minutesSaved: tag.minutesSaved,
      note: tag.note,
    });
  }
  return stripValueTags(text);
}

export interface RoiRollup {
  periodDays: number;
  tasksAutomated: number;
  hoursSaved: number;
  valueUsd: number;
  costUsd: number;
  netUsd: number;
  byDepartment: Record<string, { valueUsd: number; hoursSaved: number }>;
  byAgent: Record<string, { valueUsd: number; hoursSaved: number }>;
}

/** Roll up ROI over the last `days`. */
export function rollupRoi(db: Database, userId: string, days = 7): RoiRollup {
  const roi = db.getRoiSince(userId, days);
  const stats = db.getExecuteStatsSince(userId, days);
  const toHours = (m: Record<string, { valueUsd: number; minutesSaved: number }>) => {
    const out: Record<string, { valueUsd: number; hoursSaved: number }> = {};
    for (const [k, v] of Object.entries(m)) out[k] = { valueUsd: v.valueUsd, hoursSaved: +(v.minutesSaved / 60).toFixed(1) };
    return out;
  };
  return {
    periodDays: days,
    tasksAutomated: stats.tasksAutomated,
    hoursSaved: +(roi.minutesSaved / 60).toFixed(1),
    valueUsd: +roi.valueUsd.toFixed(2),
    costUsd: +stats.costUsd.toFixed(2),
    netUsd: +(roi.valueUsd - stats.costUsd).toFixed(2),
    byDepartment: toHours(roi.byDepartment),
    byAgent: toHours(roi.byAgent),
  };
}

export interface ValueRank { agent: string; valueUsd: number; hoursSaved: number; }
export interface DepartmentRank { department: string; valueUsd: number; hoursSaved: number; }

/** Agents ranked by $ value influenced over the last `days` (desc). */
export function rankAgentsByValue(db: Database, userId: string, days = 7): ValueRank[] {
  const { byAgent } = rollupRoi(db, userId, days);
  return Object.entries(byAgent)
    .map(([agent, v]) => ({ agent, valueUsd: v.valueUsd, hoursSaved: v.hoursSaved }))
    .sort((a, b) => b.valueUsd - a.valueUsd);
}

/** Departments ranked by $ value influenced over the last `days` (desc). */
export function rankDepartmentsByValue(db: Database, userId: string, days = 7): DepartmentRank[] {
  const { byDepartment } = rollupRoi(db, userId, days);
  return Object.entries(byDepartment)
    .map(([department, v]) => ({ department, valueUsd: v.valueUsd, hoursSaved: v.hoursSaved }))
    .sort((a, b) => b.valueUsd - a.valueUsd);
}

/** A short human-readable ROI digest (Telegram / CLI). */
export function formatRoiDigest(r: RoiRollup): string {
  const lines = [
    `📈 *ROI — last ${r.periodDays} days*`,
    ``,
    `• Tasks automated: *${r.tasksAutomated}*`,
    `• Hours saved: *${r.hoursSaved}h*`,
    `• Value influenced: *$${r.valueUsd.toLocaleString()}*`,
    `• AI cost: *$${r.costUsd.toLocaleString()}*  →  net *$${r.netUsd.toLocaleString()}*`,
  ];
  const depts = Object.entries(r.byDepartment).filter(([, v]) => v.valueUsd || v.hoursSaved);
  if (depts.length) {
    lines.push(``, `By department:`);
    for (const [d, v] of depts.sort((a, b) => b[1].valueUsd - a[1].valueUsd)) lines.push(`  · ${d}: $${v.valueUsd.toLocaleString()} / ${v.hoursSaved}h`);
  }
  return lines.join('\n');
}
