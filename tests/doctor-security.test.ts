import { test, expect } from "bun:test";
import { runSecurityChecks, checkFilePerms, securityStartupWarnings } from "../src/doctor.ts";

const base = { NOVA_ENCRYPTION_KEY: "3f8a1c9e2b7d4056a1e9c3f7b2d8046e91a3c7f5b2d804e6a91c3f7b5d2084ea", DASHBOARD_PASS: "x", NOVA_LEAK_FIREWALL: "", NOVA_AGENT_ENV_STRICT: "", NOVA_UNTRUSTED_FIREWALL: "" };

test("all-good env passes the core security checks", () => {
  const checks = runSecurityChecks(base);
  expect(checks.find((c) => c.name === "Encryption key")!.ok).toBe(true);
  expect(checks.find((c) => c.name === "Leak firewall")!.ok).toBe(true);
  expect(checks.find((c) => c.name === "Least-privilege agent env")!.ok).toBe(true);
});

test("flags disabled firewalls and weak/missing key", () => {
  const checks = runSecurityChecks({ ...base, NOVA_LEAK_FIREWALL: "off", NOVA_AGENT_ENV_STRICT: "false", NOVA_ENCRYPTION_KEY: "short" });
  expect(checks.find((c) => c.name === "Leak firewall")!.ok).toBe(false);
  expect(checks.find((c) => c.name === "Least-privilege agent env")!.ok).toBe(false);
  expect(checks.find((c) => c.name === "Encryption key")!.ok).toBe(false);
});

test("dashboard exposed without a password is a hard fail", () => {
  const checks = runSecurityChecks({ ...base, DASHBOARD_PASS: "", DASHBOARD_HOST: "0.0.0.0" });
  const c = checks.find((x) => x.name === "Dashboard auth")!;
  expect(c.ok).toBe(false);
  expect(c.fix).toBeTruthy();
});

test("flags long but low-entropy key (degenerate repeating chars)", () => {
  const checks = runSecurityChecks({ ...base, NOVA_ENCRYPTION_KEY: "a".repeat(64) });
  expect(checks.find((c) => c.name === "Encryption key")!.ok).toBe(false);
});

test("flags a world-readable .env", async () => {
  const fakeRun = async (cmd: string) => (cmd.includes(".env") ? "644" : "600");
  const checks = await checkFilePerms(fakeRun);
  const env = checks.find((c) => c.name === "Env file permissions")!;
  expect(env.ok).toBe(false);
  expect(env.fix).toContain("chmod");
});

test("flags a group-readable .env (640)", async () => {
  const fakeRun = async (cmd: string) => (cmd.includes(".env") ? "640" : "600");
  const checks = await checkFilePerms(fakeRun);
  const env = checks.find((c) => c.name === "Env file permissions")!;
  expect(env.ok).toBe(false);
  expect(env.fix).toContain("chmod");
});

test("NOVA_LEAK_FIREWALL=false is reported ENABLED (report matches enforcement)", () => {
  const checks = runSecurityChecks({ ...base, NOVA_LEAK_FIREWALL: "false" });
  const c = checks.find((x) => x.name === "Leak firewall")!;
  expect(c.ok).toBe(true);
  expect(c.detail).toBe("enabled");
});

test("startup warnings list actionable fixes for a soft config", () => {
  const w = securityStartupWarnings({ NOVA_ENCRYPTION_KEY: "short", NOVA_LEAK_FIREWALL: "off" });
  expect(w.some((s) => s.includes("NOVA_ENCRYPTION_KEY"))).toBe(true);
  expect(w.some((s) => s.includes("NOVA_LEAK_FIREWALL"))).toBe(true);
});
