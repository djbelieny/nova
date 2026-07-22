// tests/leak-scan.test.ts
import { test, expect, afterEach } from "bun:test";
import { scanForLeaks, redactLeaks } from "../src/leak-scan.ts";

afterEach(() => { delete process.env.NOVA_LEAK_ALLOW; });

// Synthetic test vectors — deliberately NOT real-provider-shaped (so they exercise our
// structural regexes without matching real key formats / tripping secret scanners).
// Provider prefixes are split across concatenated literals so the contiguous token never
// appears in source bytes (avoids push-protection scanners flagging our own test data).
const STRIPE = "sk_live_" + "FAKEtest1234notrealSTRIPE";
const SECRETS = [
  "sk-ant-FAKEtestKEYnotrealANTHROPIC000000",
  "AKIAIOSFODNN7EXAMPLE", // AWS's own documented example key
  "ghp_FAKEtestTOKENnotrealGITHUB0000",
  "xoxb-FAKEtestTOKENnotrealSLACK00",
  "AIzaFAKEtestGOOGLEkeyNOTREALnotarealkey", // AIza + 35 non-real chars
  STRIPE,
  "-----BEGIN RSA PRIVATE KEY-----",
  "enc:aGVsbG8=:dGFn:Y2lwaGVy",
  "postgres://admin:FAKEtestPWnotreal@db.internal:5432/app",
  "password=FAKEtestPWnotrealVALUE",
  "ya29.FAKEtestOAUTHnotrealGOOGLE000000",
  "Bearer FAKEtestTOKENnotreal0123456789",
];
const PII = ["123-45-6789", "4111111111111111" /* Luhn-valid Visa test */];
const BENIGN = [
  "The API key rotation policy is documented in the wiki.",
  "Order number 1234567890123456 shipped today.", // 16 digits, NOT Luhn-valid
  "const skipList = ['a','b'];",                    // 'sk' substring, not a key
  "Email me at first.last@example.com about the sprint.", // email is pii/info, must not be 'secret'
  "aGVsbG8gd29ybGQgdGhpcyBpcyBqdXN0IGJhc2U2NA==", // base64 blob, not a keyed secret
  "550e8400-e29b-41d4-a716-446655440000", // UUID
  "commit 9f4a1c2b3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f80 landed", // git SHA
  "See /Users/alice/projects/really/long/path/to/some/file.ts for details", // file path
  "MAX_RETRY_COUNT=DEFAULT_TIMEOUT_CONSTANT", // readable ALL-CAPS assignment, not a secret
  "Reset your password by clicking the link in the email.", // prose "password", no key=value
];

test("catches every secret in the redteam corpus", () => {
  for (const s of SECRETS) {
    const f = scanForLeaks(`prefix ${s} suffix`);
    expect(f.some((x) => x.severity === "secret")).toBe(true);
  }
});

test("catches SSN and Luhn-valid card as pii", () => {
  for (const p of PII) {
    const f = scanForLeaks(`value ${p} end`);
    expect(f.some((x) => x.severity === "pii")).toBe(true);
  }
});

test("does NOT flag the benign corpus as secret", () => {
  for (const b of BENIGN) {
    const f = scanForLeaks(b);
    expect(f.some((x) => x.severity === "secret")).toBe(false);
  }
});

test("redactLeaks masks secrets and reports findings", () => {
  const { text, findings } = redactLeaks(`token ${STRIPE} here`);
  expect(text).not.toContain(STRIPE);
  expect(text).toContain("‹redacted:");
  expect(findings.length).toBeGreaterThan(0);
});

test("severities filter: pii-only redaction leaves secrets untouched", () => {
  const { text } = redactLeaks(`ssn 123-45-6789 key ${STRIPE}`, { severities: ["pii"] });
  expect(text).not.toContain("123-45-6789");
  expect(text).toContain("sk_live_"); // secret left because we asked pii-only
});

test("NOVA_LEAK_ALLOW suppresses a known-safe token", () => {
  process.env.NOVA_LEAK_ALLOW = "AKIAIOSFODNN7EXAMPLE";
  expect(scanForLeaks("AKIAIOSFODNN7EXAMPLE").length).toBe(0);
});
