#!/usr/bin/env bun
// Pre-deploy guard: parse every inline browser <script> the dashboard emits.
//
// Inline browser JS lives inside template-literal strings in dashboard.ts, so
// tsc/bun build never type-check it. A stray TypeScript-ism (e.g. `x as Type`)
// compiles fine server-side but is an Uncaught SyntaxError in the browser, which
// kills the whole page's JS. This catches that class of bug before it ships.
//
// Importing dashboard.ts does NOT start the server (guarded by `import.meta.main`),
// so we can render each page and parse its inline scripts. `new Function(body)`
// parses without executing — it throws SyntaxError on invalid JS.

import { renderDashboard, renderIntegrationsPage, renderSharedCredsPage, renderAccountPage, renderProfilePage, renderSchedulesPage, renderSkillsPage, renderHistoryPage, renderWhatsappPage, renderApprovalsPage } from "../src/dashboard.ts";

// /kanban and /tickets now 302 to a system workboard (src/dashboard-workboards.ts) instead of
// rendering their own page, so renderKanban/renderTicketBoard no longer exist to check here.
const PAGES: Array<[string, () => string]> = [
  ["dashboard", renderDashboard],
  ["integrations", renderIntegrationsPage],
  ["shared-credentials", renderSharedCredsPage],
  ["account", renderAccountPage],
  ["profile", renderProfilePage],
  ["schedules", renderSchedulesPage],
  ["skills", renderSkillsPage],
  ["history", renderHistoryPage],
  ["whatsapp", renderWhatsappPage],
  ["approvals", renderApprovalsPage],
];

let failed = false;

for (const [name, render] of PAGES) {
  let html: string;
  try {
    html = render();
  } catch (e: any) {
    console.error(`✗ ${name}: render() threw — ${e?.message ?? e}`);
    failed = true;
    continue;
  }

  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  let pageOk = true;
  blocks.forEach((body, i) => {
    try {
      // Parse-only: compiles the body (throws on syntax errors) without running it.
      new Function(body);
    } catch (e: any) {
      failed = true;
      pageOk = false;
      console.error(`✗ ${name} inline <script>#${i}: ${e?.name}: ${e?.message}`);
    }
  });
  if (pageOk) console.log(`✓ ${name}: ${blocks.length} inline script(s) parse cleanly`);
}

if (failed) {
  console.error("\nInline browser-script check FAILED — fix before deploy.");
  process.exit(1);
}
console.log("\nAll inline browser scripts parse cleanly.");
process.exit(0);
