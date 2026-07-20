/**
 * CLI Channel Adapter
 *
 * An interactive terminal front-end over the existing Nova pipeline. Plain
 * readline on stdin/stdout — proves the channel-adapter seam and gives a
 * local/dev REPL. Reuses the full relay wiring (orchestrator, agents,
 * providers, approval gate); this adapter only normalizes I/O.
 *
 * CLI-specific considerations:
 * - Single local surface → resolves to the owner (see resolveUser 'cli' branch).
 * - Buttons (the two-phase approval gate) render as a numbered menu; the next
 *   numeric-only line dispatches that button's callbackData via onButtonPress.
 * - The input/output streams are injectable so the adapter is testable without
 *   touching the real stdin/stdout.
 */

import { createInterface, type Interface } from "readline";
import type {
  ChannelAdapter,
  IncomingMessage,
  OutgoingMessage,
  MessageHandler,
  ButtonHandler,
  PlatformContext,
} from "./types.ts";

const CLI_CHAT_ID = "cli";

export class CliAdapter implements ChannelAdapter {
  readonly type = "cli" as const;
  private input: NodeJS.ReadableStream;
  private output: NodeJS.WritableStream;
  private rl: Interface | null = null;
  private messageHandler: MessageHandler | null = null;
  private buttonHandler: ButtonHandler | null = null;
  private pendingButtons: Array<{ label: string; callbackData: string }> | null = null;

  constructor(opts?: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream }) {
    this.input = opts?.input ?? process.stdin;
    this.output = opts?.output ?? process.stdout;
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onButtonPress(handler: ButtonHandler): void {
    this.buttonHandler = handler;
  }

  async start(): Promise<void> {
    // terminal:false + not wiring readline's own output keeps stdout clean and
    // makes captured-stream assertions in tests deterministic.
    this.rl = createInterface({ input: this.input, terminal: false });
    this.write("Nova CLI — type a message, /exit to quit.\n");
    this.rl.on("line", (line) => this.handleLine(line));
  }

  private handleLine(line: string): void {
    const text = line.trim();

    // Local convenience: end the session (does not reach the pipeline).
    if (text === "/exit" || text === "/quit") {
      void this.stop();
      return;
    }

    // A numeric-only line right after a button menu dispatches that button.
    if (this.pendingButtons && /^\d+$/.test(text)) {
      const idx = Number(text) - 1;
      const button = this.pendingButtons[idx];
      if (button) {
        this.pendingButtons = null;
        if (this.buttonHandler) {
          this.buttonHandler(
            CLI_CHAT_ID,
            "", // userId resolved by relay
            CLI_CHAT_ID,
            button.callbackData,
            async (outMsg) => {
              await this.send(CLI_CHAT_ID, typeof outMsg === "string" ? { text: outMsg } : outMsg);
            },
            async (newText: string) => {
              this.write(`${newText}\n`);
            },
          );
        }
        return;
      }
    }

    // Any other input is a normal message; clear a stale menu.
    this.pendingButtons = null;
    if (!this.messageHandler) return;

    const incoming: IncomingMessage = {
      channelType: "cli",
      channelMessageId: `${Date.now()}`,
      channelChatId: CLI_CHAT_ID,
      userId: "", // resolved by relay.ts
      platformUserId: CLI_CHAT_ID,
      text,
    };

    const platformCtx = this.createPlatformContext();
    (incoming as any)._platformContext = platformCtx;

    this.messageHandler(incoming, async (outMsg) => {
      await this.send(CLI_CHAT_ID, typeof outMsg === "string" ? { text: outMsg } : outMsg);
    });
  }

  async send(_chatId: string, message: OutgoingMessage): Promise<void> {
    const text = message.text ?? (message.html ? htmlToPlain(message.html) : "");
    if (text) this.write(`${text}\n`);

    if (message.files) {
      for (const file of message.files) {
        await this.sendFile(CLI_CHAT_ID, file.path, file.caption);
      }
    }

    if (message.buttons?.length) {
      this.pendingButtons = message.buttons;
      const menu = message.buttons.map((b, i) => `${i + 1}) ${b.label}`).join("  ");
      this.write(`${menu}\n`);
    }
  }

  async sendTyping(_chatId: string): Promise<void> {
    // Optional in the terminal — no-op.
  }

  async sendFile(_chatId: string, filePath: string, caption?: string): Promise<void> {
    this.write(caption ? `[file] ${filePath} — ${caption}\n` : `[file] ${filePath}\n`);
  }

  async stop(): Promise<void> {
    this.rl?.close();
    this.rl = null;
  }

  private write(text: string): void {
    this.output.write(text);
  }

  /**
   * Create a PlatformContext for CLI messages — same shape Slack builds.
   */
  createPlatformContext(): PlatformContext {
    const adapter = this;

    return {
      adapter,
      chat: { id: CLI_CHAT_ID },
      channelType: "cli",

      async reply(text: string, _opts?: any) {
        adapter.write(`${htmlToPlain(text)}\n`);
        return { message_id: `${Date.now()}` };
      },

      async replyWithChatAction(_action: string) {
        // No typing indicator in the terminal.
      },

      async answerCallbackQuery(_opts?: any) {
        // No-op in the terminal.
      },

      async editMessageText(_text: string, _opts?: any) {
        // No-op in the terminal.
      },

      api: {
        async editMessageText(_chatId, _messageId, _text, _opts?) {
          // No-op in the terminal.
        },
        async deleteMessage(_chatId, _messageId) {
          // No-op in the terminal.
        },
        async sendMessage(_chatId, text, _opts?) {
          adapter.write(`${htmlToPlain(text)}\n`);
        },
      },
    };
  }
}

/** Render simple HTML to plain text for terminal output. */
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
