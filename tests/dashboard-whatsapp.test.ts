// tests/dashboard-whatsapp.test.ts
import { test, expect } from "bun:test";
import { validateContactRole } from "../src/dashboard.ts";

test("validateContactRole returns 'allowed' for valid role", () => {
  expect(validateContactRole("allowed")).toBe("allowed");
});

test("validateContactRole returns 'blocked' for valid role", () => {
  expect(validateContactRole("blocked")).toBe("blocked");
});

test("validateContactRole returns 'vip' for valid role", () => {
  expect(validateContactRole("vip")).toBe("vip");
});

test("validateContactRole returns null for invalid role 'admin'", () => {
  expect(validateContactRole("admin")).toBeNull();
});

test("validateContactRole returns null for invalid role 'member'", () => {
  expect(validateContactRole("member")).toBeNull();
});

test("validateContactRole returns null for empty string", () => {
  expect(validateContactRole("")).toBeNull();
});

test("validateContactRole returns null for uppercase 'ALLOWED'", () => {
  expect(validateContactRole("ALLOWED")).toBeNull();
});

test("validateContactRole returns null for arbitrary string", () => {
  expect(validateContactRole("unknown")).toBeNull();
});
