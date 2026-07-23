/**
 * Workboards dashboard surface — API handlers and page renderers.
 *
 * Lives outside dashboard.ts (already >10k lines): dashboard.ts delegates here and stays a router.
 */

import { addCards, archiveCard, createBoard, moveCard, updateCard } from "./workboard-service.ts";
import { fireOnEnter, needsBulkConfirm } from "./workboard-reactive.ts";
import type { DispatchAgentFn } from "./automation-engine.ts";
import type { DatabaseType, Workboard, WorkboardCard } from "./db.ts";

export interface WorkboardApiCtx { db: DatabaseType; userId: string; dispatchAgent?: DispatchAgentFn; }

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

/** Everything a board page needs in one payload. */
export function boardPayload(db: DatabaseType, userId: string, board: Workboard) {
  const cards = db.listWorkboardCards(board.scope, userId, board.id);
  const byStage: Record<string, WorkboardCard[]> = {};
  for (const s of board.stages) byStage[s.key] = [];
  for (const c of cards) (byStage[c.stageKey] ??= []).push(c);
  return {
    board: {
      id: board.id, name: board.name, purpose: board.purpose, reactive: board.reactive,
      system: board.system, source: board.source, fields: board.fields,
    },
    stages: board.stages.map((s) => ({
      ...s,
      count: byStage[s.key]?.length ?? 0,
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

/** Returns null when `path` is not a workboard route, so dashboard.ts can fall through. */
export async function handleWorkboardApi(path: string, req: Request, ctx: WorkboardApiCtx): Promise<Response | null> {
  if (!path.startsWith("/api/workboards")) return null;
  const { db, userId } = ctx;

  if (path === "/api/workboards" && req.method === "GET") {
    const boards = db.listWorkboardsVisible(userId).map((b) => ({
      id: b.id, name: b.name, purpose: b.purpose, scope: b.scope, reactive: b.reactive,
      stages: b.stages.length, cards: db.listWorkboardCards(b.scope, userId, b.id).length,
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
    const parsed = await body(req);
    if (!parsed.ok) return badJson();
    const input = parsed.value;
    const records = Array.isArray(input.records) ? input.records : [{ title: input.title, fields: input.fields ?? {} }];
    const r = addCards(db, userId, board, input.stageKey, records, "user");
    return r.ok ? json({ cards: r.value }) : json({ errors: r.errors }, 400);
  }

  const moveMatch = path.match(/^\/api\/workboards\/cards\/([\w-]+)\/move$/);
  if (moveMatch && req.method === "POST") {
    const found = findCardBoard(db, userId, moveMatch[1]);
    if (!found) return json({ errors: ["no such card"] }, 404);
    const parsed = await body(req);
    if (!parsed.ok) return badJson();
    const input = parsed.value;
    const r = moveCard(db, userId, found.board, moveMatch[1], input.toStage, userId, {
      beforeId: input.beforeId, afterId: input.afterId,
    });
    if (!r.ok) return json({ errors: r.errors }, 400);
    let fired = false;
    if (r.value.fires && ctx.dispatchAgent) {
      const outcome = await fireOnEnter(db, userId, found.board, r.value.card, r.value.fires, ctx.dispatchAgent);
      fired = outcome.fired;
    }
    return json({ card: r.value.card, fires: fired });
  }

  if (path === "/api/workboards/cards/move-many" && req.method === "POST") {
    const parsed = await body(req);
    if (!parsed.ok) return badJson();
    const input = parsed.value;
    const cardIds: string[] = Array.isArray(input.cardIds) ? input.cardIds : [];
    if (!cardIds.length) return json({ errors: ["cardIds is required"] }, 400);

    const first = findCardBoard(db, userId, cardIds[0]);
    if (!first) return json({ errors: ["no such card"] }, 404);
    const target = first.board.stages.find((s) => s.key === input.toStage);
    const armed = first.board.reactive && !!target?.onEnter;

    if (armed && !input.confirm && needsBulkConfirm(cardIds.length)) {
      return json({ needsConfirm: true, count: cardIds.length, stage: input.toStage });
    }

    const moved: string[] = [];
    const errors: string[] = [];
    for (const id of cardIds) {
      const r = moveCard(db, userId, first.board, id, input.toStage, userId);
      if (!r.ok) { errors.push(...r.errors); continue; }
      moved.push(id);
      if (r.value.fires && ctx.dispatchAgent) {
        await fireOnEnter(db, userId, first.board, r.value.card, r.value.fires, ctx.dispatchAgent);
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
    const updated = db.updateWorkboard(board.scope, userId, board.id, parsed.value);
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

export function renderWorkboardIndex(db: DatabaseType, userId: string): string {
  const boards = db.listWorkboardsVisible(userId);
  const tiles = boards.length
    ? boards.map((b) => {
        const count = db.listWorkboardCards(b.scope, userId, b.id).length;
        return `<a class="tile" href="/workboards/${esc(b.id)}">
          <div class="t">${esc(b.name)}${b.reactive ? ' <span class="armed">•</span>' : ""}</div>
          <div class="f">${esc(b.purpose ?? "")}</div>
          <div class="f">${b.stages.length} stages · ${count} cards · ${esc(b.scope)}</div></a>`;
      }).join("")
    : `<div class="tile">No workboards yet. Ask Nova in chat to create one.</div>`;
  return shell("Workboards", `<h1>Workboards</h1>
    <div class="sub">Boards of structured cards. Agents fill them; you move them.</div>
    <div class="grid">${tiles}</div>`);
}

/**
 * Client script is templated per-board so the SSE handler can scope reloads to the board the
 * page was actually rendered for. `boardId` is embedded as a JS string literal (not HTML-escaped
 * — this lands inside an inline <script>, not an HTML attribute); "</" is neutered so a board id
 * can never prematurely close the surrounding <script> tag.
 */
function boardScript(boardId: string): string {
  const boardIdLiteral = JSON.stringify(boardId).replace(/<\//g, "<\\/");
  return `
  var BOARD_ID=${boardIdLiteral};
  function showErr(msg){var e=document.getElementById('err');e.textContent=msg;e.style.display='block';
    setTimeout(function(){e.style.display='none'},4000);}
  var dragged=null;
  var ownMoves={}; // cardId -> timestamp of our own just-applied move, so the SSE handler doesn't re-reload it
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
         if(res.body.fires)showErr('Stage action running — check activity.');
       })
       .catch(function(){
         card.removeAttribute('data-moving');card.setAttribute('draggable','true');card.classList.remove('moving');
         from.appendChild(card);showErr('move failed');
       });
    });
  });
  var lastReload=0;
  var es=new EventSource('/api/activity/stream');
  es.addEventListener('message',function(ev){
    try{
      var d=JSON.parse(ev.data);
      if(!d||!d.type||d.type.indexOf('workboard.')!==0)return;
      var data=d.data||{};
      if(!data.boardId||data.boardId!==BOARD_ID)return; // not this board (or board id not present — don't assume)
      var cardId=data.cardId;
      if(cardId&&ownMoves[cardId]&&(Date.now()-ownMoves[cardId])<5000){
        delete ownMoves[cardId];return; // our own successful move, already applied optimistically
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
  const money = board.fields.find((f) => f.type === "money" || f.type === "number");
  const primaries = board.fields.filter((f) => f.primary).slice(0, 3);

  const columns = payload.stages.map((s) => {
    const cards = payload.cards[s.key] ?? [];
    const total = money
      ? cards.reduce((sum, c) => sum + (Number(c.fields[money.key]) || 0), 0)
      : null;
    const cardHtml = cards.map((c) => {
      const lines = primaries.map((f) => `${esc(f.label)}: ${esc(c.fields[f.key] ?? "—")}`).join(" · ");
      return `<div class="card" draggable="true" data-id="${esc(c.id)}">
        <div class="t">${esc(c.title)}</div><div class="f">${lines}</div></div>`;
    }).join("");
    const totalHtml = total !== null ? ` <span class="total">${total.toLocaleString("en-US")}</span>` : "";
    return `<div class="stage" data-stage="${esc(s.key)}">
      <h2><span>${esc(s.label)}${s.armed ? ' <span class="armed">⚡</span>' : ""}</span>
      <span>${s.count}${totalHtml}</span></h2>${cardHtml}</div>`;
  }).join("");

  return shell(board.name, `<h1>${esc(board.name)}</h1>
    <div class="sub">${esc(board.purpose ?? "")} · <a href="/workboards">all workboards</a></div>
    <div class="stages">${columns}</div>`, boardScript(board.id));
}
