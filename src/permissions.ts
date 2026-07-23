/**
 * Capability-based permissions (RBAC) for governed management actions.
 *
 * Admins can do everything (unchanged from today). Members need an explicit capability
 * grant. Enforcement points (CLI, dashboard write routes) call `hasCapability`; with no
 * grants and admin-only management, behavior is identical to before.
 */

import type { Database } from './db';

export const CAPABILITIES = [
  'automation.manage',
  'policy.manage',
  'connector.manage',
  'playbook.manage',
  'process.manage',
  'workboard.manage',
  'access.manage',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export function isCapability(x: string): x is Capability {
  return (CAPABILITIES as readonly string[]).includes(x);
}

/** True if the user may perform a governed action: admins always; members if granted. */
export function hasCapability(db: Database, userId: string, capability: Capability): boolean {
  try {
    const u = db.getUserById(userId);
    if (u?.role === 'admin') return true;
    return db.hasCapabilityGrant(userId, capability);
  } catch {
    return false;
  }
}

/** Throwing guard for imperative call sites. */
export function requireCapability(db: Database, userId: string, capability: Capability): void {
  if (!hasCapability(db, userId, capability)) {
    throw new Error(`permission denied: ${capability}`);
  }
}
