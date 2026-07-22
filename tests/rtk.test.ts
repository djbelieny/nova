import { test, expect, afterEach } from "bun:test";
import {
  rtkEnabled,
  wrapCommandWithRtk,
  maybeWrapWithRtk,
  resetRtkAvailability,
} from "../src/rtk.ts";

afterEach(() => {
  delete process.env.NOVA_RTK;
  delete process.env.NOVA_SANDBOX_BACKEND;
  resetRtkAvailability(null);
});

// --- rtkEnabled ---

test("enabled by default", () => {
  expect(rtkEnabled()).toBe(true);
});

test("disabled by NOVA_RTK=off / false / 0 / no", () => {
  for (const v of ["off", "OFF", "false", "0", "no"]) {
    process.env.NOVA_RTK = v;
    expect(rtkEnabled()).toBe(false);
  }
});

test("stays enabled for any other NOVA_RTK value", () => {
  process.env.NOVA_RTK = "on";
  expect(rtkEnabled()).toBe(true);
});

test("disabled under the Docker sandbox (rtk binary isn't in the container)", () => {
  process.env.NOVA_SANDBOX_BACKEND = "docker";
  expect(rtkEnabled()).toBe(false);
});

test("enabled under the local sandbox backend", () => {
  process.env.NOVA_SANDBOX_BACKEND = "local";
  expect(rtkEnabled()).toBe(true);
});

// --- wrapCommandWithRtk (pure) ---

test("prefixes a simple command", () => {
  expect(wrapCommandWithRtk("git status")).toBe("rtk git status");
  expect(wrapCommandWithRtk("  npm run build  ")).toBe("rtk npm run build");
});

test("leaves compound / piped / redirected commands untouched", () => {
  for (const c of [
    "git add . && git commit -m x",
    "cat file | grep foo",
    "echo hi; ls",
    "ls > out.txt",
    "echo $(date)",
    "grep `whoami` f",
    "a\nb",
  ]) {
    expect(wrapCommandWithRtk(c)).toBe(c);
  }
});

test("leaves shell builtins and already-wrapped commands untouched", () => {
  expect(wrapCommandWithRtk("cd /tmp")).toBe("cd /tmp");
  expect(wrapCommandWithRtk("export FOO=1")).toBe("export FOO=1");
  expect(wrapCommandWithRtk("source ./x")).toBe("source ./x");
  expect(wrapCommandWithRtk("rtk git status")).toBe("rtk git status");
  expect(wrapCommandWithRtk("")).toBe("");
  expect(wrapCommandWithRtk("   ")).toBe("   ");
});

// --- maybeWrapWithRtk (env-gated) ---

test("passthrough when disabled — never touches availability", async () => {
  process.env.NOVA_RTK = "off";
  expect(await maybeWrapWithRtk("git status")).toBe("git status");
});

test("passthrough when rtk is unavailable", async () => {
  resetRtkAvailability(false);
  expect(await maybeWrapWithRtk("git status")).toBe("git status");
});

test("wraps when enabled and available", async () => {
  resetRtkAvailability(true);
  expect(await maybeWrapWithRtk("git status")).toBe("rtk git status");
  expect(await maybeWrapWithRtk("git add . && git push")).toBe("git add . && git push");
});
