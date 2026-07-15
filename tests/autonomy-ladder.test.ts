import { test, expect } from "bun:test";
import {
  getGrant,
  decideGate,
  recordOutcome,
  setCaps,
  CLEAN_RUNS_L1,
  CLEAN_RUNS_L2,
} from "../src/autonomy.ts";

let seq = 0;
function freshUser(): string {
  seq++;
  const hex = seq.toString(16).padStart(12, "0");
  return `33333333-3333-4333-8333-${hex}`;
}

function clean(userId: string, agent: string, action: string, n: number, costUsd = 0) {
  for (let i = 0; i < n; i++) {
    recordOutcome(userId, agent, action, { success: true, costUsd });
  }
}

test("defaults to L0 with no grant present", () => {
  const u = freshUser();
  const g = getGrant(u, "orion", "email.send");
  expect(g.level).toBe(0);
  expect(g.clean_runs).toBe(0);
  expect(g.spend_cap_action).toBeNull();
  expect(g.spend_cap_daily).toBeNull();
});

test("L0 decides ask (approval gate)", () => {
  const u = freshUser();
  expect(decideGate(u, "orion", "email.send", 0.01).mode).toBe("ask");
});

test("promotes L0 -> L1 after CLEAN_RUNS_L1 clean runs", () => {
  const u = freshUser();
  clean(u, "orion", "email.send", CLEAN_RUNS_L1 - 1);
  expect(getGrant(u, "orion", "email.send").level).toBe(0);
  expect(decideGate(u, "orion", "email.send", 0).mode).toBe("ask");

  recordOutcome(u, "orion", "email.send", { success: true });
  expect(getGrant(u, "orion", "email.send").level).toBe(1);
  expect(decideGate(u, "orion", "email.send", 0).mode).toBe("notify");
});

test("promotes L1 -> L2 at CLEAN_RUNS_L2 cumulative clean runs", () => {
  const u = freshUser();
  clean(u, "pixel", "social.publish", CLEAN_RUNS_L2 - 1);
  expect(getGrant(u, "pixel", "social.publish").level).toBe(1);

  recordOutcome(u, "pixel", "social.publish", { success: true });
  const g = getGrant(u, "pixel", "social.publish");
  expect(g.level).toBe(2);
  expect(g.clean_runs).toBe(CLEAN_RUNS_L2);
  expect(decideGate(u, "pixel", "social.publish", 0).mode).toBe("auto");
});

test("instant demotion to L0 on failure", () => {
  const u = freshUser();
  clean(u, "pixel", "social.publish", CLEAN_RUNS_L2);
  expect(getGrant(u, "pixel", "social.publish").level).toBe(2);

  recordOutcome(u, "pixel", "social.publish", { success: false });
  const g = getGrant(u, "pixel", "social.publish");
  expect(g.level).toBe(0);
  expect(g.clean_runs).toBe(0);
  expect(g.demoted_at).toBeTruthy();
  expect(decideGate(u, "pixel", "social.publish", 0).mode).toBe("ask");
});

test("instant demotion to L0 on user rejection", () => {
  const u = freshUser();
  clean(u, "helios", "ads.spend", CLEAN_RUNS_L1);
  expect(getGrant(u, "helios", "ads.spend").level).toBe(1);

  recordOutcome(u, "helios", "ads.spend", { success: false, rejected: true });
  const g = getGrant(u, "helios", "ads.spend");
  expect(g.level).toBe(0);
  expect(g.clean_runs).toBe(0);
  expect(g.demoted_at).toBeTruthy();
});

test("instant demotion to L0 on spend-cap breach", () => {
  const u = freshUser();
  clean(u, "helios", "ads.spend", CLEAN_RUNS_L2);
  expect(getGrant(u, "helios", "ads.spend").level).toBe(2);

  recordOutcome(u, "helios", "ads.spend", { success: true, capBreached: true });
  const g = getGrant(u, "helios", "ads.spend");
  expect(g.level).toBe(0);
  expect(g.clean_runs).toBe(0);
  expect(g.demoted_at).toBeTruthy();
});

test("per-action cap: L2 escalates when estimate exceeds spend_cap_action", () => {
  const u = freshUser();
  clean(u, "helios", "ads.spend", CLEAN_RUNS_L2);
  setCaps(u, "helios", "ads.spend", { action: 5 });

  expect(decideGate(u, "helios", "ads.spend", 4.99).mode).toBe("auto");
  expect(decideGate(u, "helios", "ads.spend", 5.01).mode).toBe("escalate-cap");
});

test("per-day cap: L2 escalates when today's spend + estimate exceeds spend_cap_daily", () => {
  const u = freshUser();
  clean(u, "helios", "ads.spend", CLEAN_RUNS_L2, 3);
  // 10 runs * $3 = $30 already spent today
  setCaps(u, "helios", "ads.spend", { daily: 32 });

  expect(decideGate(u, "helios", "ads.spend", 1).mode).toBe("auto");
  expect(decideGate(u, "helios", "ads.spend", 3).mode).toBe("escalate-cap");
});

test("caps do not gate below L2", () => {
  const u = freshUser();
  clean(u, "orion", "email.send", CLEAN_RUNS_L1);
  setCaps(u, "orion", "email.send", { action: 0.001, daily: 0.001 });
  // L1 notifies regardless of caps
  expect(decideGate(u, "orion", "email.send", 100).mode).toBe("notify");
});

test("one-shot override does not persist grant changes", () => {
  const u = freshUser();
  const before = getGrant(u, "kai", "task.generic");
  expect(before.level).toBe(0);
  expect(before.clean_runs).toBe(0);

  for (let i = 0; i < CLEAN_RUNS_L2 + 3; i++) {
    recordOutcome(u, "kai", "task.generic", { success: true, oneShot: true });
  }

  const after = getGrant(u, "kai", "task.generic");
  expect(after.level).toBe(0);
  expect(after.clean_runs).toBe(0);
});

test("setCaps preserves level and clean_runs", () => {
  const u = freshUser();
  clean(u, "helios", "ads.spend", CLEAN_RUNS_L2);
  setCaps(u, "helios", "ads.spend", { action: 10, daily: 50 });
  const g = getGrant(u, "helios", "ads.spend");
  expect(g.level).toBe(2);
  expect(g.clean_runs).toBe(CLEAN_RUNS_L2);
  expect(g.spend_cap_action).toBe(10);
  expect(g.spend_cap_daily).toBe(50);
});

test("re-earning after demotion requires a fresh clean streak", () => {
  const u = freshUser();
  clean(u, "pixel", "social.publish", CLEAN_RUNS_L2);
  recordOutcome(u, "pixel", "social.publish", { success: false }); // demote
  expect(getGrant(u, "pixel", "social.publish").level).toBe(0);

  clean(u, "pixel", "social.publish", CLEAN_RUNS_L1 - 1);
  expect(getGrant(u, "pixel", "social.publish").level).toBe(0);
  recordOutcome(u, "pixel", "social.publish", { success: true });
  expect(getGrant(u, "pixel", "social.publish").level).toBe(1);
});

test("recordOutcome writes an execute row to the action ledger for spend tracking", async () => {
  const { getDb } = await import("../src/db.ts");
  const u = freshUser();
  recordOutcome(u, "helios", "ads.spend", { success: true, costUsd: 7.5 });
  const spend = getDb().getDailyActionSpend(u, "helios", "ads.spend");
  expect(spend).toBe(7.5);
});
