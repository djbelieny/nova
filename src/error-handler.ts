export type ErrorNotifier = (msg: string) => Promise<void>;

let _adminNotifier: ErrorNotifier | null = null;

export function setAdminNotifier(fn: ErrorNotifier): void {
  _adminNotifier = fn;
}

export function logError(err: unknown, context: string, userId?: string): void {
  const msg = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  const ts = new Date().toISOString();
  console.error(`[${ts}][error][${context}]${userId ? `[user:${userId}]` : ""} ${msg}`);
  if (stack) console.error(stack);
}

export async function notifyAdmin(message: string): Promise<void> {
  if (_adminNotifier) {
    try { await _adminNotifier(message); } catch {}
  }
}
