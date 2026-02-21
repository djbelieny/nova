/**
 * Channel Registry
 *
 * Reads enabled channels from environment variables, instantiates adapters,
 * and provides a unified interface for relay.ts to manage all channels.
 */

import type { ChannelAdapter, MessageHandler, ButtonHandler } from "./types.ts";
import { TelegramAdapter } from "./telegram.ts";
import { WhatsAppAdapter } from "./whatsapp.ts";
import { SlackAdapter } from "./slack.ts";

export { TelegramAdapter } from "./telegram.ts";
export { WhatsAppAdapter } from "./whatsapp.ts";
export { SlackAdapter } from "./slack.ts";
export type {
  ChannelAdapter,
  IncomingMessage,
  OutgoingMessage,
  MessageHandler,
  ButtonHandler,
  ReplyFn,
  PlatformContext,
} from "./types.ts";

export class ChannelRegistry {
  private adapters: ChannelAdapter[] = [];
  private telegramAdapter: TelegramAdapter | null = null;

  /**
   * Initialize all enabled channel adapters based on environment variables.
   * Does NOT start them — call start() separately after registering handlers.
   */
  init(relayDir: string): void {
    // Telegram
    if (process.env.TELEGRAM_BOT_TOKEN) {
      this.telegramAdapter = new TelegramAdapter(process.env.TELEGRAM_BOT_TOKEN);
      this.adapters.push(this.telegramAdapter);
      console.log("[channels] Telegram adapter initialized");
    }

    // WhatsApp
    if (process.env.WHATSAPP_ENABLED === "true") {
      const wa = new WhatsAppAdapter(relayDir, {
        onQR: (qrImagePath) => {
          // Send QR code to Telegram so user can scan it
          if (this.telegramAdapter && process.env.TELEGRAM_USER_ID) {
            const chatId = process.env.TELEGRAM_USER_ID;
            this.telegramAdapter.sendFile(
              chatId,
              qrImagePath,
              "Scan this QR code with WhatsApp to link your device:\nSettings → Linked Devices → Link a Device",
            ).catch((err: any) => console.error("[channels] Failed to send WA QR to Telegram:", err));
          }
        },
      });
      this.adapters.push(wa);
      console.log("[channels] WhatsApp adapter initialized");
    }

    // Slack
    if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
      const slack = new SlackAdapter(
        process.env.SLACK_BOT_TOKEN,
        process.env.SLACK_APP_TOKEN,
      );
      this.adapters.push(slack);
      console.log("[channels] Slack adapter initialized");
    }
  }

  /** Get the Telegram adapter (for backward-compatible operations). */
  getTelegram(): TelegramAdapter | null {
    return this.telegramAdapter;
  }

  /** Get all registered adapters. */
  getAll(): ChannelAdapter[] {
    return this.adapters;
  }

  /** Get an adapter by channel type. */
  get(type: string): ChannelAdapter | undefined {
    return this.adapters.find((a) => a.type === type);
  }

  /** Register a message handler on ALL adapters. */
  onMessage(handler: MessageHandler): void {
    for (const adapter of this.adapters) {
      adapter.onMessage(handler);
    }
  }

  /** Register a button press handler on ALL adapters. */
  onButtonPress(handler: ButtonHandler): void {
    for (const adapter of this.adapters) {
      adapter.onButtonPress(handler);
    }
  }

  /** Start all adapters. */
  async startAll(): Promise<void> {
    const results = await Promise.allSettled(
      this.adapters.map((a) => a.start()),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const adapter = this.adapters[i];
      if (result.status === "rejected") {
        console.error(`[channels] Failed to start ${adapter.type}:`, result.reason);
      }
    }
  }

  /** Stop all adapters. */
  async stopAll(): Promise<void> {
    await Promise.allSettled(this.adapters.map((a) => a.stop()));
  }

  /** Get a status summary of all channels. */
  getStatus(): Array<[string, boolean]> {
    return [
      ["Telegram", !!this.telegramAdapter],
      ["WhatsApp", this.adapters.some((a) => a.type === "whatsapp")],
      ["Slack", this.adapters.some((a) => a.type === "slack")],
    ];
  }
}
