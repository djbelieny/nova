/**
 * Playbooks — business SOPs as parameterized, versioned workflows.
 *
 * A playbook is authored once (steps + variables) and run many times with different
 * variable values. Rendering substitutes variables into each step and produces an
 * ExecutionPlan that is handed to the EXISTING routeComplex execution path — no new
 * execution engine, and every consequential step still passes the approval gate.
 *
 * Distinct from auto-learned `patterns` (statistical) and Tier-0 `schemas`: playbooks
 * are intentional, editable, shareable.
 */

import { looksLikeInjection } from './learning-loop';
import type { ExecutionPlan } from './patterns';
import type { Playbook, PlaybookStep, PlaybookVar } from './db';

export interface RenderResult {
  plan: ExecutionPlan | null;
  missing: string[];   // required variables with no value/default
  errors: string[];    // e.g. injection-flagged variable values
}

/** Substitute {{name}} tokens in a string from a values map. Unknown tokens are left as-is. */
export function substituteVars(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : m
  );
}

/**
 * Resolve variables against a playbook's declarations: apply defaults, collect missing
 * required ones, and reject values that read as prompt injection.
 */
export function resolveVars(
  variables: PlaybookVar[],
  provided: Record<string, string>
): { values: Record<string, string>; missing: string[]; errors: string[] } {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  const errors: string[] = [];
  for (const v of variables || []) {
    let val = provided[v.name];
    if (val == null || val === '') {
      if (v.default != null) val = v.default;
      else if (v.required) { missing.push(v.name); continue; }
      else val = '';
    }
    if (val && looksLikeInjection(val)) {
      errors.push(`variable "${v.name}" was rejected (looks like an injected instruction)`);
      continue;
    }
    values[v.name] = val;
  }
  // Pass through any extra provided vars not declared (still injection-scanned).
  for (const [k, val] of Object.entries(provided)) {
    if (k in values) continue;
    if (val && looksLikeInjection(val)) { errors.push(`variable "${k}" was rejected (looks like an injected instruction)`); continue; }
    values[k] = val;
  }
  return { values, missing, errors };
}

/** Render a playbook + variable values into an ExecutionPlan for routeComplex. */
export function renderPlaybook(pb: Playbook, provided: Record<string, string> = {}): RenderResult {
  const { values, missing, errors } = resolveVars(pb.variables, provided);
  if (missing.length || errors.length) return { plan: null, missing, errors };

  const subtasks: ExecutionPlan['subtasks'] = (pb.steps || []).map((s: PlaybookStep) => ({
    description: substituteVars(s.description, values),
    agent: s.agent,
    reviewAgent: s.reviewAgent,
    phase: s.phase,
    dependsOn: s.dependsOn,
  }));

  return { plan: { subtasks }, missing: [], errors: [] };
}

/**
 * Parse a playbook run request into a name + variables. Handles:
 *   "/playbook run client-onboarding client=Acme email=a@b.com"
 *   "run the client-onboarding playbook with client=Acme"
 *   "run client-onboarding playbook"
 * Values may be quoted to include spaces: client="Acme Corp".
 */
export function parsePlaybookInvocation(text: string): { name: string | null; vars: Record<string, string> } {
  const vars: Record<string, string> = {};
  // Extract key=value (with optional quotes) pairs anywhere in the text.
  const kvRe = /([\w.-]+)=("([^"]*)"|'([^']*)'|(\S+))/g;
  let m: RegExpExecArray | null;
  let stripped = text;
  while ((m = kvRe.exec(text)) !== null) {
    vars[m[1]] = m[3] ?? m[4] ?? m[5] ?? '';
    stripped = stripped.replace(m[0], ' ');
  }
  // Find the playbook name.
  let name: string | null = null;
  const slash = stripped.match(/\/playbook\s+run\s+([\w-]+)/i);
  const natural = stripped.match(/\brun\s+(?:the\s+)?([\w-]+)\s+playbook\b/i)
    || stripped.match(/\brun\s+playbook\s+([\w-]+)/i);
  if (slash) name = slash[1];
  else if (natural) name = natural[1];
  return { name, vars };
}

/** Human-readable one-liner for listings. */
export function describePlaybook(pb: Playbook): string {
  const vars = (pb.variables || []).map(v => v.required ? `${v.name}*` : v.name).join(', ');
  return `${pb.name} (v${pb.version}, ${pb.scope}) — ${pb.steps.length} steps${vars ? ` · vars: ${vars}` : ''}`;
}

/**
 * Starter library — cloned into a user's playbooks on demand. Each is a ready-to-run SOP;
 * agents referenced here are real Nova specialist slugs.
 */
export const SEED_PLAYBOOKS: Array<Omit<import('./db').PlaybookInput, 'scope' | 'userId'>> = [
  {
    name: 'client-onboarding',
    description: 'Onboard a new client end to end.',
    variables: [
      { name: 'client', required: true, description: 'Client / company name' },
      { name: 'email', required: true, description: 'Primary contact email' },
    ],
    steps: [
      { agent: 'athena', phase: 'prepare', description: 'Draft a concise onboarding brief and 30/60/90 plan for {{client}}.', dependsOn: [] },
      { agent: 'orion', phase: 'prepare', description: 'Write a warm welcome email to {{client}} at {{email}} introducing next steps.', dependsOn: [0] },
      { agent: 'zen', phase: 'prepare', description: 'Propose a kickoff agenda and suggested times for {{client}}.', dependsOn: [0] },
      { agent: 'orion', phase: 'execute', description: 'Send the welcome email to {{email}} and schedule the kickoff.', dependsOn: [1, 2] },
    ],
  },
  {
    name: 'refund-handling',
    description: 'Assess and process a customer refund request.',
    variables: [
      { name: 'customer', required: true },
      { name: 'order', required: true, description: 'Order / invoice reference' },
      { name: 'reason', required: false, default: 'not specified' },
    ],
    steps: [
      { agent: 'echo', phase: 'prepare', description: 'Review the refund request from {{customer}} for {{order}} (reason: {{reason}}) against policy and recommend approve/deny with rationale.', dependsOn: [] },
      { agent: 'lex', phase: 'prepare', description: 'Flag any contractual or compliance considerations for refunding {{order}}.', dependsOn: [0] },
      { agent: 'echo', phase: 'execute', description: 'If approved, process the refund for {{order}} and send {{customer}} a confirmation.', dependsOn: [0, 1] },
    ],
  },
  {
    name: 'content-launch',
    description: 'Plan and ship a coordinated content launch.',
    variables: [
      { name: 'topic', required: true },
      { name: 'date', required: false, default: 'this week' },
    ],
    steps: [
      { agent: 'kai', phase: 'prepare', description: 'Write a launch announcement post about {{topic}} for {{date}}.', dependsOn: [] },
      { agent: 'pixel', phase: 'prepare', description: 'Draft 3 social posts promoting {{topic}}.', dependsOn: [0] },
      { agent: 'orion', phase: 'prepare', description: 'Draft an email announcing {{topic}} to the list.', dependsOn: [0] },
      { agent: 'pixel', phase: 'execute', description: 'Publish the social posts and send the email for {{topic}}.', dependsOn: [1, 2] },
    ],
  },
  {
    name: 'weekly-report',
    description: 'Assemble the weekly business report.',
    variables: [{ name: 'week', required: false, default: 'this week' }],
    steps: [
      { agent: 'digit', phase: 'prepare', description: 'Pull key metrics for {{week}} and summarize trends.', dependsOn: [] },
      { agent: 'athena', phase: 'prepare', description: 'Add 3 insights and recommended actions from the {{week}} metrics.', dependsOn: [0] },
    ],
  },
  {
    name: 'lead-follow-up',
    description: 'Qualify and follow up with a new lead.',
    variables: [
      { name: 'lead', required: true },
      { name: 'source', required: false, default: 'inbound' },
    ],
    steps: [
      { agent: 'bridge', phase: 'prepare', description: 'Research {{lead}} (source: {{source}}) and assess fit.', dependsOn: [] },
      { agent: 'orion', phase: 'prepare', description: 'Draft a personalized follow-up email to {{lead}}.', dependsOn: [0] },
      { agent: 'orion', phase: 'execute', description: 'Send the follow-up email to {{lead}}.', dependsOn: [1] },
    ],
  },
];
