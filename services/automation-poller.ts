/**
 * Automation poller — drives automations whose source isn't push-based.
 *
 * v1 handles the self-contained `metric` source (poll an HTTP endpoint, extract a value,
 * fire when conditions match). Connector-backed sources (email/crm/payment) recognize
 * their source_type here and are wired when the connector framework lands (Phase 7);
 * until then they're logged as awaiting a connector, never silently dropped.
 *
 * Every fire flows through dispatchAutomation → the normal task path + approval gate.
 */

import { getByPath, dispatchAutomation, type DispatchAgentFn } from "../src/automation-engine.ts";
import { listConnectors, getConnector, isConnectorConfigured, resolveCreds } from "../src/connectors/registry.ts";
import { withLock } from "../src/locks.ts";
import type { Database } from "../src/db.ts";

const POLLABLE = ["metric"];
// Legacy generic source names (recognized; map to a connector trigger event when configured).
const CONNECTOR_BACKED = ["email", "crm", "payment", "form"];

/** All connector trigger event names (e.g. 'stripe.payment', 'shopify.order'). */
function connectorTriggerEvents(): string[] {
  return listConnectors().flatMap(c => (c.triggers || []).map(t => t.event));
}

/** Poll a connector trigger for an automation whose source_type is a connector event. */
async function pollConnectorTrigger(db: Database, dispatch: DispatchAgentFn, automation: any): Promise<void> {
  const [connectorId] = String(automation.sourceType).split(".");
  const connector = getConnector(connectorId);
  if (!connector || !isConnectorConfigured(connector, db)) return;
  const trigger = (connector.triggers || []).find(t => t.event === automation.sourceType);
  if (!trigger) return;
  try {
    const creds = resolveCreds(connector, db)!;
    const events = await trigger.poll({ creds, fetchImpl: fetch });
    for (const ev of events) {
      // dedupe (id-based) + rate limits are enforced inside dispatchAutomation via the automation's config.
      await dispatchAutomation(db, automation, ev, dispatch);
    }
  } catch (err) {
    console.warn(`[automation-poller] connector poll failed for ${automation.name}:`, (err as Error).message);
  }
}

async function pollMetric(db: Database, dispatch: DispatchAgentFn, automation: any): Promise<void> {
  const cfg = automation.sourceConfig || {};
  if (!cfg.url) return;
  try {
    const res = await fetch(cfg.url, { method: cfg.method || "GET", headers: cfg.headers || {} });
    let raw: any = null;
    try { raw = await res.json(); } catch { raw = await res.text(); }
    const value = cfg.valuePath ? getByPath(raw, cfg.valuePath) : raw;
    const event = { value, raw, url: cfg.url, status: res.status };
    await dispatchAutomation(db, automation, event, dispatch);
  } catch (err) {
    console.warn(`[automation-poller] metric probe failed for ${automation.name}:`, (err as Error).message);
  }
}

/** Start the automation poller. No-op-safe; disable with NOVA_AUTOMATION_POLLER=false. */
export function startAutomationPoller(db: Database, dispatch: DispatchAgentFn): void {
  if (process.env.NOVA_AUTOMATION_POLLER === "false") return;
  const intervalSec = Math.max(30, Number(process.env.NOVA_AUTOMATION_POLL_SEC) || 300);
  const warnedConnector = new Set<string>();

  async function tick(): Promise<void> {
    // Advisory lock so overlapping ticks / multiple instances don't double-fire automations.
    const { ran } = await withLock(db, "automation-poller", intervalSec + 30, () => tickInner());
    if (!ran) return;
  }

  async function tickInner(): Promise<void> {
    try {
      const connectorEvents = connectorTriggerEvents();
      const autos = db.listEnabledAutomationsBySource([...POLLABLE, ...CONNECTOR_BACKED, ...connectorEvents]);
      for (const a of autos) {
        if (POLLABLE.includes(a.sourceType)) {
          await pollMetric(db, dispatch, a);
        } else if (connectorEvents.includes(a.sourceType)) {
          await pollConnectorTrigger(db, dispatch, a);
        } else if (CONNECTOR_BACKED.includes(a.sourceType) && !warnedConnector.has(a.id)) {
          warnedConnector.add(a.id);
          console.log(`[automation-poller] "${a.name}" uses generic source '${a.sourceType}' — point it at a connector event (e.g. stripe.payment) to poll automatically; webhook delivery works today.`);
        }
      }
    } catch (err) {
      console.warn("[automation-poller] tick error:", (err as Error).message);
    }
  }

  setInterval(() => { tick().catch(() => {}); }, intervalSec * 1000);
  console.log(`[automation-poller] started (every ${intervalSec}s)`);
}
