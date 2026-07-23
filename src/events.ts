/**
 * Nova Event Bus — Structured Observability
 *
 * Lightweight in-process event emitter that all modules publish to.
 * Replaces scattered console.log calls with structured events consumed by:
 * - Console logger (backwards-compatible [module] format)
 * - DB persister (async, batched writes to shared.db logs table)
 * - SSE broadcaster (real-time dashboard updates)
 * - Telegram forwarder (error alerts + activity digests)
 */

import type { Database } from "./db.ts";

// ============================================================
// Event Types
// ============================================================

export type NovaEventType =
  | "message.received"
  | "message.classified"
  | "message.responded"
  | "agent.dispatched"
  | "agent.progress"
  | "agent.completed"
  | "agent.start"
  | "agent.step"
  | "agent.finish"
  | "agent.end"
  | "agent.error"
  | "pipeline.start"
  | "pipeline.finish"
  | "task.created"
  | "task.status"
  | "task.completed"
  | "task.retry"
  | "approval.requested"
  | "approval.resolved"
  | "chat.reply"
  | "chat.update"
  | "exec.message"
  | "exec.delegation"
  | "exec.heartbeat"
  | "board.convened"
  | "board.contribution"
  | "board.decision"
  | "workboard.cards.created"
  | "workboard.card.moved"
  | "workboard.card.updated"
  | "cost.tracked"
  | "agent.message"
  | "budget.spend"
  | "goal.reviewed"
  | "webhook.triggered"
  | "error"
  | "system.health";

export type EventLevel = "debug" | "info" | "warn" | "error";

export interface NovaEvent {
  type: NovaEventType;
  timestamp: string;
  requestId?: string;
  userId?: string;
  agentSlug?: string;
  execRole?: string;
  agentDisplayName?: string;
  stepMessage?: string;
  data: Record<string, any>;
  level: EventLevel;
}

// ============================================================
// Listener type
// ============================================================

type EventListener = (event: NovaEvent) => void;

// ============================================================
// Event Bus (singleton)
// ============================================================

const listeners: EventListener[] = [];
let _db: Database | null = null;
let _dbBatch: NovaEvent[] = [];
let _dbFlushTimer: ReturnType<typeof setTimeout> | null = null;
const DB_FLUSH_INTERVAL = 2000; // flush every 2s
const DB_BATCH_SIZE = 50;

// SSE connections for dashboard
const sseConnections = new Set<ReadableStreamDefaultController<Uint8Array>>();
const MAX_SSE_CONNECTIONS = 10;
const SSE_IDLE_TIMEOUT = 5 * 60 * 1000; // 5 min

// Telegram digest state
let _telegramNotify: ((text: string) => Promise<void>) | null = null;
let _digestInterval: ReturnType<typeof setInterval> | null = null;
let _digestStats = { tasks_completed: 0, agents_active: 0, approvals_pending: 0, cost_usd: 0, errors: 0 };

// ============================================================
// Init
// ============================================================

export function initEventBus(opts: {
  db?: Database | null;
  telegramNotify?: (text: string) => Promise<void>;
  digestIntervalMs?: number;
}): void {
  _db = opts.db || null;
  _telegramNotify = opts.telegramNotify || null;

  // Register default listeners
  addListener(consoleListener);
  addListener(dbListener);
  addListener(sseListener);
  addListener(digestListener);

  if (opts.telegramNotify) {
    addListener(telegramErrorListener);
  }

  // Start digest if configured
  if (opts.digestIntervalMs && opts.digestIntervalMs > 0 && opts.telegramNotify) {
    startDigest(opts.digestIntervalMs);
  }

  // Start DB flush timer
  _dbFlushTimer = setInterval(flushDbBatch, DB_FLUSH_INTERVAL);
}

// ============================================================
// Core API
// ============================================================

export function emit(event: Omit<NovaEvent, "timestamp"> & { timestamp?: string }): void {
  const fullEvent: NovaEvent = {
    ...event,
    timestamp: event.timestamp || new Date().toISOString(),
  };
  for (const listener of listeners) {
    try {
      listener(fullEvent);
    } catch (err) {
      // Don't let listener errors crash the emitter
      console.error("[events] Listener error:", err);
    }
  }
}

export function addListener(listener: EventListener): void {
  listeners.push(listener);
}

export function removeListener(listener: EventListener): void {
  const idx = listeners.indexOf(listener);
  if (idx >= 0) listeners.splice(idx, 1);
}

// ============================================================
// Console Listener — backwards-compatible [module] format
// ============================================================

const EVENT_TO_MODULE: Record<string, string> = {
  "message.received": "relay",
  "message.classified": "orchestrator",
  "message.responded": "relay",
  "agent.dispatched": "planner",
  "agent.progress": "planner",
  "agent.completed": "planner",
  "agent.start": "planner",
  "agent.step": "planner",
  "agent.finish": "planner",
  "pipeline.start": "orchestrator",
  "pipeline.finish": "orchestrator",
  "task.created": "orchestrator",
  "task.status": "orchestrator",
  "task.completed": "orchestrator",
  "approval.requested": "orchestrator",
  "approval.resolved": "orchestrator",
  "exec.message": "exec",
  "exec.delegation": "coo-pipeline",
  "exec.heartbeat": "exec",
  "board.convened": "board",
  "board.contribution": "board",
  "board.decision": "board",
  "workboard.cards.created": "workboard",
  "workboard.card.moved": "workboard",
  "workboard.card.updated": "workboard",
  "cost.tracked": "cost",
  "agent.message": "agent-inbox",
  "budget.spend": "budget",
  "goal.reviewed": "goal-engine",
  "webhook.triggered": "webhook",
  "error": "error",
  "system.health": "health",
};

function consoleListener(event: NovaEvent): void {
  const module = event.data?.module || EVENT_TO_MODULE[event.type] || event.type.split(".")[0];
  const msg = event.data?.message || event.data?.description || event.type;
  const prefix = `[${module}]`;

  switch (event.level) {
    case "debug":
      // Skip debug by default unless DEBUG env is set
      if (process.env.DEBUG) console.debug(prefix, msg);
      break;
    case "warn":
      console.warn(prefix, msg);
      break;
    case "error":
      console.error(prefix, msg, event.data?.error || "");
      break;
    default:
      console.log(prefix, msg);
  }
}

// ============================================================
// DB Listener — async batched writes to logs table
// ============================================================

function dbListener(event: NovaEvent): void {
  if (!_db) return;
  // Skip debug events from DB to reduce noise
  if (event.level === "debug") return;

  _dbBatch.push(event);
  if (_dbBatch.length >= DB_BATCH_SIZE) {
    flushDbBatch();
  }
}

function flushDbBatch(): void {
  if (!_db || _dbBatch.length === 0) return;
  const batch = _dbBatch;
  _dbBatch = [];

  // Fire and forget — don't block the event loop
  try {
    for (const event of batch) {
      _db.insertLog({
        level: event.level,
        event: event.type,
        message: event.data?.message || event.data?.description || "",
        metadata: {
          ...event.data,
          requestId: event.requestId,
          agentSlug: event.agentSlug,
          execRole: event.execRole,
        },
        user_id: event.userId,
      });
    }
  } catch (err) {
    console.error("[events] DB flush error:", err);
  }
}

// ============================================================
// SSE Listener — real-time dashboard streaming
// ============================================================

function sseListener(event: NovaEvent): void {
  if (sseConnections.size === 0) return;
  // Skip debug from SSE
  if (event.level === "debug") return;

  const data = JSON.stringify(event);
  const message = new TextEncoder().encode(`data: ${data}\n\n`);

  for (const controller of sseConnections) {
    try {
      controller.enqueue(message);
    } catch {
      // Connection closed, will be cleaned up by close handler
      sseConnections.delete(controller);
    }
  }
}

/**
 * Create an SSE Response for the dashboard.
 * Returns null if max connections reached.
 */
export function createSSEStream(): Response | null {
  if (sseConnections.size >= MAX_SSE_CONNECTIONS) {
    return null;
  }

  let controller: ReadableStreamDefaultController<Uint8Array>;
  let idleTimer: ReturnType<typeof setTimeout>;
  let keepaliveTimer: ReturnType<typeof setInterval>;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      sseConnections.add(controller);

      // Send initial keepalive
      controller.enqueue(new TextEncoder().encode(": connected\n\n"));

      // Periodic keepalive every 15s to prevent browser/proxy timeout
      keepaliveTimer = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode(": ping\n\n"));
        } catch {
          clearInterval(keepaliveTimer);
          sseConnections.delete(controller);
        }
      }, 15_000);

      // Auto-close after idle timeout
      idleTimer = setTimeout(() => {
        clearInterval(keepaliveTimer);
        try {
          controller.close();
        } catch {}
        sseConnections.delete(controller);
      }, SSE_IDLE_TIMEOUT);
    },
    cancel() {
      clearTimeout(idleTimer);
      clearInterval(keepaliveTimer);
      sseConnections.delete(controller);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ============================================================
// Telegram Error Listener — immediate alerts for errors
// ============================================================

function telegramErrorListener(event: NovaEvent): void {
  if (event.level !== "error" || !_telegramNotify) return;

  const msg = event.data?.message || event.type;
  const module = event.data?.module || EVENT_TO_MODULE[event.type] || "unknown";
  const text = `⚠️ Nova Error [${module}]\n${msg}${event.data?.error ? `\n${String(event.data.error).substring(0, 200)}` : ""}`;

  _telegramNotify(text).catch(() => {});
}

// ============================================================
// Digest Listener — tracks stats for periodic summary
// ============================================================

function digestListener(event: NovaEvent): void {
  switch (event.type) {
    case "task.completed":
    case "agent.completed":
      _digestStats.tasks_completed++;
      break;
    case "agent.dispatched":
      _digestStats.agents_active++;
      break;
    case "approval.requested":
      _digestStats.approvals_pending++;
      break;
    case "approval.resolved":
      _digestStats.approvals_pending = Math.max(0, _digestStats.approvals_pending - 1);
      break;
    case "cost.tracked":
      _digestStats.cost_usd += event.data?.cost_usd || 0;
      break;
    case "error":
      _digestStats.errors++;
      break;
  }
}

function startDigest(intervalMs: number): void {
  if (_digestInterval) clearInterval(_digestInterval);
  _digestInterval = setInterval(async () => {
    if (!_telegramNotify) return;
    const s = _digestStats;
    // Only send if there's activity
    if (s.tasks_completed === 0 && s.agents_active === 0 && s.errors === 0) return;

    const text = [
      "📊 Nova Activity Digest",
      `• ${s.tasks_completed} task(s) completed`,
      `• ${s.agents_active} agent dispatch(es)`,
      s.approvals_pending > 0 ? `• ${s.approvals_pending} approval(s) pending` : null,
      s.errors > 0 ? `• ${s.errors} error(s)` : null,
      `• $${s.cost_usd.toFixed(4)} spent`,
    ].filter(Boolean).join("\n");

    await _telegramNotify(text).catch(() => {});

    // Reset stats
    _digestStats = { tasks_completed: 0, agents_active: 0, approvals_pending: 0, cost_usd: 0, errors: 0 };
  }, intervalMs);
}

// ============================================================
// Stall Detection
// ============================================================

const activeAgents = new Map<string, { startedAt: number; description: string; requestId?: string }>();
const STALL_THRESHOLD = 10 * 60 * 1000; // 10 minutes
let _stallCheckInterval: ReturnType<typeof setInterval> | null = null;

export function startStallDetection(checkIntervalMs = 60_000): void {
  if (_stallCheckInterval) clearInterval(_stallCheckInterval);

  // Track agent starts/completions
  addListener((event) => {
    if (event.type === "agent.dispatched" && event.agentSlug) {
      const key = event.requestId || event.agentSlug;
      activeAgents.set(key, {
        startedAt: Date.now(),
        description: event.data?.description || event.agentSlug,
        requestId: event.requestId,
      });
    }
    if ((event.type === "agent.completed") && event.agentSlug) {
      const key = event.requestId || event.agentSlug;
      activeAgents.delete(key);
    }
  });

  _stallCheckInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, info] of activeAgents) {
      if (now - info.startedAt > STALL_THRESHOLD) {
        emit({
          type: "error",
          level: "warn",
          data: {
            module: "stall-detector",
            message: `Agent stalled: ${info.description} (${Math.round((now - info.startedAt) / 60000)}min)`,
            agentKey: key,
          },
          requestId: info.requestId,
        });
        activeAgents.delete(key); // Only alert once
      }
    }
  }, checkIntervalMs);
}

// ============================================================
// Query helpers (for dashboard API)
// ============================================================

export function getActiveAgents(): Array<{ key: string; description: string; startedAt: number; elapsedMs: number; requestId?: string }> {
  const now = Date.now();
  return Array.from(activeAgents.entries()).map(([key, info]) => ({
    key,
    description: info.description,
    startedAt: info.startedAt,
    elapsedMs: now - info.startedAt,
    requestId: info.requestId,
  }));
}

export function getSSEConnectionCount(): number {
  return sseConnections.size;
}

// ============================================================
// Cleanup
// ============================================================

export function shutdownEventBus(): void {
  if (_dbFlushTimer) clearInterval(_dbFlushTimer);
  if (_digestInterval) clearInterval(_digestInterval);
  if (_stallCheckInterval) clearInterval(_stallCheckInterval);
  flushDbBatch();
  for (const controller of sseConnections) {
    try { controller.close(); } catch {}
  }
  sseConnections.clear();
  listeners.length = 0;
}
