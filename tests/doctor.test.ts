// tests/doctor.test.ts
import { test, expect } from "bun:test";
import { runEnvChecks, formatDiagnostics, runAllChecks, type Check } from "../src/doctor.ts";

test("runEnvChecks flags a missing telegram token with a fix", () => {
  const checks = runEnvChecks({});
  const token = checks.find((c) => c.name === "Telegram bot token")!;
  expect(token.ok).toBe(false);
  expect(token.fix).toBeTruthy();
});

test("runEnvChecks passes with token + user id + claude provider (CLI auth)", () => {
  const checks = runEnvChecks({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_USER_ID: "1", AI_PROVIDER: "claude" });
  expect(checks.every((c) => c.ok)).toBe(true);
});

test("runEnvChecks accepts an API-key provider", () => {
  const checks = runEnvChecks({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_USER_ID: "1", AI_PROVIDER: "gemini", GEMINI_API_KEY: "k" });
  expect(checks.find((c) => c.name === "AI provider")!.ok).toBe(true);
});

test("runEnvChecks fails an API provider with no key", () => {
  const checks = runEnvChecks({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_USER_ID: "1", AI_PROVIDER: "openai" });
  expect(checks.find((c) => c.name === "AI provider")!.ok).toBe(false);
});

test("formatDiagnostics marks each check and includes versions", () => {
  const checks: Check[] = [
    { name: "Bun", ok: true, detail: "1.3.9" },
    { name: "Telegram bot token", ok: false, detail: "missing", fix: "run init" },
  ];
  const out = formatDiagnostics(checks, { platform: "darwin" });
  expect(out).toContain("✅ Bun");
  expect(out).toContain("❌ Telegram bot token");
  expect(out).toContain("→ run init");
  expect(out).toContain("platform: darwin");
});

test("runAllChecks uses the injected runner and reports tool presence", async () => {
  const fakeRun = async (cmd: string) => {
    if (cmd.startsWith("bun")) return "1.3.9";
    if (cmd.startsWith("git")) return "git version 2.44";
    throw new Error("not found"); // claude missing
  };
  const checks = await runAllChecks(
    { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_USER_ID: "1", AI_PROVIDER: "claude" },
    fakeRun
  );
  expect(checks.find((c) => c.name === "Bun")!.ok).toBe(true);
  expect(checks.find((c) => c.name === "Claude Code CLI")!.ok).toBe(false);
  expect(checks.find((c) => c.name === "git")!.ok).toBe(true);
});

test("RTK check is informational: missing rtk stays ok with an optional hint", async () => {
  const fakeRun = async (cmd: string) => {
    if (cmd.startsWith("rtk")) throw new Error("not found");
    return "ok";
  };
  const checks = await runAllChecks({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_USER_ID: "1" }, fakeRun);
  const rtk = checks.find((c) => c.name === "RTK (token saver)")!;
  expect(rtk.ok).toBe(true);
  expect(rtk.fix).toBeTruthy();
});

test("RTK check reports active when rtk is present", async () => {
  const fakeRun = async (cmd: string) => (cmd.startsWith("rtk") ? "rtk 0.4.1" : "ok");
  const checks = await runAllChecks({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_USER_ID: "1" }, fakeRun);
  const rtk = checks.find((c) => c.name === "RTK (token saver)")!;
  expect(rtk.ok).toBe(true);
  expect(rtk.detail).toContain("active");
});

test("RTK check honors NOVA_RTK=off", async () => {
  const fakeRun = async () => "ok";
  const checks = await runAllChecks(
    { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_USER_ID: "1", NOVA_RTK: "off" },
    fakeRun
  );
  const rtk = checks.find((c) => c.name === "RTK (token saver)")!;
  expect(rtk.detail).toContain("disabled");
});
