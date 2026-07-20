import type { Database, CsSession } from './db';
import { logError } from './error-handler';
import { buildEscalationClose } from './cs-persona';

// In-memory state: 'idle' | 'awaiting_contact' | 'escalated'
const escalationState = new Map<string, 'idle' | 'awaiting_contact' | 'escalated'>();

export function getEscalationState(sessionId: string): 'idle' | 'awaiting_contact' | 'escalated' {
  return escalationState.get(sessionId) ?? 'idle';
}

// Try to extract name + email from a customer message like "John Smith, john@example.com"
export function parseContactInfo(text: string): { name: string | null; email: string | null } {
  const emailMatch = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
  const email = emailMatch ? emailMatch[0] : null;
  const withoutEmail = text.replace(emailMatch?.[0] ?? '', '').replace(/[,;]/g, '').trim();
  const nameMatch = withoutEmail.match(/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/);
  const name = nameMatch ? nameMatch[0] : (withoutEmail.length > 2 && withoutEmail.length < 50 ? withoutEmail : null);
  return { name, email };
}

// Create GHL contact via REST API
async function createGhlContact(name: string, email: string, channel: string): Promise<string> {
  const apiKey = process.env.GHL_API_KEY;
  if (!apiKey) return '';
  try {
    const parts = name.trim().split(/\s+/);
    const res = await fetch('https://services.leadconnectorhq.com/contacts/', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Version: '2021-07-28' },
      body: JSON.stringify({ firstName: parts[0], lastName: parts.slice(1).join(' '), email, source: `Nova CS - ${channel}`, tags: ['cs-escalation'] })
    });
    const data = await res.json() as { contact?: { id: string } };
    return data.contact?.id ?? '';
  } catch (err) {
    logError(err, 'cs-ghl-contact');
    return '';
  }
}

// Create GHL ticket/opportunity
async function createGhlTicket(contactId: string, session: CsSession, transcript: string): Promise<string> {
  const apiKey = process.env.GHL_API_KEY;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!apiKey || !locationId) return '';
  try {
    const res = await fetch('https://services.leadconnectorhq.com/opportunities/', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Version: '2021-07-28' },
      body: JSON.stringify({
        title: `CS Support - ${session.channelType} - ${new Date().toLocaleDateString()}`,
        contactId,
        locationId,
        status: 'open',
        customFields: [{ key: 'transcript', field_value: transcript.slice(0, 5000) }, { key: 'channel', field_value: session.channelType }]
      })
    });
    const data = await res.json() as { opportunity?: { id: string } };
    return data.opportunity?.id ?? '';
  } catch (err) {
    logError(err, 'cs-ghl-ticket');
    return '';
  }
}

export async function startEscalation(
  db: Database,
  session: CsSession,
  sendToCustomer: (text: string) => Promise<void>
): Promise<void> {
  const state = getEscalationState(session.id);
  if (state !== 'idle') return;
  escalationState.set(session.id, 'awaiting_contact');
  await sendToCustomer("I want to make sure our team follows up with you directly. Could I get your name and email address?");
}

export async function processEscalationResponse(
  db: Database,
  session: CsSession,
  customerText: string,
  transcript: string,
  sendToCustomer: (text: string) => Promise<void>,
  notifyOwner: (text: string) => Promise<void>
): Promise<boolean> {
  const state = getEscalationState(session.id);
  if (state !== 'awaiting_contact') return false;

  const { name, email } = parseContactInfo(customerText);

  if (!email) {
    await sendToCustomer("I just need your email address to connect you with our team. What's the best email to reach you?");
    return true;
  }

  const resolvedName = name ?? (session.customerName ?? 'Customer');
  escalationState.set(session.id, 'escalated');

  // Update session
  db.updateCsSession(session.id, { customerName: resolvedName, customerEmail: email, status: 'escalated' });

  // Create GHL contact + ticket in background
  Promise.resolve().then(async () => {
    try {
      const contactId = await createGhlContact(resolvedName, email, session.channelType);
      const ticketId = await createGhlTicket(contactId, session, transcript);
      if (contactId) db.updateCsSession(session.id, { ghlContactId: contactId, ghlTicketId: ticketId });

      // Notify owner
      const alert = [
        `🆘 <b>CS Escalation</b> — ${resolvedName} via ${session.channelType}`,
        `📧 ${email}`,
        `💬 "${transcript.split('\n').slice(-2).join(' ').slice(0, 200)}"`,
        `🆔 Session: <code>${session.id}</code>`,
        contactId ? `🔗 GHL Contact: ${contactId}` : ''
      ].filter(Boolean).join('\n');
      await notifyOwner(alert);
    } catch (err) {
      logError(err, 'cs-escalation-ghl');
    }
  });

  const config = db.getCsConfig();
  await sendToCustomer(buildEscalationClose(config, email));
  return true;
}
