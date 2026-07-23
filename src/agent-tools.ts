/**
 * Agent-native tool access — a concise prompt block telling specialist agents which `nova`
 * capabilities they can call via the `bash` tool mid-task. Mirrors `buildGwsInstructions`.
 *
 * Follows the SAME discovery-on-demand idiom as mcp2cli (list → describe → call) so the prompt
 * footprint stays flat regardless of how many connectors/actions exist: the agent is told HOW to
 * discover tools, not handed every tool's schema inline. Connectors are surfaced only when at
 * least one is configured, and even then only their names — the agent runs `nova connector
 * describe <id>` to pull each one's actions and parameters on demand.
 */

import type { Database } from "./db.ts";
import { listConnectors, isConnectorConfigured } from "./connectors/registry.ts";

/** Structural subset of a connector used for the compact listing. */
export interface RenderableConnector { id: string; label: string; }

/** Render the compact "configured connectors" line — names only (details fetched via describe). */
export function formatConnectorTools(connectors: RenderableConnector[]): string {
  if (connectors.length === 0) return "";
  return connectors.map((c) => `${c.id} (${c.label})`).join(", ");
}

/**
 * Build the nova-tool instruction block injected into every agent prompt. Discovery-first, so it
 * stays small. `db` is used only to detect which connectors are configured.
 */
export function buildNovaToolInstructions(db: Database | null, agentSlug?: string): string {
  const lines: string[] = [
    "NOVA TOOLS — extra capabilities via the `bash` tool (`nova` is on PATH). Discover on demand:",
    "",
    '  nova kb search "<query>"             # search the knowledge base (read-only)',
    "  nova extract <file> --schema <name>   # extract structured data from a document (read-only)",
    "  nova playbook run <name> key=value    # run a saved SOP/playbook",
    "  nova data list  |  nova data query <name>   # read a connected data source (read-only)",
    "  nova workboard list | describe <board>      # boards of structured cards",
    "  nova workboard card add <board> --stage <k> --fields '{…}'    # add one card",
    "  nova workboard card add-many <board> --stage <k> --file <f>   # add many at once",
  ];

  const configured = listConnectors().filter((c) => isConnectorConfigured(c, db));
  if (configured.length > 0) {
    lines.push("");
    lines.push("CONNECTORS — configured business systems (discover actions before calling):");
    lines.push(`  configured: ${formatConnectorTools(configured)}`);
    lines.push("  nova connector describe <id>                       # list a connector's actions + params");
    lines.push("  nova connector run <id> <action> --input '{…}'    # call an action");
  }

  lines.push("");
  lines.push("USAGE:");
  lines.push("- Discover first (`nova connector describe <id>`) to learn exact action names and parameters; don't guess.");
  lines.push("- Use read actions freely to gather data mid-task.");
  lines.push(
    "- For any WRITE / consequential action (refunds, sending, creating/updating records), do NOT execute it directly — describe exactly what you intend and let the approval gate handle it."
  );
  lines.push(
    "- Workboards: run `nova workboard describe <board>` first to learn its fields and stages, then write cards that match. Adding or moving cards is safe and reversible — do it directly."
  );

  return lines.join("\n");
}
