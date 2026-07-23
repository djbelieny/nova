/**
 * Workboards dashboard surface — API handlers and page renderers.
 *
 * Lives outside dashboard.ts (already >10k lines): dashboard.ts delegates here and stays a router.
 */

import { addCards, createBoard, deriveTitle, moveCard } from "./workboard-service.ts";
import { validateCardFields } from "./workboards.ts";
import type { DatabaseType, Workboard, WorkboardCard } from "./db.ts";

export interface WorkboardApiCtx { db: DatabaseType; userId: string; }

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

async function body(req: Request): Promise<any> {
  try { return await req.json(); } catch { return {}; }
}

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
    const input = await body(req);
    const r = createBoard(db, userId, input);
    return r.ok ? json({ board: r.value }) : json({ errors: r.errors }, 400);
  }

  const cardsMatch = path.match(/^\/api\/workboards\/([\w-]+)\/cards$/);
  if (cardsMatch && req.method === "POST") {
    const board = findBoardById(db, userId, cardsMatch[1]);
    if (!board) return json({ errors: ["no such board"] }, 404);
    const input = await body(req);
    const records = Array.isArray(input.records) ? input.records : [{ title: input.title, fields: input.fields ?? {} }];
    const r = addCards(db, userId, board, input.stageKey, records, "user");
    return r.ok ? json({ cards: r.value }) : json({ errors: r.errors }, 400);
  }

  const moveMatch = path.match(/^\/api\/workboards\/cards\/([\w-]+)\/move$/);
  if (moveMatch && req.method === "POST") {
    const found = findCardBoard(db, userId, moveMatch[1]);
    if (!found) return json({ errors: ["no such card"] }, 404);
    const input = await body(req);
    const r = moveCard(db, userId, found.board, moveMatch[1], input.toStage, userId, {
      beforeId: input.beforeId, afterId: input.afterId,
    });
    return r.ok ? json({ card: r.value.card, fires: !!r.value.fires }) : json({ errors: r.errors }, 400);
  }

  const cardMatch = path.match(/^\/api\/workboards\/cards\/([\w-]+)$/);
  if (cardMatch && (req.method === "PATCH" || req.method === "DELETE")) {
    const found = findCardBoard(db, userId, cardMatch[1]);
    if (!found) return json({ errors: ["no such card"] }, 404);
    if (req.method === "DELETE") {
      db.updateWorkboardCard(found.board.scope, userId, cardMatch[1], { archived: true });
      db.insertWorkboardEvent(found.board.scope, userId, {
        boardId: found.board.id, cardId: cardMatch[1], kind: "archived", actor: userId,
      });
      return json({ ok: true });
    }
    const input = await body(req);
    const merged = { ...found.card.fields, ...(input.fields ?? {}) };
    const validated = validateCardFields(found.board.fields, merged);
    if (!validated.ok) return json({ errors: validated.errors }, 400);
    const updated = db.updateWorkboardCard(found.board.scope, userId, cardMatch[1], {
      fields: validated.values,
      title: deriveTitle(found.board.fields, validated.values, input.title),
    });
    db.insertWorkboardEvent(found.board.scope, userId, {
      boardId: found.board.id, cardId: cardMatch[1], kind: "updated", actor: userId, detail: { before: found.card.fields },
    });
    return json({ card: updated });
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
    const patch = await body(req);
    const updated = db.updateWorkboard(board.scope, userId, board.id, patch);
    return json({ board: updated });
  }

  return json({ errors: ["unknown workboard route"] }, 404);
}
