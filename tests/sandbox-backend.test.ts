import { test, expect, beforeEach } from "bun:test";
import { resolveSandboxBackend, getSandboxWarning, getResolvedSandboxName, resetSandboxForTests, wrapForExecution } from "../src/sandbox/index.ts";

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

test("env value is trimmed before matching", async () => {
  process.env.NOVA_SANDBOX_BACKEND = "  local  ";
  const backend = await resolveSandboxBackend();
  expect(backend.name).toBe("local");
  expect(getSandboxWarning()).toBeNull();
});

test("getResolvedSandboxName is null before resolution and the backend name after", async () => {
  expect(getResolvedSandboxName()).toBeNull();
  await resolveSandboxBackend();
  expect(getResolvedSandboxName()).toBe("local");
});

test("wrapForExecution skips classification calls and passes local tool calls through", async () => {
  const classify = await wrapForExecution(["claude", "-p", "x"], "/tmp/ws", false);
  expect(classify.argv).toEqual(["claude", "-p", "x"]);
  const tool = await wrapForExecution(["claude", "-p", "x"], "/tmp/ws", true);
  expect(tool.argv).toEqual(["claude", "-p", "x"]);
  expect(tool.cwd).toBe("/tmp/ws");
});
