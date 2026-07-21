/**
 * Outbound voice — place a Twilio call that speaks a message (reminders, qualification).
 * Placing a call is consequential; callers should gate it. Pure payload building is tested;
 * the HTTP call uses an injectable fetch.
 */

export interface CallConfig { accountSid: string; authToken: string; from: string; fetchImpl?: typeof fetch; }
export interface CallResult { ok: boolean; sid?: string; error?: string; }

/** Escape text for inclusion in TwiML. */
function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Build the TwiML a call will speak. */
export function buildCallTwiml(say: string, opts?: { voice?: string; loop?: number }): string {
  const voice = opts?.voice || 'Polly.Joanna';
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${voice}">${escapeXml(say)}</Say></Response>`;
}

/** Build the Twilio Calls.json form parameters. */
export function buildCallParams(to: string, from: string, say: string): Record<string, string> {
  return { To: to, From: from, Twiml: buildCallTwiml(say) };
}

/** Place an outbound call that speaks `say` to `to`. Returns the call SID on success. */
export async function initiateCall(to: string, say: string, cfg: CallConfig): Promise<CallResult> {
  if (!cfg.accountSid || !cfg.authToken || !cfg.from) return { ok: false, error: 'Twilio not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER)' };
  if (!to) return { ok: false, error: 'no destination number' };
  const fetchImpl = cfg.fetchImpl || fetch;
  const auth = 'Basic ' + Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64');
  try {
    const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Calls.json`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(buildCallParams(to, cfg.from, say)).toString(),
    });
    const text = await res.text();
    let json: any = {}; try { json = JSON.parse(text); } catch { /* */ }
    if (!res.ok) return { ok: false, error: `Twilio ${res.status}: ${String(text).slice(0, 160)}` };
    return { ok: true, sid: json.sid };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Build a CallConfig from the process environment. */
export function callConfigFromEnv(fetchImpl?: typeof fetch): CallConfig {
  return {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    from: process.env.TWILIO_PHONE_NUMBER || '',
    fetchImpl,
  };
}
