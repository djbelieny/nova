/**
 * Autonomous Goals Engine (24/7)
 *
 * Runs every 30 minutes, reviews active goals for each user,
 * assesses progress against recent task completions, and
 * self-delegates work to agents without user prompting.
 *
 * This is what makes Nova a proactive operator rather than a reactive assistant.
 *
 * Goal review flow:
 * 1. Load goals that haven't been reviewed in the last 6 hours
 * 2. Load recent task completions (last 48h) for context
 * 3. LLM prompt: "Which goals need action? For each, output [GOAL_ACTION: goalId | agentSlug | task]"
 * 4. Parse actions, create agent_tasks with created_by='nova'
 * 5. Update goal's last_reviewed_at and progress_notes
 */

import { dirname, join } from "path";
import { getDb, type Database } from "../src/db.ts";
import { emit } from "../src/events.ts";

const PROJECT_ROOT = join(dirname(import.meta.path), "..");
const REVIEW_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const STALE_THRESHOLD_MINUTES = 360; // 6 hours

let _db: Database | null = null;
function db(): Database {
  if (!_db) _db = getDb();
  return _db;
}

let _callAI: ((prompt: string, tier?: string, hint?: string) => Promise<string>) | null = null;
let _sendAlert: ((userId: string, message: string) => Promise<void>) | null = null;
let _dispatchTask: ((userId: string, agentSlug: string, taskDescription: string, createdBy?: string) => Promise<string | null>) | null = null;

export function initGoalEngine(deps: {
  callAI: (prompt: string, tier?: string, hint?: string) => Promise<string>;
  sendAlert: (userId: string, message: string) => Promise<void>;
  dispatchTask: (userId: string, agentSlug: string, taskDescription: string, createdBy?: string) => Promise<string | null>;
}): void {
  _callAI = deps.callAI;
  _sendAlert = deps.sendAlert;
  _dispatchTask = deps.dispatchTask;
}

interface GoalAction {
  goalId: string;
  agentSlug: string;
  taskDescription: string;
}

/**
 * Parse [GOAL_ACTION: goalId | agentSlug | task description] tags.
 */
function parseGoalActions(text: string): GoalAction[] {
  const actions: GoalAction[] = [];
  const pattern = /\[GOAL_ACTION:\s*([^\|]+?)\s*\|\s*([^\|]+?)\s*\|\s*(.+?)\s*\]/g;
  for (const match of text.matchAll(pattern)) {
    actions.push({
      goalId: match[1].trim(),
      agentSlug: match[2].trim().toLowerCase(),
      taskDescription: match[3].trim(),
    });
  }
  return actions;
}

/**
 * Run goal review for a single user.
 */
async function runGoalReviewForUser(user: any): Promise<void> {
  if (!_callAI || !_dispatchTask) return;

  // Skip if goal engine is disabled for this user
  if (user.preferences?.goal_engine_enabled === false) return;

  const userDb = db();

  // Load stale goals
  const goals = userDb.getGoalsNeedingReview(user.id, STALE_THRESHOLD_MINUTES);
  if (goals.length === 0) return;

  // Load recent completed tasks for context (last 48h)
  const recentTasksAll = userDb.getAgentTasksRecent({ userId: user.id, limit: 30 });
  const recentTasks = recentTasksAll.filter((t: any) => t.status === "completed" || t.status === "done");
  const recentTaskContext = recentTasks.slice(0, 10)
    .map((t: any) => `- [${t.agent}] ${t.description.slice(0, 80)}: ${(t.result || "done").slice(0, 100)}`)
    .join("\n") || "No recent completed tasks.";

  // Load in-progress tasks
  const activeTasks = userDb.getActiveTasks(user.id);
  const activeTaskContext = activeTasks
    .map((t: any) => `- [${t.agent}] ${t.description.slice(0, 80)}`)
    .join("\n") || "None.";

  const goalList = goals.map((g: any) => {
    const notes = JSON.parse(g.progress_notes || "[]");
    const lastNote = notes.length > 0 ? notes[notes.length - 1]?.note || "" : "";
    return `ID: ${g.id}\nGoal: ${g.content}\nDeadline: ${g.deadline || "none"}\nLast progress note: ${lastNote || "none"}`;
  }).join("\n\n");

  const prompt = `You are Nova's autonomous goal manager for user: ${user.name}.

Review these active goals and determine which need action right now.

ACTIVE GOALS:
${goalList}

RECENTLY COMPLETED TASKS (last 48h):
${recentTaskContext}

CURRENTLY IN PROGRESS:
${activeTaskContext}

Today's date: ${new Date().toISOString().split("T")[0]}

Instructions:
- For each goal that needs work NOW (not already covered by active tasks), output a GOAL_ACTION tag
- Only create actions for goals that have clear next steps
- Don't duplicate work already in progress
- Be specific and actionable in the task description
- Pick the most appropriate agent for each task
- If a goal is already being covered by active tasks, skip it
- If a goal is complete or on track with no action needed, skip it
- Maximum 3 actions total

Available agents: pixel (social media), kai (content/writing), orion (email), helios (ads), architect (web dev), athena (strategy), digit (analytics), echo (support), flux (funnels), lex (legal), helia (PR), bridge (partnerships), oracle (research), cipher (data science), rift (security), joule (automation), nexus (community), aura (brand), zen (productivity), tesseract (systems), magnus (SEO), cyra (website), morpheus (video), quill (grants)

For each goal needing action, output exactly:
[GOAL_ACTION: <goalId> | <agentSlug> | <specific actionable task description>]

Only output the GOAL_ACTION tags and nothing else. If no goals need action, output: NO_ACTION_NEEDED`;

  let response = "";
  try {
    response = await _callAI(prompt, "fast");
  } catch (err) {
    emit({ type: "error", level: "error", data: { message: `Goal engine AI call failed for user ${user.id}: ${err}`, module: "goal-engine" } });
    return;
  }

  if (response.includes("NO_ACTION_NEEDED")) {
    // Update last_reviewed_at for all reviewed goals
    for (const goal of goals) {
      try { userDb.updateGoalProgress(goal.id, user.id, "No action needed at this time"); } catch {}
    }
    return;
  }

  const actions = parseGoalActions(response);
  if (actions.length === 0) return;

  const dispatched: string[] = [];

  for (const action of actions.slice(0, 3)) {
    // Find matching goal
    const goal = goals.find((g: any) => g.id === action.goalId || g.content.toLowerCase().includes(action.goalId.toLowerCase()));
    if (!goal) continue;

    // Dispatch task
    try {
      const taskId = await _dispatchTask(user.id, action.agentSlug, action.taskDescription, "nova");
      if (taskId) {
        userDb.updateGoalProgress(goal.id, user.id, `Nova dispatched: ${action.taskDescription.slice(0, 100)}`, taskId);
        dispatched.push(`• ${action.agentSlug}: ${action.taskDescription.slice(0, 80)}`);

        emit({
          type: "goal.reviewed",
          level: "info",
          userId: user.id,
          agentSlug: action.agentSlug,
          data: {
            message: `Goal engine dispatched task for "${goal.content.slice(0, 60)}"`,
            goalId: goal.id,
            agentSlug: action.agentSlug,
            taskId,
            module: "goal-engine",
          },
        });
      }
    } catch (err) {
      emit({ type: "error", level: "warn", data: { message: `Goal engine dispatch failed: ${err}`, module: "goal-engine" } });
    }
  }

  // Notify user if tasks were dispatched
  if (dispatched.length > 0 && _sendAlert) {
    const msg = `🎯 Goal Engine Update\n\nI noticed some of your goals need attention and dispatched:\n${dispatched.join("\n")}\n\nI'll update you when complete.`;
    await _sendAlert(user.id, msg).catch(() => {});
  }
}

/**
 * Run goal review for all active users.
 */
async function runGoalReview(): Promise<void> {
  const userDb = db();

  let users: any[] = [];
  try {
    users = userDb.getUsersByRole ? [...(userDb.getUsersByRole("admin") || []), ...(userDb.getUsersByRole("member") || [])] : [];
  } catch {
    return;
  }

  // Filter to active users only
  users = users.filter((u: any) => u.active !== 0 && u.active !== false);

  for (const user of users) {
    try {
      await runGoalReviewForUser(user);
    } catch (err) {
      emit({ type: "error", level: "warn", data: { message: `Goal review failed for user ${user.id}: ${err}`, module: "goal-engine" } });
    }
  }
}

/**
 * Start the goal engine loop.
 */
export async function start(): Promise<void> {
  emit({ type: "goal.reviewed", level: "info", data: { message: "Goal engine started (30-min review cycle)", module: "goal-engine" } });

  const tick = async () => {
    try {
      await runGoalReview();
    } catch (err) {
      emit({ type: "error", level: "error", data: { message: `Goal engine tick failed: ${err}`, module: "goal-engine" } });
    }
    setTimeout(tick, REVIEW_INTERVAL_MS);
  };

  // First run after 5 minutes (let system settle on startup)
  setTimeout(tick, 5 * 60 * 1000);
}

/**
 * Run once immediately (for manual trigger / /goals check command).
 */
export async function runOnce(): Promise<void> {
  await runGoalReview();
}
