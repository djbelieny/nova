import { test, expect } from "bun:test";
import { runSecurityChecks } from "../src/doctor.ts";

const base = { NOVA_ENCRYPTION_KEY: "a".repeat(64), DASHBOARD_PASS: "x", NOVA_LEAK_FIREWALL: "", NOVA_AGENT_ENV_STRICT: "", NOVA_UNTRUSTED_FIREWALL: "" };

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
