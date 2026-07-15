import { getDb, type AutonomyGrantRow } from "./db.ts";

// ============================================================
// P2 — Autonomy Ladder
// Earned, graduated autonomy per (agent, action_type).
//   L0 = always ask     — approval gate before execute
//   L1 = notify after   — executes without gate, reports immediately
//   L2 = autonomous     — executes within spend caps, ledger-only
// Promotion is earned from clean runs; ANY failure / rejection /
// spend-cap breach instantly demotes to L0.
// ============================================================

export const CLEAN_RUNS_L1 = 5;
export const CLEAN_RUNS_L2 = 10;

export type GateMode = "ask" | "notify" | "auto" | "escalate-cap";

export interface Grant {
  agent: string;
  action_type: string;
  level: number;
  clean_runs: number;
  spend_cap_action: number | null;
  spend_cap_daily: number | null;
  demoted_at: string | null;
}

export interface GateDecision {
  mode: GateMode;
  level: number;
  spentToday?: number;
  cap?: number;
}

export interface OutcomeInput {
  success: boolean;
  rejected?: boolean;
  capBreached?: boolean;
  costUsd?: number;
  oneShot?: boolean;
}

function defaultGrant(agent: string, actionType: string): Grant {
  return {
    agent,
    action_type: actionType,
    level: 0,
    clean_runs: 0,
    spend_cap_action: null,
    spend_cap_daily: null,
    demoted_at: null,
  };
}

function toGrant(row: AutonomyGrantRow | null, agent: string, actionType: string): Grant {
  if (!row) return defaultGrant(agent, actionType);
  return {
    agent: row.agent,
    action_type: row.action_type,
    level: row.level,
    clean_runs: row.clean_runs,
    spend_cap_action: row.spend_cap_action,
    spend_cap_daily: row.spend_cap_daily,
    demoted_at: row.demoted_at,
  };
}

/** Materialized grant for (agent, action_type). Defaults to L0 when absent. */
export function getGrant(userId: string, agent: string, actionType: string): Grant {
  return toGrant(getDb().getAutonomyGrant(userId, agent, actionType), agent, actionType);
}

/** All grants for a user (dashboard). */
export function listGrants(userId: string): Grant[] {
  return getDb().listAutonomyGrants(userId).map((r) => toGrant(r, r.agent, r.action_type));
}

function persist(userId: string, g: Grant): void {
  getDb().upsertAutonomyGrant(userId, {
    agent: g.agent,
    action_type: g.action_type,
    level: g.level,
    clean_runs: g.clean_runs,
    spend_cap_action: g.spend_cap_action,
    spend_cap_daily: g.spend_cap_daily,
    demoted_at: g.demoted_at,
  });
}

/** Set per-action / per-day USD spend caps without disturbing earned level or streak. */
export function setCaps(
  userId: string,
  agent: string,
  actionType: string,
  caps: { action?: number | null; daily?: number | null },
): Grant {
  const g = getGrant(userId, agent, actionType);
  if (caps.action !== undefined) g.spend_cap_action = caps.action;
  if (caps.daily !== undefined) g.spend_cap_daily = caps.daily;
  persist(userId, g);
  return g;
}

function levelForCleanRuns(cleanRuns: number): number {
  if (cleanRuns >= CLEAN_RUNS_L2) return 2;
  if (cleanRuns >= CLEAN_RUNS_L1) return 1;
  return 0;
}

/**
 * Pre-execute decision the orchestrator consults for a single (agent, action_type).
 *   L0            → "ask"          (approval gate)
 *   L1            → "notify"       (execute, report immediately)
 *   L2 in caps    → "auto"         (execute, ledger-only)
 *   L2 over a cap → "escalate-cap" (route to the approval gate)
 */
export function decideGate(
  userId: string,
  agent: string,
  actionType: string,
  estimatedCostUsd: number,
): GateDecision {
  const g = getGrant(userId, agent, actionType);
  if (g.level <= 0) return { mode: "ask", level: 0 };
  if (g.level === 1) return { mode: "notify", level: 1 };

  // L2 — enforce spend caps
  const estimate = estimatedCostUsd || 0;
  if (g.spend_cap_action != null && estimate > g.spend_cap_action) {
    return { mode: "escalate-cap", level: 2, cap: g.spend_cap_action };
  }
  if (g.spend_cap_daily != null) {
    const spentToday = getDb().getDailyActionSpend(userId, agent, actionType);
    if (spentToday + estimate > g.spend_cap_daily) {
      return { mode: "escalate-cap", level: 2, spentToday, cap: g.spend_cap_daily };
    }
  }
  return { mode: "auto", level: 2 };
}

/**
 * Record the outcome of an execute-phase action and update the materialized grant.
 * Writes a row to the action ledger (source of truth for spend/audit), then promotes
 * on clean streaks or instantly demotes to L0 on failure / rejection / cap breach.
 * `oneShot` (the "just do it" override) logs the ledger row but never mutates the grant.
 */
export function recordOutcome(
  userId: string,
  agent: string,
  actionType: string,
  outcome: OutcomeInput,
): Grant {
  const current = getGrant(userId, agent, actionType);

  const ledgerOutcome = outcome.rejected
    ? "rejected"
    : outcome.success
      ? "success"
      : "failed";
  try {
    getDb().recordAction({
      user_id: userId,
      agent,
      action_type: actionType,
      phase: "execute",
      autonomy_level: current.level,
      cost_usd: outcome.costUsd ?? 0,
      outcome: ledgerOutcome,
    });
  } catch (err) {
    console.error("[autonomy] Failed to record ledger row:", err);
  }

  if (outcome.oneShot) return current;

  const demote = !outcome.success || !!outcome.rejected || !!outcome.capBreached;
  if (demote) {
    const demoted: Grant = {
      ...current,
      level: 0,
      clean_runs: 0,
      demoted_at: new Date().toISOString(),
    };
    persist(userId, demoted);
    return demoted;
  }

  const clean_runs = current.clean_runs + 1;
  const promoted: Grant = { ...current, clean_runs, level: levelForCleanRuns(clean_runs) };
  persist(userId, promoted);
  return promoted;
}
