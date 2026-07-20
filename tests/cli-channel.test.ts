import { test, expect } from "bun:test";
import { PassThrough } from "stream";
import { CliAdapter } from "../src/channels/cli.ts";
import type { IncomingMessage } from "../src/channels/types.ts";

/** Collect everything written to an output stream as a single string. */
function captureOutput(stream: PassThrough): { text: () => string } {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk.toString();
  });
  return { text: () => buf };
}

/** Wait a tick so async stream/line handlers flush. */
const tick = () => new Promise((r) => setTimeout(r, 10));

test("a stdin line is normalized into an IncomingMessage and reaches the handler", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  captureOutput(output);

  const adapter = new CliAdapter({ input, output });
  const received: IncomingMessage[] = [];
  adapter.onMessage((msg) => {
    received.push(msg);
  });

  await adapter.start();
  input.write("hello nova\n");
  await tick();

  expect(received.length).toBe(1);
  const msg = received[0];
  expect(msg.channelType).toBe("cli");
  expect(msg.channelChatId).toBe("cli");
  expect(msg.platformUserId).toBe("cli");
  expect(msg.text).toBe("hello nova");
  expect((msg as any)._platformContext).toBeDefined();

  await adapter.stop();
});

test("send with buttons renders a numbered menu and a numeric reply dispatches the callbackData", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const captured = captureOutput(output);

  const adapter = new CliAdapter({ input, output });
  adapter.onMessage(() => {});
  const pressed: string[] = [];
  adapter.onButtonPress((_chatId, _userId, _platformUserId, buttonData) => {
    pressed.push(buttonData);
  });

  await adapter.start();
  await adapter.send("cli", {
    text: "Proceed?",
    buttons: [
      { label: "Approve", callbackData: "apv:1:go" },
      { label: "Cancel", callbackData: "apv:1:no" },
    ],
  });
  await tick();

  const out = captured.text();
  expect(out).toContain("Proceed?");
  expect(out).toContain("1) Approve");
  expect(out).toContain("2) Cancel");

  // A numeric-only line dispatches the mapped button rather than a message.
  input.write("1\n");
  await tick();

  expect(pressed.length).toBe(1);
  expect(pressed[0]).toBe("apv:1:go");

  await adapter.stop();
});

test("a non-numeric line after a menu flows through as a normal message", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  captureOutput(output);

  const adapter = new CliAdapter({ input, output });
  const received: IncomingMessage[] = [];
  const pressed: string[] = [];
  adapter.onMessage((msg) => received.push(msg));
  adapter.onButtonPress((_c, _u, _p, data) => pressed.push(data));

  await adapter.start();
  await adapter.send("cli", {
    text: "Proceed?",
    buttons: [{ label: "Approve", callbackData: "apv:1:go" }],
  });
  await tick();

  input.write("actually do something else\n");
  await tick();

  expect(pressed.length).toBe(0);
  expect(received.length).toBe(1);
  expect(received[0].text).toBe("actually do something else");

  await adapter.stop();
});
