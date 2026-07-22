/**
 * Out-of-office delegation — route work (assignments, approvals, escalations) to a delegate
 * while someone is away. Follows a short delegation chain, guarding against cycles.
 */

import type { Database } from './db';

export interface ResolvedApprover { userId: string; viaDelegate: boolean; hops: number; }

/**
 * Resolve who should actually act for a user right now: if they have an active out-of-office
 * delegation, follow it (up to a few hops), avoiding cycles. Returns the original user when
 * there's no active delegation.
 */
export function resolveApprover(db: Database, userId: string, maxHops = 5): ResolvedApprover {
  const seen = new Set<string>([userId]);
  let current = userId;
  let hops = 0;
  for (let i = 0; i < maxHops; i++) {
    const d = db.getActiveDelegation(current);
    if (!d || !d.delegateUserId) break;
    if (seen.has(d.delegateUserId)) break; // cycle guard
    current = d.delegateUserId;
    seen.add(current);
    hops++;
  }
  return { userId: current, viaDelegate: hops > 0, hops };
}
