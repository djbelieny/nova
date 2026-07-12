// src/ticket-intake.ts
import type { Database } from "./db.ts";
import { parseInboundEmail, sendTicketEmail } from "./resend-client.ts";

export async function intakeInboundEmail(db: Database, operatorUserId: string, payload: any): Promise<{ ticketId: string | null; deduped: boolean }> {
  const email = parseInboundEmail(payload);
  if (!email || !email.messageId) return { ticketId: null, deduped: false };

  const existing = db.findTicketByMessageId(operatorUserId, email.messageId);
  if (existing) return { ticketId: existing.id, deduped: true };

  const ticketId = db.insertSupportTicket({
    user_id: operatorUserId, source: "resend", client_email: email.from,
    client_name: email.fromName, resend_message_id: email.messageId,
    subject: email.subject, body_raw: email.text,
  });

  await sendTicketEmail(email.from, `Re: ${email.subject}`,
    `Thanks for reaching out — we've received your request and are looking into it. We'll follow up shortly.`
  ).catch((e) => console.error("[ticket-intake] auto-ack failed:", e));

  return { ticketId, deduped: false };
}
