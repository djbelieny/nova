#!/usr/bin/env bun
/**
 * Twilio SMS & Voice Call Utility
 *
 * Standalone CLI script that Claude calls via bash.
 * Usage:
 *   bun run src/twilio.ts sms "+1234567890" "Your message"
 *   bun run src/twilio.ts call "+1234567890" "context and reason for calling"
 */

import "dotenv/config";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

// Twilio
const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const FROM_NUMBER = process.env.TWILIO_PHONE_NUMBER || "";
const TWILIO_API = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}`;

// Voice server
const VOICE_SERVER_URL = process.env.VOICE_SERVER_URL || "https://nova.1osm.com";
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
const CALL_CONTEXTS_DIR = join(RELAY_DIR, "call-contexts");

function twilioAuth(): string {
  return "Basic " + Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString("base64");
}

// ============================================================
// SMS (direct Twilio)
// ============================================================

async function sendSMS(to: string, body: string): Promise<void> {
  const response = await fetch(`${TWILIO_API}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: twilioAuth(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, From: FROM_NUMBER, Body: body }),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("SMS failed:", data.message || data);
    process.exit(1);
  }
  console.log(`SMS sent to ${to} (SID: ${data.sid})`);
}

// ============================================================
// VOICE CALL (Twilio + our voice server)
// ============================================================

async function makeCall(to: string, context: string): Promise<void> {
  // Create the outgoing call via Twilio REST API
  const response = await fetch(`${TWILIO_API}/Calls.json`, {
    method: "POST",
    headers: {
      Authorization: twilioAuth(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      To: to,
      From: FROM_NUMBER,
      Url: `${VOICE_SERVER_URL}/voice/outgoing`,
      Method: "POST",
      StatusCallback: `${VOICE_SERVER_URL}/voice/status`,
      StatusCallbackMethod: "POST",
      StatusCallbackEvent: "completed",
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    console.error("Call failed:", JSON.stringify(data, null, 2));
    process.exit(1);
  }

  // Write call context for the voice server to pick up
  await mkdir(CALL_CONTEXTS_DIR, { recursive: true });
  const contextPath = join(CALL_CONTEXTS_DIR, `${data.sid}.json`);
  await writeFile(contextPath, JSON.stringify({ context, to, timestamp: new Date().toISOString() }));

  console.log(`Call initiated to ${to}`);
  console.log(`Call SID: ${data.sid}`);
  console.log(`Context saved for voice server`);
}

// ============================================================
// CLI ENTRY POINT
// ============================================================

const [action, ...rest] = process.argv.slice(2);

if (action === "sms") {
  const [to, ...msgParts] = rest;
  const message = msgParts.join(" ");
  if (!ACCOUNT_SID || !AUTH_TOKEN || !FROM_NUMBER) {
    console.error("Missing Twilio env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER");
    process.exit(1);
  }
  if (!to || !message) {
    console.error('Usage: bun run src/twilio.ts sms "+1234567890" "message"');
    process.exit(1);
  }
  await sendSMS(to, message);
} else if (action === "call") {
  const [to, ...ctxParts] = rest;
  const context = ctxParts.join(" ");
  if (!ACCOUNT_SID || !AUTH_TOKEN || !FROM_NUMBER) {
    console.error("Missing Twilio env vars");
    process.exit(1);
  }
  if (!to || !context) {
    console.error('Usage: bun run src/twilio.ts call "+1234567890" "reason for calling"');
    process.exit(1);
  }
  await makeCall(to, context);
} else {
  console.error(`Usage: bun run src/twilio.ts <sms|call> [args...]`);
  process.exit(1);
}
