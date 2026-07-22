// tests/agent-tools.test.ts
import { test, expect } from "bun:test";
import { buildNovaToolInstructions, formatConnectorTools } from "../src/agent-tools.ts";

test("buildNovaToolInstructions lists the always-available nova subcommands + write-safety note", () => {
  const block = buildNovaToolInstructions(null);
  expect(block).toContain("nova kb search");
  expect(block).toContain("nova extract");
  expect(block).toContain("nova playbook run");
  // write-safety guidance must always be present
  expect(block).toContain("SAFETY:");
  expect(block).toMatch(/WRITE.*approval gate/s);
});

test("a connector appears ONLY when configured", () => {
  const prev = process.env.STRIPE_API_KEY;

  delete process.env.STRIPE_API_KEY;
  expect(buildNovaToolInstructions(null)).not.toContain("stripe");

  process.env.STRIPE_API_KEY = "sk_test";
  const withStripe = buildNovaToolInstructions(null);
  expect(withStripe).toContain("stripe");
  expect(withStripe).toContain("nova connector run stripe");

  if (prev === undefined) delete process.env.STRIPE_API_KEY;
  else process.env.STRIPE_API_KEY = prev;
});

test("no connector section when none configured", () => {
  // Ensure no connector creds are set for this assertion
  const saved: Record<string, string | undefined> = {};
  for (const k of ["STRIPE_API_KEY", "SHOPIFY_ACCESS_TOKEN", "ZENDESK_API_TOKEN", "HUBSPOT_ACCESS_TOKEN"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  const block = buildNovaToolInstructions(null);
  expect(block).not.toContain("CONNECTORS");
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
});

test("formatConnectorTools marks write actions distinctly", () => {
  const out = formatConnectorTools([
    {
      id: "stripe",
      label: "Stripe (payments)",
      actions: {
        list_charges: { description: "List recent charges" },
        create_refund: { write: true, description: "Refund a charge" },
      },
    },
  ]);
  expect(out).toContain("nova connector run stripe list_charges");
  expect(out).toContain("nova connector run stripe create_refund");
  // read vs write are marked differently
  expect(out).toMatch(/list_charges.*\[read\]/);
  expect(out).toMatch(/create_refund.*\[WRITE/);
  expect(out).not.toMatch(/list_charges.*\[WRITE/);
});

test("formatConnectorTools returns empty string for no connectors", () => {
  expect(formatConnectorTools([])).toBe("");
});
