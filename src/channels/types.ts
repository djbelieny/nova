/**
 * Channel Adapter Interface
 *
 * Standard interface that all messaging channels (Telegram, WhatsApp, Slack, etc.)
 * implement. Enables plug-and-play channel support.
 */

export interface IncomingMessage {
  channelType: "telegram" | "whatsapp" | "slack";
  channelMessageId: string;
  channelChatId: string;
  userId: string;           // Nova user UUID (resolved from platform ID)
  platformUserId: string;   // raw platform ID (telegram ID, phone number, etc.)
  text?: string;
  voice?: { buffer: Buffer; durationSec: number };
  image?: { buffer: Buffer; caption?: string; filePath?: string };
  document?: { buffer: Buffer; filename: string; caption?: string; filePath?: string };
  replyToMessageId?: string;
}

export interface OutgoingMessage {
  text?: string;
  html?: string;
  voice?: Buffer;
  files?: Array<{ path: string; caption?: string }>;
  buttons?: Array<{ label: string; callbackData: string }>;
}

export interface ChannelAdapter {
  readonly type: "telegram" | "whatsapp" | "slack";
  start(): Promise<void>;
  stop(): Promise<void>;
  send(chatId: string, message: OutgoingMessage): Promise<void>;
  sendTyping(chatId: string): Promise<void>;
  sendFile(chatId: string, filePath: string, caption?: string): Promise<void>;
  onMessage(handler: MessageHandler): void;
  onButtonPress(handler: ButtonHandler): void;
}

export type ReplyFn = (message: OutgoingMessage) => Promise<void>;

export type MessageHandler = (msg: IncomingMessage, reply: ReplyFn) => void;

export type ButtonHandler = (
  chatId: string,
  userId: string,
  platformUserId: string,
  buttonData: string,
  reply: ReplyFn,
  /** Platform-specific: edit the original message (e.g., remove buttons) */
  editOriginal?: (newText: string) => Promise<void>,
) => void;

/**
 * PlatformContext — a compatibility shim that provides the ctx-like API
 * that relay.ts and orchestrator.ts depend on. All channels create one of
 * these so the business logic layer can work uniformly.
 *
 * For Telegram, this wraps the real grammY Context.
 * For WhatsApp/Slack, this wraps the adapter's send methods.
 */
export interface PlatformContext {
  /** The channel adapter that created this context */
  adapter: ChannelAdapter;
  /** Chat ID on the platform */
  chat: { id: string | number };
  /** The resolved Nova user (set by relay.ts middleware) */
  novaUser?: any;
  /** Message ID to reply to (for threading) */
  novaReplyTo?: string | number;
  /** Channel type shortcut */
  channelType: "telegram" | "whatsapp" | "slack";
  /** Send a text reply */
  reply(text: string, opts?: any): Promise<{ message_id: number | string }>;
  /** Send typing indicator */
  replyWithChatAction(action: string): Promise<void>;
  /** Send a voice note reply */
  replyWithVoice?(file: any): Promise<void>;
  /** Acknowledge a callback/button press (Telegram-specific, no-op on others) */
  answerCallbackQuery?(opts?: any): Promise<void>;
  /** Edit the callback query message text (Telegram-specific) */
  editMessageText?(text: string, opts?: any): Promise<void>;
  /** The callback query data (Telegram-specific) */
  callbackQuery?: { data?: string; message?: { text?: string } };
  /** Platform API for editing/deleting messages */
  api: {
    editMessageText(chatId: string | number, messageId: number | string, text: string, opts?: any): Promise<void>;
    deleteMessage(chatId: string | number, messageId: number | string): Promise<void>;
    sendMessage(chatId: string | number, text: string, opts?: any): Promise<void>;
  };
  /** Get file from platform (Telegram-specific) */
  getFile?(): Promise<{ file_path?: string }>;
  /** The original platform-specific context (for Telegram: grammY Context) */
  _raw?: any;
}
