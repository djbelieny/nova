/**
 * Agent-to-Agent Inbox
 *
 * Allows one agent to send a message to another agent's inbox during pipeline
 * execution. The sending agent includes [ASK: @agentSlug | question] in output;
 * the planner intercepts this, dispatches an inline call to the target agent,
 * and injects the reply before the pipeline continues.
 *
 * Tag format: [ASK: @agentSlug | question text]
 */

import type { Database } from "./db.ts";
import { emit } from "./events.ts";

export interface AgentMessage {
  id: string;
  created_at: string;
  from_agent: string;
  to_agent: string;
  thread_id: string;
  user_id: string;
  subject: string | null;
  body: string;
  reply_to: string | null;
  status: "unread" | "read" | "replied";
  reply_body: string | null;
}

export interface AgentAsk {
  targetAgent: string;
  question: string;
}

/**
 * Parse [ASK: @agentSlug | question] tags from agent output.
 */
export function parseAgentAsks(text: string): AgentAsk[] {
  const asks: AgentAsk[] = [];
  const pattern = /\[ASK:\s*@?([\w-]+)\s*\|\s*(.+?)\]/g;
  for (const match of text.matchAll(pattern)) {
    asks.push({
      targetAgent: match[1].trim().toLowerCase(),
      question: match[2].trim(),
    });
  }
  return asks;
}

/**
 * Strip [ASK: ...] tags from agent output before delivery.
 */
export function stripAgentAskTags(text: string): string {
  return text.replace(/\[ASK:\s*@?[\w-]+\s*\|[^\]]+\]/g, "").trim();
}

/**
 * Send a message to an agent's inbox.
 * Returns the message ID.
 */
export function sendAgentMessage(
  db: Database,
  msg: Omit<AgentMessage, "id" | "created_at" | "status" | "reply_body">
): string {
  const id = db.insertAgentMessage(msg);
  emit({
    type: "agent.message",
    level: "info",
    agentSlug: msg.to_agent,
    userId: msg.user_id,
    data: {
      message: `Agent ${msg.from_agent} → ${msg.to_agent}: ${msg.body.slice(0, 80)}`,
      from_agent: msg.from_agent,
      to_agent: msg.to_agent,
      thread_id: msg.thread_id,
      module: "agent-inbox",
    },
  });
  return id;
}

/**
 * Read unread messages for an agent in a thread.
 */
export function readInbox(
  db: Database,
  agentSlug: string,
  threadId: string,
  userId: string
): AgentMessage[] {
  return db.getAgentInbox(agentSlug, threadId, userId);
}

/**
 * Post a reply to a message.
 */
export function replyToMessage(
  db: Database,
  messageId: string,
  replyBody: string
): void {
  db.markAgentMessageReplied(messageId, replyBody);
}

/**
 * Wait for a reply to arrive (polls every 500ms).
 * Returns the reply body, or null on timeout.
 */
export async function waitForReply(
  db: Database,
  messageId: string,
  timeoutMs = 30_000
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msg = db.getAgentMessageById(messageId);
    if (msg?.status === "replied" && msg.reply_body) {
      return msg.reply_body;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}
