/**
 * Cross-Session Project Memory
 *
 * Named project objects with persistent context across sessions.
 * Each project tracks: phase, decisions, artifacts, next actions, owner agents.
 *
 * Agents load project context via getProjectContext() when building prompts.
 * Pipelines update project state via updateProjectFromTaskResult() after execution.
 *
 * Tag formats parsed from agent output:
 *   [PROJECT_ARTIFACT: name | ref]  — logs an artifact under the project
 *   [PROJECT_DECISION: text]        — logs a key decision
 */

import type { Database } from "./db.ts";

export interface Project {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  phase: "discovery" | "planning" | "execution" | "review" | "complete" | "paused";
  owner_agents: string[];
  decisions: Array<{ date: string; decision: string; agent?: string }>;
  artifacts: Array<{ name: string; ref: string; date: string }>;
  next_actions: Array<{ action: string; agentSlug?: string; dueDate?: string }>;
  metadata: Record<string, any>;
  archived: number;
  created_at: string;
  updated_at: string;
}

/**
 * Create a new project.
 */
export function createProject(
  db: Database,
  userId: string,
  name: string,
  description?: string,
  ownerAgents?: string[]
): string {
  return db.insertProject({ user_id: userId, name, description, owner_agents: ownerAgents });
}

/**
 * Get formatted project context for injection into agent prompts.
 * If projectHint is provided, finds by name (fuzzy match).
 * Otherwise returns the most recently updated active project.
 */
export function getProjectContext(db: Database, userId: string, projectHint?: string): string | null {
  let project: Project | null = null;

  if (projectHint) {
    project = db.getStrategicProjectByName(userId, projectHint);
  }

  if (!project) {
    const all = db.getStrategicProjects(userId);
    if (all.length === 0) return null;
    project = all[0]; // most recently updated
  }

  if (!project) return null;

  const lines = [
    `## Active Project: ${project.name}`,
    `Phase: ${project.phase} | Agents: ${project.owner_agents.join(", ") || "none assigned"}`,
    project.description ? `Description: ${project.description}` : null,
  ].filter(Boolean);

  if (project.decisions.length > 0) {
    lines.push("Key decisions:");
    for (const d of project.decisions.slice(-3)) {
      lines.push(`  • [${d.date.split("T")[0]}] ${d.decision}${d.agent ? ` (${d.agent})` : ""}`);
    }
  }

  if (project.artifacts.length > 0) {
    lines.push("Artifacts:");
    for (const a of project.artifacts.slice(-5)) {
      lines.push(`  • ${a.name}: ${a.ref}`);
    }
  }

  if (project.next_actions.length > 0) {
    lines.push("Next actions:");
    for (const a of project.next_actions.slice(0, 3)) {
      const due = a.dueDate ? ` (due ${a.dueDate})` : "";
      lines.push(`  • ${a.action}${a.agentSlug ? ` → ${a.agentSlug}` : ""}${due}`);
    }
  }

  return lines.join("\n");
}

/**
 * Update project state from a completed subtask result.
 * Parses [PROJECT_ARTIFACT:] and [PROJECT_DECISION:] tags.
 */
export function updateProjectFromTaskResult(
  db: Database,
  projectId: string,
  userId: string,
  taskResult: { result: string; agent?: string }
): void {
  const today = new Date().toISOString().split("T")[0];

  // Parse artifact tags
  const artifactPattern = /\[PROJECT_ARTIFACT:\s*([^|]+?)\s*\|\s*(.+?)\s*\]/g;
  for (const match of taskResult.result.matchAll(artifactPattern)) {
    try {
      db.appendProjectArtifact(projectId, userId, {
        name: match[1].trim(),
        ref: match[2].trim(),
        date: today,
      });
    } catch {}
  }

  // Parse decision tags
  const decisionPattern = /\[PROJECT_DECISION:\s*(.+?)\s*\]/g;
  for (const match of taskResult.result.matchAll(decisionPattern)) {
    try {
      db.appendProjectDecision(projectId, userId, {
        date: new Date().toISOString(),
        decision: match[1].trim(),
        agent: taskResult.agent,
      });
    } catch {}
  }
}

/**
 * Get a formatted project brief for Telegram.
 */
export function getProjectBrief(db: Database, userId: string, projectNameOrId: string): string {
  let project: Project | null = db.getStrategicProjectByName(userId, projectNameOrId);
  if (!project) {
    project = db.getProjectById(userId, projectNameOrId);
  }

  if (!project) return `No project found matching "${projectNameOrId}"`;

  const lines = [
    `📋 ${project.name}`,
    `Phase: ${project.phase.toUpperCase()} | Created: ${project.created_at.split("T")[0]}`,
    project.description ? `\n${project.description}` : "",
    "",
  ];

  if (project.owner_agents.length > 0) {
    lines.push(`Assigned agents: ${project.owner_agents.join(", ")}`);
  }

  if (project.decisions.length > 0) {
    lines.push(`\nDecisions (${project.decisions.length} total):`);
    for (const d of project.decisions.slice(-5)) {
      lines.push(`  • ${d.decision.slice(0, 80)}`);
    }
  }

  if (project.artifacts.length > 0) {
    lines.push(`\nArtifacts (${project.artifacts.length} total):`);
    for (const a of project.artifacts.slice(-5)) {
      lines.push(`  • ${a.name}: ${a.ref.slice(0, 60)}`);
    }
  }

  if (project.next_actions.length > 0) {
    lines.push(`\nNext actions:`);
    for (const a of project.next_actions.slice(0, 5)) {
      lines.push(`  • ${a.action.slice(0, 80)}`);
    }
  }

  return lines.filter(l => l !== "").join("\n");
}

/**
 * List all active projects for a user (brief format).
 */
export function listProjects(db: Database, userId: string): string {
  const projects = db.getStrategicProjects(userId);
  if (projects.length === 0) return "No active projects. Create one with /project create <name>";

  const lines = ["📋 Active Projects:"];
  for (const p of projects) {
    const updated = p.updated_at.split("T")[0];
    lines.push(`  • ${p.name} [${p.phase}] — updated ${updated}`);
  }
  return lines.join("\n");
}
