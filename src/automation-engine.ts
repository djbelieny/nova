/**
 * Automation engine — event → condition → workflow.
 *
 * Pure evaluation (conditions, templating) + a dispatcher that reuses the EXISTING
 * webhook dispatch contract `(userId, agentSlug, taskDescription) => Promise<string|null>`.
 * An automation's action is either an agent task (templated) or a playbook (its steps
 * composed into one instruction). Every dispatched action still flows through the normal
 * task path and the approval gate.
 */

import { looksLikeInjection } from './learning-loop';
import { renderPlaybook } from './playbooks';
import { generateEmbedding } from './embeddings';
import type { Automation, Database, Playbook } from './db';

/** Injectable embedder: text → 384-dim vector (or null on failure). */
export type EmbedFn = (text: string) => Promise<number[] | null>;

/** Dot product of two L2-normalized vectors = cosine similarity. Length-mismatch → 0. */
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export type DispatchAgentFn = (userId: string, agentSlug: string, taskDescription: string, metadata?: Record<string, any>) => Promise<string | null>;

/** Access a nested value by dot path: getByPath({a:{b:1}}, "a.b") === 1. */
export function getByPath(obj: any, path: string): any {
  return path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), obj);
}

/** Handlebars-style {{a.b}} substitution from a nested object. Missing → left as-is. */
export function renderTemplate(template: string, data: Record<string, any>): string {
  return (template || '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, path) => {
    const v = getByPath(data, path);
    return v === undefined || v === null ? m : String(v);
  });
}

export interface Condition { field: string; op: string; value?: any; threshold?: number; }

/** Evaluate a single condition against the event. */
function evalOne(event: any, c: Condition): boolean {
  const actual = getByPath(event, c.field);
  switch (c.op) {
    case 'exists': return actual !== undefined && actual !== null;
    case 'not_exists': return actual === undefined || actual === null;
    case 'eq': return String(actual) === String(c.value);
    case 'neq': return String(actual) !== String(c.value);
    case 'gt': return Number(actual) > Number(c.value);
    case 'gte': return Number(actual) >= Number(c.value);
    case 'lt': return Number(actual) < Number(c.value);
    case 'lte': return Number(actual) <= Number(c.value);
    case 'contains': return String(actual ?? '').toLowerCase().includes(String(c.value ?? '').toLowerCase());
    case 'not_contains': return !String(actual ?? '').toLowerCase().includes(String(c.value ?? '').toLowerCase());
    default: return false;
  }
}

/** All conditions must pass (AND). Empty conditions → always true. `semantic` ops
 * always fail here — sync callers (buildDispatch/simulate) don't fire on semantic. */
export function evaluateConditions(event: any, conditions: Condition[]): boolean {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every((c) => evalOne(event, c));
}

/** Evaluate one `semantic` condition: embed field text + reference, pass if cosine ≥ threshold. */
async function evalSemantic(event: any, c: Condition, embed: EmbedFn): Promise<boolean> {
  const actual = getByPath(event, c.field);
  const text = actual == null ? '' : String(actual);
  const reference = c.value == null ? '' : String(c.value);
  const threshold = typeof c.threshold === 'number' ? c.threshold : 0.5;
  const [aVec, bVec] = await Promise.all([embed(text), embed(reference)]);
  if (!aVec || !bVec) return false; // fail safe
  return cosine(aVec, bVec) >= threshold;
}

/**
 * Async form of evaluateConditions. Identical to the sync version for all existing ops,
 * PLUS a `semantic` op backed by embeddings (cosine similarity ≥ threshold, default 0.5).
 * All conditions must pass (AND). `embed` is injectable for tests; defaults to generateEmbedding.
 */
export async function evaluateConditionsAsync(
  event: any,
  conditions: Condition[],
  embed: EmbedFn = generateEmbedding
): Promise<boolean> {
  if (!conditions || conditions.length === 0) return true;
  for (const c of conditions) {
    const ok = c.op === 'semantic' ? await evalSemantic(event, c, embed) : evalOne(event, c);
    if (!ok) return false;
  }
  return true;
}

/** Compose a rendered playbook's steps into a single instruction for headless dispatch. */
export function composePlaybookTask(pb: Playbook, plan: { subtasks: { agent?: string; phase?: string; description: string }[] }): string {
  const lines = plan.subtasks.map((s, i) => `${i + 1}. [${s.agent || 'general'}${s.phase ? `/${s.phase}` : ''}] ${s.description}`);
  return `Execute the "${pb.name}" playbook, step by step:\n${lines.join('\n')}`;
}

export interface BuiltDispatch { agentSlug: string; taskDescription: string; }
export interface DispatchDecision { dispatch: BuiltDispatch | null; dedupeKey: string | null; skipReason?: string; }

/**
 * Decide what (if anything) an automation should dispatch for an event. Pure except for
 * the optional playbook lookup passed in. Does NOT check dedupe/rate-limit (that needs
 * time + db state — handled in dispatchAutomation).
 */
export function buildDispatch(
  automation: Automation,
  event: Record<string, any>,
  resolvePlaybook: (name: string) => Playbook | null
): DispatchDecision {
  const dedupeKey = automation.dedupeKey ? renderTemplate(automation.dedupeKey, event) : null;

  if (!evaluateConditions(event, automation.conditions)) {
    return { dispatch: null, dedupeKey, skipReason: 'conditions-not-met' };
  }

  if (automation.actionType === 'agent') {
    const template = (automation.actionConfig?.template as string) || automation.actionRef;
    const taskDescription = renderTemplate(template, event);
    if (looksLikeInjection(taskDescription)) return { dispatch: null, dedupeKey, skipReason: 'injection' };
    return { dispatch: { agentSlug: automation.actionRef, taskDescription }, dedupeKey };
  }

  // playbook
  const pb = resolvePlaybook(automation.actionRef);
  if (!pb) return { dispatch: null, dedupeKey, skipReason: 'playbook-not-found' };
  const varsTemplate = (automation.actionConfig?.vars as Record<string, string>) || {};
  const vars: Record<string, string> = {};
  for (const [k, tmpl] of Object.entries(varsTemplate)) vars[k] = renderTemplate(tmpl, event);
  const { plan, missing, errors } = renderPlaybook(pb, vars);
  if (errors.length) return { dispatch: null, dedupeKey, skipReason: `vars-rejected: ${errors.join(', ')}` };
  if (missing.length || !plan) return { dispatch: null, dedupeKey, skipReason: `missing-vars: ${missing.join(', ')}` };
  const taskDescription = composePlaybookTask(pb, plan);
  if (looksLikeInjection(taskDescription)) return { dispatch: null, dedupeKey, skipReason: 'injection' };
  return { dispatch: { agentSlug: 'general', taskDescription }, dedupeKey };
}

export interface AutomationOutcome { fired: boolean; reason?: string; taskId?: string | null; }

/**
 * Full run for one automation + event: conditions → dedupe → rate-limit → dispatch → record.
 * Reuses the existing agent-dispatch fn; playbook actions are composed into one instruction.
 */
export async function dispatchAutomation(
  db: Database,
  automation: Automation,
  event: Record<string, any>,
  dispatchAgent: DispatchAgentFn
): Promise<AutomationOutcome> {
  if (!(await evaluateConditionsAsync(event, automation.conditions))) { return { fired: false, reason: 'conditions-not-met' }; } // [intel]
  const decision = buildDispatch(automation, event, (name) => db.findPlaybook(automation.userId, name));

  if (!decision.dispatch) {
    // Only record genuine skips that are worth seeing (not every non-matching event).
    if (decision.skipReason && decision.skipReason !== 'conditions-not-met') {
      db.insertAutomationRun({ automationId: automation.id, userId: automation.userId, dedupeKey: decision.dedupeKey, status: 'skipped', result: decision.skipReason });
      db.insertRunEvent(automation.userId, { kind: 'automation', refId: automation.id, refName: automation.name, status: 'skipped', detail: decision.skipReason }); // [trust]
    }
    return { fired: false, reason: decision.skipReason };
  }

  // Dedupe. Durable exactly-once when the automation opts in (idempotent); otherwise the
  // original 60-minute window. [gov]
  if (decision.dedupeKey) {
    if (automation.idempotent) {
      if (!db.claimIdempotencyKey(`auto:${automation.id}:${decision.dedupeKey}`, 'automation', automation.idempotencyTtlSec ?? undefined)) {
        return { fired: false, reason: 'deduped' };
      }
    } else if (db.automationDedupeSeen(automation.id, decision.dedupeKey, 60)) {
      return { fired: false, reason: 'deduped' };
    }
  }
  // Rate limit
  if (automation.rateLimitPerHour && db.countAutomationRunsSince(automation.id, 60) >= automation.rateLimitPerHour) {
    db.insertAutomationRun({ automationId: automation.id, userId: automation.userId, dedupeKey: decision.dedupeKey, status: 'rate-limited' });
    return { fired: false, reason: 'rate-limited' };
  }

  let taskId: string | null = null; // [trust] retry the agent dispatch up to 3 attempts
  let lastErr: any = null; // [trust] remember the last failure for the dead-letter record
  for (let attempt = 1; attempt <= 3; attempt++) { // [trust]
    try { // [trust]
      taskId = await dispatchAgent(automation.userId, decision.dispatch.agentSlug, decision.dispatch.taskDescription, { automation_id: automation.id, source: automation.sourceType }); // [trust]
    } catch (err) { lastErr = err; taskId = null; } // [trust] a throw is a failed attempt
    if (taskId) break; // [trust] success → stop retrying
  } // [trust]
  if (!taskId) { // [trust] every attempt failed (threw or returned null) → dead-letter it
    const errMsg = lastErr ? (lastErr?.message || String(lastErr)) : 'dispatch returned null'; // [trust]
    db.insertDeadLetter(automation.userId, { kind: 'automation', refId: automation.id, refName: automation.name, payload: JSON.stringify(event).slice(0, 4000), error: errMsg }); // [trust]
    db.insertAutomationRun({ automationId: automation.id, userId: automation.userId, dedupeKey: decision.dedupeKey, eventJson: JSON.stringify(event).slice(0, 2000), status: 'failed', result: null }); // [trust]
    db.insertRunEvent(automation.userId, { kind: 'automation', refId: automation.id, refName: automation.name, status: 'failed', detail: errMsg }); // [trust]
    return { fired: false, reason: 'failed' }; // [trust]
  } // [trust]
  db.recordAutomationFire(automation.id);
  db.insertAutomationRun({
    automationId: automation.id, userId: automation.userId, dedupeKey: decision.dedupeKey,
    eventJson: JSON.stringify(event).slice(0, 2000), status: 'dispatched', result: taskId || null,
  });
  db.insertRunEvent(automation.userId, { kind: 'automation', refId: automation.id, refName: automation.name, status: 'fired', detail: `task:${taskId}` }); // [trust]
  return { fired: true, taskId };
}
