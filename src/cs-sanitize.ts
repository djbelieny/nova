/**
 * CS Input Sanitizer — Layer 1 of the CS security sandbox.
 *
 * Strips Nova intent tags, admin commands, and code blocks from customer
 * messages before they reach the AI layer. Prevents prompt injection.
 */

const INTENT_TAG_RE = /\[(REMEMBER|SHARE|GOAL|DONE|TASK[_A-Z]*|SCHEDULE[_A-Z]*|DEVTASK|DECISION|BRIEF|DELEGATE)[:\s][^\]]*\]/gi;
const NOVA_CMD_RE = /^\/(?:help|start|agents|memory|goals|tasks|usage|schedule|feedback|codebase|devtask|board|adduser|schedules)\b/gim;
const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const MAX_LENGTH = 2000;

export interface SanitizeResult {
  text: string;
  wasModified: boolean;
  strippedTags: string[];
}

export function sanitizeCustomerInput(raw: string): SanitizeResult {
  const strippedTags: string[] = [];
  let text = raw;

  // Strip Nova intent tags
  text = text.replace(INTENT_TAG_RE, (match) => {
    strippedTags.push(match);
    return '';
  });

  // Strip Nova slash commands
  text = text.replace(NOVA_CMD_RE, (match) => {
    strippedTags.push(match);
    return '';
  });

  // Replace code blocks with safe placeholder
  text = text.replace(CODE_BLOCK_RE, (match) => {
    strippedTags.push(match.substring(0, 40) + '...');
    return '[code removed]';
  });

  text = text.trim();

  const wasModified = strippedTags.length > 0 || raw.length > MAX_LENGTH;
  if (text.length > MAX_LENGTH) text = text.slice(0, MAX_LENGTH) + '…';

  return { text, wasModified, strippedTags };
}

export function detectFrustration(text: string): boolean {
  const signals = [
    'speak to a human',
    'real person',
    'this is useless',
    'i give up',
    'so frustrated',
    'unacceptable',
    'this is ridiculous',
    'talk to someone',
    'connect me to support',
    'human please',
    'supervisor',
    'manager',
    'speak with someone',
  ];
  const lower = text.toLowerCase();
  return signals.some(s => lower.includes(s));
}

export function detectEscalationRequest(text: string): boolean {
  const signals = [
    'can i talk to',
    'connect me to',
    'human agent',
    'real agent',
    'live agent',
    'talk to a person',
    'speak to a person',
  ];
  const lower = text.toLowerCase();
  return signals.some(s => lower.includes(s));
}
