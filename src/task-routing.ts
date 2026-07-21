/**
 * Human task routing — assign agent tasks to teammates, track ownership, and escalate on
 * an SLA breach. Assignment fields live on agent_tasks (per-user db); escalation is a sweep
 * driven by the periodic dispatcher.
 */

import type { Database } from './db';

/** Resolve a teammate reference (@username, username, or display name) to a user id. */
export function resolveAssignee(db: Database, ref: string): { userId: string; name: string } | null {
  const clean = ref.replace(/^@/, '').trim();
  if (!clean) return null;
  const byUsername = (db as any).getUserByUsername?.(clean);
  if (byUsername) return { userId: byUsername.id, name: byUsername.name || clean };
  // Fall back to a case-insensitive name match across users.
  const all = (db as any).getAllUsers?.() as any[] | undefined;
  if (all) {
    const hit = all.find((u) => (u.name || '').toLowerCase() === clean.toLowerCase() || (u.username || '').toLowerCase() === clean.toLowerCase());
    if (hit) return { userId: hit.id, name: hit.name || clean };
  }
  return null;
}

export interface AssignResult { ok: boolean; error?: string; assignee?: { userId: string; name: string } }

/** Assign a task to a teammate with an optional due time / SLA. */
export function assignTaskTo(
  db: Database,
  ownerUserId: string,
  taskId: string,
  ref: string,
  opts?: { dueAt?: string | null; slaMinutes?: number | null }
): AssignResult {
  const assignee = resolveAssignee(db, ref);
  if (!assignee) return { ok: false, error: `no teammate matching "${ref}"` };
  db.assignTask(ownerUserId, taskId, assignee.userId, opts);
  return { ok: true, assignee };
}

export type EscalateNotify = (recipientUserId: string, message: string) => Promise<void>;

/**
 * Sweep overdue assigned tasks: notify the assignee and the owner, mark escalated so each
 * fires once. Returns how many escalations fired. Best-effort; never throws.
 */
export async function sweepOverdueTasks(db: Database, notify: EscalateNotify): Promise<number> {
  let n = 0;
  const overdue = db.getOverdueAssignedTasks();
  for (const { ownerUserId, task } of overdue) {
    const msg = `⏰ Task overdue: "${task.description?.slice(0, 80) || task.id}" (assigned${task.due_at ? `, due ${task.due_at}` : ''}).`;
    try {
      if (task.assignee_user_id) await notify(task.assignee_user_id, msg).catch(() => {});
      if (ownerUserId !== task.assignee_user_id) await notify(ownerUserId, `${msg} (you assigned it)`).catch(() => {});
      db.markTaskEscalated(ownerUserId, task.id);
      n++;
    } catch { /* best-effort */ }
  }
  return n;
}
