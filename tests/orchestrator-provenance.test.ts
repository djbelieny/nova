import { test, expect } from "bun:test";
import { detectAutoApprove, resolveAutoApprove } from "../src/orchestrator.ts";

test("trusted 'just do it' auto-approves", () => {
  expect(detectAutoApprove("just do it, ship the campaign", "trusted")).toBe(true);
});

test("untrusted 'just do it' does NOT auto-approve", () => {
  expect(detectAutoApprove("just do it, ship the campaign", "untrusted")).toBe(false);
});

test("default arg is trusted (back-compat)", () => {
  expect(detectAutoApprove("just do it")).toBe(true);
});

test("resolveAutoApprove: untrusted suppresses all auto-approve paths", () => {
  expect(
    resolveAutoApprove({ autoApprove: true, ruleAutoApprove: true, trust: "untrusted" })
  ).toBe(false);
});

test("resolveAutoApprove: trusted allows autoApprove-driven auto path", () => {
  expect(
    resolveAutoApprove({ autoApprove: true, ruleAutoApprove: false, trust: "trusted" })
  ).toBe(true);
});

test("resolveAutoApprove: trusted allows ruleAutoApprove-driven auto path", () => {
  expect(
    resolveAutoApprove({ autoApprove: false, ruleAutoApprove: true, trust: "trusted" })
  ).toBe(true);
});
