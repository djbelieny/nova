/**
 * Policy / compliance layer — restrictive-only.
 *
 * Evaluated at the approval gate AFTER the autonomy ladder decides. Policies can only add
 * friction (force human approval, block, or warn); they never grant more autonomy.
 * `enforceBlockPolicies` always hard-blocks content containing a detected secret, independent
 * of any configured policies (gated by NOVA_LEAK_BLOCK_EXECUTE) — it is not a no-op even with
 * no policies defined.
 *
 * Kinds:
 *   spend_cap      { period:'day'|'month', capUsd, department? }
 *   approval_matrix{ actionType?, department?, approvers:[userId], minApproverRole?, escalateAfterMin? }
 *   content_check  { checks:['pii'|'profanity'|'brand'|'claims'], onFail:'block'|'warn' }
 */

import type { Database, Policy } from './db';
import { scanForLeaks } from './leak-scan.ts';

/** Coarse agent → department map for department-scoped policies (optional matching). */
export const AGENT_DEPARTMENT: Record<string, string> = {
  helios: 'marketing', pixel: 'marketing', kai: 'marketing', orion: 'marketing', magnus: 'marketing',
  morpheus: 'marketing', flux: 'marketing', aura: 'marketing', nexus: 'marketing', helia: 'marketing',
  athena: 'strategy', oracle: 'strategy', tesseract: 'strategy', bridge: 'strategy', zen: 'ops',
  digit: 'data', cipher: 'data', architect: 'engineering', joule: 'engineering', rift: 'engineering',
  echo: 'support', quill: 'ops', lex: 'legal', cyra: 'marketing',
};

export function departmentForAgent(agent: string): string | null {
  return AGENT_DEPARTMENT[(agent || '').toLowerCase()] ?? null;
}

export type PolicyDecision = 'allow' | 'require-approval' | 'block';
export interface PolicyResult {
  decision: PolicyDecision;
  reasons: string[];
  approvers: string[];
  escalateAfterMin: number | null;
}

const PII_PATTERNS: Array<[string, RegExp]> = [
  ['SSN', /\b\d{3}-\d{2}-\d{4}\b/],
  ['credit card', /\b(?:\d[ -]?){13,16}\b/],
  ['email', /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/],
];
const PROFANITY = /\b(fuck|shit|bitch|asshole|bastard)\b/i;

/** Run content checks; returns the failed check names. */
export function runContentChecks(content: string, checks: string[]): string[] {
  const failed: string[] = [];
  const text = content || '';
  for (const check of checks) {
    if (check === 'pii') { for (const [label, re] of PII_PATTERNS) if (re.test(text)) { failed.push(`pii:${label}`); break; } }
    else if (check === 'profanity') { if (PROFANITY.test(text)) failed.push('profanity'); }
    // 'brand' / 'claims' are LLM-backed and evaluated by the caller when a checker is provided.
  }
  return failed;
}

/** Does a policy apply to this (department, actionType) context? */
function policyApplies(p: Policy, ctx: { department: string | null; actionType: string }): boolean {
  if (p.scope === 'department' && p.scopeRef && p.scopeRef !== ctx.department) return false;
  const cfgDept = p.config?.department;
  if (cfgDept && cfgDept !== ctx.department) return false;
  const cfgAction = p.config?.actionType;
  if (cfgAction && cfgAction !== ctx.actionType) return false;
  return true;
}

export interface PolicyContext {
  userId: string;
  agent: string;
  actionType: string;
  department?: string | null;
  estimateUsd?: number;
  content?: string;
}

/**
 * Evaluate all of a user's enabled policies against an action. Returns the most restrictive
 * outcome. `require-approval` forces the gate to ask; `block` also forces ask (surfacing the
 * reason) — the human can still cancel. Empty policy set → { decision: 'allow' }.
 */
export function evaluatePolicies(db: Database, ctx: PolicyContext): PolicyResult {
  const department = ctx.department ?? departmentForAgent(ctx.agent);
  const policies = db.listPolicies(ctx.userId, true);
  const reasons: string[] = [];
  const approvers: string[] = [];
  let escalateAfterMin: number | null = null;
  let decision: PolicyDecision = 'allow';
  const escalate = (d: PolicyDecision) => { if (d === 'block') decision = 'block'; else if (d === 'require-approval' && decision === 'allow') decision = 'require-approval'; };

  for (const p of policies) {
    if (!policyApplies(p, { department, actionType: ctx.actionType })) continue;

    if (p.kind === 'spend_cap') {
      const cap = Number(p.config.capUsd);
      const period = p.config.period === 'month' ? 'month' : 'day';
      const spent = period === 'month' ? db.getMonthlySpendTotal(ctx.userId) : db.getDailySpendTotal(ctx.userId);
      if (cap > 0 && spent + (ctx.estimateUsd || 0) > cap) {
        reasons.push(`${period} spend cap $${cap} reached ($${spent.toFixed(2)} spent)`);
        escalate('require-approval');
      }
    } else if (p.kind === 'approval_matrix') {
      reasons.push(`approval required by policy${p.config.minApproverRole ? ` (${p.config.minApproverRole})` : ''}`);
      for (const a of (p.config.approvers as string[]) || []) if (!approvers.includes(a)) approvers.push(a);
      if (p.config.escalateAfterMin) escalateAfterMin = Number(p.config.escalateAfterMin);
      escalate('require-approval');
    } else if (p.kind === 'content_check' && ctx.content) {
      const failed = runContentChecks(ctx.content, (p.config.checks as string[]) || []);
      if (failed.length) {
        reasons.push(`content check failed: ${failed.join(', ')}`);
        escalate(p.config.onFail === 'block' ? 'block' : 'require-approval');
      }
    }
  }

  return { decision, reasons, approvers, escalateAfterMin };
}

/** Whether a policy result should force the approval gate (i.e. downgrade auto/notify → ask). */
export function policyForcesApproval(result: PolicyResult): boolean {
  return result.decision !== 'allow';
}

/**
 * Hard-block enforcement, run at the EXECUTE boundary against the prepared content — even
 * after a human approval, a `content_check` policy with `onFail: 'block'` prevents execution
 * (true compliance block, not just added friction). Returns which checks failed.
 */
export function enforceBlockPolicies(
  db: Database,
  userId: string,
  content: string,
  opts: { agents?: string[] } = {}
): { blocked: boolean; reasons: string[] } {
  const departments = new Set((opts.agents || []).map(departmentForAgent).filter(Boolean) as string[]);
  const reasons: string[] = [];
  if (process.env.NOVA_LEAK_BLOCK_EXECUTE !== 'off' && content) {
    const secrets = scanForLeaks(content).filter((f) => f.severity === 'secret');
    if (secrets.length) reasons.push(`secret detected (${[...new Set(secrets.map((s) => s.type))].join(', ')})`);
  }
  for (const p of db.listPolicies(userId, true)) {
    if (p.kind !== 'content_check' || p.config?.onFail !== 'block') continue;
    // Department-scoped block applies only when one of the acting agents is in that department.
    const dept = p.config?.department || (p.scope === 'department' ? p.scopeRef : null);
    if (dept && departments.size && !departments.has(dept)) continue;
    const failed = runContentChecks(content || '', (p.config.checks as string[]) || []);
    if (failed.length) reasons.push(failed.join(', '));
  }
  return { blocked: reasons.length > 0, reasons: [...new Set(reasons)] };
}
