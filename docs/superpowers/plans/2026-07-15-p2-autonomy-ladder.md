# P2 — Autonomy Ladder Engine

Earned, graduated autonomy per `(agent, action_type)` with spend caps and instant demotion.

## Ladder rules

Three levels per `(agent, action_type)`, defaulting to L0:

| Level | Name | Behavior |
|-------|------|----------|
| L0 | always ask | approval gate before execute (current behavior) |
| L1 | notify after | executes without gate, reports immediately |
| L2 | autonomous | executes within spend caps, ledger-only |

- Promotion is earned from the action ledger: **5** consecutive clean runs → L1, **10** cumulative clean runs → L2 (constants `CLEAN_RUNS_L1`, `CLEAN_RUNS_L2`).
- A clean run = an approved/successful execute of that `(agent, action_type)`.
- **Instant demotion to L0** on ANY of: execution failure, user rejection (cancel), or spend-cap breach. Resets `clean_runs` to 0 and stamps `demoted_at`.
- Spend caps enforced at **L2**: per-action (`spend_cap_action`) and per-day (`spend_cap_daily`, summed from today's execute ledger rows for that `(agent, action_type)`). Exceeding a cap → escalate that action to the approval gate (`escalate-cap`). Never split spend to dodge caps.
- Caps default `null` (unlimited) until set. Ledger is never pruned.
- The "just do it" / auto-approve phrases become a **one-shot L2 override for a single task only** — they run without the gate but MUST NOT change the stored grant (recordOutcome `oneShot: true` short-circuits grant mutation).

## Source of truth

`action_ledger` (per-user) is the source of truth for spend and audit. `autonomy_grants` is the
materialized state machine (level, clean_runs, caps, demoted_at). Daily spend is summed live from
the ledger; the grant counter is the materialized clean-streak.

## Deliverables

1. **`src/db.ts`** — `AutonomyGrantRow` type + methods `getAutonomyGrant`, `upsertAutonomyGrant`,
   `listAutonomyGrants`, `getDailyActionSpend`.
2. **`src/autonomy.ts`** — the engine:
   - `getGrant(userId, agent, actionType)` → materialized grant, defaults L0.
   - `decideGate(userId, agent, actionType, estimatedCostUsd)` → `{mode, level}` where mode is
     `ask` | `notify` | `auto` | `escalate-cap`.
   - `recordOutcome(userId, agent, actionType, {success, rejected, costUsd, capBreached, oneShot})`
     → records the outcome to the ledger, then promotes/demotes the materialized grant.
   - `setCaps` / `getGrant` / `listGrants` for the dashboard.
3. **`src/orchestrator.ts`** — consult `decideGate` after the prepare phase, before the approval
   gate. L0 → gate (unchanged). L1/L2 within caps → execute inline (notify / ledger-only). Cap
   exceeded → gate with spent-so-far context. Route "just do it" phrases as one-shot L2. Call
   `recordOutcome` after execute (success/failure) and on cancel (rejection).
4. **`tests/autonomy-ladder.test.ts`** — full state machine: L0→L1→L2 promotion, instant demotion
   on failure / rejection / cap-breach, per-action + per-day cap enforcement, one-shot override
   does not persist.

## Regression safety

Everything defaults to L0, so `decideGate` returns `ask` for all current users and the existing
approval gate runs exactly as before. New `recordOutcome` calls are additive and wrapped in
try/catch. The L1/L2 inline-execute branch is inert until a grant is earned.
