import { test, expect } from "bun:test";
import { getDb } from "../src/db.ts";
import {
  getAutonomyView,
  setAutonomyGrantView,
  getBudgetsView,
  getGoalsView,
} from "../src/dashboard.ts";

const U = "44444444-4444-4444-8444-444444444444";
const U2 = "55555555-5555-4555-8555-555555555555";

test("setAutonomyGrant / getAutonomyGrants round-trips and upserts", () => {
  const db = getDb();
  db.setAutonomyGrant(U, { agent: "pixel", action_type: "social.publish", level: 2, spend_cap_daily: 5 });
  let grants = db.getAutonomyGrants(U);
  expect(grants.length).toBe(1);
  expect(grants[0].agent).toBe("pixel");
  expect(grants[0].level).toBe(2);
  expect(grants[0].spend_cap_daily).toBe(5);

  // Upsert same key updates in place.
  db.setAutonomyGrant(U, { agent: "pixel", action_type: "social.publish", level: 3, spend_cap_daily: 10 });
  grants = db.getAutonomyGrants(U);
  expect(grants.length).toBe(1);
  expect(grants[0].level).toBe(3);
  expect(grants[0].spend_cap_daily).toBe(10);
});

test("setAutonomyGrantView validates level range and caps", async () => {
  expect(await setAutonomyGrantView(U, { agent: "kai", action_type: "email.send", level: 9 })).toEqual({
    error: "level must be an integer 0-3",
  });
  expect(await setAutonomyGrantView(U, { agent: "", action_type: "x", level: 1 })).toEqual({
    error: "agent and action_type are required",
  });
  const badCap = await setAutonomyGrantView(U, { agent: "kai", action_type: "email.send", level: 1, spend_cap_daily: -3 });
  expect(badCap).toEqual({ error: "spend caps must be non-negative numbers" });
});

test("setAutonomyGrantView persists a valid grant", async () => {
  const res: any = await setAutonomyGrantView(U, { agent: "orion", action_type: "email.send", level: 1, spend_cap_action: 2 });
  expect(res.ok).toBe(true);
  expect(res.grant.agent).toBe("orion");
  const view: any = await getAutonomyView(U);
  const agents = view.grants.map((g: any) => g.agent);
  expect(agents).toContain("orion");
});

test("getBudgetsView returns a spend summary shape", async () => {
  const res: any = await getBudgetsView(U);
  expect(res.budgets).toBeTruthy();
  expect(typeof res.budgets.today).toBe("number");
  expect(typeof res.budgets.month).toBe("number");
  expect(Array.isArray(res.budgets.perAgent)).toBe(true);
});

test("getBudgetsView surfaces per-agent daily caps from grants", async () => {
  const db = getDb();
  db.setAutonomyGrant(U, { agent: "helios", action_type: "ads.spend", level: 2, spend_cap_daily: 25 });
  const res: any = await getBudgetsView(U);
  const helios = res.budgets.perAgent.find((p: any) => p.agent === "helios");
  expect(helios).toBeTruthy();
  expect(helios.cap_daily).toBe(25);
  expect(typeof helios.spent_today).toBe("number");
});

test("getGoalsView returns active goals with parsed progress notes", async () => {
  const db = getDb();
  db.insertMemory({ user_id: U2, type: "goal", content: "Launch v1", scope: "private" });
  const res: any = await getGoalsView(U2);
  expect(res.goals.length).toBeGreaterThanOrEqual(1);
  const g = res.goals[0];
  expect(g.content).toBe("Launch v1");
  expect(Array.isArray(g.progress_notes)).toBe(true);
});
