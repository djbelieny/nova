import { test, expect } from "bun:test";
import { detectAutoApprove } from "../src/orchestrator.ts";

test("trusted 'just do it' auto-approves", () => {
  expect(detectAutoApprove("just do it, ship the campaign", "trusted")).toBe(true);
});

test("untrusted 'just do it' does NOT auto-approve", () => {
  expect(detectAutoApprove("just do it, ship the campaign", "untrusted")).toBe(false);
});

test("default arg is trusted (back-compat)", () => {
  expect(detectAutoApprove("just do it")).toBe(true);
});
