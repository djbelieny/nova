/**
 * Agent-native tool access — inject a concise prompt block that tells specialist agents which
 * `nova` CLI subcommands they can call via the `bash` tool mid-task. Mirrors the established
 * pattern used by `buildGwsInstructions` (giving agents Google Workspace via a CLI on PATH).
 *
 * The block is scoped to what is actually available: knowledge-base search, document extraction
 * and saved playbooks are always listed; connectors appear only when they are configured.
 */

import type { Database } from "./db.ts";
import { listConnectors, isConnectorConfigured } from "./connectors/registry.ts";

/** A connector action as rendered in the prompt (structural subset of ConnectorAction). */
export interface RenderableConnector {
  id: string;
  label: string;
  actions: Record<string, { write?: boolean; description: string }>;
}

/**
 * Render the connector command lines for a set of connectors. Pure — no credential resolution,
 * no db, no network. Write actions are marked distinctly so the agent knows to route them
 * through the approval gate rather than executing directly.
 */
export function formatConnectorTools(connectors: RenderableConnector[]): string {
  if (connectors.length === 0) return "";

  const lines: string[] = [];
  for (const c of connectors) {
    lines.push(`  ${c.id} — ${c.label}`);
    for (const [name, action] of Object.entries(c.actions)) {
      const tag = action.write ? "  [WRITE — gate this]" : "  [read]";
      lines.push(`    nova connector run ${c.id} ${name} --input '{…}'${tag}  # ${action.description}`);
    }
  }
  return lines.join("\n");
}

/**
 * Build the nova-tool instruction block injected into every agent prompt. Concise by design.
 * `db` is used only to detect which connectors are configured (env vars or shared_credentials).
 */
export function buildNovaToolInstructions(db: Database | null, agentSlug?: string): string {
  const lines: string[] = [
    "NOVA CLI — extra capabilities available via the `bash` tool (`nova` is on PATH):",
    "",
    '  nova kb search "<query>"            # search the knowledge base (read-only)',
    "  nova extract <file> --schema <name>  # extract structured data from a document (read-only)",
    "  nova playbook run <name> key=value   # run a saved SOP/playbook",
  ];

  const configured = listConnectors().filter((c) => isConnectorConfigured(c, db));
  if (configured.length > 0) {
    const connectorBlock = formatConnectorTools(configured);
    lines.push("");
    lines.push("CONNECTORS (configured business systems) — `nova connector run <id> <action> --input '{…}'`:");
    lines.push(connectorBlock);
  }

  lines.push("");
  lines.push("SAFETY:");
  lines.push("- Use read actions freely to gather data mid-task.");
  lines.push(
    "- For any WRITE / consequential action (refunds, sending, creating/updating records), do NOT execute it directly — describe exactly what you intend and let the approval gate handle it."
  );

  return lines.join("\n");
}
