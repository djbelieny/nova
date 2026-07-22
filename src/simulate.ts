/**
 * Dry-run / simulation for automations.
 *
 * Reuses the EXISTING pure `buildDispatch` decision from the automation engine to preview
 * what an event WOULD do — which agent, what task — without touching state: no automation_run,
 * no dispatch, no dead-letter. Safe to call any number of times.
 */

import { buildDispatch } from './automation-engine';
import type { Automation, Database } from './db';

export interface SimulationResult {
  wouldFire: boolean;
  agentSlug?: string;
  taskDescription?: string;
  reason?: string;
}

/** Preview an automation against an event. Executes NOTHING. */
export function simulateAutomation(db: Database, automation: Automation, event: Record<string, any>): SimulationResult {
  const decision = buildDispatch(automation, event, (name) => db.findPlaybook(automation.userId, name));
  if (!decision.dispatch) {
    return { wouldFire: false, reason: decision.skipReason || 'no-dispatch' };
  }
  return {
    wouldFire: true,
    agentSlug: decision.dispatch.agentSlug,
    taskDescription: decision.dispatch.taskDescription,
  };
}
