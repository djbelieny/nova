import { test, expect } from "bun:test";
import {
  hasActiveTask,
  goalsNeedingPursuit,
  parseGoalTasks,
  decomposeGoal,
  pursueGoalsForUser,
  MAX_TASKS_PER_GOAL,
  MAX_TASKS_PER_USER_CYCLE,
  type GoalPursuerDeps,
  type GoalPursuerDb,
} from "../services/goal-pursuer.ts";

const goal = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  content: `goal ${id}`,
  deadline: null,
  priority: 0,
  progress_notes: "[]",
  ...extra,
});

const notesWithTask = (taskId: string) => JSON.stringify([{ date: "2026-07-15", note: "dispatched", task_id: taskId }]);

test("hasActiveTask is true only when a linked task is still active", () => {
  const active = [{ id: "t1", status: "in_progress" }];
  expect(hasActiveTask(goal("g1", { progress_notes: notesWithTask("t1") }), active)).toBe(true);
  expect(hasActiveTask(goal("g2", { progress_notes: notesWithTask("t9") }), active)).toBe(false);
  expect(hasActiveTask(goal("g3"), active)).toBe(false);
});

test("hasActiveTask tolerates malformed progress_notes", () => {
  expect(hasActiveTask(goal("g", { progress_notes: "not json" }), [{ id: "t1", status: "pending" }])).toBe(false);
});

test("goalsNeedingPursuit drops goals that already have active tasks", () => {
  const goals = [
    goal("covered", { progress_notes: notesWithTask("t1") }),
    goal("uncovered"),
  ];
  const active = [{ id: "t1", status: "pending" }];
  const needing = goalsNeedingPursuit(goals, active);
  expect(needing.map((g) => g.id)).toEqual(["uncovered"]);
});

test("parseGoalTasks extracts agent + description pairs", () => {
  const tasks = parseGoalTasks(
    "[GOAL_TASK: orion | draft the welcome sequence]\n[GOAL_TASK: Pixel | schedule 3 IG posts]",
  );
  expect(tasks).toEqual([
    { agent: "orion", description: "draft the welcome sequence" },
    { agent: "pixel", description: "schedule 3 IG posts" },
  ]);
});

test("decomposeGoal caps at MAX_TASKS_PER_GOAL", async () => {
  const many = Array.from({ length: 5 }, (_, i) => `[GOAL_TASK: kai | task ${i}]`).join("\n");
  const deps: GoalPursuerDeps = {
    callModel: async () => many,
    dispatchTask: async () => "x",
  };
  const tasks = await decomposeGoal(goal("g", { content: "grow newsletter to 5k" }), deps);
  expect(tasks.length).toBe(MAX_TASKS_PER_GOAL);
});

test("decomposeGoal returns [] on NO_ACTION and never throws on model error", async () => {
  expect(await decomposeGoal(goal("g"), { callModel: async () => "NO_ACTION_NEEDED", dispatchTask: async () => "x" })).toEqual([]);
  expect(
    await decomposeGoal(goal("g"), {
      callModel: async () => {
        throw new Error("boom");
      },
      dispatchTask: async () => "x",
    }),
  ).toEqual([]);
});

function fakeDb(goals: any[], active: any[]) {
  const progress: Array<{ goalId: string; note: string; taskId?: string }> = [];
  const db: GoalPursuerDb = {
    getGoalsNeedingReview: () => goals,
    getActiveTasks: () => active,
    updateGoalProgress: (goalId, _userId, note, taskId) => progress.push({ goalId, note, taskId }),
  };
  return { db, progress };
}

test("pursueGoalsForUser dispatches capped tasks and links them to the goal", async () => {
  const { db, progress } = fakeDb([goal("g1", { content: "grow newsletter" })], []);
  const dispatched: Array<{ agent: string; desc: string }> = [];
  let n = 0;
  const deps: GoalPursuerDeps = {
    callModel: async () => "[GOAL_TASK: orion | send newsletter]\n[GOAL_TASK: kai | write article]\n[GOAL_TASK: pixel | post]",
    dispatchTask: async (_u, agent, desc) => {
      dispatched.push({ agent, desc });
      return `task-${n++}`;
    },
  };
  const summary = await pursueGoalsForUser("u1", db, deps);
  expect(dispatched.length).toBe(MAX_TASKS_PER_GOAL);
  expect(summary.dispatched).toBe(MAX_TASKS_PER_GOAL);
  expect(progress.filter((p) => p.taskId).length).toBe(MAX_TASKS_PER_GOAL);
});

test("pursueGoalsForUser skips goals that already have active tasks", async () => {
  const { db } = fakeDb(
    [goal("g1", { progress_notes: notesWithTask("t1") })],
    [{ id: "t1", status: "in_progress" }],
  );
  let called = false;
  const deps: GoalPursuerDeps = {
    callModel: async () => {
      called = true;
      return "[GOAL_TASK: orion | x]";
    },
    dispatchTask: async () => "t",
  };
  const summary = await pursueGoalsForUser("u1", db, deps);
  expect(called).toBe(false);
  expect(summary.dispatched).toBe(0);
});

test("pursueGoalsForUser enforces the per-user cycle cap across goals", async () => {
  const goals = Array.from({ length: 6 }, (_, i) => goal(`g${i}`));
  const { db } = fakeDb(goals, []);
  let dispatchCount = 0;
  const deps: GoalPursuerDeps = {
    callModel: async () => "[GOAL_TASK: kai | a]\n[GOAL_TASK: kai | b]",
    dispatchTask: async () => `t${dispatchCount++}`,
  };
  const summary = await pursueGoalsForUser("u1", db, deps);
  expect(summary.dispatched).toBeLessThanOrEqual(MAX_TASKS_PER_USER_CYCLE);
  expect(dispatchCount).toBeLessThanOrEqual(MAX_TASKS_PER_USER_CYCLE);
});
