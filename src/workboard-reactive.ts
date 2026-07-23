/**
 * Reactive stages — when a card enters a stage with an onEnter action, dispatch it.
 *
 * Dispatch goes through the SAME DispatchAgentFn contract the automation engine uses, so spend
 * caps, compliance policies, and the approval gate apply unchanged. Containment lives here:
 * exactly-once claiming, and dead-lettering a dispatch that will not go through. The loop guard
 * itself is in planMove — a move made by an onEnter action never arms another.
 */

import { composePlaybookTask, renderTemplate, type DispatchAgentFn } from "./automation-engine.ts";
import { looksLikeInjection } from "./learning-loop.ts";
import { withLock } from "./locks.ts";
import { renderPlaybook } from "./playbooks.ts";
import type { OnEnterAction } from "./workboards.ts";
import type { DatabaseType, Playbook, Workboard, WorkboardCard } from "./db.ts";

/**
 * Claim TTL for the onEnter idempotency key. Guards against a rapid double-fire or a
 * mid-run restart, not against a card genuinely leaving and re-entering the same stage
 * later (a second outreach round, no field edit in between) — that repeat entry should
 * dispatch again, not be swallowed by a claim held over from an hour ago.
 */
const ONENTER_CLAIM_TTL_SECONDS = 120;

/** Template context for {{card.*}} tokens. */
export function cardScope(card: WorkboardCard, extra: Record<string, unknown> = {}): Record<string, any> {
  return { card: { ...card.fields, id: card.id, title: card.title, stage: card.stageKey }, ...extra };
}

/**
 * Content revision, not updatedAt: `updated_at` is bumped by every patch, including the
 * stage/position patch a move itself performs, so it would mint a new key on every repeat
 * move and defeat exactly-once. Hashing title+fields changes only on a genuine field edit.
 */
function cardRevision(card: WorkboardCard): string {
  return Bun.hash(JSON.stringify({ title: card.title, fields: card.fields })).toString(36);
}

export function onEnterKey(card: WorkboardCard, stageKey: string): string {
  return `workboard:onenter:${card.id}:${stageKey}:${cardRevision(card)}`;
}

export function buildOnEnterDispatch(
  action: OnEnterAction,
  card: WorkboardCard,
  resolvePlaybook: (name: string) => Playbook | null
): { agentSlug: string; taskDescription: string } | { skip: string } {
  const scope = cardScope(card);
  if ("agent" in action) {
    const taskDescription = renderTemplate(action.task, scope);
    if (looksLikeInjection(taskDescription)) return { skip: "injection" };
    return { agentSlug: action.agent, taskDescription };
  }
  const pb = resolvePlaybook(action.playbook);
  if (!pb) return { skip: `playbook-not-found: ${action.playbook}` };
  const vars: Record<string, string> = {};
  for (const [k, tmpl] of Object.entries(action.vars ?? {})) vars[k] = renderTemplate(tmpl, scope);
  const { plan, missing, errors } = renderPlaybook(pb, vars);
  if (errors.length) return { skip: `vars-rejected: ${errors.join(", ")}` };
  if (missing.length || !plan) return { skip: `missing-vars: ${missing.join(", ")}` };
  const taskDescription = composePlaybookTask(pb, plan);
  if (looksLikeInjection(taskDescription)) return { skip: "injection" };
  return { agentSlug: "general", taskDescription };
}

export async function fireOnEnter(
  db: DatabaseType,
  userId: string,
  board: Workboard,
  card: WorkboardCard,
  action: OnEnterAction,
  dispatchAgent: DispatchAgentFn
): Promise<{ fired: boolean; reason?: string; taskId?: string | null }> {
  const built = buildOnEnterDispatch(action, card, (name) => db.findPlaybook(userId, name));
  if ("skip" in built) {
    db.insertWorkboardEvent(board.scope, userId, {
      boardId: board.id, cardId: card.id, kind: "skipped", toStage: card.stageKey,
      actor: "automation", detail: { skipped: built.skip },
    });
    return { fired: false, reason: built.skip };
  }

  // Claimed before the dispatch attempt below: a process that dies mid-flight leaves the
  // claim held with no task and no dead-letter record. Mirrors dispatchAutomation's existing
  // behavior — accepted here for the same reason (exactly-once claiming can't also guarantee
  // the dispatch it gates completes).
  if (!db.claimIdempotencyKey(onEnterKey(card, card.stageKey), "workboard", ONENTER_CLAIM_TTL_SECONDS)) {
    db.insertWorkboardEvent(board.scope, userId, {
      boardId: board.id, cardId: card.id, kind: "deduped", toStage: card.stageKey,
      actor: "automation", detail: { reason: "deduped" },
    });
    return { fired: false, reason: "deduped" };
  }

  let taskId: string | null = null;
  let lastErr: any = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      taskId = await dispatchAgent(userId, built.agentSlug, built.taskDescription, {
        workboard_id: board.id, card_id: card.id, stage: card.stageKey, source: "workboard",
      });
    } catch (err) { lastErr = err; taskId = null; }
    if (taskId) break;
  }

  if (!taskId) {
    const errMsg = lastErr ? (lastErr?.message || String(lastErr)) : "dispatch returned null";
    db.insertDeadLetter(userId, {
      kind: "workboard", refId: card.id, refName: `${board.name}/${card.stageKey}`,
      payload: JSON.stringify(cardScope(card)).slice(0, 4000), error: errMsg,
    });
    db.insertWorkboardEvent(board.scope, userId, {
      boardId: board.id, cardId: card.id, kind: "failed", toStage: card.stageKey,
      actor: "automation", detail: { error: errMsg },
    });
    return { fired: false, reason: "failed" };
  }

  db.insertWorkboardEvent(board.scope, userId, {
    boardId: board.id, cardId: card.id, kind: "fired", toStage: card.stageKey,
    actor: "automation", detail: { taskId, agent: built.agentSlug },
  });
  return { fired: true, taskId };
}

/** Fan a playbook over a set of cards: one dispatch per card, with {{card.*}} bound. */
export function buildStageRun(
  playbookName: string,
  cards: WorkboardCard[],
  resolvePlaybook: (name: string) => Playbook | null,
  vars: Record<string, string> = {}
): Array<{ cardId: string; agentSlug: string; taskDescription: string } | { cardId: string; skip: string }> {
  return cards.map((card) => {
    const built = buildOnEnterDispatch({ playbook: playbookName, vars }, card, resolvePlaybook);
    return "skip" in built ? { cardId: card.id, skip: built.skip } : { cardId: card.id, ...built };
  });
}

/** Moving more than this many cards into an armed stage at once asks once for the batch. */
export const BULK_CONFIRM_LIMIT = Number(process.env.WORKBOARD_BULK_CONFIRM || 10);

export function needsBulkConfirm(count: number, limit = BULK_CONFIRM_LIMIT): boolean {
  return count > limit;
}

/**
 * Drains the durable queue a process with no dispatcher (the dashboard) enqueued into. Reads
 * pending rows oldest-first, reconstructs the board and card, and re-runs the SAME fireOnEnter
 * used by the inline path — so exactly-once claiming, retries, and dead-lettering are not
 * duplicated here. A row whose board or card is gone (archived/deleted between the drag and the
 * drain) is marked failed rather than thrown; every other row is still attempted.
 *
 * A row's captured `stageKey` is checked against the card's CURRENT stage before firing: if the
 * card has since moved on, fireOnEnter would derive its idempotency claim and event's `toStage`
 * from the card's current stage, not the row's, and fire a stale action against the wrong stage.
 * That row is skipped, not fired.
 *
 * Each row's processing is isolated in its own try/catch: an unexpected throw (a transient write
 * error inside fireOnEnter's claim, event, or dead-letter writes) marks only that row failed and
 * lets the loop continue, so one bad row can't starve every pending row behind it.
 */
export async function drainWorkboardQueue(
  db: DatabaseType,
  dispatchAgent: DispatchAgentFn,
  limit = 25
): Promise<{ processed: number; fired: number; skipped: number; failed: number }> {
  const rows = db.listPendingWorkboardActions(limit);
  let fired = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const board = db.getWorkboardById(row.boardScope, row.userId, row.boardId);
      if (!board) {
        db.markWorkboardActionFailed(row.id, "board not found");
        failed++;
        continue;
      }
      const card = db.getWorkboardCard(row.boardScope, row.userId, row.cardId);
      if (!card || card.archived) {
        db.markWorkboardActionFailed(row.id, card ? "card archived" : "card not found");
        failed++;
        continue;
      }
      if (card.stageKey !== row.stageKey) {
        db.markWorkboardActionSkipped(
          row.id,
          `stale stage: captured "${row.stageKey}", card now in "${card.stageKey}"`
        );
        skipped++;
        continue;
      }

      const outcome = await fireOnEnter(db, row.userId, board, card, row.action, dispatchAgent);
      if (outcome.fired) {
        db.markWorkboardActionDone(row.id);
        fired++;
      } else {
        db.markWorkboardActionSkipped(row.id, outcome.reason ?? "not dispatched");
        skipped++;
      }
    } catch (err) {
      db.markWorkboardActionFailed(row.id, err instanceof Error ? err.message : String(err));
      failed++;
    }
  }

  return { processed: rows.length, fired, skipped, failed };
}

/** TTL for the drain's advisory lock. Longer than the default tick so a slow drain still holds it
 * when the next tick arrives, and short enough that a process killed mid-drain frees it quickly. */
export const DRAIN_LOCK_TTL_SECONDS = 90;

/**
 * The drain under an advisory lock — what a periodic caller should use, mirroring the automation
 * poller. Without it a slow drain overlaps its own next tick (or a second relay instance) and the
 * two passes race: the first fires a row and marks it done, the second re-reads the same still-
 * pending row and records it as "skipped: deduped", so the audit trail contradicts what happened.
 * `ran: false` means another holder had the lock and this round did nothing.
 */
export async function drainWorkboardQueueLocked(
  db: DatabaseType,
  dispatchAgent: DispatchAgentFn,
  limit = 25
): Promise<{ ran: boolean; processed: number; fired: number; skipped: number; failed: number }> {
  const { ran, result } = await withLock(db, "workboard-queue-drain", DRAIN_LOCK_TTL_SECONDS, () =>
    drainWorkboardQueue(db, dispatchAgent, limit));
  return ran && result
    ? { ran: true, ...result }
    : { ran: false, processed: 0, fired: 0, skipped: 0, failed: 0 };
}
