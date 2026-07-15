import { test, expect } from "bun:test";
import { getDb } from "../src/db.ts";

const U = "22222222-2222-4222-8222-222222222222";

test("recordAction returns id and getActions round-trips", () => {
  const db = getDb();
  const id = db.recordAction({
    user_id: U, agent: "orion", action_type: "email.send",
    phase: "execute", outcome: "success", cost_usd: 0.03,
    sandbox_backend: "local", artifacts: [{ type: "text", value: "sent" }],
  });
  expect(id).toBeTruthy();
  const rows = db.getActions(U, { agent: "orion" });
  expect(rows.length).toBe(1);
  expect(rows[0].action_type).toBe("email.send");
  expect(rows[0].artifacts).toEqual([{ type: "text", value: "sent" }]);
});

test("getActions filters by actionType and respects limit", () => {
  const db = getDb();
  for (let i = 0; i < 3; i++) {
    db.recordAction({ user_id: U, agent: "pixel", action_type: "social.publish", phase: "execute", outcome: "success" });
  }
  db.recordAction({ user_id: U, agent: "pixel", action_type: "task.generic", phase: "prepare", outcome: "failed" });
  expect(db.getActions(U, { actionType: "social.publish" }).length).toBe(3);
  expect(db.getActions(U, { actionType: "social.publish", limit: 2 }).length).toBe(2);
  expect(db.getActions(U, { agent: "pixel" }).length).toBe(4);
});
