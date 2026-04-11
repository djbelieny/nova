/**
 * Agent Performance Reputation
 *
 * Tracks per-agent success/failure/revision rates across all pipelines.
 * Used to:
 * - Prefer higher-reputation agents for critical path tasks
 * - Surface weekly performance reports in COO briefings
 * - Identify underperforming agents that need prompt tuning
 *
 * Reputation score = (success_count / total_tasks) - 0.3 * (revision_count / total_tasks)
 * Range: 0.0 (terrible) to 1.0 (perfect)
 */

import type { Database } from "./db.ts";

export interface AgentReputation {
  agent_slug: string;
  total_tasks: number;
  success_count: number;
  fail_count: number;
  revision_count: number;
  avg_confidence: number;
  last_task_at: string | null;
  score: number;
}

/**
 * Calculate reputation score from raw stats.
 * Penalizes revisions (requested revisions mean output wasn't good enough first time).
 */
export function calculateReputationScore(rep: {
  total_tasks: number;
  success_count: number;
  fail_count: number;
  revision_count: number;
}): number {
  if (rep.total_tasks === 0) return 0.5; // neutral for new agents
  const successRate = rep.success_count / rep.total_tasks;
  const revisionPenalty = 0.3 * (rep.revision_count / rep.total_tasks);
  return Math.min(1.0, Math.max(0.0, successRate - revisionPenalty));
}

/**
 * Get reputation for a single agent, including calculated score.
 */
export function getAgentReputation(db: Database, agentSlug: string): AgentReputation | null {
  const rep = db.getAgentReputation(agentSlug);
  if (!rep) return null;
  return {
    ...rep,
    score: calculateReputationScore(rep),
  };
}

/**
 * Sort agent slugs by reputation score (best first).
 * Agents without reputation data get neutral score 0.5.
 */
export function sortAgentsByReputation(db: Database, agentSlugs: string[]): string[] {
  const scores = agentSlugs.map((slug) => {
    const rep = db.getAgentReputation(slug);
    const score = rep ? calculateReputationScore(rep) : 0.5;
    return { slug, score };
  });
  return scores.sort((a, b) => b.score - a.score).map((s) => s.slug);
}

/**
 * Record a task outcome for an agent.
 */
export function recordTaskOutcome(
  db: Database,
  agentSlug: string,
  outcome: { success: boolean; revised?: boolean; confidenceScore?: number }
): void {
  try {
    db.recordAgentOutcome(agentSlug, outcome);
  } catch (err) {
    // Non-critical — never let reputation tracking break the pipeline
    console.debug("[reputation] Failed to record outcome:", err);
  }
}

/**
 * Mark that a task was revised (user requested changes).
 * Call this when a revision is triggered in orchestrator.
 */
export function recordRevision(db: Database, agentSlug: string): void {
  recordTaskOutcome(db, agentSlug, { success: false, revised: true });
}

/**
 * Get a formatted weekly reputation report for all agents.
 * Used in COO morning briefing.
 */
export function getWeeklyReputationReport(db: Database): string {
  const reps = db.getAllAgentReputations();
  if (reps.length === 0) return "No agent performance data yet.";

  // Only include agents with at least 2 tasks
  const active = reps.filter((r: any) => r.total_tasks >= 2);
  if (active.length === 0) return "Not enough task history for reputation analysis.";

  const withScores = active.map((r: any) => ({
    ...r,
    score: calculateReputationScore(r),
  })).sort((a: any, b: any) => b.score - a.score);

  const lines = ["## Agent Reputation Report\n"];

  // Top performers
  const top = withScores.slice(0, 5);
  if (top.length > 0) {
    lines.push("**Top Performers:**");
    for (const r of top) {
      const pct = Math.round(r.score * 100);
      lines.push(`  • ${r.agent_slug}: ${pct}% (${r.success_count}/${r.total_tasks} success${r.revision_count > 0 ? `, ${r.revision_count} revisions` : ""})`);
    }
  }

  // Underperformers (score < 0.6 with at least 5 tasks)
  const under = withScores.filter((r: any) => r.score < 0.6 && r.total_tasks >= 5);
  if (under.length > 0) {
    lines.push("\n**Needs Attention:**");
    for (const r of under) {
      const pct = Math.round(r.score * 100);
      lines.push(`  • ${r.agent_slug}: ${pct}% (${r.fail_count} failures, ${r.revision_count} revisions)`);
    }
  }

  return lines.join("\n");
}

/**
 * Get a compact reputation context string for LLM decomposer prompts.
 * Informs the planner to prefer high-reputation agents for critical tasks.
 */
export function getReputationContext(db: Database): string {
  const reps = db.getAllAgentReputations();
  if (reps.length === 0) return "";

  const active = reps.filter((r: any) => r.total_tasks >= 3);
  if (active.length === 0) return "";

  const high = active
    .filter((r: any) => calculateReputationScore(r) >= 0.8)
    .map((r: any) => r.agent_slug);

  const low = active
    .filter((r: any) => calculateReputationScore(r) < 0.5 && r.total_tasks >= 5)
    .map((r: any) => r.agent_slug);

  const parts: string[] = [];
  if (high.length > 0) parts.push(`High-performing agents (prefer for critical tasks): ${high.join(", ")}`);
  if (low.length > 0) parts.push(`Underperforming agents (use cautiously): ${low.join(", ")}`);

  return parts.length > 0 ? `\n## Agent Reputation\n${parts.join("\n")}\n` : "";
}
