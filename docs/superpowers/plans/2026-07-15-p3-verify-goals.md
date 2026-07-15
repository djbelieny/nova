# P3 — Closed-Loop Execution: Verification Phase + Goal Pursuit Loop

Branch: `feat/p3-verify-goals` (off `main` @ 2594297, post-P0).

## Goal

Close the loop after the execute phase:

1. **Verification phase** — a cheap fast-tier model pass that checks whether an executed
   subtask actually achieved its goal (did the email send, does the page render, did the
   campaign go live) *before* reporting done. Verdict is written to `action_ledger.verification`.
   This is the evidence source the autonomy ladder (P2) depends on.
2. **Goal pursuit loop** — a standing-goal pursuer that periodically scans active goals,
   decomposes those without active tasks into concrete agent tasks (COO path), links the
   work back to the goal, and reports progress — with hard per-cycle caps so it can never
   run away.

## Constraints

- Verification is **best-effort and never blocks/crashes** the execution path (try/catch,
  degrade to `unverifiable`). Outcomes that aren't cheaply checkable return an explicit
  `unverifiable` verdict, never a false pass.
- Goal pursuer is **opt-in and capped** — max tasks per goal per cycle and per user per cycle;
  logs everything it does; skips goals that already have active tasks.
- No real network/model calls in tests — all model callers are dependency-injected.
- `bunx tsc --noEmit` clean + full suite green before every commit and the PR.

## Design

### `src/verify.ts`

```ts
type VerifyStatus = "verified" | "failed" | "unverifiable";
interface VerifyVerdict { status: VerifyStatus; reason: string; confidence: number }
interface VerifyInput { goal: string; result: string; artifacts?; agent?: string }
type VerifyModelCall = (opts: { prompt: string; systemPrompt?: string }) => Promise<string>;

verifyOutcome(input, callModel?): Promise<VerifyVerdict>
recordVerification(userId, actionId, verdict, db?): void   // attaches to ledger row
```

- Builds a concise prompt asking the model to reply with strict JSON
  `{"status","reason","confidence"}`.
- Default `callModel` routes to the **fast** tier via `selectProvider` + `provider.call`,
  fully wrapped so it can never throw.
- Parser is lenient: extract the first `{...}` JSON block; fall back to a `VERDICT: x` tag;
  on any failure return `unverifiable` (low confidence). Never throws.
- Short-circuits: empty/error result with no artifacts → `unverifiable`.

### `src/db.ts`

- Add `updateActionVerification(userId, actionId, verdict)` — patches the `verification`
  JSON column of an existing `action_ledger` row.

### `src/ledger.ts`

- `recordSubtaskAction` returns the new action id (`string | null`) so the planner can attach
  a verdict to the exact row.

### `src/planner.ts`

- In `executePhase`, capture `index → actionId` while recording subtask actions.
- After the batch loop, **only for `phase === "execute"`**, run verification best-effort for
  each result and patch its ledger row. Failed subtasks short-circuit to a `failed` verdict
  with no model call. Whole block wrapped in try/catch — never affects the return value.

### `services/goal-pursuer.ts`

Mirrors `services/task-dispatcher.ts` (standalone entry, registers providers, `main()`),
but exposes pure, testable helpers:

- `hasActiveTask(goal, activeTasks)` — a goal is "covered" if any `progress_notes.task_id`
  matches a still-active agent task.
- `goalsNeedingPursuit(goals, activeTasks)` — active goals with no active task.
- `decomposeGoal(goal, deps)` — fast-tier model call → up to `MAX_TASKS_PER_GOAL` `{agent, task}`.
- `pursueGoalsForUser(userId, db, deps)` — applies caps, dispatches, links via
  `updateGoalProgress`, returns a summary of what it did.
- `start()` / `main()` — opt-in via `NOVA_GOAL_PURSUER_ENABLED`; per-cycle interval.

Caps: `MAX_TASKS_PER_GOAL = 2`, `MAX_TASKS_PER_USER_CYCLE = 5`, `MAX_GOALS_PER_CYCLE = 10`.

## Tests

- `tests/verify.test.ts` — verified/failed/unverifiable parsing; never-throws on bad model
  output; unverifiable when outcome isn't checkable; JSON + tag fallback; failed short-circuit;
  `recordVerification` round-trips to the ledger.
- `tests/goal-pursuer.test.ts` — `hasActiveTask` / `goalsNeedingPursuit` logic; decomposition
  parsing; per-goal and per-user caps enforced; never dispatches for covered goals; stubbed deps.

## Steps (TDD)

1. Plan (this file).
2. `tests/verify.test.ts` → `src/verify.ts` + `db.updateActionVerification`. Commit.
3. Wire verification into `planner.executePhase` (+ `ledger` return id). Commit.
4. `tests/goal-pursuer.test.ts` → `services/goal-pursuer.ts`. Commit.
5. tsc clean + full suite green → PR.
