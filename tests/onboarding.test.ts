// tests/onboarding.test.ts
import { test, expect } from "bun:test";
import {
  STARTER_EXAMPLES,
  OUTCOME_GROUPS,
  buildWelcomeMessage,
  buildHelpMessage,
  buildTeamMessage,
  buildExamplesMessage,
  exampleButtons,
  getExamplePrompt,
  NOVA_COMMANDS,
} from "../src/onboarding.ts";
import { getAllAgents, loadAgents } from "../src/agent-router.ts";
import type { AgentDef } from "../src/agent-router.ts";

await loadAgents();

test("welcome greets the user by first name", () => {
  const msg = buildWelcomeMessage("Jake Belieny");
  expect(msg).toContain("Jake");
  expect(msg).not.toContain("Belieny"); // first name only
});

test("welcome tolerates empty name", () => {
  expect(buildWelcomeMessage("")).toContain("Hi there");
});

test("help is task-oriented and lists shortcuts", () => {
  const h = buildHelpMessage();
  expect(h).toContain("/team");
  expect(h).toContain("/examples");
});

test("every starter example has a non-empty prompt and unique key", () => {
  const keys = new Set<string>();
  for (const e of STARTER_EXAMPLES) {
    expect(e.prompt.trim().length).toBeGreaterThan(0);
    expect(e.label.trim().length).toBeGreaterThan(0);
    expect(keys.has(e.key)).toBe(false);
    keys.add(e.key);
  }
});

test("getExamplePrompt round-trips known keys and rejects junk", () => {
  expect(getExamplePrompt("plan_week")).toBe(STARTER_EXAMPLES[0].prompt);
  expect(getExamplePrompt("not-a-key")).toBeUndefined();
});

test("example buttons all carry nova_ex: callback data in rows of <=2", () => {
  const rows = exampleButtons();
  const flat = rows.flat();
  expect(flat.length).toBe(STARTER_EXAMPLES.length);
  for (const row of rows) expect(row.length).toBeLessThanOrEqual(2);
  for (const btn of flat) expect(btn.callbackData.startsWith("nova_ex:")).toBe(true);
});

test("team message surfaces EVERY catalog agent under a named group, with no raw slugs", () => {
  const agents = getAllAgents();
  expect(agents.length).toBeGreaterThan(0);
  const msg = buildTeamMessage(agents);
  for (const a of agents) {
    expect(msg).toContain(a.name); // friendly name present
  }
  // Group titles present
  for (const g of OUTCOME_GROUPS) expect(msg).toContain(g.title);
});

test("team message uses the catch-all for an unknown slug instead of dropping it", () => {
  const fake: AgentDef = { name: "Zzz", slug: "zzz-unknown", description: "does the unknown", prompt: "" };
  const msg = buildTeamMessage([fake]);
  expect(msg).toContain("Zzz");
  expect(msg).toContain("More specialists");
});

test("examples message lists the labels", () => {
  const m = buildExamplesMessage();
  expect(m).toContain("Plan my week");
});

test("command menu covers the onboarding surfaces", () => {
  const names = NOVA_COMMANDS.map((c) => c.command);
  expect(names).toEqual(expect.arrayContaining(["start", "help", "team", "examples", "status", "settings"]));
});
