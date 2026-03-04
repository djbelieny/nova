/**
 * WhatsApp Channel Adapter — Kapso (Official Meta Cloud API)
 *
 * Uses Kapso's REST API wrapper around the official Meta WhatsApp Cloud API.
 * Each user provides their own Kapso API key + phone number ID.
 *
 * Advantages over Baileys:
 * - Zero ban risk (official Meta API)
 * - Native interactive buttons (up to 3)
 * - Stable — no reverse-engineering breakage
 * - Voice notes come as .ogg (same as before, existing transcription works)
 */

import { readFile } from "fs/promises";
import type {
  ChannelAdapter,
  IncomingMessage,
  OutgoingMessage,
  MessageHandler,
  ButtonHandler,
  ReplyFn,
  PlatformContext,
} from "./types.ts";

const KAPSO_BASE = "https://api.kapso.ai/meta/whatsapp/v24.0";
const KAPSO_PLATFORM = "https://api.kapso.ai/platform/v1";

export type ConnectionState = "disconnected" | "connected" | "error";

export interface WhatsAppStatus {
  state: ConnectionState;
  phoneNumberId: string | null;
  error?: string;
}

export class WhatsAppAdapter implements ChannelAdapter {
  readonly type = "whatsapp" as const;
  private messageHandler: MessageHandler | null = null;
  private buttonHandler: ButtonHandler | null = null;
  private webhookId: string | null = null;
  readonly userId: string;
  private apiKey: string;
  private phoneNumberId: string;

  connectionState: ConnectionState = "disconnected";
  private lastError: string | null = null;

  constructor(userId: string, apiKey: string, phoneNumberId: string) {
    this.userId = userId;
    this.apiKey = apiKey;
    this.phoneNumberId = phoneNumberId;
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onButtonPress(handler: ButtonHandler): void {
    this.buttonHandler = handler;
  }

  getStatus(): WhatsAppStatus {
    return {
      state: this.connectionState,
      phoneNumberId: this.phoneNumberId,
      error: this.lastError || undefined,
    };
  }

  async start(): Promise<void> {
    // Try to register webhook with Kapso (non-fatal — webhook may need manual setup)
    const webhookUrl = process.env.MINIAPP_PUBLIC_URL;
    if (webhookUrl) {
      try {
        const res = await fetch(`${KAPSO_PLATFORM}/whatsapp/phone_numbers/${this.phoneNumberId}/webhooks`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({
            webhook: {
              url: `${webhookUrl}/webhook/kapso`,
              events: ["whatsapp.message.received"],
            },
          }),
        });
        if (res.ok) {
          const data = await res.json() as any;
          this.webhookId = data.id || null;
          console.log(`[whatsapp:${this.userId}] Webhook auto-registered`);
        } else {
          console.log(`[whatsapp:${this.userId}] Webhook auto-registration not available (${res.status}) — configure manually in Kapso dashboard`);
        }
      } catch {
        console.log(`[whatsapp:${this.userId}] Webhook auto-registration skipped — configure manually in Kapso dashboard`);
      }
    } else {
      console.warn(`[whatsapp:${this.userId}] MINIAPP_PUBLIC_URL not set — incoming messages won't work`);
    }

    this.connectionState = "connected";
    this.lastError = null;
    console.log(`[whatsapp:${this.userId}] Connected (phone_number_id: ${this.phoneNumberId})`);
  }

  async stop(): Promise<void> {
    // Deregister webhook
    if (this.webhookId) {
      try {
        await fetch(`${KAPSO_BASE}/whatsapp/phone_numbers/${this.phoneNumberId}/webhooks/${this.webhookId}`, {
          method: "DELETE",
          headers: this.headers(),
        });
      } catch {}
      this.webhookId = null;
    }
    this.connectionState = "disconnected";
    this.lastError = null;
    console.log(`[whatsapp:${this.userId}] Disconnected`);
  }

  /** Called by WhatsAppManager when a Kapso webhook arrives for this adapter. */
  async handleWebhook(payload: any): Promise<void> {
    if (!this.messageHandler) return;

    // Kapso sends batched or single message formats
    const messages = this.extractMessages(payload);
    for (const message of messages) {
      await this.processMessage(message);
    }
  }

  /** Extract messages from Kapso webhook payload (batched or single format). */
  private extractMessages(payload: any): any[] {
    // Batched format: { type: "whatsapp.message.received", batch: true, data: [...] }
    if (payload.type === "whatsapp.message.received" && payload.data) {
      return payload.data
        .map((item: any) => item.message)
        .filter((m: any) => m && m.kapso?.direction === "inbound");
    }

    // Single format: { message: {...}, conversation: {...}, phone_number_id: "..." }
    if (payload.message) {
      const msg = payload.message;
      // Only process inbound messages
      if (msg.kapso?.direction && msg.kapso.direction !== "inbound") return [];
      return [msg];
    }

    // Meta forwarded format: { entry: [...] }
    const metaMsg = payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (metaMsg) return [metaMsg];

    return [];
  }

  /** Process a single extracted message. */
  private async processMessage(message: any): Promise<void> {
    if (!this.messageHandler) return;

    const senderPhone = message.from || message.kapso?.phone_number || "";
    const chatId = senderPhone;
    const messageId = message.id || "";
    const isGroup = false;

    // Button press (interactive reply)
    if (message.interactive?.button_reply || message.interactive?.list_reply) {
      if (this.buttonHandler) {
        const reply = message.interactive.button_reply || message.interactive.list_reply;
        this.buttonHandler(
          chatId,
          "",
          senderPhone,
          reply.id,
          async (outMsg) => { await this.send(chatId, outMsg); },
        );
      }
      return;
    }

    // Button reply (older format)
    if (message.type === "button" && message.button) {
      if (this.buttonHandler) {
        this.buttonHandler(
          chatId,
          "",
          senderPhone,
          message.button.payload,
          async (outMsg) => { await this.send(chatId, outMsg); },
        );
      }
      return;
    }

    // Text message
    if (message.text?.body) {
      const numberMatch = message.text.body.match(/^(\d+)$/);
      if (numberMatch && this.buttonHandler) {
        this.buttonHandler(
          chatId,
          "",
          senderPhone,
          `btn_num:${numberMatch[1]}`,
          async (outMsg) => { await this.send(chatId, outMsg); },
        );
        return;
      }

      const incoming: IncomingMessage = {
        channelType: "whatsapp",
        channelMessageId: messageId,
        channelChatId: chatId,
        userId: "",
        platformUserId: senderPhone,
        text: message.text.body,
      };

      this.attachMeta(incoming, chatId, messageId, isGroup, senderPhone);
      this.messageHandler(incoming, async (outMsg) => { await this.send(chatId, outMsg); });
      return;
    }

    // Audio/voice message
    if (message.audio || message.voice) {
      const audio = message.audio || message.voice;
      try {
        const buffer = await this.downloadMedia(audio.id);
        const incoming: IncomingMessage = {
          channelType: "whatsapp",
          channelMessageId: messageId,
          channelChatId: chatId,
          userId: "",
          platformUserId: senderPhone,
          voice: { buffer, durationSec: 0 },
        };
        this.attachMeta(incoming, chatId, messageId, isGroup, senderPhone);
        this.messageHandler(incoming, async (outMsg) => { await this.send(chatId, outMsg); });
      } catch (error) {
        console.error(`[whatsapp:${this.userId}] Voice download error:`, error);
      }
      return;
    }

    // Image message
    if (message.image) {
      try {
        const buffer = await this.downloadMedia(message.image.id);
        const incoming: IncomingMessage = {
          channelType: "whatsapp",
          channelMessageId: messageId,
          channelChatId: chatId,
          userId: "",
          platformUserId: senderPhone,
          image: { buffer, caption: message.image.caption || undefined },
        };
        this.attachMeta(incoming, chatId, messageId, isGroup, senderPhone);
        this.messageHandler(incoming, async (outMsg) => { await this.send(chatId, outMsg); });
      } catch (error) {
        console.error(`[whatsapp:${this.userId}] Image download error:`, error);
      }
      return;
    }

    // Document message
    if (message.document) {
      try {
        const buffer = await this.downloadMedia(message.document.id);
        const incoming: IncomingMessage = {
          channelType: "whatsapp",
          channelMessageId: messageId,
          channelChatId: chatId,
          userId: "",
          platformUserId: senderPhone,
          document: {
            buffer,
            filename: message.document.filename || `file_${Date.now()}`,
            caption: message.document.caption || undefined,
          },
        };
        this.attachMeta(incoming, chatId, messageId, isGroup, senderPhone);
        this.messageHandler(incoming, async (outMsg) => { await this.send(chatId, outMsg); });
      } catch (error) {
        console.error(`[whatsapp:${this.userId}] Document download error:`, error);
      }
    }
  }

  async send(chatId: string, message: OutgoingMessage): Promise<void> {
    // Send files
    if (message.files) {
      for (const file of message.files) {
        await this.sendFile(chatId, file.path, file.caption);
      }
    }

    // Send voice
    if (message.voice) {
      const mediaId = await this.uploadMedia(message.voice, "audio/ogg; codecs=opus", "voice.ogg");
      if (mediaId) {
        await this.kapsoPost(`${this.phoneNumberId}/messages`, {
          messaging_product: "whatsapp",
          to: chatId,
          type: "audio",
          audio: { id: mediaId },
        });
      }
    }

    // Send text with optional buttons
    const text = message.text || "";

    if (text && message.buttons?.length && message.buttons.length <= 3) {
      // Native WhatsApp interactive buttons (max 3)
      await this.kapsoPost(`${this.phoneNumberId}/messages`, {
        messaging_product: "whatsapp",
        to: chatId,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text },
          action: {
            buttons: message.buttons.map((btn, i) => ({
              type: "reply",
              reply: {
                id: btn.callbackData || `btn_${i}`,
                title: btn.label.substring(0, 20), // WhatsApp button title max 20 chars
              },
            })),
          },
        },
      });
    } else if (text) {
      // Plain text (or too many buttons — fall back to numbered list)
      let finalText = text;
      if (message.buttons?.length && message.buttons.length > 3) {
        finalText += "\n\nReply with a number:";
        message.buttons.forEach((btn, i) => {
          finalText += `\n${i + 1}. ${btn.label}`;
        });
      }
      await this.kapsoPost(`${this.phoneNumberId}/messages`, {
        messaging_product: "whatsapp",
        to: chatId,
        type: "text",
        text: { body: finalText },
      });
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    // Cloud API doesn't have a true typing indicator, but we can mark as read
    // which serves a similar UX purpose
  }

  async sendFile(chatId: string, filePath: string, caption?: string): Promise<void> {
    try {
      const buffer = await readFile(filePath);
      const ext = filePath.substring(filePath.lastIndexOf(".")).toLowerCase();
      const imageExts = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

      if (imageExts.has(ext)) {
        const mimeType = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/jpeg";
        const mediaId = await this.uploadMedia(buffer, mimeType, filePath.split("/").pop() || "image");
        if (mediaId) {
          await this.kapsoPost(`${this.phoneNumberId}/messages`, {
            messaging_product: "whatsapp",
            to: chatId,
            type: "image",
            image: { id: mediaId, caption: caption || undefined },
          });
        }
      } else {
        const filename = filePath.split("/").pop() || "file";
        const mediaId = await this.uploadMedia(buffer, "application/octet-stream", filename);
        if (mediaId) {
          await this.kapsoPost(`${this.phoneNumberId}/messages`, {
            messaging_product: "whatsapp",
            to: chatId,
            type: "document",
            document: { id: mediaId, filename, caption: caption || undefined },
          });
        }
      }
      console.log(`[whatsapp:${this.userId}] Sent file: ${filePath}`);
    } catch (error) {
      console.error(`[whatsapp:${this.userId}] Failed to send file ${filePath}:`, error);
    }
  }

  createPlatformContext(chatId: string, messageId?: string): PlatformContext {
    const adapter = this;
    let lastMessageId = 0;

    return {
      adapter,
      chat: { id: chatId },
      channelType: "whatsapp",

      async reply(text: string, _opts?: any) {
        const cleanText = text.replace(/<[^>]+>/g, "");
        await adapter.send(chatId, { text: cleanText });
        lastMessageId++;
        return { message_id: lastMessageId };
      },

      async replyWithChatAction(_action: string) {
        await adapter.sendTyping(chatId);
      },

      api: {
        async editMessageText(_chatId, _messageId, _text, _opts?) {
          // WhatsApp Cloud API doesn't support editing messages
        },
        async deleteMessage(_chatId, _messageId) {
          // WhatsApp message deletion is limited
        },
        async sendMessage(targetChatId, text, _opts?) {
          await adapter.send(String(targetChatId), { text });
        },
      },
    };
  }

  // ---- INTERNAL ----

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "X-API-Key": this.apiKey,
    };
  }

  private async kapsoPost(path: string, body: any): Promise<any> {
    const res = await fetch(`${KAPSO_BASE}/${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      console.error(`[whatsapp:${this.userId}] Kapso API error ${res.status}: ${errorText}`);
      return null;
    }
    return res.json().catch(() => null);
  }

  private async kapsoGet(path: string): Promise<any> {
    const res = await fetch(`${KAPSO_BASE}/${path}`, {
      method: "GET",
      headers: this.headers(),
    });
    if (!res.ok) return null;
    return res.json().catch(() => null);
  }

  private async downloadMedia(mediaId: string): Promise<Buffer> {
    // Step 1: Get media URL
    const meta = await this.kapsoGet(mediaId);
    if (!meta?.url) throw new Error(`Failed to get media URL for ${mediaId}`);

    // Step 2: Download the actual media
    const res = await fetch(meta.url, {
      headers: { "X-API-Key": this.apiKey },
    });
    if (!res.ok) throw new Error(`Failed to download media: ${res.status}`);
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  private async uploadMedia(buffer: Buffer | Uint8Array, mimeType: string, filename: string): Promise<string | null> {
    const formData = new FormData();
    formData.append("messaging_product", "whatsapp");
    formData.append("file", new Blob([buffer], { type: mimeType }), filename);

    const res = await fetch(`${KAPSO_BASE}/${this.phoneNumberId}/media`, {
      method: "POST",
      headers: { "X-API-Key": this.apiKey },
      body: formData,
    });
    if (!res.ok) {
      console.error(`[whatsapp:${this.userId}] Media upload failed: ${res.status}`);
      return null;
    }
    const data = await res.json() as any;
    return data.id || null;
  }

  private attachMeta(incoming: IncomingMessage, chatId: string, messageId: string, isGroup: boolean, senderPhone: string): void {
    const extra = incoming as any;
    extra._platformContext = this.createPlatformContext(chatId, messageId);
    extra._isGroup = isGroup;
    extra._senderPhone = senderPhone;
    extra._ownerUserId = this.userId;
  }
}
