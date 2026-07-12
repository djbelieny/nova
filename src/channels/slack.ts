/**
 * Slack Channel Adapter
 *
 * Uses @slack/bolt with Socket Mode (WebSocket — no public URL needed).
 * Responds to DMs and @mentions in channels.
 *
 * Slack-specific considerations:
 * - Buttons work natively via Block Kit actions
 * - File delivery uses files.uploadV2 API
 * - Messages > 4000 chars need splitting
 * - Uses mrkdwn (similar to Markdown with quirks like *bold* instead of **bold**)
 * - Thread replies: responds in the same thread as the user's message
 */

import { App } from "@slack/bolt";
import { readFile, stat } from "fs/promises";
import { basename } from "path";
import type {
  ChannelAdapter,
  IncomingMessage,
  OutgoingMessage,
  MessageHandler,
  ButtonHandler,
  ReplyFn,
  PlatformContext,
} from "./types.ts";

export class SlackAdapter implements ChannelAdapter {
  readonly type = "slack" as const;
  private app: App;
  private messageHandler: MessageHandler | null = null;
  private buttonHandler: ButtonHandler | null = null;

  constructor(botToken: string, appToken: string) {
    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
    });
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onButtonPress(handler: ButtonHandler): void {
    this.buttonHandler = handler;
  }

  async start(): Promise<void> {
    this.registerHandlers();
    await this.app.start();
    console.log("[slack] Bot started (Socket Mode)");
  }

  private registerHandlers(): void {
    // DM messages
    this.app.message(async ({ message, say }) => {
      if (!this.messageHandler) return;
      // Skip bot messages and edited messages
      if ((message as any).bot_id || (message as any).subtype) return;

      const msg = message as any;
      const slackUserId = msg.user || "";
      const channelId = msg.channel || "";
      const threadTs = msg.thread_ts || msg.ts;

      // Detect if this is a channel (group) or DM
      // Slack channel IDs: C = public channel, G = private channel/group, D = DM
      const isGroup = channelId.startsWith("C") || channelId.startsWith("G");
      // Check for @mention in text
      const isMentioned = /nova|<@/i.test(msg.text || "");

      const incoming: IncomingMessage = {
        channelType: "slack",
        channelMessageId: msg.ts || "",
        channelChatId: channelId,
        userId: "", // resolved by relay.ts
        platformUserId: slackUserId,
        text: msg.text || "",
        isGroup,
        groupId: isGroup ? channelId : undefined,
        isMentioned,
      };

      const platformCtx = this.createPlatformContext(channelId, threadTs);
      (incoming as any)._platformContext = platformCtx;

      this.messageHandler(incoming, async (outMsg) => {
        await this.sendInThread(channelId, threadTs, outMsg);
      });
    });

    // @mention in channels
    this.app.event("app_mention", async ({ event, say }) => {
      if (!this.messageHandler) return;

      const slackUserId = event.user || "";
      const channelId = event.channel || "";
      const threadTs = event.thread_ts || event.ts;
      // Remove the @mention from the text
      const text = (event.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();

      const incoming: IncomingMessage = {
        channelType: "slack",
        channelMessageId: event.ts || "",
        channelChatId: channelId,
        userId: "",
        platformUserId: slackUserId,
        text,
        isGroup: true,
        groupId: channelId,
        isMentioned: true, // app_mention always means mentioned
      };

      const platformCtx = this.createPlatformContext(channelId, threadTs);
      (incoming as any)._platformContext = platformCtx;

      this.messageHandler(incoming, async (outMsg) => {
        await this.sendInThread(channelId, threadTs, outMsg);
      });
    });

    // Button actions (Block Kit interactive elements)
    this.app.action(/^btn:/, async ({ action, body, ack }) => {
      await ack();
      if (!this.buttonHandler) return;

      const actionData = (action as any).action_id || "";
      const channelId = (body as any).channel?.id || "";
      const slackUserId = (body as any).user?.id || "";
      const messageTs = (body as any).message?.ts;

      this.buttonHandler(
        channelId,
        "", // userId resolved by relay
        slackUserId,
        actionData,
        async (outMsg) => {
          await this.sendInThread(channelId, messageTs, outMsg);
        },
        async (newText: string) => {
          // Edit the original message to remove buttons
          try {
            await this.app.client.chat.update({
              channel: channelId,
              ts: messageTs,
              text: newText,
              blocks: [],
            });
          } catch {}
        },
      );
    });

    // Approval button actions
    this.app.action(/^apv:/, async ({ action, body, ack }) => {
      await ack();
      if (!this.buttonHandler) return;

      const actionData = (action as any).action_id || "";
      const channelId = (body as any).channel?.id || "";
      const slackUserId = (body as any).user?.id || "";
      const messageTs = (body as any).message?.ts;

      this.buttonHandler(
        channelId,
        "",
        slackUserId,
        actionData,
        async (outMsg) => {
          await this.sendInThread(channelId, messageTs, outMsg);
        },
        async (newText: string) => {
          try {
            await this.app.client.chat.update({
              channel: channelId,
              ts: messageTs,
              text: newText,
              blocks: [],
            });
          } catch {}
        },
      );
    });
  }

  async send(chatId: string, message: OutgoingMessage): Promise<void> {
    await this.sendInThread(chatId, undefined, message);
  }

  private async sendInThread(
    channelId: string,
    threadTs: string | undefined,
    message: string | OutgoingMessage,
  ): Promise<void> {
    const normalizedMsg: OutgoingMessage = typeof message === "string" ? { text: message } : message;
    // Send files first
    if (normalizedMsg.files) {
      for (const file of normalizedMsg.files) {
        await this.sendFile(channelId, file.path, file.caption);
      }
    }

    // Build Block Kit blocks for buttons
    const blocks: any[] = [];
    const text = normalizedMsg.text || "";

    if (text) {
      // Split text into blocks (Slack section text max is 3000 chars)
      const MAX_SECTION = 3000;
      let remaining = text;
      while (remaining.length > 0) {
        const chunk = remaining.substring(0, MAX_SECTION);
        remaining = remaining.substring(MAX_SECTION);
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: this.markdownToSlack(chunk) },
        });
      }
    }

    // Add buttons as actions block
    if (normalizedMsg.buttons?.length) {
      blocks.push({
        type: "actions",
        elements: normalizedMsg.buttons.map((btn) => ({
          type: "button",
          text: { type: "plain_text", text: btn.label },
          action_id: btn.callbackData,
        })),
      });
    }

    if (blocks.length > 0) {
      // Slack requires a fallback text for notifications
      const fallbackText = text.substring(0, 200) || "New message from Nova";
      await this.app.client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: fallbackText,
        blocks,
      });
    }

    // Send voice as file (Slack doesn't have native voice)
    if (normalizedMsg.voice) {
      await this.app.client.filesUploadV2({
        channel_id: channelId,
        thread_ts: threadTs,
        file: normalizedMsg.voice,
        filename: "response.ogg",
        title: "Voice response",
      });
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    // Slack doesn't have a typing indicator API for bots — no-op
  }

  async sendFile(chatId: string, filePath: string, caption?: string): Promise<void> {
    try {
      await stat(filePath);
    } catch {
      console.warn(`[slack] File not found: ${filePath}`);
      return;
    }

    try {
      const buffer = await readFile(filePath);
      const filename = basename(filePath);

      await this.app.client.filesUploadV2({
        channel_id: chatId,
        file: buffer,
        filename,
        title: caption || filename,
      });
      console.log(`[slack] Sent file: ${filePath}`);
    } catch (error) {
      console.error(`[slack] Failed to send file ${filePath}:`, error);
    }
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }

  /**
   * Convert standard Markdown to Slack mrkdwn format.
   * Key differences: *bold* instead of **bold**, _italic_ same, ~strike~ instead of ~~strike~~
   */
  private markdownToSlack(text: string): string {
    let result = text;

    // Bold: **text** → *text*
    result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");

    // Strikethrough: ~~text~~ → ~text~
    result = result.replace(/~~(.+?)~~/g, "~$1~");

    // Headings → bold
    result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

    // Links: [text](url) → <url|text>
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

    // Code blocks stay the same (```)
    // Inline code stays the same (`)

    // Blockquotes: > text → > text (same in Slack)

    return result;
  }

  /**
   * Create a PlatformContext for Slack messages.
   */
  createPlatformContext(channelId: string, threadTs?: string): PlatformContext {
    const adapter = this;
    let lastMessageTs = "";

    return {
      adapter,
      chat: { id: channelId },
      channelType: "slack",

      async reply(text: string, opts?: any) {
        const cleanText = text.replace(/<[^>]+>/g, "");
        const result = await adapter.app.client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: cleanText,
        });
        lastMessageTs = result.ts || "";
        return { message_id: lastMessageTs as any };
      },

      async replyWithChatAction(_action: string) {
        // No typing indicator in Slack for bots
      },

      api: {
        async editMessageText(chatId, messageId, text, _opts?) {
          try {
            await adapter.app.client.chat.update({
              channel: String(chatId),
              ts: String(messageId),
              text: text.replace(/<[^>]+>/g, ""),
            });
          } catch {}
        },
        async deleteMessage(chatId, messageId) {
          try {
            await adapter.app.client.chat.delete({
              channel: String(chatId),
              ts: String(messageId),
            });
          } catch {}
        },
        async sendMessage(chatId, text, _opts?) {
          await adapter.app.client.chat.postMessage({
            channel: String(chatId),
            thread_ts: threadTs,
            text,
          });
        },
      },
    };
  }
}
