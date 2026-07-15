import { test, expect, beforeEach } from "bun:test";
import { wrapForExecution } from "../src/providers/claude.ts";
import { resetSandboxForTests } from "../src/sandbox/index.ts";

beforeEach(() => {
  resetSandboxForTests();
  delete process.env.NOVA_SANDBOX_BACKEND;
});

test("local backend leaves provider argv untouched", async () => {
  const out = await wrapForExecution(["claude", "-p", "x"], "/tmp/ws", true);
  expect(out.argv).toEqual(["claude", "-p", "x"]);
});

test("classification calls (isToolExecution=false) are never docker-wrapped", async () => {
  process.env.NOVA_SANDBOX_BACKEND = "docker";
  const out = await wrapForExecution(["claude", "-p", "classify"], "/tmp/ws", false);
  expect(out.argv[0]).toBe("claude");
});
