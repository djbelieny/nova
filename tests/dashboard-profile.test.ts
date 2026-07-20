// tests/dashboard-profile.test.ts
import { test, expect } from "bun:test";
import { updateProfileFields, safeUserProjection } from "../src/dashboard.ts";

test("updateProfileFields keeps only allowlisted keys", () => {
  const result = updateProfileFields({ name: "A", timezone: "UTC", role: "admin", bogus: 1 });
  expect(result).toEqual({ name: "A", timezone: "UTC" });
});

test("updateProfileFields keeps all four allowlisted fields when present", () => {
  const result = updateProfileFields({ name: "Bob", timezone: "America/New_York", phone: "+1555", ai_provider: "gemini", extra: "x" });
  expect(result).toEqual({ name: "Bob", timezone: "America/New_York", phone: "+1555", ai_provider: "gemini" });
});

test("updateProfileFields returns empty object when no allowlisted keys", () => {
  const result = updateProfileFields({ role: "admin", bogus: 1, secret: "x" });
  expect(result).toEqual({});
});

test("updateProfileFields ignores undefined values", () => {
  const result = updateProfileFields({ name: "Carol", timezone: undefined });
  expect(result).toEqual({ name: "Carol" });
});

// --- safeUserProjection (Fix 2: PUT /api/profile safe response) ---

test("safeUserProjection strips sensitive fields", () => {
  const rawUser = {
    id: "u1",
    name: "Alice",
    timezone: "UTC",
    phone: "+1555",
    ai_provider: "claude",
    role: "member",
    preferences: { voice_responses: false },
    password_hash: "$argon2id$...",
    username: "alice",
    must_change_password: false,
    kapso_api_key: "sk-secret-key",
  };
  const safe = safeUserProjection(rawUser);
  expect(safe).not.toBeNull();
  expect(safe!.password_hash).toBeUndefined();
  expect(safe!.username).toBeUndefined();
  expect(safe!.must_change_password).toBeUndefined();
  expect(safe!.kapso_api_key).toBeUndefined();
});

test("safeUserProjection preserves safe fields", () => {
  const rawUser = {
    id: "u2",
    name: "Bob",
    timezone: "America/New_York",
    phone: "+1444",
    ai_provider: "gemini",
    role: "admin",
    preferences: { auto_approve: true },
    password_hash: "secret",
    kapso_api_key: "key",
  };
  const safe = safeUserProjection(rawUser)!;
  expect(safe.id).toBe("u2");
  expect(safe.name).toBe("Bob");
  expect(safe.timezone).toBe("America/New_York");
  expect(safe.phone).toBe("+1444");
  expect(safe.ai_provider).toBe("gemini");
  expect(safe.role).toBe("admin");
  expect(safe.preferences).toEqual({ auto_approve: true });
});

test("safeUserProjection returns null for null input", () => {
  expect(safeUserProjection(null)).toBeNull();
});

test("safeUserProjection returns null for undefined input", () => {
  expect(safeUserProjection(undefined)).toBeNull();
});
