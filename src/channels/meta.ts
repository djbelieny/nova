import { handleCsMessage, sendGreeting } from '../cs-orchestrator';
import { logError } from '../error-handler';

// Meta channel types
type MetaChannelType = 'facebook' | 'instagram' | 'whatsapp';

// Detect channel from webhook body
function detectChannel(body: any): MetaChannelType {
  const obj = body?.object as string ?? '';
  if (obj === 'instagram') return 'instagram';
  if (obj === 'whatsapp_business_account') return 'whatsapp';
  return 'facebook';
}

// Extract messages from Meta webhook body
interface MetaMessage { senderId: string; text: string; isFirstMessage: boolean; }

function extractMessages(body: any, channel: MetaChannelType): MetaMessage[] {
  const messages: MetaMessage[] = [];
  const entries: any[] = body?.entry ?? [];

  for (const entry of entries) {
    if (channel === 'whatsapp') {
      const changes: any[] = entry?.changes ?? [];
      for (const change of changes) {
        const msgs: any[] = change?.value?.messages ?? [];
        for (const msg of msgs) {
          if (msg?.type === 'text' && msg?.text?.body) {
            messages.push({ senderId: msg.from, text: msg.text.body, isFirstMessage: false });
          }
        }
      }
    } else {
      // Messenger / Instagram
      const messaging: any[] = entry?.messaging ?? [];
      for (const event of messaging) {
        if (event?.message?.text && !event?.message?.is_echo) {
          messages.push({ senderId: event.sender?.id, text: event.message.text, isFirstMessage: false });
        }
      }
    }
  }
  return messages;
}

// Send reply via Meta Graph API
async function sendMetaReply(channel: MetaChannelType, recipientId: string, text: string): Promise<void> {
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  if (!token) return;

  // Truncate to Meta limits (1000 chars for most channels)
  const safeText = text.slice(0, 1000);

  try {
    if (channel === 'whatsapp') {
      const phoneNumberId = process.env.META_WHATSAPP_PHONE_NUMBER_ID;
      if (!phoneNumberId) return;
      await fetch(`https://graph.facebook.com/v18.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: recipientId, type: 'text', text: { body: safeText } })
      });
    } else {
      // Messenger + Instagram use the same endpoint
      await fetch(`https://graph.facebook.com/v18.0/me/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: { id: recipientId }, message: { text: safeText } })
      });
    }
  } catch (err) {
    logError(err, `cs-meta-send-${channel}`);
  }
}

// Verify Meta webhook challenge
export function verifyMetaWebhook(url: URL): Response | null {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN && challenge) {
    return new Response(challenge, { status: 200 });
  }
  return new Response('Forbidden', { status: 403 });
}

// Process incoming Meta webhook
export async function processMetaWebhook(
  body: any,
  notifyOwner: (text: string) => Promise<void>
): Promise<void> {
  const channel = detectChannel(body);
  const messages = extractMessages(body, channel);

  for (const { senderId, text } of messages) {
    if (!senderId || !text) continue;
    const channelSessionId = `${channel}_${senderId}`;
    const sendToCustomer = (reply: string) => sendMetaReply(channel, senderId, reply);

    await handleCsMessage(
      channel,
      channelSessionId,
      text,
      senderId,
      sendToCustomer,
      notifyOwner
    ).catch(err => logError(err, `cs-meta-${channel}`, channelSessionId));
  }
}
