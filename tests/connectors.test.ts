// tests/connectors.test.ts
import { test, expect } from "bun:test";
import { listConnectors, getConnector, validateConnector, resolveCreds, runConnectorAction } from "../src/connectors/registry.ts";
import { httpJson } from "../src/connectors/types.ts";

/** A mock fetch that records the request and returns a canned JSON response. */
function mockFetch(status: number, body: any) {
  const calls: Array<{ url: string; method?: string; headers?: any; body?: any }> = [];
  const impl = (async (url: string, init: any = {}) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as any;
  }) as any;
  return { impl, calls };
}

test("registry lists built-in connectors", () => {
  const ids = listConnectors().map(c => c.id);
  expect(ids).toContain("stripe");
  expect(ids).toContain("shopify");
  expect(ids).toContain("zendesk");
  expect(ids).toContain("hubspot");
});

test("validateConnector accepts a well-formed connector, rejects a broken one", () => {
  expect(validateConnector(getConnector("stripe")!)).toBeNull();
  expect(validateConnector({ id: "", label: "", authKind: "api_key", credEnv: [], actions: {} } as any)).not.toBeNull();
});

test("resolveCreds returns null without env, resolves with env", () => {
  const stripe = getConnector("stripe")!;
  const prev = process.env.STRIPE_API_KEY;
  delete process.env.STRIPE_API_KEY;
  expect(resolveCreds(stripe, null)).toBeNull();
  process.env.STRIPE_API_KEY = "sk_test_123";
  expect(resolveCreds(stripe, null)).toEqual({ STRIPE_API_KEY: "sk_test_123" });
  if (prev === undefined) delete process.env.STRIPE_API_KEY; else process.env.STRIPE_API_KEY = prev;
});

test("stripe list_charges builds the right request", async () => {
  process.env.STRIPE_API_KEY = "sk_test_abc";
  const { impl, calls } = mockFetch(200, { data: [{ id: "ch_1", paid: true }] });
  const r = await runConnectorAction(null, "stripe", "list_charges", { limit: 3 }, impl);
  expect(r.ok).toBe(true);
  expect(r.data.data[0].id).toBe("ch_1");
  expect(calls[0].url).toBe("https://api.stripe.com/v1/charges?limit=3");
  expect(calls[0].headers.Authorization).toBe("Bearer sk_test_abc");
  delete process.env.STRIPE_API_KEY;
});

test("stripe create_refund posts a form body", async () => {
  process.env.STRIPE_API_KEY = "sk_test_abc";
  const { impl, calls } = mockFetch(200, { id: "re_1", status: "succeeded" });
  const r = await runConnectorAction(null, "stripe", "create_refund", { charge: "ch_9", amount: 500 }, impl);
  expect(r.ok).toBe(true);
  expect(calls[0].method).toBe("POST");
  expect(calls[0].body).toContain("charge=ch_9");
  expect(calls[0].body).toContain("amount=500");
  delete process.env.STRIPE_API_KEY;
});

test("zendesk create_ticket posts JSON with basic auth", async () => {
  process.env.ZENDESK_SUBDOMAIN = "acme";
  process.env.ZENDESK_EMAIL = "a@b.com";
  process.env.ZENDESK_TOKEN = "tok";
  const { impl, calls } = mockFetch(201, { ticket: { id: 5 } });
  const r = await runConnectorAction(null, "zendesk", "create_ticket", { subject: "Help", body: "broken" }, impl);
  expect(r.ok).toBe(true);
  expect(calls[0].url).toBe("https://acme.zendesk.com/api/v2/tickets.json");
  expect(calls[0].headers.Authorization).toStartWith("Basic ");
  expect(JSON.parse(calls[0].body).ticket.subject).toBe("Help");
  delete process.env.ZENDESK_SUBDOMAIN; delete process.env.ZENDESK_EMAIL; delete process.env.ZENDESK_TOKEN;
});

test("unconfigured connector returns a helpful error", async () => {
  delete process.env.HUBSPOT_TOKEN;
  const r = await runConnectorAction(null, "hubspot", "list_contacts", {}, (async () => ({ ok: true, status: 200, text: async () => "{}" })) as any);
  expect(r.ok).toBe(false);
  expect(r.error).toContain("not configured");
});

test("httpJson throws on non-2xx", async () => {
  const impl = (async () => ({ ok: false, status: 404, text: async () => "not found" })) as any;
  await expect(httpJson({ creds: {}, fetchImpl: impl }, "GET", "https://x/y")).rejects.toThrow("404");
});
