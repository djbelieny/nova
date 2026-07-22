// tests/dashboard-bind.test.ts
//
// Regression coverage for the dashboard bind-host security logic. Before this test existed,
// the bind-host decision was an inline module-level const with no test coverage — a future
// edit could silently reopen the unauthenticated-exposure hole. computeBindHost() is now a
// pure, exported function so the four env combinations that matter are pinned here.

import { test, expect } from "bun:test";
import { computeBindHost } from "../src/dashboard.ts";

test("explicit DASHBOARD_HOST wins even with a password set", () => {
  expect(computeBindHost({ DASHBOARD_HOST: "0.0.0.0", DASHBOARD_PASS: "x" })).toBe("0.0.0.0");
});

test("explicit DASHBOARD_HOST wins with no password", () => {
  expect(computeBindHost({ DASHBOARD_HOST: "10.0.0.5" })).toBe("10.0.0.5");
});

test("no host, no password: falls back to loopback-only", () => {
  expect(computeBindHost({})).toBe("127.0.0.1");
});

test("no host, password set: binds all interfaces (Bun default)", () => {
  expect(computeBindHost({ DASHBOARD_PASS: "x" })).toBeUndefined();
});
