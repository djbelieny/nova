import type { Database } from "./db.ts";

export type TrustLevel = 0 | 1 | 2 | 3;

export interface TrustScore {
  taskType: string;
  userId: string;
  level: TrustLevel;
  successCount: number;
  lastSuccess: string | null;
  lastFailure: string | null;
  manuallySet: boolean;
}

export interface ActionMeta {
  isExternal?: boolean;
  amountUsd?: number;
  modifiesSharedData?: boolean;
  alwaysAsk?: boolean;
}

export interface TrustGateResult {
  requiresApproval: boolean;
  requiresNotification: boolean;
  reason: string;
}

const TRUST_HARD_OVERRIDE_AMOUNT_USD = 50;
const TRUST_DECAY_DAYS = 30;

const PROMOTION_THRESHOLDS: Record<number, number> = {
  0: 3,
  1: 10,
  2: 20,
};

function clampLevel(n: number): TrustLevel {
  return Math.max(0, Math.min(3, n)) as TrustLevel;
}

function daysSince(isoDate: string | null): number {
  if (!isoDate) return Infinity;
  return (Date.now() - new Date(isoDate).getTime()) / (1000 * 60 * 60 * 24);
}

export async function getTrustLevel(
  db: Database,
  userId: string,
  taskType: string,
): Promise<TrustLevel> {
  const row = db.getTrustScore(userId, taskType);
  if (!row) return 0;

  let level = clampLevel(row.level);

  if (!row.manually_set && level > 0) {
    const lastActivity = row.last_success ?? row.last_failure;
    if (daysSince(lastActivity) > TRUST_DECAY_DAYS) {
      level = clampLevel(level - 1);
      db.upsertTrustScore(userId, taskType, { level, success_count: row.success_count });
    }
  }

  return level;
}

export async function recordSuccess(
  db: Database,
  userId: string,
  taskType: string,
): Promise<TrustLevel> {
  const row = db.getTrustScore(userId, taskType);
  const current = row ? clampLevel(row.level) : 0;
  const successCount = (row?.success_count ?? 0) + 1;

  let newLevel = current;
  const threshold = PROMOTION_THRESHOLDS[current];
  if (threshold !== undefined && successCount >= threshold) {
    newLevel = clampLevel(current + 1);
  }

  db.upsertTrustScore(userId, taskType, {
    level: newLevel,
    success_count: successCount,
    last_success: new Date().toISOString(),
    manually_set: row?.manually_set ?? false,
  });

  return newLevel;
}

export async function recordFailure(
  db: Database,
  userId: string,
  taskType: string,
): Promise<void> {
  const row = db.getTrustScore(userId, taskType);
  db.upsertTrustScore(userId, taskType, {
    level: 0,
    success_count: row?.success_count ?? 0,
    last_failure: new Date().toISOString(),
    manually_set: row?.manually_set ?? false,
  });
}

export function checkTrustGate(
  level: TrustLevel,
  actionMeta: ActionMeta,
): TrustGateResult {
  if (actionMeta.alwaysAsk) {
    return { requiresApproval: true, requiresNotification: true, reason: "always_ask_flagged" };
  }

  if (actionMeta.isExternal) {
    return { requiresApproval: level < 2, requiresNotification: true, reason: "external_action" };
  }

  if (actionMeta.amountUsd !== undefined && actionMeta.amountUsd > TRUST_HARD_OVERRIDE_AMOUNT_USD) {
    return { requiresApproval: true, requiresNotification: true, reason: `amount_exceeds_$${TRUST_HARD_OVERRIDE_AMOUNT_USD}` };
  }

  if (actionMeta.modifiesSharedData) {
    return { requiresApproval: level < 1, requiresNotification: level < 2, reason: "modifies_shared_data" };
  }

  if (level === 0) {
    return { requiresApproval: true, requiresNotification: true, reason: "trust_level_0" };
  }
  if (level === 1) {
    return { requiresApproval: false, requiresNotification: true, reason: "trust_level_1" };
  }
  if (level === 2) {
    return { requiresApproval: false, requiresNotification: false, reason: "trust_level_2" };
  }
  return { requiresApproval: false, requiresNotification: false, reason: "trust_level_3_silent" };
}

export async function setTrustLevel(
  db: Database,
  userId: string,
  taskType: string,
  level: TrustLevel,
): Promise<void> {
  const row = db.getTrustScore(userId, taskType);
  db.upsertTrustScore(userId, taskType, {
    level,
    success_count: row?.success_count ?? 0,
    last_success: row?.last_success ?? null,
    last_failure: row?.last_failure ?? null,
    manually_set: true,
  });
}
