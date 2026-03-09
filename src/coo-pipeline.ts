/**
 * COO Pipeline — Delegation polling, agent dispatch, progress monitoring
 *
 * The COO is the execution engine of the executive board.
 * Polls the delegations table, assigns agents, executes tasks,
 * and reports results back.
 */

import type { ExecComms, Delegation } from "./exec-comms.ts";
import { getAllAgents, getAgent, buildAgentPrompt } from "./agent-router.ts";

// ============================================================
// State
// ============================================================

let _callAI: (prompt: string, tier?: string, hint?: string) => Promise<string>;
let _comms: ExecComms;
let _sendMessage: (chatId: string | number, text: string) => Promise<void>;

// Track active delegation IDs to avoid double-claiming
const _activeDelegations = new Set<string>();

// ============================================================
// Init
// ============================================================

export function initCooPipeline(deps: {
  callAI: (prompt: string, tier?: string, hint?: string) => Promise<string>;
  comms: ExecComms;
  sendMessage: (chatId: string | number, text: string) => Promise<void>;
}): void {
  _callAI = deps.callAI;
  _comms = deps.comms;
  _sendMessage = deps.sendMessage;
}

// ============================================================
// Start
// ============================================================

export function startCooPipeline(): void {
  setInterval(async () => {
    try {
      await processPendingDelegations();
    } catch (err) {
      console.error("[coo-pipeline] Error:", err);
    }
  }, 3000);
  console.log("[coo-pipeline] Started delegation polling");
}

// ============================================================
// Core: process pending delegations
// ============================================================

async function processPendingDelegations(): Promise<void> {
  const pending = await _comms.pollDelegations();
  if (pending.length === 0) return;

  for (const delegation of pending) {
    // Skip if we're already working on this one
    if (_activeDelegations.has(delegation.id)) continue;
    _activeDelegations.add(delegation.id);

    // Process without blocking the loop — fire and forget per delegation
    processDelegation(delegation).finally(() => {
      _activeDelegations.delete(delegation.id);
    });
  }
}

async function processDelegation(delegation: Delegation): Promise<void> {
  try {
    // 1. Claim the delegation
    await _comms.claimDelegation(delegation.id);
    console.log(`[coo-pipeline] Claimed delegation ${delegation.id}: ${delegation.task_description.slice(0, 80)}`);

    // 2. Determine agent
    const agentSlug = delegation.assigned_agent
      ? delegation.assigned_agent
      : await selectAgent(delegation.task_description);

    console.log(`[coo-pipeline] Using agent "${agentSlug}" for delegation ${delegation.id}`);

    // 3. Build prompt and execute
    const result = await executeWithAgent(agentSlug, delegation);

    // 4. Parse artifacts from result
    const artifacts = parseArtifacts(result);

    // 5. Complete the delegation
    await _comms.completeDelegation(delegation.id, result, artifacts);
    console.log(`[coo-pipeline] Completed delegation ${delegation.id} (${artifacts.length} artifacts)`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[coo-pipeline] Delegation ${delegation.id} failed:`, errorMsg);

    // Attempt retries
    await retryDelegation(delegation, errorMsg, 0);
  }
}

// ============================================================
// Agent selection
// ============================================================

async function selectAgent(taskDescription: string): Promise<string> {
  const allAgents = getAllAgents();
  if (allAgents.length === 0) return "general";

  const catalogLines = allAgents
    .map((a) => `${a.slug}: ${a.description}`)
    .join("\n");

  const prompt = `Given these available agents and a task, pick the best agent slug.

Agents:
${catalogLines}

Task: ${taskDescription}

Reply with just the agent slug (e.g., "pixel", "kai", "architect"). Nothing else.`;

  try {
    const result = await _callAI(prompt, "fast");
    const slug = result.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");

    // Validate the slug exists
    if (getAgent(slug)) return slug;

    console.warn(`[coo-pipeline] AI selected unknown agent "${slug}", falling back to general`);
    return "general";
  } catch (err) {
    console.error("[coo-pipeline] Agent selection failed:", err);
    return "general";
  }
}

// ============================================================
// Execution
// ============================================================

async function executeWithAgent(agentSlug: string, delegation: Delegation): Promise<string> {
  const prompt = buildAgentPrompt(
    agentSlug,
    delegation.task_description,
    buildBasePrompt(delegation),
    /* depContext */ undefined,
    "prepare",
  );

  return _callAI(prompt, "standard", agentSlug);
}

function buildBasePrompt(delegation: Delegation): string {
  return [
    `You are executing a delegated task from the ${delegation.requesting_role.toUpperCase()}.`,
    "",
    `Task: ${delegation.task_description}`,
    "",
    "Complete this task thoroughly. Produce concrete output, not just plans.",
    "If you generate files or content, tag them as artifacts using [ARTIFACT: type | value] format.",
    "",
    "Important:",
    "- Be specific and actionable",
    "- Produce deliverables, not descriptions of deliverables",
    "- If the task requires tools you don't have access to, explain what's needed",
  ].join("\n");
}

// ============================================================
// Retry logic
// ============================================================

async function retryDelegation(
  delegation: Delegation,
  error: string,
  attempt: number,
): Promise<void> {
  if (attempt >= 3) {
    await _comms.failDelegation(
      delegation.id,
      `Failed after 3 attempts: ${error}`,
    );
    await _comms.sendAlert(
      delegation.requesting_role,
      "Delegation Failed",
      `Task "${delegation.task_description}" failed after 3 retries. Last error: ${error}`,
    );
    console.error(
      `[coo-pipeline] Delegation ${delegation.id} permanently failed after 3 attempts`,
    );
    return;
  }

  const retryNum = attempt + 1;
  console.log(`[coo-pipeline] Retry ${retryNum}/3 for delegation ${delegation.id}`);

  try {
    let agentSlug: string;
    let extraContext: string;

    if (retryNum <= 1) {
      // Retry 1: Same agent, add error context
      agentSlug = delegation.assigned_agent || await selectAgent(delegation.task_description);
      extraContext = `\n\nPrevious attempt failed with error: ${error}\nPlease try a different approach.`;
    } else {
      // Retry 2+: Ask AI to pick an alternative agent
      agentSlug = await selectAlternativeAgent(delegation.task_description, delegation.assigned_agent);
      extraContext = `\n\nThis task was previously attempted by a different agent and failed: ${error}\nYou are being brought in as an alternative. Try a fresh approach.`;
    }

    const prompt = buildAgentPrompt(
      agentSlug,
      delegation.task_description + extraContext,
      buildBasePrompt(delegation),
      undefined,
      "prepare",
    );

    const result = await _callAI(prompt, "standard", agentSlug);
    const artifacts = parseArtifacts(result);

    await _comms.completeDelegation(delegation.id, result, artifacts);
    console.log(`[coo-pipeline] Delegation ${delegation.id} succeeded on retry ${retryNum}`);
  } catch (retryErr) {
    const retryErrMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
    console.error(`[coo-pipeline] Retry ${retryNum} failed:`, retryErrMsg);
    await retryDelegation(delegation, retryErrMsg, retryNum);
  }
}

async function selectAlternativeAgent(
  taskDescription: string,
  previousAgent: string | null,
): Promise<string> {
  const allAgents = getAllAgents();
  if (allAgents.length === 0) return "general";

  const catalogLines = allAgents
    .filter((a) => a.slug !== previousAgent)
    .map((a) => `${a.slug}: ${a.description}`)
    .join("\n");

  const prompt = `A task failed with the previous agent${previousAgent ? ` "${previousAgent}"` : ""}. Pick a different agent.

Available agents:
${catalogLines}

Task: ${taskDescription}

Reply with just the agent slug. Nothing else.`;

  try {
    const result = await _callAI(prompt, "fast");
    const slug = result.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (getAgent(slug)) return slug;
    return "general";
  } catch {
    return "general";
  }
}

// ============================================================
// Artifact parsing
// ============================================================

function parseArtifacts(text: string): Array<{ type: string; value: string }> {
  const artifacts: Array<{ type: string; value: string }> = [];
  const regex = /\[ARTIFACT:\s*([^|]+?)\s*\|\s*(.+?)\s*\]/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    artifacts.push({
      type: match[1].trim(),
      value: match[2].trim(),
    });
  }

  return artifacts;
}
