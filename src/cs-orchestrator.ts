/**
 * CS Orchestrator — main message handler for the CS/SDR pipeline.
 *
 * Pipeline per message:
 *   sanitize → get/create session → rate limit → escalation check →
 *   RAG retrieval → system prompt build → Claude call → save → respond
 *
 * Hard wall: this file MUST NOT import from relay.ts, orchestrator.ts, or memory.ts.
 */

import { ClaudeProvider } from './providers/claude';
import { getDb } from './db';
import { logError } from './error-handler';
import { sanitizeCustomerInput } from './cs-sanitize';
import { buildCsSystemPrompt, buildGreeting, buildFallbackResponse, buildOffHoursMessage } from './cs-persona';
import { searchKnowledge, buildKnowledgeContext } from './cs-rag';
import {
  getOrCreateSession,
  getSessionHistory,
  formatHistoryForPrompt,
  shouldEscalate,
  saveMessage,
  incrementResolutionAttempts,
} from './cs-session';
import {
  getEscalationState,
  startEscalation,
  processEscalationResponse,
} from './cs-escalation';

const claude = new ClaudeProvider();

// Rate limiting: 20 messages per 10 minutes per session
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 20;
const rateLimitMap = new Map<string, number[]>();

function checkRateLimit(sessionId: string): boolean {
  const now = Date.now();
  const windowStart = now - RATE_WINDOW_MS;
  const timestamps = (rateLimitMap.get(sessionId) ?? []).filter(t => t > windowStart);
  timestamps.push(now);
  rateLimitMap.set(sessionId, timestamps);
  return timestamps.length <= RATE_LIMIT;
}

function isWithinBusinessHours(hours: string): boolean {
  const m = hours.match(/(\w+)[–\-](\w+)\s+(\d+(?::\d+)?(?:am|pm))[–\-](\d+(?::\d+)?(?:am|pm))\s*(\w+)?/i);
  if (!m) return true; // Unparseable format — don't block
  const [, dayStart, dayEnd, timeStart, timeEnd, tz] = m;
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const dFrom = days.indexOf(dayStart.toLowerCase().slice(0, 3));
  const dTo = days.indexOf(dayEnd.toLowerCase().slice(0, 3));
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: tz || 'UTC' }));
  const d = now.getDay();
  if (dFrom < 0 || dTo < 0 || d < dFrom || d > dTo) return false;
  const parseTime = (t: string) => {
    const p = t.match(/(\d+)(?::(\d+))?(am|pm)/i)!;
    let h = +p[1];
    const min = +(p[2] || '0');
    if (p[3].toLowerCase() === 'pm' && h !== 12) h += 12;
    if (p[3].toLowerCase() === 'am' && h === 12) h = 0;
    return h * 60 + min;
  };
  const cur = now.getHours() * 60 + now.getMinutes();
  return cur >= parseTime(timeStart) && cur < parseTime(timeEnd);
}

export async function sendGreeting(
  channelType: string,
  channelSessionId: string,
  sendToCustomer: (text: string) => Promise<void>
): Promise<void> {
  const db = getDb();
  const session = db.getCsSession(channelType, channelSessionId);
  if (session) return; // not first contact
  const config = db.getCsConfig();
  await sendToCustomer(buildGreeting(config));
}

export async function handleCsMessage(
  channelType: string,
  channelSessionId: string,
  rawMessage: string,
  platformUserId: string | undefined,
  sendToCustomer: (text: string) => Promise<void>,
  notifyOwner: (text: string) => Promise<void>
): Promise<void> {
  const db = getDb();

  try {
    // 0. Business hours check — send off-hours message without entering the pipeline
    const config = db.getCsConfig();
    if (config.businessHours && !isWithinBusinessHours(config.businessHours)) {
      await sendToCustomer(buildOffHoursMessage(config));
      return;
    }

    // 1. Sanitize input
    const { text, wasModified, strippedTags } = sanitizeCustomerInput(rawMessage);
    if (wasModified && strippedTags.length > 0) {
      logError(new Error(`Stripped tags: ${strippedTags.join(', ')}`), 'cs-sanitize-warning');
    }
    if (!text.trim()) return;

    // 2. Get/create session
    const session = getOrCreateSession(db, channelType, channelSessionId, platformUserId);

    // 3. Rate limit
    if (!checkRateLimit(session.id)) {
      await sendToCustomer("I'm receiving a lot of messages — please give me a moment and try again shortly.");
      return;
    }

    // 4. If already escalated, hold or process contact collection
    if (session.status === 'escalated') {
      const escalationState = getEscalationState(session.id);
      if (escalationState === 'awaiting_contact') {
        // Process contact info response
        const history = getSessionHistory(db, session.id);
        const transcript = formatHistoryForPrompt(history);
        const handled = await processEscalationResponse(
          db,
          session,
          text,
          transcript,
          sendToCustomer,
          notifyOwner
        );
        if (handled) {
          saveMessage(db, session.id, 'customer', text);
          return;
        }
      } else {
        // Already fully escalated — holding message
        const email = session.customerEmail ?? 'your email';
        await sendToCustomer(
          `Our team will be in touch with you at ${email} soon. Is there anything else I can help with in the meantime?`
        );
        return;
      }
    }

    // 5. Save customer message
    saveMessage(db, session.id, 'customer', text);

    // 6. Check if this message should trigger escalation
    if (shouldEscalate(session, text)) {
      await startEscalation(db, session, sendToCustomer);
      return;
    }

    // 7. Config already loaded above (step 0) — reuse it

    // 8. Search knowledge base
    const chunks = await searchKnowledge(db, text);
    const knowledgeContext = buildKnowledgeContext(chunks, 0.65);

    // 9. If no knowledge found, increment resolution attempts and use fallback
    if (!knowledgeContext) {
      incrementResolutionAttempts(db, session);
      const refreshedSession = db.getCsSession(channelType, channelSessionId)!;
      if (refreshedSession.resolutionAttempts >= 2) {
        await startEscalation(db, refreshedSession, sendToCustomer);
        return;
      }
      const fallback = buildFallbackResponse(config);
      await sendToCustomer(fallback);
      saveMessage(db, session.id, 'agent', fallback);
      return;
    }

    // 10. Build conversation history and system prompt
    const history = getSessionHistory(db, session.id, 10);
    // Exclude the customer message just saved (last entry) to avoid double-counting
    const historyForContext = history.slice(0, -1);
    const conversationHistory = formatHistoryForPrompt(historyForContext);
    const systemPrompt = buildCsSystemPrompt(config, knowledgeContext, conversationHistory);

    // 11. Call Claude — sandboxed (no MCP tools, no file access, no bypassPermissions).
    // ClaudeProvider.call() uses --output-format text and cwd=/tmp when noMcp=true.
    // System prompt is embedded in the prompt field since AIProviderCallOpts has no
    // dedicated systemPrompt field; the --system-prompt CLI flag would be ideal but
    // is not exposed through the provider interface.
    const fullPrompt = `${systemPrompt}\n\nCustomer: ${text}`;
    let response = '';
    try {
      const result = await claude.call({
        prompt: fullPrompt,
        outputFormat: 'text',
        sandboxed: true,
        noMcp: true,
      });
      response = result.text.trim();
    } catch (err) {
      logError(err, 'cs-orchestrator-claude', session.id);
      await sendToCustomer("I'm having trouble processing your request right now. Please try again in a moment.");
      return;
    }

    if (!response) {
      response = buildFallbackResponse(config);
    }

    // 12. Save agent response and send to customer
    const topSimilarity = chunks[0]?.similarity ?? 0;
    const chunkIds = chunks.filter(c => c.similarity >= 0.65).map(c => c.id);
    saveMessage(db, session.id, 'agent', response, chunkIds, topSimilarity);
    await sendToCustomer(response);
  } catch (err) {
    logError(err, 'cs-orchestrator', channelSessionId);
    await sendToCustomer("I encountered an issue. Please try again or contact us directly.").catch(() => {});
  }
}
