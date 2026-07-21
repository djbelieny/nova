/**
 * Nova — Outbound Call CLI (`nova call <number> --say "message"`)
 * Places a Twilio call that speaks a message (reminders, qualification). Consequential.
 */

import { initiateCall, callConfigFromEnv } from "./outbound-voice.ts";

export async function runCallCli(argv: string[]): Promise<number> {
  const to = argv.find((a) => !a.startsWith("--")) || "";
  const i = argv.indexOf("--say");
  const say = i >= 0 ? argv[i + 1] : "";
  if (!to || !say) { console.error('  Usage: nova call <number> --say "your message"'); return 1; }
  console.log(`  Calling ${to} …`);
  const r = await initiateCall(to, say, callConfigFromEnv());
  if (r.ok) { console.log(`  ✓ Call placed (sid ${r.sid})`); return 0; }
  console.error(`  ✗ ${r.error}`);
  return 1;
}

if (import.meta.main) {
  runCallCli(process.argv.slice(2)).then(c => process.exit(c)).catch(err => { console.error(`\n  Error: ${err?.message || err}`); process.exit(1); });
}
