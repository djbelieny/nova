/**
 * Public Telegram CS Bot Adapter
 *
 * A second Telegram bot instance dedicated to public customer service.
 * Uses CS_TELEGRAM_BOT_TOKEN (separate from the private Nova bot).
 *
 * Hard wall: MUST NOT import from relay.ts, orchestrator.ts, or memory.ts.
 */

import { Bot } from "grammy";
import { handleCsMessage, sendGreeting } from "../cs-orchestrator.ts";
import { logError } from "../error-handler.ts";

class CsTelegramAdapter {
  private bot: Bot;
  private notifyOwner: (text: string) => Promise<void>;

  constructor(notifyOwner: (text: string) => Promise<void>) {
    const token = process.env.CS_TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error("[cs-telegram] CS_TELEGRAM_BOT_TOKEN is not set");

    this.bot = new Bot(token);
    this.notifyOwner = notifyOwner;
  }

  start(): void {
    this.registerHandlers();
    // Non-blocking — grammY's polling loop never resolves
    this.bot.start({
      onStart: () => console.log("[cs-telegram] Public CS bot started"),
    });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  private registerHandlers(): void {
    // /start command — send greeting
    this.bot.command("start", async (ctx) => {
      const chatId = ctx.chat.id.toString();
      const channelSessionId = `tg_${chatId}`;

      const sendToCustomer = async (text: string) => {
        await ctx.reply(text, { parse_mode: "HTML" }).catch((err) =>
          logError(err, "cs-telegram.start-reply")
        );
      };

      try {
        await sendGreeting("telegram", channelSessionId, sendToCustomer);
      } catch (err) {
        logError(err, "cs-telegram.start-command");
        await ctx.reply("Hi! How can I help you today?").catch(() => {});
      }
    });

    // All text messages → CS pipeline
    this.bot.on("message:text", async (ctx) => {
      const chatId = ctx.chat.id.toString();
      const channelSessionId = `tg_${chatId}`;
      const platformUserId = ctx.from?.id?.toString() ?? chatId;
      const rawMessage = ctx.message.text ?? "";

      const sendToCustomer = async (text: string) => {
        await ctx.reply(text, { parse_mode: "HTML" }).catch((err) =>
          logError(err, "cs-telegram.send")
        );
      };

      try {
        await handleCsMessage(
          "telegram",
          channelSessionId,
          rawMessage,
          platformUserId,
          sendToCustomer,
          this.notifyOwner
        );
      } catch (err) {
        logError(err, "cs-telegram.message");
        await ctx
          .reply("Something went wrong. Please try again in a moment.")
          .catch(() => {});
      }
    });

    // Catch-all error handler
    this.bot.catch((err) => {
      logError(err, "cs-telegram.bot-error");
    });
  }

  /**
   * Send a message to a specific chat by ID (used for owner reply-to-escalate forwarding).
   */
  async sendMessage(chatId: string, text: string): Promise<void> {
    try {
      await this.bot.api.sendMessage(Number(chatId), text);
    } catch (err) {
      logError(err, "cs-telegram.sendMessage");
    }
  }
}

export function startCsTelegramBot(
  notifyOwner: (text: string) => Promise<void>
): void {
  const adapter = new CsTelegramAdapter(notifyOwner);
  adapter.start();
}
