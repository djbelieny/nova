/**
 * Reactive stages — when a card enters a stage with an onEnter action, dispatch it.
 *
 * Dispatch goes through the SAME DispatchAgentFn contract the automation engine uses, so spend
 * caps, compliance policies, and the approval gate apply unchanged. Containment lives here:
 * exactly-once claiming, and dead-lettering a dispatch that will not go through. The loop guard
 * itself is in planMove — a move made by an onEnter action never arms another.
 */

import { composePlaybookTask, renderTemplate, type DispatchAgentFn } from "./automation-engine.ts";
import { renderPlaybook } from "./playbooks.ts";
import type { OnEnterAction } from "./workboards.ts";
import type { DatabaseType, Playbook, Workboard, WorkboardCard } from "./db.ts";

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
    return { agentSlug: action.agent, taskDescription: renderTemplate(action.task, scope) };
  }
  const pb = resolvePlaybook(action.playbook);
  if (!pb) return { skip: `playbook-not-found: ${action.playbook}` };
  const vars: Record<string, string> = {};
  for (const [k, tmpl] of Object.entries(action.vars ?? {})) vars[k] = renderTemplate(tmpl, scope);
  const { plan, missing, errors } = renderPlaybook(pb, vars);
  if (errors.length) return { skip: `vars-rejected: ${errors.join(", ")}` };
  if (missing.length || !plan) return { skip: `missing-vars: ${missing.join(", ")}` };
  return { agentSlug: "general", taskDescription: composePlaybookTask(pb, plan) };
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
      boardId: board.id, cardId: card.id, kind: "fired", toStage: card.stageKey,
      actor: "automation", detail: { skipped: built.skip },
    });
    return { fired: false, reason: built.skip };
  }

  if (!db.claimIdempotencyKey(onEnterKey(card, card.stageKey), "workboard", 3600)) {
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
      boardId: board.id, cardId: card.id, kind: "fired", toStage: card.stageKey,
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
