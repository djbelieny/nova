// tests/resend-client.test.ts
import { test, expect } from "bun:test";
import { parseInboundEmail, verifyResendSignature } from "../src/resend-client.ts";
import { createHmac } from "crypto";

test("parseInboundEmail extracts fields from email.received", () => {
  const payload = { type: "email.received", data: {
    email_id: "e-123", from: "Jane Doe <jane@acme.com>", subject: "Help",
    text: "It broke", } };
  const r = parseInboundEmail(payload);
  expect(r?.messageId).toBe("e-123");
  expect(r?.from).toBe("jane@acme.com");
  expect(r?.fromName).toBe("Jane Doe");
  expect(r?.text).toBe("It broke");
});

test("parseInboundEmail returns null for non-received events", () => {
  expect(parseInboundEmail({ type: "email.delivered", data: {} })).toBeNull();
});

test("verifyResendSignature accepts a correct svix signature", () => {
  const secret = "whsec_dGVzdHNlY3JldA=="; // base64 after the whsec_ prefix
  const body = JSON.stringify({ hello: "world" });
  const id = "msg_1", ts = "1700000000";
  const signed = `${id}.${ts}.${body}`;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", key).update(signed).digest("base64");
  const headers = { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` };
  expect(verifyResendSignature(body, headers, secret)).toBe(true);
  expect(verifyResendSignature(body + "x", headers, secret)).toBe(false);
});
