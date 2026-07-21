/**
 * Durable process engine — runs a sequence of action/wait steps that can span days,
 * survive restarts (state in SQLite), and resume on a due timer or a named event.
 *
 * Driver-agnostic: the caller injects `runStep` (the task-dispatcher uses the scheduled-task
 * executor; tests use a stub). Every `action` step runs a normal agent task, so the approval
 * gate applies exactly as usual.
 */

import { substituteVars } from './playbooks';
import type { Database, ProcessInstance, ProcessStep } from './db';

export type RunStepFn = (
  userId: string,
  description: string,
  agent: string | undefined,
  context: Record<string, any>
) => Promise<{ success: boolean; result: string }>;

/** Format a Date as a SQLite UTC datetime string 'YYYY-MM-DD HH:MM:SS'. */
function sqliteUtc(d: Date): string {
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

/** Resolve a wait `until` (ISO datetime or relative +30m/+2h/+3d) to a SQLite datetime string. */
export function computeWaitUntil(until: string, now: Date = new Date()): string {
  const rel = String(until).trim().match(/^\+(\d+)\s*([mhd])$/i);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    const ms = unit === 'm' ? n * 60000 : unit === 'h' ? n * 3600000 : n * 86400000;
    return sqliteUtc(new Date(now.getTime() + ms));
  }
  const d = new Date(until);
  return isNaN(d.getTime()) ? sqliteUtc(now) : sqliteUtc(d);
}

/** Context values as strings for {{var}} substitution in step descriptions. */
function stringCtx(ctx: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx)) out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  return out;
}

const MAX_STEPS = 100;

export interface AdvanceResult { state: ProcessInstance['state']; waitingOn?: string; }

/**
 * Advance a process from its current step until it hits a wait, fails, or completes.
 * Persists state at each transition so it is resumable across restarts.
 */
export async function advanceProcess(db: Database, proc: ProcessInstance, runStep: RunStepFn): Promise<AdvanceResult> {
  const ctx: Record<string, any> = { ...proc.context };
  let step = proc.currentStep;
  let guard = 0;

  while (step < proc.steps.length) {
    if (++guard > MAX_STEPS) {
      db.updateProcess(proc.userId, proc.id, { state: 'failed', currentStep: step, context: ctx });
      return { state: 'failed' };
    }
    const s: ProcessStep = proc.steps[step];

    if (s.type === 'wait') {
      if (s.event) {
        db.updateProcess(proc.userId, proc.id, { state: 'waiting', currentStep: step + 1, waitEvent: s.event, waitUntil: null, context: ctx });
        return { state: 'waiting', waitingOn: `event:${s.event}` };
      }
      if (s.until) {
        db.updateProcess(proc.userId, proc.id, { state: 'waiting', currentStep: step + 1, waitUntil: computeWaitUntil(s.until), waitEvent: null, context: ctx });
        return { state: 'waiting', waitingOn: `timer:${s.until}` };
      }
      step++; // malformed wait — skip
      continue;
    }

    // action step
    const desc = substituteVars(s.description || '', stringCtx(ctx));
    const { success, result } = await runStep(proc.userId, desc, s.agent, ctx);
    ctx[`step_${step}`] = result;
    if (!success) {
      db.updateProcess(proc.userId, proc.id, { state: 'failed', currentStep: step, context: ctx });
      return { state: 'failed' };
    }
    step++;
  }

  db.updateProcess(proc.userId, proc.id, { state: 'done', currentStep: step, context: ctx });
  return { state: 'done' };
}

/** Start a new process and run it to the first wait / completion. */
export async function startProcess(
  db: Database,
  def: { userId: string; name: string; steps: ProcessStep[]; context?: Record<string, any>; playbookId?: string | null },
  runStep: RunStepFn
): Promise<{ id: string; result: AdvanceResult }> {
  const proc = db.insertProcess(def);
  const result = await advanceProcess(db, proc, runStep);
  return { id: proc.id, result };
}

/** Resume all processes whose timer is now due (called from the periodic dispatcher). */
export async function resumeDueTimers(db: Database, runStep: RunStepFn): Promise<number> {
  const due = db.getDueTimerProcesses();
  for (const p of due) {
    db.updateProcess(p.userId, p.id, { state: 'running', waitUntil: null });
    await advanceProcess(db, { ...p, state: 'running', waitUntil: null }, runStep).catch(() => {});
  }
  return due.length;
}

/** Resume all processes waiting on a named event (called when that event fires). */
export async function resumeOnEvent(db: Database, eventName: string, runStep: RunStepFn): Promise<number> {
  const waiting = db.getEventWaitingProcesses(eventName);
  for (const p of waiting) {
    db.updateProcess(p.userId, p.id, { state: 'running', waitEvent: null });
    await advanceProcess(db, { ...p, state: 'running', waitEvent: null }, runStep).catch(() => {});
  }
  return waiting.length;
}

/** Cancel a running/waiting process. */
export function cancelProcess(db: Database, userId: string, id: string): boolean {
  const p = db.getProcess(userId, id);
  if (!p || p.state === 'done' || p.state === 'cancelled') return false;
  db.updateProcess(userId, id, { state: 'cancelled' });
  return true;
}
