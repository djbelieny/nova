import { createHash } from "crypto";
import type { Database } from "./db.ts";

export type ActionType = "email" | "social_post" | "payment" | "crm_update" | "calendar" | "webhook";

export interface IdempotencyKey {
  userId: string;
  actionType: ActionType;
  canonicalPayload: string;
  dateWindow?: string;
}

export const DEDUP_WINDOWS: Record<ActionType, number> = {
  email: 24,
  social_post: 24,
  payment: 168,
  crm_update: 1,
  calendar: 0,
  webhook: 0.083,
};

export function buildIdempotencyKey(key: IdempotencyKey): string {
  const raw = `${key.userId}:${key.actionType}:${key.canonicalPayload}:${key.dateWindow ?? ""}`;
  return createHash("sha256").update(raw).digest("hex");
}

export async function acquireActionLock(
  db: Database,
  key: IdempotencyKey,
): Promise<boolean> {
  const keyStr = buildIdempotencyKey(key);
  const existing = db.checkActionLog(keyStr);
  if (existing) return false;

  const windowHours = DEDUP_WINDOWS[key.actionType];
  const inserted = db.insertActionLog(
    keyStr,
    key.userId,
    key.actionType,
    key.canonicalPayload,
    windowHours,
  );
  return inserted;
}

export async function releaseActionLock(
  db: Database,
  key: IdempotencyKey,
  result: string,
): Promise<void> {
  const keyStr = buildIdempotencyKey(key);
  db.updateActionLog(keyStr, "completed", result);
}

export async function failActionLock(
  db: Database,
  key: IdempotencyKey,
  error: string,
): Promise<void> {
  const keyStr = buildIdempotencyKey(key);
  db.updateActionLog(keyStr, "failed", error);
}
