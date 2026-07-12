/**
 * COO Pipeline — Delegation orchestration
 *
 * The COO is a coordinator, not an executor. When a board delegation arrives:
 *   1. Decompose it into sub-tasks via LLM
 *   2. Dispatch each sub-task to the right specialist agent (creates child delegations)
 *   3. Monitor child completions via polling
 *   4. Aggregate results and complete the parent delegation
 *
 * Actual agent execution happens on the relay node (agent-dispatcher).
 */

import type { ExecComms, Delegation } from "./exec-comms.ts";
import { getAllAgents, getAgent } from "./agent-router.ts";
import { emit } from "./events.ts";

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

// Adaptive polling — fast when active, slows down when idle
const MIN_POLL_MS = 3000;
const MAX_POLL_MS = 30000;
let _pollInterval = MIN_POLL_MS;
let _idleStreak = 0;

export function startCooPipeline(): void {
  const tick = async () => {
    try {
      const hadWork = await processPendingDelegations();
      if (hadWork) {
        _idleStreak = 0;
        _pollInterval = MIN_POLL_MS;
      } else {
        _idleStreak++;
        if (_idleStreak >= 5) {
          _pollInterval = Math.min(_pollInterval * 2, MAX_POLL_MS);
        }
      }
    } catch (err) {
      emit({ type: "error", level: "error", data: { message: "Delegation processing error", module: "coo-pipeline", error: String(err) } });
    }
    setTimeout(tick, _pollInterval);
  };
  setTimeout(tick, MIN_POLL_MS);
  emit({ type: "exec.delegation", level: "info", data: { message: "COO pipeline started", module: "coo-pipeline" } });
}

// ============================================================
// Core: process board-level delegations only
// ============================================================

/** Slug set of all 24 specialist agents — COO skips these (relay executes them). */
function getAgentSlugs(): Set<string> {
  return new Set(getAllAgents().map((a) => a.slug));
}

async function processPendingDelegations(): Promise<boolean> {
  const pending = await _comms.pollDelegations();
  if (pending.length === 0) return false;

  const agentSlugs = getAgentSlugs();

  // COO only handles board-level delegations (those NOT already assigned to a specialist agent).
  // Agent-assigned delegations are picked up by the relay node's agent-dispatcher.
  const boardLevel = pending.filter((d) => !d.assigned_agent || !agentSlugs.has(d.assigned_agent));

  if (boardLevel.length === 0) return false;

  for (const delegation of boardLevel) {
    if (_activeDelegations.has(delegation.id)) continue;
    _activeDelegations.add(delegation.id);

    processDelegation(delegation).finally(() => {
      _activeDelegations.delete(delegation.id);
    });
  }
  return true;
}

async function processDelegation(delegation: Delegation): Promise<void> {
  try {
    await _comms.claimDelegation(delegation.id);
    emit({ type: "exec.delegation", level: "info", data: { message: `COO orchestrating: ${delegation.task_description.slice(0, 80)}`, delegationId: delegation.id, module: "coo-pipeline" } });

    await decomposeAndDispatch(delegation);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    emit({ type: "error", level: "error", data: { message: `COO delegation failed: ${errorMsg}`, delegationId: delegation.id, module: "coo-pipeline", error: errorMsg } });
    await _comms.failDelegation(delegation.id, errorMsg);
  }
}

// ============================================================
// Decompose → Dispatch → Monitor → Aggregate
// ============================================================

async function decomposeAndDispatch(delegation: Delegation): Promise<void> {
  // 1. Ask LLM to decompose into agent sub-tasks
  const agentCatalog = getAllAgents()
    .map((a) => `${a.slug}: ${a.description}`)
    .join("\n");

  const decomposePrompt = `You are the COO. Decompose this delegated task into concrete sub-tasks for specialist agents.

Task: ${delegation.task_description}

Available agents:
${agentCatalog}

Return a JSON array of sub-tasks (max 5):
[{ "agent": "slug", "description": "specific actionable task" }]

Rules:
- Each sub-task must be concrete and actionable — not a plan or summary
- Pick the most relevant agent for each
- If one agent covers the whole task, return a single item
- No overlap between sub-tasks

Reply with ONLY the JSON array, no other text.`;

  let subTasks: Array<{ agent: string; description: string }> = [];
  try {
    const raw = await _callAI(decomposePrompt, "fast");
    const cleaned = raw.replace(/^```json?\s*/m, "").replace(/```\s*$/m, "").trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed) && parsed.length > 0) {
      subTasks = parsed
        .slice(0, 5)
        .map((t) => ({
          agent: String(t.agent || "").toLowerCase().trim(),
          description: String(t.description || "").trim(),
        }))
        .filter((t) => t.description.length > 0);
    }
  } catch {
    // Fallback: single sub-task to the originally assigned agent (if any)
  }

  if (subTasks.length === 0) {
    // Fallback: delegate to a single best-fit agent
    const fallbackAgent = await selectAgent(delegation.task_description);
    subTasks = [{ agent: fallbackAgent, description: delegation.task_description }];
  }

  // 2. Create child delegations for each sub-task
  const childIds: string[] = [];
  for (const task of subTasks) {
    const slug = getAgent(task.agent) ? task.agent : await selectAgent(task.description);
    const childDescription = `[ParentDelegation: ${delegation.id}] ${task.description}`;
    const childId = await _comms.requestDelegation(childDescription, delegation.user_id, slug);
    childIds.push(childId);
    emit({ type: "exec.delegation", level: "info", data: {
      message: `Dispatched sub-task to agent: ${slug}`,
      agentSlug: slug,
      childDelegationId: childId,
      parentDelegationId: delegation.id,
      module: "coo-pipeline",
    }});
  }

  emit({ type: "exec.delegation", level: "info", data: {
    message: `COO dispatched ${childIds.length} sub-tasks. Monitoring...`,
    delegationId: delegation.id,
    childCount: childIds.length,
    module: "coo-pipeline",
  }});

  // 3. Monitor child completions (poll every 15s, timeout 45 min)
  const results = await monitorChildDelegations(childIds, delegation.id);

  // 4. Aggregate and complete the parent
  const completed = results.filter((d) => d.status === "completed");
  const failed = results.filter((d) => d.status === "failed");

  const summary = buildAggregatedSummary(delegation.task_description, completed, failed);
  const artifacts = results.flatMap((d) => parseArtifacts(d.result || ""));

  await _comms.completeDelegation(delegation.id, summary, artifacts);
  emit({ type: "exec.delegation", level: "info", data: {
    message: `COO completed parent delegation: ${completed.length} succeeded, ${failed.length} failed`,
    delegationId: delegation.id,
    succeeded: completed.length,
    failedCount: failed.length,
    status: "completed",
    module: "coo-pipeline",
  }});
}

async function monitorChildDelegations(
  childIds: string[],
  parentId: string,
  timeoutMs = 45 * 60 * 1000,
): Promise<Delegation[]> {
  const deadline = Date.now() + timeoutMs;
  const POLL_INTERVAL_MS = 15_000;

  while (Date.now() < deadline) {
    const statuses = await Promise.all(childIds.map((id) => _comms.getDelegationResult(id)));
    const allDone = statuses.every((d) => d && (d.status === "completed" || d.status === "failed"));

    if (allDone) {
      return statuses.filter(Boolean) as Delegation[];
    }

    const doneCount = statuses.filter((d) => d && (d.status === "completed" || d.status === "failed")).length;
    emit({ type: "exec.delegation", level: "info", data: {
      message: `Monitoring ${parentId}: ${doneCount}/${childIds.length} sub-tasks done`,
      parentDelegationId: parentId,
      progress: `${doneCount}/${childIds.length}`,
      module: "coo-pipeline",
    }});

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  // Timeout — return whatever we have
  emit({ type: "exec.delegation", level: "warn", data: {
    message: `Monitoring timeout for parent delegation ${parentId}`,
    parentDelegationId: parentId,
    module: "coo-pipeline",
  }});
  const final = await Promise.all(childIds.map((id) => _comms.getDelegationResult(id)));
  return final.filter(Boolean) as Delegation[];
}

function buildAggregatedSummary(
  originalTask: string,
  completed: Delegation[],
  failed: Delegation[],
): string {
  const lines = [`COO Execution Summary for: "${originalTask.slice(0, 100)}"\n`];

  if (completed.length > 0) {
    lines.push(`Completed (${completed.length}):`);
    for (const d of completed) {
      const taskLabel = d.task_description.replace(/^\[ParentDelegation:[^\]]+\]\s*/, "").slice(0, 80);
      lines.push(`  ✓ [${d.assigned_agent || "agent"}] ${taskLabel}`);
      if (d.result) lines.push(`    → ${d.result.slice(0, 300)}`);
    }
  }

  if (failed.length > 0) {
    lines.push(`\nFailed (${failed.length}):`);
    for (const d of failed) {
      const taskLabel = d.task_description.replace(/^\[ParentDelegation:[^\]]+\]\s*/, "").slice(0, 80);
      lines.push(`  ✗ [${d.assigned_agent || "agent"}] ${taskLabel}: ${(d.result || "unknown error").slice(0, 200)}`);
    }
  }

  return lines.join("\n");
}

// ============================================================
// Agent selection
// ============================================================

async function selectAgent(taskDescription: string): Promise<string> {
  const allAgents = getAllAgents();
  if (allAgents.length === 0) return "general";

  const catalogLines = allAgents.map((a) => `${a.slug}: ${a.description}`).join("\n");
  const prompt = `Given these agents and a task, pick the best agent slug.

Agents:
${catalogLines}

Task: ${taskDescription}

Reply with just the agent slug (e.g. "pixel", "kai", "architect"). Nothing else.`;

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
// Artifact parsing (exported for relay agent-dispatcher)
// ============================================================

export function parseArtifacts(text: string): Array<{ type: string; value: string }> {
  const artifacts: Array<{ type: string; value: string }> = [];
  const regex = /\[ARTIFACT:\s*([^|]+?)\s*\|\s*(.+?)\s*\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    artifacts.push({ type: match[1].trim(), value: match[2].trim() });
  }
  return artifacts;
}
