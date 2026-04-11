/**
 * Execution Engine — Autonomous project execution after board decisions
 *
 * Decomposes board decisions into work items per executive,
 * distributes via delegations table, monitors progress,
 * and provides self-healing + recovery.
 */

import type { ExecComms, Delegation, Project, BoardSession } from "./exec-comms.ts";
import { emit } from "./events.ts";

// ============================================================
// State
// ============================================================

let _callAI: (prompt: string, tier?: string, hint?: string) => Promise<string>;
let _comms: ExecComms;
let _sendMessage: (chatId: string | number, text: string) => Promise<void>;
let _monitorInterval: ReturnType<typeof setInterval> | null = null;

// ============================================================
// Types
// ============================================================

interface WorkItem {
  role: string;
  description: string;
  agents: string[];
  depends_on: number[];
}

interface TrackedDelegation {
  delegationId: string;
  workItemIndex: number;
  role: string;
  description: string;
}

// In-memory map of project ID -> delegation tracking
const _projectDelegations = new Map<string, TrackedDelegation[]>();

// ============================================================
// Init
// ============================================================

export function initExecutionEngine(deps: {
  callAI: (prompt: string, tier?: string, hint?: string) => Promise<string>;
  comms: ExecComms;
  sendMessage: (chatId: string | number, text: string) => Promise<void>;
}): void {
  _callAI = deps.callAI;
  _comms = deps.comms;
  _sendMessage = deps.sendMessage;
}

// ============================================================
// Create project from board decision
// ============================================================

export async function createProjectFromDecision(
  sessionId: string,
  decision: string,
  userId: string,
): Promise<string> {
  // 1. Get the board session for context
  const session = await _comms.getSession(sessionId);
  if (!session) {
    emit({ type: "error", level: "error", data: { message: `Session ${sessionId} not found`, module: "execution-engine" } });
    return "";
  }

  // 2. Decompose decision into work items
  const workItems = await decomposeDecision(decision, session);
  if (workItems.length === 0) {
    emit({ type: "error", level: "error", data: { message: "Decomposition produced no work items", module: "execution-engine" } });
    return "";
  }

  emit({ type: "task.created", level: "info", data: { message: `Decomposed into ${workItems.length} work items`, workItemCount: workItems.length, module: "execution-engine" } });

  // 3. Create the project
  const projectId = await _comms.createProject({
    user_id: userId,
    title: summarizeDecision(decision),
    description: decision,
    board_session_id: sessionId,
    work_items: workItems,
    completion_criteria: `All ${workItems.length} work items completed successfully`,
  });

  if (!projectId) {
    emit({ type: "error", level: "error", data: { message: "Failed to create project", module: "execution-engine" } });
    return "";
  }

  // 4. Create delegations for independent work items (no dependencies)
  const tracked: TrackedDelegation[] = [];
  const delegationIds: string[] = [];

  for (let i = 0; i < workItems.length; i++) {
    const item = workItems[i];
    const hasDeps = item.depends_on.length > 0;

    if (!hasDeps) {
      const delegationId = await createDelegationForWorkItem(item, userId, projectId);
      delegationIds.push(delegationId);
      tracked.push({
        delegationId,
        workItemIndex: i,
        role: item.role,
        description: item.description,
      });
    } else {
      // Dependent items will be created when their dependencies complete
      delegationIds.push(""); // placeholder
      tracked.push({
        delegationId: "",
        workItemIndex: i,
        role: item.role,
        description: item.description,
      });
    }
  }

  _projectDelegations.set(projectId, tracked);

  emit({ type: "task.created", level: "info", data: { message: `Project ${projectId} created with ${tracked.filter((t) => t.delegationId).length} initial delegations`, projectId, delegationCount: tracked.filter((t) => t.delegationId).length, module: "execution-engine" } });

  return projectId;
}

// ============================================================
// Decision decomposition
// ============================================================

async function decomposeDecision(
  decision: string,
  session: BoardSession,
): Promise<WorkItem[]> {
  const prompt = `Decompose this approved decision into work items for each executive.

Decision: ${decision}
Context: ${session.question}
${session.decision_rationale ? `Rationale: ${session.decision_rationale}` : ""}

Available executives: CEO (strategy), CFO (finance), CMO (marketing), CTO (technology), COO (operations), Research (analysis)

For each work item specify:
- role: which executive (ceo, cfo, cmo, cto, coo, or research)
- description: what they should do (be specific and actionable)
- agents: suggested agent slugs to delegate to (e.g., ["pixel", "kai"])
- depends_on: indices of work items this depends on (0-indexed), use [] if independent

Format as a JSON array: [{ "role": "...", "description": "...", "agents": ["..."], "depends_on": [] }]

Reply with ONLY the JSON array, no other text.`;

  try {
    const result = await _callAI(prompt, "standard");
    const cleaned = result
      .replace(/^```json?\s*/m, "")
      .replace(/```\s*$/m, "")
      .trim();

    const parsed = JSON.parse(cleaned) as WorkItem[];

    // Validate structure
    if (!Array.isArray(parsed) || parsed.length === 0) {
      emit({ type: "error", level: "error", data: { message: "Invalid decomposition result", module: "execution-engine" } });
      return [];
    }

    return parsed.map((item) => ({
      role: String(item.role || "coo").toLowerCase(),
      description: String(item.description || ""),
      agents: Array.isArray(item.agents) ? item.agents.map(String) : [],
      depends_on: Array.isArray(item.depends_on) ? item.depends_on.filter((n) => typeof n === "number") : [],
    }));
  } catch (err) {
    emit({ type: "error", level: "error", data: { message: "Decomposition failed", module: "execution-engine", error: String(err) } });
    return [];
  }
}

function summarizeDecision(decision: string): string {
  // Take the first sentence or first 80 chars
  const firstSentence = decision.split(/[.!?\n]/)[0]?.trim() || decision;
  return firstSentence.length > 80 ? firstSentence.slice(0, 77) + "..." : firstSentence;
}

// ============================================================
// Delegation creation
// ============================================================

async function createDelegationForWorkItem(
  item: WorkItem,
  userId: string,
  projectId: string,
): Promise<string> {
  const agent = item.agents[0] || undefined;
  const taskWithContext = `[Project: ${projectId}] [Role: ${item.role}] ${item.description}`;

  return _comms.requestDelegation(taskWithContext, userId, agent);
}

// ============================================================
// Project monitor
// ============================================================

export function startProjectMonitor(): void {
  if (_monitorInterval) return;

  _monitorInterval = setInterval(async () => {
    try {
      await monitorActiveProjects();
    } catch (err) {
      emit({ type: "error", level: "error", data: { message: "Monitor error", module: "execution-engine", error: String(err) } });
    }
  }, 30_000);

  emit({ type: "system.health", level: "info", data: { message: "Started project monitor (30s interval)", module: "execution-engine" } });
}

export function stopProjectMonitor(): void {
  if (_monitorInterval) {
    clearInterval(_monitorInterval);
    _monitorInterval = null;
    emit({ type: "system.health", level: "info", data: { message: "Stopped project monitor", module: "execution-engine" } });
  }
}

async function monitorActiveProjects(): Promise<void> {
  const projects = await _comms.getActiveProjects();
  if (projects.length === 0) return;

  for (const project of projects) {
    try {
      await checkAndHeal(project);
    } catch (err) {
      emit({ type: "error", level: "error", data: { message: `Error monitoring project ${project.id}`, projectId: project.id, module: "execution-engine", error: String(err) } });
    }
  }
}

async function checkAndHeal(project: Project): Promise<void> {
  const tracked = _projectDelegations.get(project.id);
  if (!tracked || tracked.length === 0) return;

  let completed = 0;
  let failed = 0;
  let inProgress = 0;
  let pending = 0;

  for (const t of tracked) {
    if (!t.delegationId) {
      // Check if dependencies are met and create delegation
      await tryScheduleDependentItem(t, tracked, project);
      pending++;
      continue;
    }

    const delegation = await _comms.getDelegationResult(t.delegationId);
    if (!delegation) {
      pending++;
      continue;
    }

    switch (delegation.status) {
      case "completed":
        completed++;
        break;

      case "failed": {
        failed++;
        const retries = (delegation.metadata?.retries as number) || 0;
        if (retries < 3) {
          emit({ type: "task.status", level: "info", data: { message: `Reassigning failed delegation ${delegation.id} (retry ${retries + 1})`, delegationId: delegation.id, status: "retrying", module: "execution-engine" } });
          await reassignDelegation(delegation, project);
        }
        break;
      }

      case "in_progress": {
        inProgress++;
        const updatedAt = new Date(delegation.updated_at).getTime();
        const age = Date.now() - updatedAt;

        if (age > 60 * 60 * 1000) {
          // Stalled for over 1 hour
          await _comms.sendAlert(
            "coo",
            "Stalled Delegation",
            `Delegation "${delegation.task_description}" has been in_progress for over 1 hour (project: ${project.id})`,
          );
        }
        break;
      }

      default:
        pending++;
    }
  }

  // Update project progress
  const total = tracked.length;
  const progressPct = total > 0 ? Math.round((completed / total) * 100) : 0;

  await _comms.updateProject(project.id, {
    progress_pct: progressPct,
    next_milestone: getNextMilestone(completed, total, inProgress),
  });

  // Check if project is complete
  if (completed === total) {
    await _comms.updateProject(project.id, {
      status: "completed",
      progress_pct: 100,
    });
    emit({ type: "task.completed", level: "info", data: { message: `Project ${project.id} completed`, projectId: project.id, status: "completed", module: "execution-engine" } });

    // Notify user
    if (project.user_id) {
      await _sendMessage(
        project.user_id,
        `Project completed: "${project.title}"\n\nAll ${total} work items finished successfully.`,
      );
    }
  } else if (failed >= total - completed && inProgress === 0 && pending === 0) {
    // All remaining items have failed
    await _comms.updateProject(project.id, { status: "failed" });
    emit({ type: "error", level: "error", data: { message: `Project ${project.id} failed — all remaining items exhausted`, projectId: project.id, status: "failed", module: "execution-engine" } });

    if (project.user_id) {
      await _sendMessage(
        project.user_id,
        `Project stalled: "${project.title}"\n\n${completed}/${total} items completed. ${failed} items failed after retries. Manual intervention needed.`,
      );
    }
  }
}

// ============================================================
// Dependency resolution
// ============================================================

async function tryScheduleDependentItem(
  item: TrackedDelegation,
  allTracked: TrackedDelegation[],
  project: Project,
): Promise<void> {
  const workItems = project.work_items as WorkItem[];
  if (!workItems || item.workItemIndex >= workItems.length) return;

  const workItem = workItems[item.workItemIndex];
  if (!workItem || workItem.depends_on.length === 0) return;

  // Check if all dependencies are completed
  const allDepsComplete = workItem.depends_on.every((depIdx: number) => {
    const depTracked = allTracked.find((t) => t.workItemIndex === depIdx);
    if (!depTracked?.delegationId) return false;
    // We'll need to check status — for now just check if the delegation exists
    return true;
  });

  if (!allDepsComplete) return;

  // Verify by actually checking delegation statuses
  for (const depIdx of workItem.depends_on) {
    const depTracked = allTracked.find((t) => t.workItemIndex === depIdx);
    if (!depTracked?.delegationId) return;

    const dep = await _comms.getDelegationResult(depTracked.delegationId);
    if (!dep || dep.status !== "completed") return;
  }

  // All dependencies met — create the delegation
  const delegationId = await createDelegationForWorkItem(workItem, project.user_id, project.id);
  item.delegationId = delegationId;
  emit({ type: "task.status", level: "info", data: { message: `Scheduled dependent work item ${item.workItemIndex} for project ${project.id}`, projectId: project.id, workItemIndex: item.workItemIndex, status: "scheduled", module: "execution-engine" } });
}

// ============================================================
// Reassignment / self-healing
// ============================================================

async function reassignDelegation(
  delegation: Delegation,
  project: Project,
): Promise<void> {
  const retries = (delegation.metadata?.retries as number) || 0;

  // Create a new delegation with retry context
  const retryTask = `${delegation.task_description}\n\n[RETRY ${retries + 1}] Previous attempt failed: ${delegation.result || "unknown error"}. Try a different approach.`;

  const newId = await _comms.requestDelegation(
    retryTask,
    project.user_id,
    retries >= 1 ? undefined : delegation.assigned_agent || undefined, // Different agent on 2nd+ retry
  );

  // Update tracking
  const tracked = _projectDelegations.get(project.id);
  if (tracked) {
    const entry = tracked.find((t) => t.delegationId === delegation.id);
    if (entry) {
      entry.delegationId = newId;
    }
  }
}

// ============================================================
// Node failure recovery
// ============================================================

export async function recoverInProgressDelegations(): Promise<void> {
  emit({ type: "system.health", level: "info", data: { message: "Checking for stale in_progress delegations to recover", module: "execution-engine" } });

  // Get all active projects and rebuild tracking state
  const projects = await _comms.getActiveProjects();

  for (const project of projects) {
    if (!project.work_items || !Array.isArray(project.work_items)) continue;

    // Rebuild tracked delegations from project work items if not in memory
    if (!_projectDelegations.has(project.id)) {
      emit({ type: "task.status", level: "info", data: { message: `Rebuilding tracking for project ${project.id}`, projectId: project.id, status: "recovering", module: "execution-engine" } });
      const tracked: TrackedDelegation[] = (project.work_items as WorkItem[]).map(
        (item, idx) => ({
          delegationId: "",
          workItemIndex: idx,
          role: item.role,
          description: item.description,
        }),
      );

      // Re-match existing delegations back to work items
      try {
        const existing = await _comms.getDelegationsByProject(project.id);
        for (const del of existing) {
          // Match by role tag embedded in task_description
          const roleMatch = del.task_description.match(/\[Role:\s*([^\]]+)\]/);
          if (!roleMatch) continue;
          const delRole = roleMatch[1].trim().toLowerCase();

          // Find the first unmatched tracked item with the same role
          const entry = tracked.find(
            (t) => !t.delegationId && t.role.toLowerCase() === delRole
          );
          if (entry) {
            entry.delegationId = del.id;
          }
        }
      } catch (err) {
        emit({ type: "error", level: "warn", data: { message: `Could not recover delegations for project ${project.id}`, projectId: project.id, module: "execution-engine", error: String(err) } });
      }

      _projectDelegations.set(project.id, tracked);
    }
  }

  emit({ type: "system.health", level: "info", data: { message: `Recovery check complete. Tracking ${_projectDelegations.size} projects`, projectCount: _projectDelegations.size, module: "execution-engine" } });
}

// ============================================================
// Helpers
// ============================================================

function getNextMilestone(completed: number, total: number, inProgress: number): string {
  if (completed === 0) return `Starting — ${inProgress} items in progress`;
  if (completed >= total) return "All items complete";
  return `${completed}/${total} complete, ${inProgress} in progress`;
}
