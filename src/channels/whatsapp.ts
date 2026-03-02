/**
 * WhatsApp Channel Adapter — Per-User Sessions
 *
 * Uses @whiskeysockets/baileys (unofficial WhatsApp Web API) to connect
 * to WhatsApp. Each user gets their own session with auth stored in
 * ~/.nova/users/{userId}/wa-auth/.
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
} from "@whiskeysockets/baileys";
import { SocksProxyAgent } from "socks-proxy-agent";
import QRCode from "qrcode";
import { mkdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import type {
  ChannelAdapter,
  IncomingMessage,
  OutgoingMessage,
  MessageHandler,
  ButtonHandler,
  ReplyFn,
  PlatformContext,
} from "./types.ts";

export type ConnectionState = "disconnected" | "qr_pending" | "pairing_code" | "connected";

export interface WhatsAppStatus {
  state: ConnectionState;
  qrDataUrl: string | null;
  pairingCode: string | null;
  phoneNumber: string | null;
}

export class WhatsAppAdapter implements ChannelAdapter {
  readonly type = "whatsapp" as const;
  private sock: WASocket | null = null;
  private messageHandler: MessageHandler | null = null;
  private buttonHandler: ButtonHandler | null = null;
  private authDir: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private stopping = false;
  readonly userId: string;

  /** Current QR code as base64 data URL for Mini App display */
  qrDataUrl: string | null = null;

  /** Pairing code for phone number linking */
  pairingCode: string | null = null;

  /** Phone number to pair with (for pairing code flow) */
  pairPhoneNumber: string | null = null;

  /** Current connection state */
  connectionState: ConnectionState = "disconnected";

  /** Connected phone number (e.g., "15551234567") */
  phoneNumber: string | null = null;

  constructor(userId: string, authDir: string) {
    this.userId = userId;
    this.authDir = authDir;
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
      qrDataUrl: this.qrDataUrl,
      pairingCode: this.pairingCode,
      phoneNumber: this.phoneNumber,
    };
  }

  /** Check if auth credentials exist on disk (for session restore). */
  hasAuthCredentials(): boolean {
    return existsSync(join(this.authDir, "creds.json"));
  }

  async start(pairPhone?: string): Promise<void> {
    await mkdir(this.authDir, { recursive: true });
    if (pairPhone) {
      this.pairPhoneNumber = pairPhone.replace(/[^0-9]/g, "");
    }
    await this.connect();
  }

  private async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

    const proxyUrl = process.env.WHATSAPP_PROXY;
    const agent = proxyUrl ? new SocksProxyAgent(proxyUrl) : undefined;
    console.log(`[whatsapp:${this.userId}] Connecting${proxyUrl ? ` via proxy ${proxyUrl}` : ' directly'}`);

    this.sock = makeWASocket({
      auth: state,
      agent,
      fetchAgent: agent,
    });

    this.sock.ev.on("creds.update", saveCreds);

    // Request pairing code if phone number provided (instead of QR)
    if (this.pairPhoneNumber && !this.hasAuthCredentials()) {
      // Wait for connection to be ready before requesting code
      setTimeout(async () => {
        try {
          const code = await this.sock!.requestPairingCode(this.pairPhoneNumber!);
          this.pairingCode = code;
          this.connectionState = "pairing_code";
          console.log(`[whatsapp:${this.userId}] Pairing code: ${code}`);
        } catch (err: any) {
          console.error(`[whatsapp:${this.userId}] Pairing code request failed:`, err.message);
        }
      }, 3000);
    }

    this.sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !this.pairPhoneNumber) {
        console.log(`[whatsapp:${this.userId}] QR code received`);
        try {
          this.qrDataUrl = await QRCode.toDataURL(qr, { width: 512, margin: 2 });
          this.connectionState = "qr_pending";
        } catch (err) {
          console.error(`[whatsapp:${this.userId}] QR generation error:`, err);
        }
      }

      if (connection === "close") {
        this.connectionState = "disconnected";
        this.qrDataUrl = null;
        this.pairingCode = null;

        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (shouldReconnect && !this.stopping) {
          this.reconnectAttempts++;
          if (this.reconnectAttempts <= this.maxReconnectAttempts) {
            const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 60000);
            console.log(`[whatsapp:${this.userId}] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})`);
            setTimeout(() => this.connect(), delay);
          } else {
            console.error(`[whatsapp:${this.userId}] Max reconnect attempts reached`);
          }
        } else if (statusCode === DisconnectReason.loggedOut) {
          console.log(`[whatsapp:${this.userId}] Logged out`);
        }
      }

      if (connection === "open") {
        this.reconnectAttempts = 0;
        this.connectionState = "connected";
        this.qrDataUrl = null;
        this.pairingCode = null;
        this.pairPhoneNumber = null;

        // Extract phone number from connection info
        const me = this.sock?.user;
        if (me?.id) {
          this.phoneNumber = me.id.split(":")[0] || me.id.split("@")[0];
        }
        console.log(`[whatsapp:${this.userId}] Connected (phone: ${this.phoneNumber})`);
      }
    });

    // Message handling
    this.sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;

        const jid = msg.key.remoteJid;
        if (!jid || jid === "status@broadcast") continue;

        const isGroup = jid.endsWith("@g.us");
        // For group messages, the sender is msg.key.participant
        // For DMs, the sender is the JID itself
        const senderJid = isGroup ? (msg.key.participant || "") : jid;
        const senderPhone = senderJid.split("@")[0].split(":")[0];

        try {
          await this.handleIncomingMessage(msg, jid, senderPhone, isGroup);
        } catch (error) {
          console.error(`[whatsapp:${this.userId}] Message handling error:`, error);
        }
      }
    });
  }

  private async handleIncomingMessage(
    msg: any,
    jid: string,
    senderPhone: string,
    isGroup: boolean,
  ): Promise<void> {
    if (!this.messageHandler) return;

    const messageContent = msg.message;
    const messageId = msg.key.id || "";

    // Extract text
    const text = messageContent.conversation
      || messageContent.extendedTextMessage?.text;

    if (text) {
      // Check if this is a numbered list response (button emulation)
      const numberMatch = text.match(/^(\d+)$/);
      if (numberMatch && this.buttonHandler) {
        this.buttonHandler(
          jid,
          "",
          senderPhone,
          `btn_num:${numberMatch[1]}`,
          async (outMsg) => { await this.send(jid, outMsg); },
        );
        return;
      }

      const incoming: IncomingMessage = {
        channelType: "whatsapp",
        channelMessageId: messageId,
        channelChatId: jid,
        userId: "",
        platformUserId: senderPhone,
        text,
      };

      // Attach extra metadata for the manager's classification pipeline
      const extra = incoming as any;
      extra._platformContext = this.createPlatformContext(jid, messageId);
      extra._isGroup = isGroup;
      extra._senderPhone = senderPhone;
      extra._ownerUserId = this.userId;

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
          platformUserId: senderPhone,
          voice: { buffer: Buffer.from(buffer as any), durationSec: duration },
        };

        const extra = incoming as any;
        extra._platformContext = this.createPlatformContext(jid, messageId);
        extra._isGroup = isGroup;
        extra._senderPhone = senderPhone;
        extra._ownerUserId = this.userId;

        this.messageHandler(incoming, async (outMsg) => {
          await this.send(jid, outMsg);
        });
      } catch (error) {
        console.error(`[whatsapp:${this.userId}] Voice download error:`, error);
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
          platformUserId: senderPhone,
          image: { buffer: Buffer.from(buffer as any), caption },
        };

        const extra = incoming as any;
        extra._platformContext = this.createPlatformContext(jid, messageId);
        extra._isGroup = isGroup;
        extra._senderPhone = senderPhone;
        extra._ownerUserId = this.userId;

        this.messageHandler(incoming, async (outMsg) => {
          await this.send(jid, outMsg);
        });
      } catch (error) {
        console.error(`[whatsapp:${this.userId}] Image download error:`, error);
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
          platformUserId: senderPhone,
          document: { buffer: Buffer.from(buffer as any), filename, caption },
        };

        const extra = incoming as any;
        extra._platformContext = this.createPlatformContext(jid, messageId);
        extra._isGroup = isGroup;
        extra._senderPhone = senderPhone;
        extra._ownerUserId = this.userId;

        this.messageHandler(incoming, async (outMsg) => {
          await this.send(jid, outMsg);
        });
      } catch (error) {
        console.error(`[whatsapp:${this.userId}] Document download error:`, error);
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
      console.log(`[whatsapp:${this.userId}] Sent file: ${filePath}`);
    } catch (error) {
      console.error(`[whatsapp:${this.userId}] Failed to send file ${filePath}:`, error);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
    this.connectionState = "disconnected";
    this.qrDataUrl = null;
    this.phoneNumber = null;
  }

  createPlatformContext(chatId: string, messageId?: string): PlatformContext {
    const adapter = this;
    let lastMessageId = 0;

    return {
      adapter,
      chat: { id: chatId },
      channelType: "whatsapp",

      async reply(text: string, opts?: any) {
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
          // WhatsApp doesn't support editing messages
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
}
