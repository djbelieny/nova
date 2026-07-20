import { test, expect } from "bun:test";
import { buttonsToComponents, toIncomingMessage } from "../src/channels/discord.ts";
import { getDb } from "../src/db.ts";

test("buttonsToComponents chunks 7 buttons into rows of 5 + 2", () => {
  const buttons = Array.from({ length: 7 }, (_, i) => ({
    label: `Btn ${i}`,
    callbackData: `cb:${i}`,
  }));

  const rows = buttonsToComponents(buttons);
  expect(rows.length).toBe(2);
  expect(rows[0].components.length).toBe(5);
  expect(rows[1].components.length).toBe(2);

  // custom_id must equal callbackData on each component.
  const flat = rows.flatMap((r) => r.components);
  expect(flat.map((c) => c.custom_id)).toEqual(buttons.map((b) => b.callbackData));
});

test("buttonsToComponents returns [] for no buttons", () => {
  expect(buttonsToComponents([])).toEqual([]);
  expect(buttonsToComponents(undefined)).toEqual([]);
});

test("toIncomingMessage normalizes a guild message that mentions the bot", () => {
  const discordMsg = {
    id: "msg-1",
    content: "hey @nova what's up",
    author: { id: "user-123", bot: false },
    guildId: "guild-1",
    channel: { id: "chan-1" },
    mentions: { has: (id: string) => id === "bot-1" },
  };

  const incoming = toIncomingMessage(discordMsg, "bot-1");
  expect(incoming.channelType).toBe("discord");
  expect(incoming.channelMessageId).toBe("msg-1");
  expect(incoming.channelChatId).toBe("chan-1");
  expect(incoming.platformUserId).toBe("user-123");
  expect(incoming.text).toBe("hey @nova what's up");
  expect(incoming.isGroup).toBe(true);
  expect(incoming.groupId).toBe("chan-1");
  expect(incoming.isMentioned).toBe(true);
});

test("toIncomingMessage marks a DM as not a group", () => {
  const dm = {
    id: "msg-2",
    content: "private hello",
    author: { id: "user-456", bot: false },
    channel: { id: "dm-1" },
    mentions: { has: () => false },
  };

  const incoming = toIncomingMessage(dm, "bot-1");
  expect(incoming.isGroup).toBe(false);
  expect(incoming.groupId).toBeUndefined();
  expect(incoming.isMentioned).toBe(false);
  expect(incoming.platformUserId).toBe("user-456");
});

test("getUserByDiscordId round-trips a discord_id set via upsertUser", () => {
  const db = getDb();
  const user = db.upsertUser({
    telegram_id: "tg-discord-1",
    name: "Discord User",
    role: "member",
    discord_id: "discord-abc-123",
  });

  const found = db.getUserByDiscordId("discord-abc-123");
  expect(found).not.toBeNull();
  expect(found.id).toBe(user.id);
  expect(found.discord_id).toBe("discord-abc-123");

  expect(db.getUserByDiscordId("nope-does-not-exist")).toBeNull();
});
