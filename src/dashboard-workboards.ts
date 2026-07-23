/**
 * Workboards dashboard surface — API handlers and page renderers.
 *
 * Lives outside dashboard.ts (already >10k lines): dashboard.ts delegates here and stays a router.
 */

import { addCards, archiveCard, createBoard, moveCard, updateCard, validateDefinition } from "./workboard-service.ts";
import { fireOnEnter, needsBulkConfirm } from "./workboard-reactive.ts";
import { buildPush, type ConnectorBinding } from "./workboard-sync.ts";
import { boardCardCount, getCardSource } from "./workboard-sources.ts";
import { hasCapability } from "./permissions.ts";
import { conformCardFields, diffSchema } from "./workboards.ts";
import type { DispatchAgentFn } from "./automation-engine.ts";
import type { DatabaseType, Workboard, WorkboardCard } from "./db.ts";

/** `userId` owns the data being read or written; `actorId` is who is asking (an admin may act on
 * another user's boards via ?user_id=). Capability checks use the actor, never the owner. */
export interface WorkboardApiCtx { db: DatabaseType; userId: string; actorId?: string; dispatchAgent?: DispatchAgentFn; }

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

// Mirrors db.ts's UUID_RE (not exported from there). Boards live in a per-user database keyed by
// UUID, so any session identity that isn't one — e.g. the master bootstrap login — has no such
// database. Checking here lets every route below return a clean 4xx instead of letting a getUserDb
// call throw uncaught deep in db.ts.
const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export function isValidUserId(userId: string): boolean {
  return UUID_RE.test(userId);
}

const NO_PERSONAL_ACCOUNT_MSG =
  "workboards need a personal account — the master admin login has no per-user database; sign in as a user";

/** How many cards a single stage renders. The cap is per stage, not per board: one crowded
 * stage must never starve the stages after it of every card the way a whole-board read does. */
export const STAGE_CARD_LIMIT = 200;

/** The board's numeric field, if it has one — its per-stage sum is shown in the stage header. */
function totalsField(board: Workboard) {
  return board.fields.find((f) => f.type === "money" || f.type === "number") ?? null;
}

/** Change marker for a board, whatever its cards are read from. Adapter boards have no rows in
 * workboard_cards, so theirs is derived from the cards the adapter currently returns. */
export function boardRevision(db: DatabaseType, userId: string, board: Workboard): string {
  const source = getCardSource(board.source);
  if (!source) return db.workboardRevision(board.scope, userId, board.id);
  const cards = source.readCards(db, userId, board.id);
  const shape = cards.map((c) => `${c.id}${c.stageKey}${c.updatedAt ?? ""}`).join(",");
  return `${cards.length}:${Bun.hash(shape).toString(36)}`;
}

export { boardCardCount };

/** Everything a board page needs in one payload. Counts and totals come from COUNT(*)/SUM() over
 * the whole board; only the card lists are capped, and each stage reports how much it is showing
 * so the page can say so. */
export function boardPayload(db: DatabaseType, userId: string, board: Workboard) {
  const source = getCardSource(board.source);
  const money = totalsField(board);
  const byStage: Record<string, WorkboardCard[]> = {};
  for (const s of board.stages) byStage[s.key] = [];

  let counts: Record<string, number> = {};
  let totals: Record<string, number> = {};
  if (source) {
    for (const c of source.readCards(db, userId, board.id)) (byStage[c.stageKey] ??= []).push(c);
    // Counts come from the underlying table, never from the capped read above — otherwise
    // `shown === count` by construction and a truncated stage could never say so.
    counts = source.countByStage(db, userId);
    if (money) {
      for (const [key, cards] of Object.entries(byStage)) {
        totals[key] = cards.reduce((sum, c) => sum + (Number(c.fields[money.key]) || 0), 0);
      }
    }
  } else {
    counts = db.countWorkboardCardsByStage(board.scope, userId, board.id);
    if (money) totals = db.sumWorkboardCardFieldByStage(board.scope, userId, board.id, money.key);
    for (const s of board.stages) {
      byStage[s.key] = db.listWorkboardCards(board.scope, userId, board.id, {
        stageKey: s.key, limit: STAGE_CARD_LIMIT,
      });
    }
  }

  return {
    board: {
      id: board.id, name: board.name, purpose: board.purpose, reactive: board.reactive,
      system: board.system, source: board.source, fields: board.fields,
    },
    stages: board.stages.map((s) => ({
      ...s,
      count: counts[s.key] ?? 0,
      shown: byStage[s.key]?.length ?? 0,
      total: money ? (totals[s.key] ?? 0) : null,
      armed: board.reactive && !!s.onEnter,
    })),
    cards: byStage,
  };
}

/** Locate a board by id across the scopes this user can see. */
function findBoardById(db: DatabaseType, userId: string, id: string): Workboard | null {
  return db.listWorkboardsVisible(userId).find((b) => b.id === id) ?? null;
}

function findCardBoard(db: DatabaseType, userId: string, cardId: string): { board: Workboard; card: WorkboardCard } | null {
  for (const board of db.listWorkboardsVisible(userId)) {
    const card = db.getWorkboardCard(board.scope, userId, cardId);
    if (card && card.boardId === board.id) return { board, card };
  }
  return null;
}

/** Same lookup for boards whose cards are adapted from another table (source !== 'cards') —
 * those rows never exist in workboard_cards, so findCardBoard alone can't see them. Used only
 * by the move route: adding/patching/archiving system-board cards is not part of this surface. */
function findAdapterCardBoard(db: DatabaseType, userId: string, cardId: string): { board: Workboard; card: WorkboardCard } | null {
  for (const board of db.listWorkboardsVisible(userId)) {
    const source = getCardSource(board.source);
    if (!source) continue;
    const card = source.readCards(db, userId, board.id).find((c) => c.id === cardId);
    if (card) return { board, card };
  }
  return null;
}

type BodyResult = { ok: true; value: any } | { ok: false };

/** Distinguishes an absent body (legitimate no-op) from one the client sent but we couldn't parse. */
async function body(req: Request): Promise<BodyResult> {
  const text = await req.text();
  if (!text) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

const badJson = () => json({ errors: ["request body is not valid JSON"] }, 400);

const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/** Page size for walking every card on a board during a schema edit (snapshot + backfill).
 * Small on purpose: tests exercise paging against it directly instead of seeding thousands
 * of cards to hit a production-sized page. */
export const SCHEMA_EDIT_PAGE_SIZE = 200;

/** Every card on the board, archived included — a schema edit must reach cards a normal
 * board view never shows, since archived cards still hold field values that need the same
 * backfill/snapshot treatment as live ones. Pages rather than taking one capped read so a
 * board of any size is fully covered without holding it all in memory at once. */
function* allCardsForSchemaEdit(db: DatabaseType, board: Workboard, userId: string): Generator<WorkboardCard[]> {
  let offset = 0;
  for (;;) {
    const page = db.listWorkboardCards(board.scope, userId, board.id, {
      limit: SCHEMA_EDIT_PAGE_SIZE, offset, includeArchived: true,
    });
    if (!page.length) return;
    yield page;
    if (page.length < SCHEMA_EDIT_PAGE_SIZE) return;
    offset += SCHEMA_EDIT_PAGE_SIZE;
  }
}

/** Returns null when `path` is not a workboard route, so dashboard.ts can fall through. */
export async function handleWorkboardApi(path: string, req: Request, ctx: WorkboardApiCtx): Promise<Response | null> {
  if (!path.startsWith("/api/workboards")) return null;
  const { db, userId } = ctx;
  if (!isValidUserId(userId)) return json({ errors: [NO_PERSONAL_ACCOUNT_MSG] }, 400);

  // Every team board is visible to every user (db.listWorkboardsVisible), and an armed reactive
  // stage is functionally an automation — so a write here can arm and trigger an autonomous agent
  // dispatch. Gate writes the way /api/automations and /api/playbooks gate theirs; reads stay open
  // to any authenticated session, like their GETs.
  if (MUTATING_METHODS.has(req.method) && !hasCapability(db, ctx.actorId ?? userId, "workboard.manage")) {
    return json({ errors: ["permission denied — workboard.manage is required to change a board"] }, 403);
  }

  if (path === "/api/workboards" && req.method === "GET") {
    const boards = db.listWorkboardsVisible(userId).map((b) => ({
      id: b.id, name: b.name, purpose: b.purpose, scope: b.scope, reactive: b.reactive,
      stages: b.stages.length, cards: boardCardCount(db, userId, b),
      updatedAt: b.updatedAt,
    }));
    return json({ boards });
  }

  if (path === "/api/workboards" && req.method === "POST") {
    const parsed = await body(req);
    if (!parsed.ok) return badJson();
    const r = createBoard(db, userId, parsed.value);
    return r.ok ? json({ board: r.value }) : json({ errors: r.errors }, 400);
  }

  const cardsMatch = path.match(/^\/api\/workboards\/([\w-]+)\/cards$/);
  if (cardsMatch && req.method === "POST") {
    const board = findBoardById(db, userId, cardsMatch[1]);
    if (!board) return json({ errors: ["no such board"] }, 404);
    // System boards read through an adapter (see boardPayload) and never look at workboard_cards —
    // a card written here would be stored but permanently invisible. Same guard as the PATCH branch below.
    if (board.system) return json({ errors: ["this board's cards are read from another table — add the card there instead"] }, 400);
    const parsed = await body(req);
    if (!parsed.ok) return badJson();
    const input = parsed.value;
    const records = Array.isArray(input.records) ? input.records : [{ title: input.title, fields: input.fields ?? {} }];
    const r = addCards(db, userId, board, input.stageKey, records, "user");
    return r.ok ? json({ cards: r.value }) : json({ errors: r.errors }, 400);
  }

  const moveMatch = path.match(/^\/api\/workboards\/cards\/([\w-]+)\/move$/);
  if (moveMatch && req.method === "POST") {
    const found = findCardBoard(db, userId, moveMatch[1]) ?? findAdapterCardBoard(db, userId, moveMatch[1]);
    if (!found) return json({ errors: ["no such card"] }, 404);
    const parsed = await body(req);
    if (!parsed.ok) return badJson();
    const input = parsed.value;

    // System boards (source !== 'cards') are neither reactive nor connector-bound — route the
    // move straight through the adapter and skip fireOnEnter/enqueue/connector-push entirely.
    const src = getCardSource(found.board.source);
    if (src) {
      // The adapters fall back to a default status for a key they don't recognise, so an
      // unknown stage would silently reopen a closed ticket and report success. planMove does
      // this check for card-backed boards; adapter boards need it before applyMove.
      if (!found.board.stages.some((s) => s.key === input.toStage)) {
        const keys = found.board.stages.map((s) => s.key).join(", ");
        return json({ errors: [`unknown stage "${input.toStage}" — this board has: ${keys}`] }, 400);
      }
      const ok = src.applyMove(db, userId, moveMatch[1], input.toStage);
      return ok
        ? json({ card: { ...found.card, stageKey: input.toStage }, fires: false, pendingPush: null })
        : json({ errors: ["could not move this card"] }, 400);
    }

    const r = moveCard(db, userId, found.board, moveMatch[1], input.toStage, userId, {
      beforeId: input.beforeId, afterId: input.afterId,
    });
    if (!r.ok) return json({ errors: r.errors }, 400);
    // "dispatched" only when a dispatcher was on hand AND the dispatch went through; the
    // dashboard has none, so its armed moves report "queued" — a promise the relay will keep,
    // not work already done. Anything else (skipped, deduped, dead-lettered) is neither.
    let firing: "dispatched" | "queued" | null = null;
    if (r.value.fires) {
      if (ctx.dispatchAgent) {
        const outcome = await fireOnEnter(db, userId, found.board, r.value.card, r.value.fires, ctx.dispatchAgent);
        firing = outcome.fired ? "dispatched" : null;
      } else {
        db.enqueueWorkboardAction({
          userId, boardScope: found.board.scope, boardId: found.board.id,
          cardId: r.value.card.id, stageKey: r.value.card.stageKey, action: r.value.fires,
        });
        firing = "queued";
      }
    }
    const binding = found.board.connectorBinding as ConnectorBinding | null;
    let pendingPush: { connector: string; action: string; input: Record<string, any> } | null = null;
    if (binding) {
      const push = buildPush(binding, r.value.card, input.toStage);
      if (!("skip" in push)) {
        pendingPush = push;
        db.insertWorkboardEvent(found.board.scope, userId, {
          boardId: found.board.id, cardId: r.value.card.id, kind: "sync", toStage: input.toStage,
          actor: userId, detail: { pendingPush: push },
        });
      }
    }
    return json({ card: r.value.card, fires: firing !== null, firing, pendingPush });
  }

  if (path === "/api/workboards/cards/move-many" && req.method === "POST") {
    const parsed = await body(req);
    if (!parsed.ok) return badJson();
    const input = parsed.value;
    const cardIds: string[] = Array.isArray(input.cardIds) ? input.cardIds : [];
    if (!cardIds.length) return json({ errors: ["cardIds is required"] }, 400);

    const first = findCardBoard(db, userId, cardIds[0]);
    if (!first) return json({ errors: ["no such card"] }, 404);

    // Every card must resolve to the SAME board as cardIds[0] before anything is moved or
    // fired — otherwise a mixed request would move a foreign card under the wrong board's
    // stage definitions and (if armed) fire an automation its real board never configured.
    const foreignIds: string[] = [];
    for (const id of cardIds.slice(1)) {
      const found = findCardBoard(db, userId, id);
      if (!found || found.board.id !== first.board.id) foreignIds.push(id);
    }
    if (foreignIds.length) {
      return json({ errors: [`cards not on board "${first.board.name}": ${foreignIds.join(", ")}`] }, 400);
    }

    const target = first.board.stages.find((s) => s.key === input.toStage);
    const armed = first.board.reactive && !!target?.onEnter;

    if (armed && !input.confirm && needsBulkConfirm(cardIds.length)) {
      return json({ needsConfirm: true, count: cardIds.length, stage: input.toStage });
    }

    const moved: string[] = [];
    const errors: string[] = [];
    for (const id of cardIds) {
      const r = moveCard(db, userId, first.board, id, input.toStage, userId);
      if (!r.ok) { errors.push(...r.errors.map((e) => `card ${id}: ${e}`)); continue; }
      moved.push(id);
      if (r.value.fires) {
        if (ctx.dispatchAgent) {
          await fireOnEnter(db, userId, first.board, r.value.card, r.value.fires, ctx.dispatchAgent);
        } else {
          db.enqueueWorkboardAction({
            userId, boardScope: first.board.scope, boardId: first.board.id,
            cardId: r.value.card.id, stageKey: r.value.card.stageKey, action: r.value.fires,
          });
        }
      }
    }
    return json({ moved: moved.length, errors });
  }

  const cardMatch = path.match(/^\/api\/workboards\/cards\/([\w-]+)$/);
  if (cardMatch && (req.method === "PATCH" || req.method === "DELETE")) {
    const found = findCardBoard(db, userId, cardMatch[1]);
    if (!found) return json({ errors: ["no such card"] }, 404);
    if (req.method === "DELETE") {
      const r = archiveCard(db, userId, found.board, cardMatch[1], userId);
      if (!r.ok) return json({ errors: r.errors }, 400);
      return json({ ok: true });
    }
    const parsed = await body(req);
    if (!parsed.ok) return badJson();
    const input = parsed.value;
    const r = updateCard(db, userId, found.board, found.card, { fields: input.fields, title: input.title }, userId);
    if (!r.ok) return json({ errors: r.errors }, 400);
    return json({ card: r.value });
  }

  const revMatch = path.match(/^\/api\/workboards\/([\w-]+)\/rev$/);
  if (revMatch && req.method === "GET") {
    const board = findBoardById(db, userId, revMatch[1]);
    if (!board) return json({ errors: ["no such board"] }, 404);
    return json({ rev: boardRevision(db, userId, board) });
  }

  const boardMatch = path.match(/^\/api\/workboards\/([\w-]+)$/);
  if (boardMatch && req.method === "GET") {
    const board = findBoardById(db, userId, boardMatch[1]);
    if (!board) return json({ errors: ["no such board"] }, 404);
    return json(boardPayload(db, userId, board));
  }

  if (boardMatch && req.method === "PATCH") {
    const board = findBoardById(db, userId, boardMatch[1]);
    if (!board) return json({ errors: ["no such board"] }, 404);
    if (board.system) return json({ errors: ["this board's schema and stages are locked"] }, 400);
    const parsed = await body(req);
    if (!parsed.ok) return badJson();
    const patch = parsed.value;

    if (patch.fields || patch.stages) {
      const defErrors = validateDefinition({
        name: patch.name ?? board.name,
        fields: patch.fields ?? board.fields,
        stages: patch.stages ?? board.stages,
      });
      if (defErrors.length) return json({ errors: defErrors }, 400);
    }

    if (patch.fields) {
      const diff = diffSchema(board.fields, patch.fields);
      if (diff.destructive && !patch.confirm) {
        return json({ needsConfirm: true, diff }, 200);
      }
      // Snapshot before mutating, backfill after, schema persisted last — wrapped in one
      // transaction so a crash mid-edit leaves the board untouched rather than half-migrated.
      const updated = db.withWorkboardTransaction(board.scope, userId, () => {
        if (diff.destructive) {
          // Snapshot AND rewrite in the same walk: a card that keeps a removed key, or a value the
          // new type can't take, fails validateCardFields forever after — every later edit, every
          // connector update. conformCardFields drops what the new schema no longer declares; the
          // event written below is what those values are recovered from.
          const preserved: { id: string; fields: Record<string, unknown> }[] = [];
          for (const page of allCardsForSchemaEdit(db, board, userId)) {
            for (const card of page) {
              preserved.push({ id: card.id, fields: card.fields });
              db.updateWorkboardCard(board.scope, userId, card.id, {
                fields: conformCardFields(patch.fields, card.fields),
              });
            }
          }
          db.insertWorkboardEvent(board.scope, userId, {
            boardId: board.id, kind: "updated", actor: userId,
            detail: { diff, preserved },
          });
        } else if (diff.added.length) {
          for (const page of allCardsForSchemaEdit(db, board, userId)) {
            for (const card of page) {
              const backfilled = { ...card.fields };
              for (const key of diff.added) backfilled[key] = null;
              db.updateWorkboardCard(board.scope, userId, card.id, { fields: backfilled });
            }
          }
        }
        return db.updateWorkboard(board.scope, userId, board.id, patch);
      });
      return json({ board: updated });
    }

    const updated = db.updateWorkboard(board.scope, userId, board.id, patch);
    return json({ board: updated });
  }

  return json({ errors: ["unknown workboard route"] }, 404);
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

const SHELL_CSS = `
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#06060b;--glass:rgba(255,255,255,.055);--glass-border:rgba(255,255,255,.10);
        --indigo:#6366f1;--text:rgba(255,255,255,.92);--dim:rgba(255,255,255,.5)}
  body{font-family:Inter,-apple-system,BlinkMacSystemFont,sans-serif;background:var(--bg);
       color:var(--text);font-size:13px;line-height:1.5;min-height:100vh;padding:24px}
  h1{font-size:18px;font-weight:600;margin-bottom:4px}
  .sub{color:var(--dim);margin-bottom:20px}
  a{color:inherit;text-decoration:none}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
  .card,.tile{background:var(--glass);border:1px solid var(--glass-border);border-radius:10px;padding:12px}
  .tile:hover{background:rgba(255,255,255,.08)}
  .stages{display:flex;gap:12px;align-items:flex-start;overflow-x:auto;padding-bottom:12px}
  .stage{flex:0 0 280px;background:rgba(255,255,255,.03);border:1px solid var(--glass-border);
         border-radius:12px;padding:10px;min-height:120px}
  .stage.over{border-color:var(--indigo)}
  .stage h2{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;
            display:flex;justify-content:space-between;margin-bottom:8px;color:var(--dim)}
  .card{margin-bottom:8px;cursor:grab}
  .card.dragging{opacity:.4}
  .card.moving{opacity:.5;cursor:wait}
  .card .t{font-weight:600;margin-bottom:4px}
  .card .f{color:var(--dim);font-size:12px}
  .armed{color:var(--indigo)}
  .total{font-variant-numeric:tabular-nums}
  .more{margin-top:6px;font-style:italic}
  .err{background:#ef4444;color:#fff;padding:8px 12px;border-radius:8px;position:fixed;
       bottom:16px;left:50%;transform:translateX(-50%);display:none}
`;

function shell(title: string, bodyHtml: string, script = ""): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nova — ${esc(title)}</title><style>${SHELL_CSS}</style></head>
<body>${bodyHtml}<div class="err" id="err"></div><script>${script}</script></body></html>`;
}

/** Shown instead of /kanban, /tickets, /workboards, or /workboards/:id for a session with no
 * per-user database (the master bootstrap login) — a clear stop, not a crash or a fake-empty board. */
export function renderWorkboardsUnavailable(): string {
  return shell("Workboards", `<h1>Workboards need a personal account</h1>
    <div class="sub">The master admin login has no per-user database, so it can't own or view a workboard.
    Sign in with a real user account to use Kanban, Tickets, or Workboards.</div>`);
}

export function renderWorkboardIndex(db: DatabaseType, userId: string): string {
  const boards = db.listWorkboardsVisible(userId);
  const tiles = boards.length
    ? boards.map((b) => {
        const count = boardCardCount(db, userId, b);
        return `<a class="tile" href="/workboards/${esc(b.id)}">
          <div class="t">${esc(b.name)}${b.reactive ? ' <span class="armed">•</span>' : ""}</div>
          <div class="f">${esc(b.purpose ?? "")}</div>
          <div class="f">${b.stages.length} stages · ${count} cards · ${esc(b.scope)}</div></a>`;
      }).join("")
    : `<div class="tile">No workboards yet. Create one with <code>nova workboard create</code>,
        or ask an agent to put a set of results on a board.</div>`;
  return shell("Workboards", `<h1>Workboards</h1>
    <div class="sub">Boards of structured cards. Agents fill them; you move them.</div>
    <div class="grid">${tiles}</div>`);
}

/** How often an open board asks whether another process changed it. */
export const REV_POLL_MS = 10000;

/** How long one of the viewer's own moves suppresses a reload. Two poll intervals, so a poll can
 * never land inside the window between a drag and the revision that drag produced. A shorter
 * window than the poll interval would let the very next poll reload the page under the viewer. */
export const OWN_MOVE_WINDOW_MS = REV_POLL_MS * 2;

/**
 * Client script is templated per-board so the SSE handler can scope reloads to the board the
 * page was actually rendered for. `boardId` and `rev` are embedded as JS string literals (not
 * HTML-escaped — this lands inside an inline <script>, not an HTML attribute); "</" is neutered
 * so neither can prematurely close the surrounding <script> tag.
 */
export function boardScript(boardId: string, rev = ""): string {
  const literal = (s: string) => JSON.stringify(s).replace(/<\//g, "<\\/");
  const boardIdLiteral = literal(boardId);
  return `
  var BOARD_ID=${boardIdLiteral};
  var REV=${literal(rev)};
  function showErr(msg){var e=document.getElementById('err');e.textContent=msg;e.style.display='block';
    setTimeout(function(){e.style.display='none'},4000);}
  var dragged=null;
  var OWN_MOVE_MS=${OWN_MOVE_WINDOW_MS};
  var ownMoves={}; // cardId -> timestamp of our own just-applied move, so neither the SSE handler nor the poll re-reloads it
  // Entries age out on their own. Nothing deletes one on arrival of an event: a cross-process move
  // produces no SSE event here at all, so an arrival-driven delete would both leave those entries
  // forever and cut the window short for the ones it does see.
  function pruneOwnMoves(){
    var now=Date.now();
    for(var k in ownMoves){if(now-ownMoves[k]>=OWN_MOVE_MS)delete ownMoves[k];}
  }
  function movedRecently(){
    var now=Date.now();
    for(var k in ownMoves){if(now-ownMoves[k]<OWN_MOVE_MS)return true;}
    return false;
  }
  // Adopt the marker our own write produced, so the next poll sees no change to react to.
  function adoptRev(){
    return fetch('/api/workboards/'+encodeURIComponent(BOARD_ID)+'/rev')
     .then(function(r){return r.json();})
     .then(function(b){if(b&&b.rev)REV=b.rev;})
     .catch(function(){});
  }
  document.querySelectorAll('.card').forEach(function(c){
    c.addEventListener('dragstart',function(e){
      if(c.dataset.moving){e.preventDefault();return;} // in-flight card: no second move until the first settles
      dragged=c;c.classList.add('dragging');
    });
    c.addEventListener('dragend',function(){c.classList.remove('dragging');});
  });
  document.querySelectorAll('.stage').forEach(function(col){
    col.addEventListener('dragover',function(e){e.preventDefault();col.classList.add('over');});
    col.addEventListener('dragleave',function(){col.classList.remove('over');});
    col.addEventListener('drop',function(e){
      e.preventDefault();col.classList.remove('over');
      if(!dragged)return;
      var card=dragged;dragged=null;
      if(card.dataset.moving)return; // belt-and-braces: ignore a drop of a card already in flight
      var from=card.parentElement,to=col.dataset.stage;
      if(from===col)return; // dropped back into its own stage — nothing to do
      card.dataset.moving='1';card.setAttribute('draggable','false');card.classList.add('moving');
      col.appendChild(card);
      fetch('/api/workboards/cards/'+card.dataset.id+'/move',{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({toStage:to})})
       .then(function(r){return r.json().then(function(b){return {ok:r.ok,body:b};});})
       .then(function(res){
         card.removeAttribute('data-moving');card.setAttribute('draggable','true');card.classList.remove('moving');
         if(!res.ok){from.appendChild(card);showErr((res.body.errors||['move failed']).join(', '));return;}
         ownMoves[card.dataset.id]=Date.now();
         adoptRev();
         var notices=[];
         if(res.body.firing==='queued')notices.push('Stage action queued — the relay will run it shortly.');
         else if(res.body.firing==='dispatched')notices.push('Stage action running — check activity.');
         if(res.body.pendingPush)notices.push('Stage synced locally. The '+res.body.pendingPush.connector+
           ' write was recorded in board history — run it yourself when you want it applied.');
         if(notices.length)showErr(notices.join(' '));
       })
       .catch(function(){
         card.removeAttribute('data-moving');card.setAttribute('draggable','true');card.classList.remove('moving');
         from.appendChild(card);showErr('move failed');
       });
    });
  });
  var lastReload=0;
  // SSE only carries events emitted in the dashboard's OWN process. A card an agent writes via the
  // CLI, or a stage the relay's drain touches, is invisible to it — so poll a cheap change marker
  // too. Adopting the new marker without reloading while our own write is settling keeps a drag
  // from bouncing the page.
  setInterval(function(){
    pruneOwnMoves();
    fetch('/api/workboards/'+encodeURIComponent(BOARD_ID)+'/rev')
     .then(function(r){return r.json();})
     .then(function(b){
       if(!b||!b.rev||b.rev===REV)return;
       REV=b.rev;
       if(movedRecently())return;
       var now=Date.now();
       if(now-lastReload<3000)return;
       lastReload=now;
       location.reload();
     })
     .catch(function(){});
  },${REV_POLL_MS});
  var es=new EventSource('/api/activity/stream');
  es.addEventListener('message',function(ev){
    try{
      var d=JSON.parse(ev.data);
      if(!d||!d.type||d.type.indexOf('workboard.')!==0)return;
      var data=d.data||{};
      if(!data.boardId||data.boardId!==BOARD_ID)return; // not this board (or board id not present — don't assume)
      var cardId=data.cardId;
      if(cardId&&ownMoves[cardId]&&(Date.now()-ownMoves[cardId])<OWN_MOVE_MS){
        return; // our own successful move, already applied optimistically — the entry ages out
      }
      var now=Date.now();
      if(now-lastReload<3000)return; // debounce a burst or replay so it can't loop the page
      lastReload=now;
      location.reload();
    }catch(e){}
  });
`;
}

export function renderWorkboard(db: DatabaseType, userId: string, boardId: string): string {
  const board = db.listWorkboardsVisible(userId).find((b) => b.id === boardId);
  if (!board) return shell("Workboard", `<h1>Workboard not found</h1>
    <div class="sub"><a href="/workboards">Back to workboards</a></div>`);

  const payload = boardPayload(db, userId, board);
  const primaries = board.fields.filter((f) => f.primary).slice(0, 3);
  // `nova workboard query` reads workboard_cards, so it can't show the rest of an adapter-backed
  // board — pointing a viewer at it there would be the same empty promise the marker just fixed.
  const seeTheRest = getCardSource(board.source)
    ? "this board reads from another table and shows only its most recently updated rows"
    : "open the board's stage in the CLI (<code>nova workboard query</code>) to see the rest";

  const columns = payload.stages.map((s) => {
    const cards = payload.cards[s.key] ?? [];
    const cardHtml = cards.map((c) => {
      const lines = primaries.map((f) => `${esc(f.label)}: ${esc(c.fields[f.key] ?? "—")}`).join(" · ");
      return `<div class="card" draggable="true" data-id="${esc(c.id)}">
        <div class="t">${esc(c.title)}</div><div class="f">${lines}</div></div>`;
    }).join("");
    const totalHtml = s.total !== null ? ` <span class="total">${s.total.toLocaleString("en-US")}</span>` : "";
    const moreHtml = s.shown < s.count
      ? `<div class="f more">Showing ${s.shown} of ${s.count} — ${seeTheRest}</div>`
      : "";
    return `<div class="stage" data-stage="${esc(s.key)}">
      <h2><span>${esc(s.label)}${s.armed ? ' <span class="armed">⚡</span>' : ""}</span>
      <span>${s.count}${totalHtml}</span></h2>${cardHtml}${moreHtml}</div>`;
  }).join("");

  return shell(board.name, `<h1>${esc(board.name)}</h1>
    <div class="sub">${esc(board.purpose ?? "")} · <a href="/workboards">all workboards</a></div>
    <div class="stages">${columns}</div>`, boardScript(board.id, boardRevision(db, userId, board)));
}
