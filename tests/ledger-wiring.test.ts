import { test, expect } from "bun:test";
import { deriveActionType, recordSubtaskAction } from "../src/ledger.ts";
import { getDb } from "../src/db.ts";

const U = "33333333-3333-4333-8333-333333333333";

test("deriveActionType maps consequential verbs", () => {
  expect(deriveActionType("Send the launch email to subscribers")).toBe("email.send");
  expect(deriveActionType("Publish post to Instagram")).toBe("social.publish");
  expect(deriveActionType("Create ad campaign with $50 budget")).toBe("ads.spend");
  expect(deriveActionType("Research competitor pricing")).toBe("task.generic");
  expect(deriveActionType("Ship the physical order to the customer")).toBe("task.generic");
  expect(deriveActionType("Release the grant funds to the vendor")).toBe("task.generic");
  expect(deriveActionType("Deploy the new website build")).toBe("code.deploy");
  expect(deriveActionType("Share the x-axis results with the team")).toBe("task.generic");
});

test("recordSubtaskAction writes a ledger row with sandbox backend name", () => {
  recordSubtaskAction(U, "execute", {
    description: "Send weekly newsletter", agent: "orion", success: true, artifacts: [],
  });
  const rows = getDb().getActions(U, { actionType: "email.send" });
  expect(rows.length).toBe(1);
  expect(rows[0].agent).toBe("orion");
  expect(rows[0].outcome).toBe("success");
  expect(rows[0].phase).toBe("execute");
  expect(rows[0].sandbox_backend).toBe("local");
});

test("failed subtasks record outcome failed and never throw", () => {
  recordSubtaskAction(U, "execute", { description: "Publish to x.com", agent: "pixel", success: false });
  const rows = getDb().getActions(U, { actionType: "social.publish" });
  expect(rows[0].outcome).toBe("failed");
});
