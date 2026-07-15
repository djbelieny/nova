import { test, expect, beforeEach } from "bun:test";
import { resolveSandboxBackend, getSandboxWarning, resetSandboxForTests } from "../src/sandbox/index.ts";

beforeEach(() => {
  resetSandboxForTests();
  delete process.env.NOVA_SANDBOX_BACKEND;
});

test("defaults to local backend which passes argv through untouched", async () => {
  const backend = await resolveSandboxBackend();
  expect(backend.name).toBe("local");
  const wrapped = backend.wrapCommand(["claude", "-p", "hi"], { cwd: "/tmp/ws" });
  expect(wrapped.argv).toEqual(["claude", "-p", "hi"]);
  expect(wrapped.cwd).toBe("/tmp/ws");
  expect(getSandboxWarning()).toBeNull();
});

test("unknown backend value falls back to local with a warning", async () => {
  process.env.NOVA_SANDBOX_BACKEND = "banana";
  const backend = await resolveSandboxBackend();
  expect(backend.name).toBe("local");
  expect(getSandboxWarning()).toContain("banana");
});
