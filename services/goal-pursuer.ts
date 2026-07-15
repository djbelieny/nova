/**
 * Goal Pursuit Loop (24/7, opt-in)
 *
 * Turns standing goals ("grow the newsletter to 5k") into forward motion. Periodically
 * scans active goals, and for any goal that has NO active task covering it, decomposes it
 * into a small number of concrete agent tasks and dispatches them down the COO path — then
 * links the dispatched work back to the goal so it isn't re-decomposed next cycle.
 *
 * This complements goal-engine.ts (which reviews progress) by guaranteeing that a goal with
 * no work in flight always gets a concrete next step. Safety is paramount: hard caps on tasks
 * per goal, per user, and goals per cycle prevent any runaway task creation.
 *
 * Opt-in: set NOVA_GOAL_PURSUER_ENABLED=1. Run: bun run services/goal-pursuer.ts
 * Mirrors services/task-dispatcher.ts (standalone entry, registers providers, polling loop).
 */

import { getDb } from "../src/db.ts";
import { emit } from "../src/events.ts";

// Safety caps — the whole point of this module is to be un-runnable-away.
export const MAX_TASKS_PER_GOAL = 2;
export const MAX_TASKS_PER_USER_CYCLE = 5;
export const MAX_GOALS_PER_CYCLE = 10;

const REVIEW_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const STALE_THRESHOLD_MINUTES = 360; // only pursue goals not reviewed in the last 6h

const AGENT_MENU =
  "pixel (social), kai (content), orion (email), helios (ads), architect (web), athena (strategy), " +
  "digit (analytics), echo (support), flux (funnels), lex (legal), helia (PR), bridge (partnerships), " +
  "oracle (research), cipher (data science), rift (security), joule (automation), nexus (community), " +
  "aura (brand), zen (productivity), tesseract (systems), magnus (SEO), cyra (website), morpheus (video), quill (grants)";

export interface Goal {
  id: string;
  content: string;
  deadline?: string | null;
  priority?: number;
  progress_notes?: string | null;
}

export interface ActiveTask {
  id: string;
  status: string;
}

export interface GoalTask {
  agent: string;
  description: string;
}

export interface GoalPursuerDeps {
  callModel: (prompt: string) => Promise<string>;
  dispatchTask: (userId: string, agent: string, description: string, createdBy?: string) => Promise<string | null>;
}

/** The slice of the Database this module needs — structural so a fake satisfies it in tests. */
export interface GoalPursuerDb {
  getGoalsNeedingReview: (userId: string, staleAfterMinutes?: number) => Goal[];
  getActiveTasks: (userId: string) => ActiveTask[];
  updateGoalProgress: (goalId: string, userId: string, note: string, taskId?: string) => void;
}

export interface PursuitSummary {
  goalsConsidered: number;
  goalsActioned: number;
  dispatched: number;
}

function taskIdsFromNotes(progressNotes: string | null | undefined): string[] {
  if (!progressNotes) return [];
  try {
    const notes = JSON.parse(progressNotes);
    if (!Array.isArray(notes)) return [];
    return notes.map((n) => n?.task_id).filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

/** A goal is "covered" if any task it previously spawned is still active. */
export function hasActiveTask(goal: Goal, activeTasks: ActiveTask[]): boolean {
  const active = new Set(activeTasks.map((t) => t.id));
  return taskIdsFromNotes(goal.progress_notes).some((id) => active.has(id));
}

export function goalsNeedingPursuit(goals: Goal[], activeTasks: ActiveTask[]): Goal[] {
  return goals.filter((g) => !hasActiveTask(g, activeTasks));
}

/** Parse [GOAL_TASK: agentSlug | task description] tags. */
export function parseGoalTasks(text: string): GoalTask[] {
  const tasks: GoalTask[] = [];
  const pattern = /\[GOAL_TASK:\s*([^\|]+?)\s*\|\s*(.+?)\s*\]/g;
  for (const match of text.matchAll(pattern)) {
    const agent = match[1].trim().toLowerCase();
    const description = match[2].trim();
    if (agent && description) tasks.push({ agent, description });
  }
  return tasks;
}

function buildDecomposePrompt(goal: Goal): string {
  return `You are Nova's goal pursuit planner. This standing goal currently has NO work in progress.
Break it into up to ${MAX_TASKS_PER_GOAL} concrete, immediately actionable next tasks — the smallest
steps that move it forward now.

GOAL: ${goal.content}
DEADLINE: ${goal.deadline || "none"}
TODAY: ${new Date().toISOString().split("T")[0]}

Available agents: ${AGENT_MENU}

Output only tags, one per task, and nothing else:
[GOAL_TASK: <agentSlug> | <specific actionable task>]

If the goal needs no action right now, output exactly: NO_ACTION_NEEDED`;
}

/** Decompose a single goal into at most MAX_TASKS_PER_GOAL tasks. Never throws. */
export async function decomposeGoal(goal: Goal, deps: GoalPursuerDeps): Promise<GoalTask[]> {
  let response = "";
  try {
    response = await deps.callModel(buildDecomposePrompt(goal));
  } catch (err) {
    emit({ type: "error", level: "warn", data: { message: `Goal pursuer decompose failed: ${err}`, module: "goal-pursuer" } });
    return [];
  }
  if (response.includes("NO_ACTION_NEEDED")) return [];
  return parseGoalTasks(response).slice(0, MAX_TASKS_PER_GOAL);
}

/**
 * Pursue all uncovered goals for one user, dispatching capped concrete tasks and linking each
 * back to its goal. Returns a summary of what it did. Never throws.
 */
export async function pursueGoalsForUser(
  userId: string,
  db: GoalPursuerDb,
  deps: GoalPursuerDeps,
): Promise<PursuitSummary> {
  const summary: PursuitSummary = { goalsConsidered: 0, goalsActioned: 0, dispatched: 0 };

  let goals: Goal[] = [];
  let activeTasks: ActiveTask[] = [];
  try {
    goals = db.getGoalsNeedingReview(userId, STALE_THRESHOLD_MINUTES) || [];
    activeTasks = db.getActiveTasks(userId) || [];
  } catch (err) {
    emit({ type: "error", level: "warn", data: { message: `Goal pursuer load failed for ${userId}: ${err}`, module: "goal-pursuer" } });
    return summary;
  }

  const candidates = goalsNeedingPursuit(goals, activeTasks).slice(0, MAX_GOALS_PER_CYCLE);
  summary.goalsConsidered = candidates.length;

  for (const goal of candidates) {
    if (summary.dispatched >= MAX_TASKS_PER_USER_CYCLE) break;

    const tasks = await decomposeGoal(goal, deps);
    if (tasks.length === 0) {
      try { db.updateGoalProgress(goal.id, userId, "Pursuer: no actionable step right now"); } catch {}
      continue;
    }

    const remaining = MAX_TASKS_PER_USER_CYCLE - summary.dispatched;
    let actioned = false;
    for (const task of tasks.slice(0, remaining)) {
      let taskId: string | null = null;
      try {
        taskId = await deps.dispatchTask(userId, task.agent, task.description, "nova");
      } catch (err) {
        emit({ type: "error", level: "warn", data: { message: `Goal pursuer dispatch failed: ${err}`, module: "goal-pursuer" } });
        continue;
      }
      if (!taskId) continue;
      actioned = true;
      summary.dispatched++;
      try {
        db.updateGoalProgress(goal.id, userId, `Pursuer dispatched to ${task.agent}: ${task.description.slice(0, 100)}`, taskId);
      } catch {}
      emit({
        type: "goal.reviewed",
        level: "info",
        userId,
        agentSlug: task.agent,
        data: { message: `Goal pursuer dispatched task for "${goal.content.slice(0, 60)}"`, goalId: goal.id, agentSlug: task.agent, taskId, module: "goal-pursuer" },
      });
    }
    if (actioned) summary.goalsActioned++;
  }

  return summary;
}

function activeUsers(db: any): any[] {
  try {
    const users = [...(db.getUsersByRole("admin") || []), ...(db.getUsersByRole("member") || [])];
    return users.filter((u: any) => u.active !== 0 && u.active !== false && u.preferences?.goal_pursuer_enabled !== false);
  } catch {
    return [];
  }
}

/** Run one full pursuit cycle across all active users. */
export async function runOnce(deps: GoalPursuerDeps): Promise<void> {
  const db = getDb();
  for (const user of activeUsers(db)) {
    try {
      const summary = await pursueGoalsForUser(user.id, db as unknown as GoalPursuerDb, deps);
      if (summary.dispatched > 0) {
        console.log(`[goal-pursuer] ${user.name || user.id}: actioned ${summary.goalsActioned}/${summary.goalsConsidered} goals, dispatched ${summary.dispatched} task(s)`);
      }
    } catch (err) {
      emit({ type: "error", level: "warn", data: { message: `Goal pursuer failed for user ${user.id}: ${err}`, module: "goal-pursuer" } });
    }
  }
}

// ============================================================
// Standalone entry
// ============================================================

async function buildDefaultDeps(): Promise<GoalPursuerDeps> {
  const { registerProvider, getProvider, getDefaultProvider } = await import("../src/ai-provider.ts");
  const { ClaudeProvider } = await import("../src/providers/claude.ts");
  const { GeminiProvider } = await import("../src/providers/gemini.ts");
  const { CodexProvider } = await import("../src/providers/codex.ts");
  registerProvider(new ClaudeProvider());
  registerProvider(new GeminiProvider());
  registerProvider(new CodexProvider());

  const callModel = async (prompt: string): Promise<string> => {
    try {
      const { selectProvider } = await import("../src/ai-router.ts");
      const route = await selectProvider({ tier: "fast" });
      const res = await route.provider.call({ prompt, model: route.model, outputFormat: "text", sandboxed: true, maxTurns: 1 });
      return res.text ?? "";
    } catch {
      return "";
    }
  };

  const dispatchTask = async (userId: string, agent: string, description: string, createdBy = "nova"): Promise<string | null> => {
    try {
      return getDb().insertTask({ agent, description, status: "pending", user_id: userId, created_by: createdBy });
    } catch {
      return null;
    }
  };

  // Touch the providers so an unused-import lint never trips; harmless.
  void getProvider;
  void getDefaultProvider;

  return { callModel, dispatchTask };
}

export async function start(): Promise<void> {
  if (process.env.NOVA_GOAL_PURSUER_ENABLED !== "1") {
    console.log("[goal-pursuer] disabled (set NOVA_GOAL_PURSUER_ENABLED=1 to enable)");
    return;
  }
  const deps = await buildDefaultDeps();
  emit({ type: "goal.reviewed", level: "info", data: { message: "Goal pursuer started (30-min cycle)", module: "goal-pursuer" } });

  const tick = async () => {
    try {
      await runOnce(deps);
    } catch (err) {
      emit({ type: "error", level: "error", data: { message: `Goal pursuer tick failed: ${err}`, module: "goal-pursuer" } });
    }
    setTimeout(tick, REVIEW_INTERVAL_MS);
  };
  setTimeout(tick, 5 * 60 * 1000);
}

if (import.meta.main) {
  if (process.env.NOVA_GOAL_PURSUER_ENABLED !== "1") {
    console.log("[goal-pursuer] disabled (set NOVA_GOAL_PURSUER_ENABLED=1 to enable). Exiting.");
    process.exit(0);
  }
  buildDefaultDeps()
    .then((deps) => runOnce(deps))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[goal-pursuer] fatal:", err);
      process.exit(1);
    });
}
