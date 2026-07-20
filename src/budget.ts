/**
 * Budget Autonomy with Rails
 *
 * Per-user budget ledger with per-agent spend limits. Any agent pipeline that
 * includes a [SPEND: category | $amount | description] tag calls requestSpend()
 * before executing. If under the auto-approve threshold, spend is logged and
 * approved immediately. If over, it creates a pending_approvals entry.
 *
 * Budget rule precedence (most specific wins):
 *   agent_slug + category  >  agent_slug + NULL  >  NULL + category  >  NULL + NULL (global)
 */

import type { Database } from "./db.ts";
import { emit } from "./events.ts";

export interface SpendRequest {
  userId: string;
  agentSlug: string;
  category: string;
  amountUsd: number;
  description: string;
  taskId?: string | null;
}

export interface BudgetDecision {
  approved: boolean;
  reason: "under_limit" | "over_limit" | "daily_exceeded" | "monthly_exceeded" | "no_rule";
  requiresUserApproval: boolean;
  ledgerEntryId: string;
  autoApproveThreshold: number;
}

export interface BudgetSummary {
  monthlySpend: number;
  dailySpend: number;
  byAgent: Record<string, { spend: number; approvedCount: number; pendingCount: number }>;
  pendingApprovals: Array<{ id: string; agent: string; amount: number; description: string; created_at: string }>;
}

/**
 * Find the most specific applicable budget rule.
 * Precedence: agent+category > agent > category > global (null+null)
 */
function findApplicableRule(rules: any[], agentSlug: string, category: string): any | null {
  // 1. agent + category
  let rule = rules.find(r => r.agent_slug === agentSlug && r.category === category);
  if (rule) return rule;
  // 2. agent + any category
  rule = rules.find(r => r.agent_slug === agentSlug && r.category === null);
  if (rule) return rule;
  // 3. any agent + category
  rule = rules.find(r => r.agent_slug === null && r.category === category);
  if (rule) return rule;
  // 4. global (null + null)
  rule = rules.find(r => r.agent_slug === null && r.category === null);
  return rule || null;
}

/**
 * Request authorization for a spend.
 * Returns a BudgetDecision — if requiresUserApproval is true,
 * the caller should pause the pipeline and surface for review.
 */
export async function requestSpend(db: Database, req: SpendRequest): Promise<BudgetDecision> {
  const rules = db.getBudgetRules(req.userId);
  const rule = findApplicableRule(rules, req.agentSlug, req.category);

  const autoApproveThreshold = rule?.auto_approve_under ?? 10.0;
  const perActionLimit = rule?.per_action_limit ?? 100.0;
  const dailyLimit = rule?.daily_limit ?? null;
  const monthlyLimit = rule?.monthly_limit ?? null;

  // Check daily limit
  if (dailyLimit !== null) {
    const dailySpend = db.getDailyBudgetSpend(req.userId, req.agentSlug);
    if (dailySpend + req.amountUsd > dailyLimit) {
      const ledgerEntryId = db.insertBudgetEntry({
        user_id: req.userId,
        agent_slug: req.agentSlug,
        category: req.category,
        description: req.description,
        amount_usd: req.amountUsd,
        approved_by: "auto",
        status: "flagged",
        task_id: req.taskId,
        metadata: { reason: "daily_limit_exceeded", daily_limit: dailyLimit, current_daily_spend: dailySpend },
      });
      emit({ type: "budget.spend", level: "warn", userId: req.userId, agentSlug: req.agentSlug, data: { message: `Budget daily limit exceeded: ${req.agentSlug} wants $${req.amountUsd} but daily limit is $${dailyLimit}`, module: "budget" } });
      return { approved: false, reason: "daily_exceeded", requiresUserApproval: true, ledgerEntryId, autoApproveThreshold };
    }
  }

  // Check monthly limit
  if (monthlyLimit !== null) {
    const monthlySpend = db.getMonthlyBudgetSpend(req.userId);
    if (monthlySpend + req.amountUsd > monthlyLimit) {
      const ledgerEntryId = db.insertBudgetEntry({
        user_id: req.userId,
        agent_slug: req.agentSlug,
        category: req.category,
        description: req.description,
        amount_usd: req.amountUsd,
        approved_by: "auto",
        status: "flagged",
        task_id: req.taskId,
        metadata: { reason: "monthly_limit_exceeded", monthly_limit: monthlyLimit },
      });
      emit({ type: "budget.spend", level: "warn", userId: req.userId, agentSlug: req.agentSlug, data: { message: `Budget monthly limit exceeded: wants $${req.amountUsd}`, module: "budget" } });
      return { approved: false, reason: "monthly_exceeded", requiresUserApproval: true, ledgerEntryId, autoApproveThreshold };
    }
  }

  // Check per-action limit
  if (req.amountUsd > perActionLimit) {
    const ledgerEntryId = db.insertBudgetEntry({
      user_id: req.userId,
      agent_slug: req.agentSlug,
      category: req.category,
      description: req.description,
      amount_usd: req.amountUsd,
      approved_by: "auto",
      status: "flagged",
      task_id: req.taskId,
      metadata: { reason: "over_per_action_limit", per_action_limit: perActionLimit },
    });
    emit({ type: "budget.spend", level: "warn", userId: req.userId, agentSlug: req.agentSlug, data: { message: `Budget per-action limit exceeded: $${req.amountUsd} > limit $${perActionLimit}`, module: "budget" } });
    return { approved: false, reason: "over_limit", requiresUserApproval: true, ledgerEntryId, autoApproveThreshold };
  }

  // Auto-approve if under threshold
  if (req.amountUsd <= autoApproveThreshold) {
    const ledgerEntryId = db.insertBudgetEntry({
      user_id: req.userId,
      agent_slug: req.agentSlug,
      category: req.category,
      description: req.description,
      amount_usd: req.amountUsd,
      approved_by: "auto",
      status: "approved",
      task_id: req.taskId,
    });
    emit({ type: "budget.spend", level: "info", userId: req.userId, agentSlug: req.agentSlug, data: { message: `Auto-approved spend: ${req.agentSlug} $${req.amountUsd} for ${req.description}`, module: "budget" } });
    return { approved: true, reason: "under_limit", requiresUserApproval: false, ledgerEntryId, autoApproveThreshold };
  }

  // Requires user approval (above auto-approve threshold but below per-action limit)
  const ledgerEntryId = db.insertBudgetEntry({
    user_id: req.userId,
    agent_slug: req.agentSlug,
    category: req.category,
    description: req.description,
    amount_usd: req.amountUsd,
    approved_by: "auto",
    status: "pending",
    task_id: req.taskId,
  });
  emit({ type: "budget.spend", level: "info", userId: req.userId, agentSlug: req.agentSlug, data: { message: `Budget approval required: ${req.agentSlug} $${req.amountUsd} for ${req.description}`, module: "budget" } });
  return { approved: false, reason: "over_limit", requiresUserApproval: true, ledgerEntryId, autoApproveThreshold };
}

/**
 * Get a budget summary for a user.
 */
export function getBudgetSummary(db: Database, userId: string): BudgetSummary {
  const entries = db.getBudgetEntries(userId);
  const monthlySpend = db.getMonthlyBudgetSpend(userId);
  const dailySpend = db.getDailyBudgetSpend(userId);

  const byAgent: BudgetSummary["byAgent"] = {};
  const pendingApprovals: BudgetSummary["pendingApprovals"] = [];

  for (const entry of entries) {
    if (!byAgent[entry.agent_slug]) {
      byAgent[entry.agent_slug] = { spend: 0, approvedCount: 0, pendingCount: 0 };
    }
    if (entry.status === "approved") {
      byAgent[entry.agent_slug].spend += entry.amount_usd;
      byAgent[entry.agent_slug].approvedCount++;
    } else if (entry.status === "pending" || entry.status === "flagged") {
      byAgent[entry.agent_slug].pendingCount++;
      if (pendingApprovals.length < 10) {
        pendingApprovals.push({
          id: entry.id,
          agent: entry.agent_slug,
          amount: entry.amount_usd,
          description: entry.description || "",
          created_at: entry.created_at,
        });
      }
    }
  }

  return { monthlySpend, dailySpend, byAgent, pendingApprovals };
}

/**
 * Format a budget summary for Telegram message.
 */
export function formatBudgetSummary(summary: BudgetSummary): string {
  const lines = [
    `💰 Budget Summary`,
    `Today: $${summary.dailySpend.toFixed(2)} | This month: $${summary.monthlySpend.toFixed(2)}`,
    "",
  ];

  if (Object.keys(summary.byAgent).length > 0) {
    lines.push("By agent:");
    for (const [agent, stats] of Object.entries(summary.byAgent)) {
      if (stats.spend > 0 || stats.pendingCount > 0) {
        lines.push(`  ${agent}: $${stats.spend.toFixed(2)} (${stats.approvedCount} approved${stats.pendingCount > 0 ? `, ${stats.pendingCount} pending` : ""})`);
      }
    }
  }

  if (summary.pendingApprovals.length > 0) {
    lines.push("", "Pending approvals:");
    for (const p of summary.pendingApprovals) {
      lines.push(`  • ${p.agent} — $${p.amount.toFixed(2)}: ${p.description.slice(0, 60)}`);
    }
  }

  if (lines.length <= 3) lines.push("No spending recorded yet.");

  return lines.join("\n");
}
