// tests/agent-tools.test.ts
import { test, expect } from "bun:test";
import { buildNovaToolInstructions, formatConnectorTools } from "../src/agent-tools.ts";

test("buildNovaToolInstructions lists the always-available nova subcommands + write-safety note", () => {
  const block = buildNovaToolInstructions(null);
  expect(block).toContain("nova kb search");
  expect(block).toContain("nova extract");
  expect(block).toContain("nova playbook run");
  // write-safety guidance must always be present
  expect(block).toContain("USAGE:");
  expect(block).toMatch(/WRITE.*approval gate/s);
});

test("connectors use the discovery-first idiom (describe before run) only when configured", () => {
  const prev = process.env.STRIPE_API_KEY;

  delete process.env.STRIPE_API_KEY;
  expect(buildNovaToolInstructions(null)).not.toContain("stripe");

  process.env.STRIPE_API_KEY = "sk_test";
  const withStripe = buildNovaToolInstructions(null);
  expect(withStripe).toContain("stripe");
  // Discovery-first: describe is taught, actions are NOT enumerated inline (keeps prompt flat).
  expect(withStripe).toContain("nova connector describe <id>");
  expect(withStripe).toContain("nova connector run <id> <action>");
  expect(withStripe).not.toContain("nova connector run stripe list_charges");

  if (prev === undefined) delete process.env.STRIPE_API_KEY;
  else process.env.STRIPE_API_KEY = prev;
});

test("no connector section when none configured", () => {
  const saved: Record<string, string | undefined> = {};
  for (const k of ["STRIPE_API_KEY", "SHOPIFY_SHOP", "SHOPIFY_TOKEN", "ZENDESK_TOKEN", "HUBSPOT_TOKEN"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  const block = buildNovaToolInstructions(null);
  expect(block).not.toContain("CONNECTORS");
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
});

test("formatConnectorTools renders a compact names-only list", () => {
  const out = formatConnectorTools([
    { id: "stripe", label: "Stripe (payments)" },
    { id: "shopify", label: "Shopify (orders)" },
  ]);
  expect(out).toBe("stripe (Stripe (payments)), shopify (Shopify (orders))");
  expect(formatConnectorTools([])).toBe("");
});

test("nova tool instructions advertise workboard discovery, not every verb inline", () => {
  const block = buildNovaToolInstructions(null);
  expect(block).toContain("nova workboard list");
  expect(block).toContain("nova workboard describe");
  expect(block).toContain("nova workboard card add");
  expect(block).not.toContain("pipeline");
});
