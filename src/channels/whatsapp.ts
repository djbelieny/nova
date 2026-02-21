/**
 * WhatsApp Channel Adapter
 *
 * Uses @whiskeysockets/baileys (unofficial WhatsApp Web API) to connect
 * to WhatsApp. Auth is QR-code based on first run; session persists to disk.
 *
 * Limitations:
 * - Baileys is unofficial — WhatsApp could break it with protocol changes
 * - No inline buttons — uses numbered list menus for approvals
 * - Stricter rate limits than Telegram
 * - Voice notes come as .ogg (same as Telegram, existing transcription works)
 */

import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  type WASocket,
  type BaileysEventMap,
} from "@whiskeysockets/baileys";
import { mkdir } from "fs/promises";
import { join } from "path";
import type {
  ChannelAdapter,
  IncomingMessage,
  OutgoingMessage,
  MessageHandler,
  ButtonHandler,
  ReplyFn,
  PlatformContext,
} from "./types.ts";

const AUTH_DIR_NAME = "whatsapp-auth";

export class WhatsAppAdapter implements ChannelAdapter {
  readonly type = "whatsapp" as const;
  private sock: WASocket | null = null;
  private messageHandler: MessageHandler | null = null;
  private buttonHandler: ButtonHandler | null = null;
  private authDir: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private stopping = false;

  constructor(relayDir: string) {
    this.authDir = join(relayDir, AUTH_DIR_NAME);
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onButtonPress(handler: ButtonHandler): void {
    this.buttonHandler = handler;
  }

  async start(): Promise<void> {
    await mkdir(this.authDir, { recursive: true });
    await this.connect();
  }

  private async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

    this.sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
    });

    // Save credentials on update
    this.sock.ev.on("creds.update", saveCreds);

    // Connection updates (QR code, reconnection)
    this.sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("[whatsapp] Scan the QR code above with your WhatsApp app");
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (shouldReconnect && !this.stopping) {
          this.reconnectAttempts++;
          if (this.reconnectAttempts <= this.maxReconnectAttempts) {
            const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 60000);
            console.log(`[whatsapp] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})`);
            setTimeout(() => this.connect(), delay);
          } else {
            console.error("[whatsapp] Max reconnect attempts reached");
          }
        } else if (statusCode === DisconnectReason.loggedOut) {
          console.log("[whatsapp] Logged out — delete auth folder and restart to re-pair");
        }
      }

      if (connection === "open") {
        this.reconnectAttempts = 0;
        console.log("[whatsapp] Connected successfully");
      }
    });

    // Message handling
    this.sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;

        const jid = msg.key.remoteJid;
        if (!jid || jid === "status@broadcast") continue;

        // Extract phone number from JID (e.g., "1234567890@s.whatsapp.net")
        const platformUserId = jid.split("@")[0];

        try {
          await this.handleIncomingMessage(msg, jid, platformUserId);
        } catch (error) {
          console.error("[whatsapp] Message handling error:", error);
        }
      }
    });
  }

  private async handleIncomingMessage(
    msg: any,
    jid: string,
    platformUserId: string,
  ): Promise<void> {
    if (!this.messageHandler) return;

    const messageContent = msg.message;
    const messageId = msg.key.id || "";

    // Text message
    const text = messageContent.conversation
      || messageContent.extendedTextMessage?.text;

    if (text) {
      // Check if this is a numbered list response (button emulation)
      const numberMatch = text.match(/^(\d+)$/);
      if (numberMatch && this.buttonHandler) {
        this.buttonHandler(
          jid,
          "", // userId resolved by relay
          platformUserId,
          `btn_num:${numberMatch[1]}`,
          async (outMsg) => { await this.send(jid, outMsg); },
        );
        return;
      }

      const incoming: IncomingMessage = {
        channelType: "whatsapp",
        channelMessageId: messageId,
        channelChatId: jid,
        userId: "", // resolved by relay.ts
        platformUserId,
        text,
      };

      const platformCtx = this.createPlatformContext(jid, messageId);
      (incoming as any)._platformContext = platformCtx;

      this.messageHandler(incoming, async (outMsg) => {
        await this.send(jid, outMsg);
      });
      return;
    }

    // Voice message
    if (messageContent.audioMessage) {
      try {
        const buffer = await downloadMediaMessage(msg, "buffer", {});
        const duration = messageContent.audioMessage.seconds || 0;

        const incoming: IncomingMessage = {
          channelType: "whatsapp",
          channelMessageId: messageId,
          channelChatId: jid,
          userId: "",
          platformUserId,
          voice: { buffer: Buffer.from(buffer as any), durationSec: duration },
        };

        const platformCtx = this.createPlatformContext(jid, messageId);
        (incoming as any)._platformContext = platformCtx;

        this.messageHandler(incoming, async (outMsg) => {
          await this.send(jid, outMsg);
        });
      } catch (error) {
        console.error("[whatsapp] Voice download error:", error);
      }
      return;
    }

    // Image message
    if (messageContent.imageMessage) {
      try {
        const buffer = await downloadMediaMessage(msg, "buffer", {});
        const caption = messageContent.imageMessage.caption || undefined;

        const incoming: IncomingMessage = {
          channelType: "whatsapp",
          channelMessageId: messageId,
          channelChatId: jid,
          userId: "",
          platformUserId,
          image: { buffer: Buffer.from(buffer as any), caption },
        };

        const platformCtx = this.createPlatformContext(jid, messageId);
        (incoming as any)._platformContext = platformCtx;

        this.messageHandler(incoming, async (outMsg) => {
          await this.send(jid, outMsg);
        });
      } catch (error) {
        console.error("[whatsapp] Image download error:", error);
      }
      return;
    }

    // Document message
    if (messageContent.documentMessage) {
      try {
        const buffer = await downloadMediaMessage(msg, "buffer", {});
        const filename = messageContent.documentMessage.fileName || `file_${Date.now()}`;
        const caption = messageContent.documentMessage.caption || undefined;

        const incoming: IncomingMessage = {
          channelType: "whatsapp",
          channelMessageId: messageId,
          channelChatId: jid,
          userId: "",
          platformUserId,
          document: { buffer: Buffer.from(buffer as any), filename, caption },
        };

        const platformCtx = this.createPlatformContext(jid, messageId);
        (incoming as any)._platformContext = platformCtx;

        this.messageHandler(incoming, async (outMsg) => {
          await this.send(jid, outMsg);
        });
      } catch (error) {
        console.error("[whatsapp] Document download error:", error);
      }
    }
  }

  async send(chatId: string, message: OutgoingMessage): Promise<void> {
    if (!this.sock) return;

    // Send files
    if (message.files) {
      for (const file of message.files) {
        await this.sendFile(chatId, file.path, file.caption);
      }
    }

    // Send voice
    if (message.voice) {
      await this.sock.sendMessage(chatId, {
        audio: message.voice,
        mimetype: "audio/ogg; codecs=opus",
        ptt: true,
      });
    }

    // Build text with numbered options if buttons provided
    let text = message.text || "";
    if (message.buttons?.length) {
      text += "\n\nReply with a number:";
      message.buttons.forEach((btn, i) => {
        text += `\n${i + 1}. ${btn.label}`;
      });
    }

    // Send text
    if (text) {
      await this.sock.sendMessage(chatId, { text });
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    if (!this.sock) return;
    try {
      await this.sock.presenceSubscribe(chatId);
      await this.sock.sendPresenceUpdate("composing", chatId);
    } catch {}
  }

  async sendFile(chatId: string, filePath: string, caption?: string): Promise<void> {
    if (!this.sock) return;

    const { readFile } = await import("fs/promises");
    try {
      const buffer = await readFile(filePath);
      const ext = filePath.substring(filePath.lastIndexOf(".")).toLowerCase();
      const imageExts = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

      if (imageExts.has(ext)) {
        await this.sock.sendMessage(chatId, {
          image: buffer,
          caption: caption || undefined,
        });
      } else {
        const filename = filePath.split("/").pop() || "file";
        await this.sock.sendMessage(chatId, {
          document: buffer,
          mimetype: "application/octet-stream",
          fileName: filename,
          caption: caption || undefined,
        });
      }
      console.log(`[whatsapp] Sent file: ${filePath}`);
    } catch (error) {
      console.error(`[whatsapp] Failed to send file ${filePath}:`, error);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
  }

  /**
   * Create a PlatformContext for WhatsApp messages.
   * Provides the ctx-like API that the orchestrator expects.
   */
  createPlatformContext(chatId: string, messageId?: string): PlatformContext {
    const adapter = this;
    let lastMessageId = 0;

    return {
      adapter,
      chat: { id: chatId },
      channelType: "whatsapp",

      async reply(text: string, opts?: any) {
        // Strip HTML tags for WhatsApp (it doesn't support HTML)
        const cleanText = text.replace(/<[^>]+>/g, "");
        await adapter.send(chatId, {
          text: cleanText,
          buttons: opts?.reply_markup ? undefined : undefined,
        });
        lastMessageId++;
        return { message_id: lastMessageId };
      },

      async replyWithChatAction(_action: string) {
        await adapter.sendTyping(chatId);
      },

      api: {
        async editMessageText(_chatId, _messageId, _text, _opts?) {
          // WhatsApp doesn't support editing messages — no-op
        },
        async deleteMessage(_chatId, _messageId) {
          // WhatsApp message deletion is limited — no-op
        },
        async sendMessage(targetChatId, text, _opts?) {
          await adapter.send(String(targetChatId), { text });
        },
      },
    };
  }
}
