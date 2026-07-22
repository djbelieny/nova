/**
 * Connector framework — a thin, uniform interface over external business systems (Stripe,
 * Shopify, Zendesk, HubSpot, …) so the community can add more with one file. Actions are
 * callable by automations/playbooks/extraction destinations; triggers feed the automation
 * poller. Credentials come from env vars (self-host) or the shared_credentials store.
 */

export type FetchImpl = typeof fetch;

export interface ConnectorCtx {
  creds: Record<string, string>;
  fetchImpl: FetchImpl;
}

export interface ConnectorInput { name: string; required?: boolean; description?: string; }

export interface ConnectorAction {
  description: string;
  /** Consequential (write) actions must be gated by the caller. */
  write?: boolean;
  /** Input parameter hints — surfaced by `nova connector describe` (mcp2cli-style introspection). */
  inputs?: ConnectorInput[];
  run: (input: Record<string, any>, ctx: ConnectorCtx) => Promise<any>;
}

export interface ConnectorTrigger {
  event: string;
  description: string;
  /** Return new event objects since the last poll (poller handles dedup via automation dedupe keys). */
  poll: (ctx: ConnectorCtx) => Promise<any[]>;
}

export interface Connector {
  id: string;
  label: string;
  authKind: 'api_key' | 'basic' | 'oauth';
  /** Env var names that supply credentials (checked in order; first set wins per slot). */
  credEnv: string[];
  actions: Record<string, ConnectorAction>;
  triggers?: ConnectorTrigger[];
}

/** Shared JSON HTTP helper for connectors. Throws on non-2xx with the status + body snippet. */
export async function httpJson(
  ctx: ConnectorCtx,
  method: string,
  url: string,
  opts: { headers?: Record<string, string>; body?: any; form?: Record<string, string> } = {}
): Promise<any> {
  const headers: Record<string, string> = { Accept: 'application/json', ...(opts.headers || {}) };
  let body: string | undefined;
  if (opts.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(opts.form).toString();
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await ctx.fetchImpl(url, { method, headers, body });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${String(text).slice(0, 200)}`);
  return json;
}
