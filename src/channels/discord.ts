/**
 * Discord Channel Adapter
 *
 * A first-class Discord bot channel over the existing Nova pipeline. Same
 * adapter contract as Slack/Telegram — this file only normalizes I/O; the
 * orchestrator, agents, providers and approval gate are untouched.
 *
 * discord.js is imported dynamically inside start() so the SDK is only loaded
 * when Discord is actually enabled (DISCORD_BOT_TOKEN set).
 *
 * Discord-specific considerations:
 * - Buttons work natively via message components (action rows, ≤5 buttons/row,
 *   ≤5 rows). The two-phase approval gate maps onto these.
 * - Button clicks arrive as interactions; ack them with deferUpdate().
 * - DMs vs. guild channels distinguish isGroup.
 */

import { basename } from "path";
import type {
  ChannelAdapter,
  IncomingMessage,
  OutgoingMessage,
  MessageHandler,
  ButtonHandler,
  PlatformContext,
} from "./types.ts";

// Discord message-component type/style constants (kept local so the pure
// mappers below never need to load discord.js).
const COMPONENT_ACTION_ROW = 1;
const COMPONENT_BUTTON = 2;
const BUTTON_STYLE_PRIMARY = 1;
const MAX_BUTTONS_PER_ROW = 5;
const MAX_ROWS = 5;

/**
 * Map OutgoingMessage.buttons → Discord action-row component JSON.
 * Chunks into rows of ≤5 buttons, ≤5 rows. Returns [] for no buttons.
 * Pure + testable — no discord.js needed.
 */
export function buttonsToComponents(
  buttons?: Array<{ label: string; callbackData: string }>,
): Array<{ type: number; components: any[] }> {
  if (!buttons?.length) return [];

  const rows: Array<{ type: number; components: any[] }> = [];
  for (let i = 0; i < buttons.length && rows.length < MAX_ROWS; i += MAX_BUTTONS_PER_ROW) {
    const chunk = buttons.slice(i, i + MAX_BUTTONS_PER_ROW);
    rows.push({
      type: COMPONENT_ACTION_ROW,
      components: chunk.map((btn) => ({
        type: COMPONENT_BUTTON,
        style: BUTTON_STYLE_PRIMARY,
        label: btn.label,
        custom_id: btn.callbackData,
      })),
    });
  }
  return rows;
}

/**
 * Normalize a discord.js message object into an IncomingMessage.
 * Pure + testable — accepts any message-shaped object so tests never need a
 * live client.
 */
export function toIncomingMessage(discordMsg: any, botUserId?: string): IncomingMessage {
  const channelId = discordMsg.channel?.id || discordMsg.channelId || "";
  const isGroup = Boolean(discordMsg.guildId ?? discordMsg.guild);
  const isMentioned = botUserId ? Boolean(discordMsg.mentions?.has?.(botUserId)) : false;

  return {
    channelType: "discord",
    channelMessageId: discordMsg.id || "",
    channelChatId: channelId,
    userId: "", // resolved by relay.ts
    platformUserId: discordMsg.author?.id || "",
    text: discordMsg.content || "",
    isGroup,
    groupId: isGroup ? channelId : undefined,
    isMentioned,
  };
}

export class DiscordAdapter implements ChannelAdapter {
  readonly type = "discord" as const;
  private token: string;
  private client: any = null;
  private messageHandler: MessageHandler | null = null;
  private buttonHandler: ButtonHandler | null = null;

  constructor(token: string) {
    this.token = token;
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onButtonPress(handler: ButtonHandler): void {
    this.buttonHandler = handler;
  }

  async start(): Promise<void> {
    // Lazy-load: the SDK only loads when Discord is enabled.
    const { Client, GatewayIntentBits } = await import("discord.js");

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on("messageCreate", (message: any) => {
      if (!this.messageHandler) return;
      // Ignore bots and self.
      if (message.author?.bot) return;
      if (this.client?.user && message.author?.id === this.client.user.id) return;

      const incoming = toIncomingMessage(message, this.client?.user?.id);
      const channelId = message.channel?.id || "";
      const platformCtx = this.createPlatformContext(channelId);
      (incoming as any)._platformContext = platformCtx;

      this.messageHandler(incoming, async (outMsg) => {
        await this.send(channelId, typeof outMsg === "string" ? { text: outMsg } : outMsg);
      });
    });

    this.client.on("interactionCreate", async (interaction: any) => {
      if (!interaction.isButton?.()) return;
      if (!this.buttonHandler) return;

      // Ack immediately so Discord doesn't show a failed interaction.
      try {
        await interaction.deferUpdate();
      } catch {}

      const channelId = interaction.channelId || interaction.channel?.id || "";
      const platformUserId = interaction.user?.id || "";

      this.buttonHandler(
        channelId,
        "", // userId resolved by relay
        platformUserId,
        interaction.customId,
        async (outMsg) => {
          await this.send(channelId, typeof outMsg === "string" ? { text: outMsg } : outMsg);
        },
        async (newText: string) => {
          // Edit the interaction's message to remove the buttons.
          try {
            await interaction.message?.edit({ content: newText, components: [] });
          } catch {}
        },
      );
    });

    await this.client.login(this.token);
    console.log("[discord] Bot started");
  }

  private async fetchChannel(chatId: string): Promise<any | null> {
    if (!this.client) return null;
    try {
      return await this.client.channels.fetch(chatId);
    } catch {
      return null;
    }
  }

  async send(chatId: string, message: OutgoingMessage): Promise<void> {
    const channel = await this.fetchChannel(chatId);
    if (!channel?.send) return;

    const content = message.text ?? (message.html ? htmlToPlain(message.html) : "");
    const components = buttonsToComponents(message.buttons);
    const files = message.files?.map((f) => f.path);

    const payload: any = {};
    if (content) payload.content = content;
    if (components.length) payload.components = components;
    if (files?.length) payload.files = files;

    if (Object.keys(payload).length === 0) return;
    try {
      await channel.send(payload);
    } catch (error) {
      console.error(`[discord] Failed to send to ${chatId}:`, error);
    }

    if (message.voice) {
      try {
        await channel.send({ files: [{ attachment: message.voice, name: "response.ogg" }] });
      } catch {}
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    const channel = await this.fetchChannel(chatId);
    try {
      await channel?.sendTyping?.();
    } catch {}
  }

  async sendFile(chatId: string, filePath: string, caption?: string): Promise<void> {
    const channel = await this.fetchChannel(chatId);
    if (!channel?.send) {
      console.warn(`[discord] Channel not found: ${chatId}`);
      return;
    }
    try {
      await channel.send({
        content: caption || undefined,
        files: [{ attachment: filePath, name: basename(filePath) }],
      });
      console.log(`[discord] Sent file: ${filePath}`);
    } catch (error) {
      console.error(`[discord] Failed to send file ${filePath}:`, error);
    }
  }

  async stop(): Promise<void> {
    try {
      await this.client?.destroy();
    } catch {}
    this.client = null;
  }

  /**
   * Create a PlatformContext for Discord messages — same shape Slack builds.
   */
  createPlatformContext(channelId: string): PlatformContext {
    const adapter = this;

    return {
      adapter,
      chat: { id: channelId },
      channelType: "discord",

      async reply(text: string, _opts?: any) {
        const channel = await adapter.fetchChannel(channelId);
        const result = await channel?.send?.({ content: htmlToPlain(text) });
        return { message_id: (result?.id as any) ?? `${Date.now()}` };
      },

      async replyWithChatAction(_action: string) {
        await adapter.sendTyping(channelId);
      },

      async answerCallbackQuery(_opts?: any) {
        // Discord acks button interactions via deferUpdate() at press time.
      },

      async editMessageText(_text: string, _opts?: any) {
        // No-op — edits are handled via the interaction's editOriginal callback.
      },

      api: {
        async editMessageText(chatId, messageId, text, _opts?) {
          try {
            const channel = await adapter.fetchChannel(String(chatId));
            const msg = await channel?.messages?.fetch?.(String(messageId));
            await msg?.edit?.({ content: htmlToPlain(text) });
          } catch {}
        },
        async deleteMessage(chatId, messageId) {
          try {
            const channel = await adapter.fetchChannel(String(chatId));
            const msg = await channel?.messages?.fetch?.(String(messageId));
            await msg?.delete?.();
          } catch {}
        },
        async sendMessage(chatId, text, _opts?) {
          const channel = await adapter.fetchChannel(String(chatId));
          await channel?.send?.({ content: htmlToPlain(text) });
        },
      },
    };
  }
}

/** Render simple HTML to plain text for Discord output. */
function htmlToPlain(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
