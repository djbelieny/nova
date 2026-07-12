/**
 * Telegram Channel Adapter
 *
 * Wraps grammY to implement the ChannelAdapter interface.
 * Handles all Telegram-specific I/O: message formatting, inline keyboards,
 * file delivery, voice notes, and typing indicators.
 */

import { Bot, Context, InputFile, InlineKeyboard } from "grammy";
import { stat } from "fs/promises";
import type {
  ChannelAdapter,
  IncomingMessage,
  OutgoingMessage,
  MessageHandler,
  ButtonHandler,
  ReplyFn,
  PlatformContext,
} from "./types.ts";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export class TelegramAdapter implements ChannelAdapter {
  readonly type = "telegram" as const;
  private bot: Bot;
  private token: string;
  private messageHandler: MessageHandler | null = null;
  private buttonHandler: ButtonHandler | null = null;
  private approvalHandler: ((data: string, ctx: Context) => Promise<void>) | null = null;

  constructor(token: string) {
    this.token = token;
    this.bot = new Bot(token);
  }

  /** Expose bot instance for backward-compatible operations (orchestrator, etc.) */
  getBot(): Bot {
    return this.bot;
  }

  /**
   * Apply grammY middleware. Call this before start() to register
   * middleware (like user resolution) that runs before message handlers.
   */
  use(middleware: (ctx: Context, next: () => Promise<void>) => Promise<void>): void {
    this.bot.use(middleware);
  }

  /**
   * Register the internal grammY handlers that convert messages to IncomingMessage.
   * Called by the channel registry after middleware is set up.
   */
  registerHandlers(): void {
    // Callback queries (inline button presses)
    this.bot.on("callback_query:data", async (ctx) => {
      const data = ctx.callbackQuery.data;
      const user = (ctx as any).novaUser;
      const chatId = ctx.chat?.id?.toString() || "";

      // Handle approval buttons directly — they need the raw grammY Context
      if (data.startsWith("apv:") && this.approvalHandler) {
        await this.approvalHandler(data, ctx);
        return;
      }

      if (!this.buttonHandler) return;

      const reply: ReplyFn = async (msg) => {
        await this.send(chatId, msg);
      };

      const editOriginal = async (newText: string) => {
        try {
          await ctx.editMessageText(newText, { reply_markup: undefined });
        } catch {}
      };

      this.buttonHandler(
        chatId,
        user?.id || "",
        ctx.from?.id?.toString() || "",
        data,
        reply,
        editOriginal,
      );
    });

    // Text messages
    this.bot.on("message:text", async (ctx) => {
      if (!this.messageHandler) return;
      const user = (ctx as any).novaUser;
      if (!user) return;

      const chatType = ctx.chat.type;
      const isGroup = chatType === "group" || chatType === "supergroup" || chatType === "channel";

      // Detect @mention — check entities for mention of this bot
      const botUsername = (ctx.me as any)?.username;
      const text = ctx.message.text || "";
      const isMentioned = botUsername
        ? text.toLowerCase().includes(`@${botUsername.toLowerCase()}`)
        : (ctx.message.entities || []).some((e: any) => e.type === "mention");

      const msg: IncomingMessage = {
        channelType: "telegram",
        channelMessageId: ctx.message.message_id.toString(),
        channelChatId: ctx.chat.id.toString(),
        userId: user.id,
        platformUserId: ctx.from?.id?.toString() || "",
        text: ctx.message.text,
        replyToMessageId: ctx.message.reply_to_message?.message_id?.toString(),
        isGroup,
        groupId: isGroup ? ctx.chat.id.toString() : undefined,
        isMentioned,
      };

      // Attach platform context for orchestrator compat
      const platformCtx = this.createPlatformContext(ctx);
      (msg as any)._platformContext = platformCtx;

      const reply: ReplyFn = async (outMsg) => {
        await this.send(msg.channelChatId, outMsg);
      };

      this.messageHandler(msg, reply);
    });

    // Voice messages
    this.bot.on("message:voice", async (ctx) => {
      if (!this.messageHandler) return;
      const user = (ctx as any).novaUser;
      if (!user) return;

      try {
        const voice = ctx.message.voice;
        const file = await ctx.getFile();
        const url = `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;
        const response = await fetch(url);
        const buffer = Buffer.from(await response.arrayBuffer());

        const msg: IncomingMessage = {
          channelType: "telegram",
          channelMessageId: ctx.message.message_id.toString(),
          channelChatId: ctx.chat.id.toString(),
          userId: user.id,
          platformUserId: ctx.from?.id?.toString() || "",
          voice: { buffer, durationSec: voice.duration },
          replyToMessageId: ctx.message.reply_to_message?.message_id?.toString(),
        };

        const platformCtx = this.createPlatformContext(ctx);
        (msg as any)._platformContext = platformCtx;

        const reply: ReplyFn = async (outMsg) => {
          await this.send(msg.channelChatId, outMsg);
        };

        this.messageHandler(msg, reply);
      } catch (error) {
        console.error("[telegram] Voice download error:", error);
      }
    });

    // Photos
    this.bot.on("message:photo", async (ctx) => {
      if (!this.messageHandler) return;
      const user = (ctx as any).novaUser;
      if (!user) return;

      try {
        const photos = ctx.message.photo;
        const photo = photos[photos.length - 1];
        const file = await ctx.api.getFile(photo.file_id);
        const url = `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;
        const response = await fetch(url);
        const buffer = Buffer.from(await response.arrayBuffer());

        const msg: IncomingMessage = {
          channelType: "telegram",
          channelMessageId: ctx.message.message_id.toString(),
          channelChatId: ctx.chat.id.toString(),
          userId: user.id,
          platformUserId: ctx.from?.id?.toString() || "",
          image: { buffer, caption: ctx.message.caption || undefined },
          replyToMessageId: ctx.message.reply_to_message?.message_id?.toString(),
        };

        const platformCtx = this.createPlatformContext(ctx);
        (msg as any)._platformContext = platformCtx;

        const reply: ReplyFn = async (outMsg) => {
          await this.send(msg.channelChatId, outMsg);
        };

        this.messageHandler(msg, reply);
      } catch (error) {
        console.error("[telegram] Photo download error:", error);
      }
    });

    // Documents
    this.bot.on("message:document", async (ctx) => {
      if (!this.messageHandler) return;
      const user = (ctx as any).novaUser;
      if (!user) return;

      try {
        const doc = ctx.message.document;
        const file = await ctx.getFile();
        const url = `https://api.telegram.org/file/bot${this.token}/${file.file_path}`;
        const response = await fetch(url);
        const buffer = Buffer.from(await response.arrayBuffer());

        const msg: IncomingMessage = {
          channelType: "telegram",
          channelMessageId: ctx.message.message_id.toString(),
          channelChatId: ctx.chat.id.toString(),
          userId: user.id,
          platformUserId: ctx.from?.id?.toString() || "",
          document: {
            buffer,
            filename: doc.file_name || `file_${Date.now()}`,
            caption: ctx.message.caption || undefined,
          },
          replyToMessageId: ctx.message.reply_to_message?.message_id?.toString(),
        };

        const platformCtx = this.createPlatformContext(ctx);
        (msg as any)._platformContext = platformCtx;

        const reply: ReplyFn = async (outMsg) => {
          await this.send(msg.channelChatId, outMsg);
        };

        this.messageHandler(msg, reply);
      } catch (error) {
        console.error("[telegram] Document download error:", error);
      }
    });
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onButtonPress(handler: ButtonHandler): void {
    this.buttonHandler = handler;
  }

  /**
   * Register a handler for approval button callbacks (apv:ID:action).
   * This receives the raw grammY Context for backward compatibility with the orchestrator.
   */
  onApproval(handler: (data: string, ctx: Context) => Promise<void>): void {
    this.approvalHandler = handler;
  }

  async start(): Promise<void> {
    this.registerHandlers();
    // Don't await — grammy's bot.start() never resolves (it runs the polling loop)
    this.bot.start({
      onStart: () => {
        console.log("[telegram] Bot started via adapter");
      },
    });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  async send(chatId: string, message: string | OutgoingMessage): Promise<void> {
    const normalizedMsg: OutgoingMessage = typeof message === "string" ? { text: message } : message;
    const numericChatId = Number(chatId);

    // Send files first
    if (normalizedMsg.files) {
      for (const file of normalizedMsg.files) {
        await this.sendFile(chatId, file.path, file.caption);
      }
    }

    // Send voice
    if (normalizedMsg.voice) {
      await this.bot.api.sendVoice(numericChatId, new InputFile(normalizedMsg.voice, "response.ogg"));
    }

    // Build keyboard if buttons provided
    let keyboard: InlineKeyboard | undefined;
    if (normalizedMsg.buttons?.length) {
      keyboard = new InlineKeyboard();
      for (let i = 0; i < normalizedMsg.buttons.length; i++) {
        const btn = normalizedMsg.buttons[i];
        keyboard.text(btn.label, btn.callbackData);
        if ((i + 1) % 3 === 0 && i < normalizedMsg.buttons.length - 1) {
          keyboard.row();
        }
      }
    }

    // Send text
    const text = normalizedMsg.html || normalizedMsg.text;
    if (text) {
      const parseMode = normalizedMsg.html ? "HTML" as const : undefined;
      const MAX_LENGTH = 4000;

      if (text.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(numericChatId, text, {
          parse_mode: parseMode,
          reply_markup: keyboard,
        }).catch(async () => {
          // Fallback without parse_mode
          await this.bot.api.sendMessage(numericChatId, normalizedMsg.text || text, {
            reply_markup: keyboard,
          });
        });
      } else {
        // Split long messages
        const chunks: string[] = [];
        let remaining = text;
        while (remaining.length > 0) {
          if (remaining.length <= MAX_LENGTH) {
            chunks.push(remaining);
            break;
          }
          let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
          if (splitIndex === -1 || splitIndex < MAX_LENGTH / 2) {
            splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
          }
          if (splitIndex === -1 || splitIndex < MAX_LENGTH / 2) {
            splitIndex = MAX_LENGTH;
          }
          chunks.push(remaining.substring(0, splitIndex));
          remaining = remaining.substring(splitIndex).trim();
        }

        for (let i = 0; i < chunks.length; i++) {
          const isLast = i === chunks.length - 1;
          await this.bot.api.sendMessage(numericChatId, chunks[i], {
            parse_mode: parseMode,
            reply_markup: isLast ? keyboard : undefined,
          }).catch(async () => {
            await this.bot.api.sendMessage(numericChatId, chunks[i], {
              reply_markup: isLast ? keyboard : undefined,
            });
          });
        }
      }
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    try {
      await this.bot.api.sendChatAction(Number(chatId), "typing");
    } catch {}
  }

  async sendFile(chatId: string, filePath: string, caption?: string): Promise<void> {
    try {
      await stat(filePath);
    } catch {
      console.warn(`[telegram] File not found: ${filePath}`);
      return;
    }

    const ext = filePath.substring(filePath.lastIndexOf(".")).toLowerCase();
    const inputFile = new InputFile(filePath);
    const numericChatId = Number(chatId);

    try {
      if (IMAGE_EXTENSIONS.has(ext)) {
        await this.bot.api.sendPhoto(numericChatId, inputFile, {
          caption: caption || undefined,
        });
      } else {
        await this.bot.api.sendDocument(numericChatId, inputFile, {
          caption: caption || undefined,
        });
      }
      console.log(`[telegram] Sent file: ${filePath}`);
    } catch (error) {
      console.error(`[telegram] Failed to send ${filePath}:`, error);
    }
  }

  /**
   * Create a PlatformContext from a grammY Context.
   * This provides backward compatibility with code that expects ctx.reply(), ctx.api.*, etc.
   */
  createPlatformContext(ctx: Context): PlatformContext {
    const adapter = this;
    return {
      adapter,
      chat: { id: ctx.chat?.id || 0 },
      channelType: "telegram",
      novaUser: (ctx as any).novaUser,
      novaReplyTo: ctx.message?.message_id,

      async reply(text: string, opts?: any) {
        const result = await ctx.reply(text, opts);
        return { message_id: result.message_id };
      },

      async replyWithChatAction(action: string) {
        await ctx.replyWithChatAction(action as any);
      },

      async replyWithVoice(file: any) {
        await ctx.replyWithVoice(file);
      },

      async answerCallbackQuery(opts?: any) {
        await ctx.answerCallbackQuery(opts);
      },

      async editMessageText(text: string, opts?: any) {
        await ctx.editMessageText(text, opts);
      },

      callbackQuery: ctx.callbackQuery ? {
        data: (ctx.callbackQuery as any).data,
        message: ctx.callbackQuery.message ? {
          text: (ctx.callbackQuery.message as any).text,
        } : undefined,
      } : undefined,

      api: {
        async editMessageText(chatId: string | number, messageId: number | string, text: string, opts?: any) {
          await ctx.api.editMessageText(Number(chatId), Number(messageId), text, opts);
        },
        async deleteMessage(chatId: string | number, messageId: number | string) {
          await ctx.api.deleteMessage(Number(chatId), Number(messageId));
        },
        async sendMessage(chatId: string | number, text: string, opts?: any) {
          await ctx.api.sendMessage(Number(chatId), text, opts);
        },
      },

      _raw: ctx,
    };
  }

  /**
   * Register the Mini App menu button (if URL configured).
   */
  async setMenuButton(url: string): Promise<void> {
    try {
      await this.bot.api.setChatMenuButton({
        menu_button: { type: "web_app", text: "Nova App", web_app: { url } },
      });
      console.log(`[telegram] Mini App menu button registered: ${url}`);
    } catch (err: any) {
      console.warn(`[telegram] Could not set Mini App menu button: ${err.message}`);
    }
  }

  /**
   * Send startup notification to admin users.
   */
  async notifyAdmins(adminTelegramIds: string[], message: string): Promise<void> {
    for (const id of adminTelegramIds) {
      this.bot.api.sendMessage(Number(id), message).catch(() => {});
    }
  }
}

// ============================================================
// TELEGRAM FORMATTING UTILITIES
// ============================================================

/**
 * Convert Markdown to Telegram-compatible HTML.
 * Telegram supports: <b>, <i>, <u>, <s>, <code>, <pre>, <a href="">, <blockquote>
 */
export function markdownToTelegramHTML(text: string): string {
  let html = text;

  // Escape HTML entities first
  html = html
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    return `<pre>${code.trim()}</pre>`;
  });

  // Inline code (`...`)
  html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");

  // Headings -> bold
  html = html.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Bold+italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>");

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  html = html.replace(/__(.+?)__/g, "<b>$1</b>");

  // Italic
  html = html.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, "<i>$1</i>");
  html = html.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "<i>$1</i>");

  // Strikethrough
  html = html.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Blockquotes
  html = html.replace(/^&gt;\s?(.+)$/gm, "<blockquote>$1</blockquote>");
  html = html.replace(/<\/blockquote>\n<blockquote>/g, "\n");

  // Horizontal rules
  html = html.replace(/^[-*_]{3,}$/gm, "");

  return html.trim();
}

/**
 * Parse inline button markup from Claude's response.
 * Format: [BUTTONS: Label 1 | Label 2 | Label 3]
 */
export function parseButtons(response: string): {
  text: string;
  buttons: Array<{ label: string; callbackData: string }> | null;
} {
  const buttonPattern = /\[BUTTONS:\s*(.+?)\]/g;
  let buttons: Array<{ label: string; callbackData: string }> | null = null;
  let text = response;

  const matches = [...response.matchAll(buttonPattern)];
  if (matches.length > 0) {
    const match = matches[matches.length - 1];
    const labels = match[1].split("|").map((l) => l.trim()).filter(Boolean);

    if (labels.length > 0) {
      buttons = labels.map((label) => ({
        label,
        callbackData: `btn:${label}`,
      }));
    }

    text = response.replace(buttonPattern, "").trim();
  }

  return { text, buttons };
}

/**
 * Strip internal artifacts from Claude's response before sending to user.
 */
export function cleanResponseForUser(response: string): string {
  let cleaned = response;

  cleaned = cleaned.replace(/\[ARTIFACT:\s*[^\]]+\]/g, "");
  cleaned = cleaned.replace(/\[TASK(?:_\w+)?:\s*[^\]]+\]/g, "");
  cleaned = cleaned.replace(/\[SCHEDULE(?:_CANCEL)?:\s*[^\]]+\]/g, "");
  cleaned = cleaned.replace(/^.*(?:Running|Executing|Invoking|Loading skill|Tool call|bash:).*$/gm, "");
  cleaned = cleaned.replace(/^\/(?:tmp|Users|var|home)\/\S+\s*$/gm, "");
  cleaned = cleaned.replace(/^.*(?:scripts\/generate_image\.py|send_telegram_file\.sh|\.claude\/skills\/).*$/gm, "");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

  return cleaned.trim();
}
