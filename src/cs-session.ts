import { randomUUID } from 'crypto';
import type { Database, CsSession, CsMessage } from './db';
import { detectFrustration, detectEscalationRequest } from './cs-sanitize';

export function getOrCreateSession(db: Database, channelType: string, channelSessionId: string, platformUserId?: string): CsSession {
  const existing = db.getCsSession(channelType, channelSessionId);
  if (existing) {
    db.updateCsSession(existing.id, { lastActivity: Math.floor(Date.now() / 1000) });
    return { ...existing, lastActivity: Math.floor(Date.now() / 1000) };
  }
  const id = randomUUID();
  return db.createCsSession(id, channelType, channelSessionId, platformUserId);
}

export function getSessionHistory(db: Database, sessionId: string, limit = 10): CsMessage[] {
  return db.getCsMessages(sessionId, limit);
}

export function formatHistoryForPrompt(messages: CsMessage[]): string {
  return messages.map(m => `${m.role === 'customer' ? 'Customer' : 'Agent'}: ${m.content}`).join('\n');
}

export function shouldEscalate(session: CsSession, customerText: string): boolean {
  return session.resolutionAttempts >= 2 || detectFrustration(customerText) || detectEscalationRequest(customerText);
}

export function incrementResolutionAttempts(db: Database, session: CsSession): void {
  db.updateCsSession(session.id, { resolutionAttempts: session.resolutionAttempts + 1 });
}

export function saveMessage(db: Database, sessionId: string, role: 'customer' | 'agent', content: string, chunkIds?: string[], topSimilarity?: number): void {
  db.addCsMessage(randomUUID(), sessionId, role, content, chunkIds, topSimilarity);
}
