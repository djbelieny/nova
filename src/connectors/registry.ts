/**
 * Connector registry — the built-in connectors + credential resolution + action dispatch.
 * Credentials resolve from env vars (self-host) or the shared_credentials store. Write actions
 * are consequential and must be gated by the caller.
 */

import type { Connector, ConnectorCtx, FetchImpl } from './types';
import { stripeConnector } from './stripe';
import { shopifyConnector } from './shopify';
import { zendeskConnector } from './zendesk';
import { hubspotConnector } from './hubspot';
import type { Database } from '../db';

const CONNECTORS: Record<string, Connector> = {
  stripe: stripeConnector,
  shopify: shopifyConnector,
  zendesk: zendeskConnector,
  hubspot: hubspotConnector,
};

export function listConnectors(): Connector[] {
  return Object.values(CONNECTORS);
}

export function getConnector(id: string): Connector | null {
  return CONNECTORS[id] ?? null;
}

/** Validate a connector's shape (used for community-added connectors). */
export function validateConnector(c: Connector): string | null {
  if (!c.id || !c.label) return 'id and label are required';
  if (!c.credEnv?.length) return 'credEnv must list at least one credential var';
  if (!c.actions || Object.keys(c.actions).length === 0) return 'at least one action is required';
  for (const [name, a] of Object.entries(c.actions)) if (typeof a.run !== 'function') return `action ${name} has no run()`;
  return null;
}

/**
 * Resolve a connector's credentials. Env vars win; otherwise fall back to shared_credentials
 * (metadata JSON keyed by env var name). Returns null if any required cred is missing.
 */
export function resolveCreds(connector: Connector, db?: Database | null): Record<string, string> | null {
  const creds: Record<string, string> = {};
  let stored: Record<string, any> = {};
  try {
    const row = db?.getSharedCredential?.(connector.id);
    if (row?.metadata) stored = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
    if (row?.credentials) { const c = typeof row.credentials === 'string' ? JSON.parse(row.credentials) : row.credentials; stored = { ...stored, ...c }; }
  } catch { /* no stored creds */ }
  for (const name of connector.credEnv) {
    const val = process.env[name] || stored[name];
    if (!val) return null;
    creds[name] = String(val);
  }
  return creds;
}

export function isConnectorConfigured(connector: Connector, db?: Database | null): boolean {
  return resolveCreds(connector, db) !== null;
}

export interface RunActionResult { ok: boolean; data?: any; error?: string }

/** Run a connector action by name, resolving credentials. `fetchImpl` is injectable for tests. */
export async function runConnectorAction(
  db: Database | null,
  connectorId: string,
  actionName: string,
  input: Record<string, any>,
  fetchImpl?: FetchImpl
): Promise<RunActionResult> {
  const connector = getConnector(connectorId);
  if (!connector) return { ok: false, error: `unknown connector: ${connectorId}` };
  const action = connector.actions[actionName];
  if (!action) return { ok: false, error: `unknown action: ${connectorId}.${actionName}` };
  const creds = resolveCreds(connector, db);
  if (!creds) return { ok: false, error: `${connectorId} is not configured (set ${connector.credEnv.join(', ')})` };
  const ctx: ConnectorCtx = { creds, fetchImpl: fetchImpl || fetch };
  try {
    const data = await action.run(input, ctx);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
