import { test, expect } from "bun:test";
import { getDb } from "../src/db.ts";
import { addCards, archiveCard, createBoard, moveCard } from "../src/workboard-service.ts";
import { buildOnEnterDispatch, drainWorkboardQueue, drainWorkboardQueueLocked } from "../src/workboard-reactive.ts";
import { handleWorkboardApi } from "../src/dashboard-workboards.ts";

let seq = 0;
function seed(reactive = true) {
  const db = getDb();
  const u = db.upsertUser({ telegram_id: `wbq-${Date.now()}-${seq++}`, name: "Q User", role: "admin" });
  const created = createBoard(db, u.id, {
    name: `queue-board-${seq}`,
    fields: [
      { key: "company", label: "Company", type: "text", required: true, primary: true },
      { key: "email", label: "Email", type: "email" },
    ],
    stages: [
      { key: "new", label: "New", order: 0 },
      { key: "nurture", label: "Nurture", order: 1, onEnter: { agent: "orion", task: "Email {{card.company}} at {{card.email}}" } },
    ],
    reactive,
  });
  if (!created.ok) throw new Error(created.errors.join(", "));
  const added = addCards(db, u.id, created.value, "new", [{ fields: { company: "Acme", email: "a@acme.com" } }], "agent");
  if (!added.ok) throw new Error(added.errors.join(", "));
  return { db, userId: u.id, board: created.value, card: added.value[0] };
}

/**
 * The queue table is shared across every test in this file (and every user), so a row a prior
 * test left pending would otherwise pollute an exact `result.processed` count here. Drain
 * everything outstanding before a test that asserts precise counts.
 */
async function flushQueue(db: ReturnType<typeof getDb>): Promise<void> {
  let round = await drainWorkboardQueue(db, async () => "flushed", 500);
  while (round.processed > 0) round = await drainWorkboardQueue(db, async () => "flushed", 500);
}

test("enqueueWorkboardAction writes a pending row carrying everything needed to reconstruct the call", () => {
  const { db, userId, board, card } = seed();
  const action = { agent: "orion", task: "Email {{card.company}}" };
  const row = db.enqueueWorkboardAction({
    userId, boardScope: board.scope, boardId: board.id, cardId: card.id, stageKey: "nurture", action,
  });
  expect(row.status).toBe("pending");
  expect(row.userId).toBe(userId);
  expect(row.boardScope).toBe(board.scope);
  expect(row.boardId).toBe(board.id);
  expect(row.cardId).toBe(card.id);
  expect(row.stageKey).toBe("nurture");
  expect(row.action).toEqual(action);

  const pending = db.listPendingWorkboardActions(50);
  expect(pending.some((r) => r.id === row.id)).toBe(true);
});

test("drainWorkboardQueue picks up a pending row, dispatches the same agent/task the inline path would, and marks it done", async () => {
  const { db, userId, board, card } = seed();
  await flushQueue(db);
  const action = board.stages.find((s) => s.key === "nurture")!.onEnter!;
  const expected = buildOnEnterDispatch(action, card, () => null);
  if ("skip" in expected) throw new Error("expected a dispatch, got a skip");

  const moved = moveCard(db, userId, board, card.id, "nurture", "test-setup", { actorIsOnEnter: true });
  if (!moved.ok) throw new Error(moved.errors.join(", "));

  const enqueued = db.enqueueWorkboardAction({
    userId, boardScope: board.scope, boardId: board.id, cardId: card.id, stageKey: "nurture", action,
  });

  const calls: any[] = [];
  const dispatch = async (uid: string, agent: string, task: string) => { calls.push({ uid, agent, task }); return "task-1"; };
  const result = await drainWorkboardQueue(db, dispatch);

  expect(result.processed).toBe(1);
  expect(result.fired).toBe(1);
  expect(calls.length).toBe(1);
  expect(calls[0].agent).toBe(expected.agentSlug);
  expect(calls[0].task).toBe(expected.taskDescription);
  expect(db.listPendingWorkboardActions(50).length).toBe(0);

  const row = db.getWorkboardQueueRow(enqueued.id)!;
  expect(row.status).toBe("done");
});

test("a row whose card has been archived is marked failed with a reason, and the drainer keeps going", async () => {
  const { db, userId, board, card } = seed();
  await flushQueue(db);
  const okCardBatch = addCards(db, userId, board, "new", [{ fields: { company: "Beta", email: "b@beta.com" } }], "agent");
  if (!okCardBatch.ok) throw new Error("setup failed");
  const okCard = okCardBatch.value[0];

  const archived = archiveCard(db, userId, board, card.id, userId);
  if (!archived.ok) throw new Error(archived.errors.join(", "));

  const action = board.stages.find((s) => s.key === "nurture")!.onEnter!;
  const okMoved = moveCard(db, userId, board, okCard.id, "nurture", "test-setup", { actorIsOnEnter: true });
  if (!okMoved.ok) throw new Error(okMoved.errors.join(", "));
  const staleRow = db.enqueueWorkboardAction({
    userId, boardScope: board.scope, boardId: board.id, cardId: card.id, stageKey: "nurture", action,
  });
  const okRow = db.enqueueWorkboardAction({
    userId, boardScope: board.scope, boardId: board.id, cardId: okCard.id, stageKey: "nurture", action,
  });

  const calls: any[] = [];
  const dispatch = async (uid: string, agent: string, task: string) => { calls.push({ uid, agent, task }); return "task-1"; };
  const result = await drainWorkboardQueue(db, dispatch);

  expect(result.processed).toBe(2);
  expect(result.failed).toBe(1);
  expect(result.fired).toBe(1);
  expect(calls.length).toBe(1);

  const staleAfter = db.getWorkboardQueueRow(staleRow.id)!;
  expect(staleAfter.status).toBe("failed");
  expect(staleAfter.error).toBeTruthy();

  const okAfter = db.getWorkboardQueueRow(okRow.id)!;
  expect(okAfter.status).toBe("done");
});

test("a row whose board has been deleted-equivalent (no such board id) is marked failed, not thrown", async () => {
  const { db, userId } = seed();
  await flushQueue(db);
  const row = db.enqueueWorkboardAction({
    userId, boardScope: "personal", boardId: "no-such-board", cardId: "no-such-card",
    stageKey: "nurture", action: { agent: "orion", task: "x" },
  });
  const dispatch = async () => "task-1";
  const result = await drainWorkboardQueue(db, dispatch);
  expect(result.failed).toBe(1);
  const after = db.getWorkboardQueueRow(row.id)!;
  expect(after.status).toBe("failed");
  expect(after.error).toBe("board not found");
});

test("draining twice does not dispatch twice for the same card/stage/action", async () => {
  const { db, userId, board, card } = seed();
  await flushQueue(db);
  const action = board.stages.find((s) => s.key === "nurture")!.onEnter!;
  const moved = moveCard(db, userId, board, card.id, "nurture", "test-setup", { actorIsOnEnter: true });
  if (!moved.ok) throw new Error(moved.errors.join(", "));
  db.enqueueWorkboardAction({
    userId, boardScope: board.scope, boardId: board.id, cardId: card.id, stageKey: "nurture", action,
  });
  db.enqueueWorkboardAction({
    userId, boardScope: board.scope, boardId: board.id, cardId: card.id, stageKey: "nurture", action,
  });

  let n = 0;
  const dispatch = async () => { n++; return "task-1"; };
  const result = await drainWorkboardQueue(db, dispatch);

  expect(result.processed).toBe(2);
  expect(n).toBe(1); // fireOnEnter's own idempotency claim absorbs the second row
  expect(result.fired).toBe(1);

  const second = await drainWorkboardQueue(db, dispatch);
  expect(second.processed).toBe(0);
  expect(n).toBe(1);
});

test("an API move into an armed stage with no dispatcher in the context enqueues exactly one row and fires nothing inline", async () => {
  const { db, userId, board, card } = seed();
  const ctx = { db, userId }; // no dispatchAgent
  const req = new Request(`http://x/api/workboards/cards/${card.id}/move`, {
    method: "POST", body: JSON.stringify({ toStage: "nurture" }),
  });
  const res = await handleWorkboardApi(`/api/workboards/cards/${card.id}/move`, req, ctx);
  const bodyJson = await res!.json();

  expect(res!.status).toBe(200);
  expect(bodyJson.firing).toBe("queued"); // promised to the relay, not run inline

  const pending = db.listPendingWorkboardActions(50).filter((r) => r.cardId === card.id);
  expect(pending.length).toBe(1);
  expect(pending[0].stageKey).toBe("nurture");
});

test("the same move WITH a dispatcher in the context fires inline and enqueues nothing", async () => {
  const { db, userId, board, card } = seed();
  let dispatched = 0;
  const ctx = { db, userId, dispatchAgent: async () => { dispatched++; return "t1"; } };
  const req = new Request(`http://x/api/workboards/cards/${card.id}/move`, {
    method: "POST", body: JSON.stringify({ toStage: "nurture" }),
  });
  const res = await handleWorkboardApi(`/api/workboards/cards/${card.id}/move`, req, ctx);
  const bodyJson = await res!.json();

  expect(res!.status).toBe(200);
  expect(bodyJson.firing).toBe("dispatched");
  expect(dispatched).toBe(1);

  const pending = db.listPendingWorkboardActions(50).filter((r) => r.cardId === card.id);
  expect(pending.length).toBe(0);
});

test("an unconfirmed over-threshold bulk move into an armed stage enqueues nothing (with no dispatcher)", async () => {
  const { db, userId, board } = seed();
  const many = addCards(db, userId, board, "new",
    Array.from({ length: 12 }, (_, i) => ({ fields: { company: `Co ${i}`, email: `c${i}@x.com` } })), "agent");
  if (!many.ok) throw new Error("setup failed");

  const ctx = { db, userId }; // no dispatchAgent
  const req = new Request("http://x/api/workboards/cards/move-many", {
    method: "POST",
    body: JSON.stringify({ cardIds: many.value.map((c) => c.id), toStage: "nurture" }),
  });
  const res = await handleWorkboardApi("/api/workboards/cards/move-many", req, ctx);
  const bodyJson = await res!.json();

  expect(bodyJson.needsConfirm).toBe(true);
  const cardIdSet = new Set(many.value.map((c) => c.id));
  const pending = db.listPendingWorkboardActions(200).filter((r) => cardIdSet.has(r.cardId));
  expect(pending.length).toBe(0);

  for (const c of many.value) {
    const fresh = db.getWorkboardCard(board.scope, userId, c.id)!;
    expect(fresh.stageKey).toBe("new");
  }
});

test("a confirmed bulk move into an armed stage with no dispatcher enqueues one row per card", async () => {
  const { db, userId, board } = seed();
  const many = addCards(db, userId, board, "new",
    Array.from({ length: 3 }, (_, i) => ({ fields: { company: `Co ${i}`, email: `c${i}@x.com` } })), "agent");
  if (!many.ok) throw new Error("setup failed");

  const ctx = { db, userId }; // no dispatchAgent
  const req = new Request("http://x/api/workboards/cards/move-many", {
    method: "POST",
    body: JSON.stringify({ cardIds: many.value.map((c) => c.id), toStage: "nurture", confirm: true }),
  });
  const res = await handleWorkboardApi("/api/workboards/cards/move-many", req, ctx);
  const bodyJson = await res!.json();

  expect(bodyJson.moved).toBe(3);
  const cardIdSet = new Set(many.value.map((c) => c.id));
  const pending = db.listPendingWorkboardActions(200).filter((r) => cardIdSet.has(r.cardId));
  expect(pending.length).toBe(3);
});

test("a queued row whose card has since moved to a different stage does not dispatch, and records both stages", async () => {
  const { db, userId, board, card } = seed();
  await flushQueue(db);
  const action = board.stages.find((s) => s.key === "nurture")!.onEnter!;

  const entered = moveCard(db, userId, board, card.id, "nurture", "test-setup", { actorIsOnEnter: true });
  if (!entered.ok) throw new Error(entered.errors.join(", "));
  const row = db.enqueueWorkboardAction({
    userId, boardScope: board.scope, boardId: board.id, cardId: card.id, stageKey: "nurture", action,
  });

  const left = moveCard(db, userId, board, card.id, "new", "test-setup", { actorIsOnEnter: true });
  if (!left.ok) throw new Error(left.errors.join(", "));

  let dispatched = 0;
  const dispatch = async () => { dispatched++; return "task-1"; };
  const result = await drainWorkboardQueue(db, dispatch);

  expect(result.processed).toBe(1);
  expect(result.fired).toBe(0);
  expect(result.skipped).toBe(1);
  expect(dispatched).toBe(0);

  const after = db.getWorkboardQueueRow(row.id)!;
  expect(after.status).toBe("skipped");
  expect(after.error).toContain("nurture");
  expect(after.error).toContain("new");
});

test("a queued row whose card is still in the captured stage dispatches (Fix 1 does not break the normal path)", async () => {
  const { db, userId, board, card } = seed();
  await flushQueue(db);
  const action = board.stages.find((s) => s.key === "nurture")!.onEnter!;

  const entered = moveCard(db, userId, board, card.id, "nurture", "test-setup", { actorIsOnEnter: true });
  if (!entered.ok) throw new Error(entered.errors.join(", "));
  const row = db.enqueueWorkboardAction({
    userId, boardScope: board.scope, boardId: board.id, cardId: card.id, stageKey: "nurture", action,
  });

  let dispatched = 0;
  const dispatch = async () => { dispatched++; return "task-1"; };
  const result = await drainWorkboardQueue(db, dispatch);

  expect(result.processed).toBe(1);
  expect(result.fired).toBe(1);
  expect(dispatched).toBe(1);

  const after = db.getWorkboardQueueRow(row.id)!;
  expect(after.status).toBe("done");
});

test("the three outcomes (dispatched, attempted-not-dispatched, could-not-attempt) land in three distinguishable statuses", async () => {
  const { db, userId, board, card } = seed();
  await flushQueue(db);
  const action = board.stages.find((s) => s.key === "nurture")!.onEnter!;

  const entered = moveCard(db, userId, board, card.id, "nurture", "test-setup", { actorIsOnEnter: true });
  if (!entered.ok) throw new Error(entered.errors.join(", "));
  const doneRow = db.enqueueWorkboardAction({
    userId, boardScope: board.scope, boardId: board.id, cardId: card.id, stageKey: "nurture", action,
  });
  // Drained immediately, while the card is still in the captured stage, so this row dispatches
  // before the card is moved away for the skipped-row case below.
  const dispatch = async () => "task-1";
  await drainWorkboardQueue(db, dispatch);

  const left = moveCard(db, userId, board, card.id, "new", "test-setup", { actorIsOnEnter: true });
  if (!left.ok) throw new Error(left.errors.join(", "));
  const skippedRow = db.enqueueWorkboardAction({
    userId, boardScope: board.scope, boardId: board.id, cardId: card.id, stageKey: "nurture", action,
  });

  const failedRow = db.enqueueWorkboardAction({
    userId, boardScope: "personal", boardId: "no-such-board", cardId: "no-such-card",
    stageKey: "nurture", action,
  });

  await drainWorkboardQueue(db, dispatch);

  expect(db.getWorkboardQueueRow(doneRow.id)!.status).toBe("done");
  expect(db.getWorkboardQueueRow(skippedRow.id)!.status).toBe("skipped");
  expect(db.getWorkboardQueueRow(failedRow.id)!.status).toBe("failed");

  const statuses = new Set([
    db.getWorkboardQueueRow(doneRow.id)!.status,
    db.getWorkboardQueueRow(skippedRow.id)!.status,
    db.getWorkboardQueueRow(failedRow.id)!.status,
  ]);
  expect(statuses.size).toBe(3);
});

/**
 * fireOnEnter's own dispatch loop already swallows a throwing dispatcher into its retry/
 * dead-letter path (three attempts, then a dead-letter write) — that throw never escapes to
 * drainWorkboardQueue, so injecting it through the dispatcher cannot reach Fix 3's row-isolation
 * catch. To exercise that catch for real, this test forces the throw one level deeper, in
 * claimIdempotencyKey, which fireOnEnter does NOT wrap in its own try/catch. Coverage note: the
 * dispatcher-only injection path described in the task is not sufficient here — this is the one
 * uncovered-by-dispatcher case, addressed instead by overriding the db method for the duration
 * of this test.
 */
test("a row whose processing throws is marked failed and does not block a later pending row in the same drain", async () => {
  const { db, userId, board, card } = seed();
  await flushQueue(db);
  const action = board.stages.find((s) => s.key === "nurture")!.onEnter!;

  const enteredA = moveCard(db, userId, board, card.id, "nurture", "test-setup", { actorIsOnEnter: true });
  if (!enteredA.ok) throw new Error(enteredA.errors.join(", "));
  const rowA = db.enqueueWorkboardAction({
    userId, boardScope: board.scope, boardId: board.id, cardId: card.id, stageKey: "nurture", action,
  });

  const otherBatch = addCards(db, userId, board, "new", [{ fields: { company: "Gamma", email: "g@gamma.com" } }], "agent");
  if (!otherBatch.ok) throw new Error("setup failed");
  const otherCard = otherBatch.value[0];
  const enteredB = moveCard(db, userId, board, otherCard.id, "nurture", "test-setup", { actorIsOnEnter: true });
  if (!enteredB.ok) throw new Error(enteredB.errors.join(", "));
  const rowB = db.enqueueWorkboardAction({
    userId, boardScope: board.scope, boardId: board.id, cardId: otherCard.id, stageKey: "nurture", action,
  });

  const originalClaim = db.claimIdempotencyKey.bind(db);
  db.claimIdempotencyKey = ((key: string, scope?: string, ttlSeconds?: number) => {
    if (key.includes(card.id)) throw new Error("simulated transient write error");
    return originalClaim(key, scope, ttlSeconds);
  }) as typeof db.claimIdempotencyKey;

  const calls: string[] = [];
  const dispatch = async (uid: string, agent: string, task: string) => { calls.push(task); return "task-1"; };

  try {
    const result = await drainWorkboardQueue(db, dispatch);
    expect(result.processed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.fired).toBe(1);
    expect(calls.length).toBe(1);
  } finally {
    db.claimIdempotencyKey = originalClaim;
  }

  const rowAAfter = db.getWorkboardQueueRow(rowA.id)!;
  expect(rowAAfter.status).toBe("failed");
  expect(rowAAfter.error).toContain("simulated transient write error");

  const rowBAfter = db.getWorkboardQueueRow(rowB.id)!;
  expect(rowBAfter.status).toBe("done");
});

test("the locked drain skips its round while another holder owns the lock, and runs once it is released", async () => {
  const { db, userId, board, card } = seed();
  await flushQueue(db);
  const action = board.stages.find((s) => s.key === "nurture")!.onEnter!;
  const entered = moveCard(db, userId, board, card.id, "nurture", "test-setup", { actorIsOnEnter: true });
  if (!entered.ok) throw new Error(entered.errors.join(", "));
  const row = db.enqueueWorkboardAction({
    userId, boardScope: board.scope, boardId: board.id, cardId: card.id, stageKey: "nurture", action,
  });

  let dispatched = 0;
  const dispatch = async () => { dispatched++; return "task-1"; };

  expect(db.acquireLock("workboard-queue-drain", "another-relay", 60)).toBe(true);
  const blocked = await drainWorkboardQueueLocked(db, dispatch);
  expect(blocked.ran).toBe(false);
  expect(dispatched).toBe(0);
  expect(db.getWorkboardQueueRow(row.id)!.status).toBe("pending");

  db.releaseLock("workboard-queue-drain", "another-relay");
  const ran = await drainWorkboardQueueLocked(db, dispatch);
  expect(ran.ran).toBe(true);
  expect(dispatched).toBe(1);
  expect(db.getWorkboardQueueRow(row.id)!.status).toBe("done");
});
