import type { Database } from "./db.ts";

export function resolveProject(db: Database, userId: string, clientEmail: string): { project: any | null; escalate: boolean } {
  const project = db.getProjectByClientMatch(userId, clientEmail);
  return project ? { project, escalate: false } : { project: null, escalate: true };
}
