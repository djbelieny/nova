/**
 * Best-effort advisory locking over the shared database, so periodic loops (the automation
 * poller, the task dispatcher) don't double-fire when ticks overlap or multiple instances
 * run. Single-node: prevents overlapping ticks. Multi-node: prevents cross-node double work.
 * If the lock can't be acquired, the caller simply skips this round.
 */

import { randomUUID } from 'crypto';
import type { Database } from './db';

/** A stable-per-process holder id (so a process can renew its own lock). */
export const PROCESS_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;

export interface LockRunResult<T> { ran: boolean; result?: T; }

/**
 * Run `fn` only if the named lock can be acquired; release it afterward. Returns
 * `{ ran: false }` without running when another holder owns the lock.
 */
export async function withLock<T>(
  db: Database,
  name: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
  holder: string = PROCESS_ID
): Promise<LockRunResult<T>> {
  if (!db.acquireLock(name, holder, ttlSeconds)) return { ran: false };
  try {
    const result = await fn();
    return { ran: true, result };
  } finally {
    try { db.releaseLock(name, holder); } catch { /* lock will expire on its own */ }
  }
}
