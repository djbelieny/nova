// src/resend-client.ts
import { createHmac, timingSafeEqual } from "crypto";

export interface InboundEmail { messageId: string; from: string; fromName: string | null; subject: string; text: string; }

export function parseInboundEmail(payload: any): InboundEmail | null {
  if (!payload || payload.type !== "email.received" || !payload.data) return null;
  const d = payload.data;
  const rawFrom = String(d.from || "");
  const m = rawFrom.match(/^\s*(?:"?([^"<]*)"?\s)?<?([^<>\s]+@[^<>\s]+)>?\s*$/);
  const email = (m?.[2] || rawFrom).trim().toLowerCase();
  const name = m?.[1]?.trim() || null;
  return {
    messageId: String(d.email_id || d.id || ""),
    from: email, fromName: name && name.length ? name : null,
    subject: String(d.subject || "(no subject)"),
    text: String(d.text || d.html || ""),
  };
}

export function verifyResendSignature(rawBody: string, headers: Record<string, string>, secret: string): boolean {
  const id = headers["svix-id"]; const ts = headers["svix-timestamp"]; const sigHeader = headers["svix-signature"];
  if (!id || !ts || !sigHeader || !secret) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest("base64");
  // svix-signature may contain multiple space-separated "v1,<sig>" entries
  for (const part of sigHeader.split(" ")) {
    const sig = part.split(",")[1];
    if (!sig) continue;
    const a = Buffer.from(sig); const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

export async function sendTicketEmail(to: string, subject: string, body: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY || "";
  const from = process.env.TICKET_SUPPORT_FROM || "support@example.com";
  if (!apiKey) { console.error("[resend] RESEND_API_KEY missing — skipping send"); return; }
  const { Resend } = await import("resend");
  const resend = new Resend(apiKey);
  await resend.emails.send({ from, to, subject, text: body });
}
