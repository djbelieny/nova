/**
 * WhatsApp Manager — Per-User Session Management (Kapso / Meta Cloud API)
 *
 * Manages multiple WhatsApp sessions (one per Nova user), routes incoming
 * webhook payloads through a classification pipeline that enforces contact
 * access control, group whitelisting, and per-contact rate limiting.
 *
 * Architecture:
 *   Mini App → connect/disconnect endpoints → WhatsAppManager
 *   Kapso webhooks → routeWebhook → classifyAndRoute → Nova message handler
 */

import { WhatsAppAdapter, type WhatsAppStatus } from "./channels/whatsapp.ts";
import type { Database } from "./db.ts";
import type { IncomingMessage, MessageHandler, ReplyFn } from "./channels/types.ts";

/** Rate limit config per contact role */
const RATE_LIMITS: Record<string, { maxPerHour: number }> = {
  vip: { maxPerHour: 20 },
  allowed: { maxPerHour: 10 },
};

/** Per-contact rate limit tracking: "userId:phone" → timestamp[] */
const contactRateLimits = new Map<string, number[]>();

// Cleanup stale rate limit entries every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 3600_000;
  for (const [key, timestamps] of contactRateLimits) {
    const recent = timestamps.filter((t) => t > cutoff);
    if (recent.length === 0) contactRateLimits.delete(key);
    else contactRateLimits.set(key, recent);
  }
}, 10 * 60 * 1000);

export class WhatsAppManager {
  private sessions = new Map<string, WhatsAppAdapter>();
  /** Reverse lookup: phoneNumberId → userId for webhook routing */
  private phoneNumberToUser = new Map<string, string>();
  private messageHandler: MessageHandler | null = null;
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /** Register Nova's message handler. Called once during startup. */
  setMessageHandler(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /** Start a new WhatsApp session for a user using Kapso credentials from DB. */
  async connect(userId: string): Promise<void> {
    if (this.sessions.has(userId)) {
      const existing = this.sessions.get(userId)!;
      if (existing.connectionState !== "disconnected") {
        return; // already connecting/connected
      }
      await existing.stop();
    }

    const creds = this.db.getKapsoCredentials(userId);
    if (!creds || !creds.kapso_api_key || !creds.kapso_phone_number_id) {
      throw new Error("Kapso credentials not found. Save API key and phone number ID first.");
    }

    const adapter = new WhatsAppAdapter(userId, creds.kapso_api_key, creds.kapso_phone_number_id);

    // Wire up the classification pipeline as the message handler
    adapter.onMessage((msg, reply) => {
      this.classifyAndRoute(userId, msg, reply);
    });

    this.sessions.set(userId, adapter);
    this.phoneNumberToUser.set(creds.kapso_phone_number_id, userId);
    await adapter.start();
    console.log(`[wa-manager] Session started for user ${userId}`);
  }

  /** Disconnect and clean up a user's session. */
  async disconnect(userId: string): Promise<void> {
    const adapter = this.sessions.get(userId);
    if (adapter) {
      const status = adapter.getStatus();
      if (status.phoneNumberId) {
        this.phoneNumberToUser.delete(status.phoneNumberId);
      }
      await adapter.stop();
      this.sessions.delete(userId);
    }
    console.log(`[wa-manager] Session disconnected for user ${userId}`);
  }

  /** Get connection status for a user. */
  getStatus(userId: string): WhatsAppStatus {
    const adapter = this.sessions.get(userId);
    if (!adapter) {
      return { state: "disconnected", phoneNumberId: null };
    }
    return adapter.getStatus();
  }

  /** Restore sessions for users who have Kapso credentials. */
  async restoreConnectedSessions(): Promise<void> {
    let restored = 0;
    try {
      const users = this.db.getUsersWithKapso();
      console.log(`[wa-manager] Found ${users.length} user(s) with Kapso credentials`);
      for (const user of users) {
        try {
          await this.connect(user.id);
          restored++;
        } catch (err) {
          console.error(`[wa-manager] Failed to restore session for ${user.id}:`, err);
        }
      }
    } catch (err) {
      console.error(`[wa-manager] Error restoring sessions:`, err);
    }

    console.log(`[wa-manager] Restored ${restored} WhatsApp session(s)`);
  }

  /** Route an incoming Kapso webhook payload to the correct user's adapter. */
  async routeWebhook(phoneNumberId: string, payload: any): Promise<void> {
    const userId = this.phoneNumberToUser.get(phoneNumberId);
    if (!userId) {
      console.warn(`[wa-manager] No user found for phone_number_id: ${phoneNumberId}`);
      return;
    }

    const adapter = this.sessions.get(userId);
    if (!adapter) {
      console.warn(`[wa-manager] No active adapter for user ${userId}`);
      return;
    }

    await adapter.handleWebhook(payload);
  }

  /** Get all active sessions (for admin/debug). */
  getActiveSessions(): Array<{ userId: string; status: WhatsAppStatus }> {
    const result: Array<{ userId: string; status: WhatsAppStatus }> = [];
    for (const [userId, adapter] of this.sessions) {
      result.push({ userId, status: adapter.getStatus() });
    }
    return result;
  }

  /** Stop all sessions (for graceful shutdown). */
  async stopAll(): Promise<void> {
    const stops = Array.from(this.sessions.values()).map((a) => a.stop());
    await Promise.allSettled(stops);
    this.sessions.clear();
    this.phoneNumberToUser.clear();
  }

  // ---- INTERNAL ----

  /**
   * Classification pipeline — every incoming WhatsApp message goes through this
   * before reaching Nova's message handler.
   */
  private async classifyAndRoute(
    ownerUserId: string,
    msg: IncomingMessage,
    reply: ReplyFn,
  ): Promise<void> {
    if (!this.messageHandler) return;

    const extra = msg as any;
    const senderPhone = extra._senderPhone || msg.platformUserId;
    const isGroup = extra._isGroup || false;

    // 1. Is sender the owner? (phone matches user's whatsapp_id or registered phone)
    const ownerUser = this.db.getUserById(ownerUserId);
    if (!ownerUser) return;

    const ownerPhones = [
      ownerUser.whatsapp_id,
      ownerUser.phone,
    ].filter(Boolean).map((p: string) => p.replace(/[^0-9]/g, ""));

    const normalizedSender = senderPhone.replace(/[^0-9]/g, "");
    const isOwner = ownerPhones.some((p: string) => p === normalizedSender || normalizedSender.endsWith(p) || p.endsWith(normalizedSender));

    if (isOwner) {
      // Owner mode — full access, treat like Telegram DM
      msg.userId = ownerUserId;
      extra._whatsappMeta = {
        sender_phone: senderPhone,
        sender_name: ownerUser.name,
        sender_role: "owner",
        is_owner: true,
        is_group: isGroup,
        permissions_applied: ["full"],
      };
      this.messageHandler(msg, reply);
      return;
    }

    // 2. Group messages — only respond if group is whitelisted AND Nova is @mentioned
    if (isGroup) {
      const groupJid = msg.channelChatId;
      const group = this.db.getWhatsappGroup(ownerUserId, groupJid);

      if (!group || !group.active) {
        return;
      }

      const text = msg.text || "";
      const mentionPatterns = ["@nova", "@bot", "@assistant"];
      const isMentioned = mentionPatterns.some((p) => text.toLowerCase().includes(p));

      if (!isMentioned) {
        return;
      }

      const contact = this.db.getWhatsappContact(ownerUserId, normalizedSender);
      if (!contact || contact.role === "blocked") return;

      if (this.isContactRateLimited(ownerUserId, normalizedSender, contact.role)) return;

      msg.userId = ownerUserId;
      extra._whatsappMeta = {
        sender_phone: senderPhone,
        sender_name: contact.name || senderPhone,
        sender_role: contact.role,
        is_owner: false,
        is_group: true,
        permissions_applied: Object.keys(contact.permissions || {}).filter(
          (k) => (contact.permissions as any)[k]
        ),
      };
      extra._contactContext = this.buildContactContext(ownerUser, contact);
      this.messageHandler(msg, reply);
      return;
    }

    // 3. DM from contact — check whatsapp_contacts table
    const contact = this.db.getWhatsappContact(ownerUserId, normalizedSender);

    if (!contact) {
      return;
    }

    if (contact.role === "blocked") {
      return;
    }

    if (this.isContactRateLimited(ownerUserId, normalizedSender, contact.role)) return;

    msg.userId = ownerUserId;
    extra._whatsappMeta = {
      sender_phone: senderPhone,
      sender_name: contact.name || senderPhone,
      sender_role: contact.role,
      is_owner: false,
      is_group: false,
      permissions_applied: Object.keys(contact.permissions || {}).filter(
        (k) => (contact.permissions as any)[k]
      ),
    };
    extra._contactContext = this.buildContactContext(ownerUser, contact);
    this.messageHandler(msg, reply);
  }

  /** Build system prompt context for contact messages. */
  private buildContactContext(
    owner: any,
    contact: any,
  ): string {
    const perms = contact.permissions || {};
    const allowed = Object.entries(perms)
      .filter(([, v]) => v)
      .map(([k]) => k);
    const denied = Object.entries(perms)
      .filter(([, v]) => !v)
      .map(([k]) => k);

    return `[WhatsApp Context]
You are responding on behalf of ${owner.name} to a WhatsApp message from ${contact.name || contact.phone} (${contact.phone}).
This person has role: ${contact.role}.

RULES:
- You ARE NOT ${owner.name}. You are Nova, ${owner.name}'s AI assistant.
- Always identify yourself as Nova when the contact doesn't know you yet.
- You can access: ${allowed.length > 0 ? allowed.join(", ") : "none"}
- You CANNOT access: ${denied.length > 0 ? denied.join(", ") : "none"}
- Never share private information, personal opinions, or make commitments on ${owner.name}'s behalf without their pre-approval.
- For scheduling requests: check calendar availability and suggest times, but mark as "pending ${owner.name}'s confirmation" unless the contact is VIP.
- Keep responses concise — this is WhatsApp, not email.`;
  }

  /** Check if a contact has exceeded their rate limit. Returns true if limited. */
  private isContactRateLimited(userId: string, phone: string, role: string): boolean {
    const limit = RATE_LIMITS[role];
    if (!limit) return false;

    const key = `${userId}:${phone}`;
    const now = Date.now();
    const hourAgo = now - 3600_000;
    const timestamps = (contactRateLimits.get(key) || []).filter((t) => t > hourAgo);
    timestamps.push(now);
    contactRateLimits.set(key, timestamps);

    return timestamps.length > limit.maxPerHour;
  }
}
