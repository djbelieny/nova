#!/usr/bin/env bun
/**
 * `nova connect` — standalone terminal client for a running Nova.
 *
 *   bun run connect                 # Ink UI, prompts for URL + password on first run
 *   bun run connect --url http://host:3033
 *   bun run connect --plain         # readline fallback for dumb terminals / CI
 *   bun run connect --reset         # forget the saved session and re-auth
 *
 * Talks to Nova purely over the existing dashboard HTTP endpoints — it does not
 * import the relay/orchestrator.
 */

import React from "react";
import { render } from "ink";
import { createInterface } from "node:readline";
import { App } from "./App.tsx";
import {
  approve,
  connectActivityStream,
  extractApprovalFromEvent,
  fetchHistory,
  loadSession,
  login,
  saveSession,
  sendChat,
  whoami,
  type Session,
} from "./client.ts";
import { describeEvent } from "./components/ActivityLine.tsx";

interface Args {
  url?: string;
  plain: boolean;
  reset: boolean;
  user: string;
  userId?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { plain: false, reset: false, user: "admin" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") args.url = argv[++i];
    else if (a === "--plain") args.plain = true;
    else if (a === "--reset") args.reset = true;
    else if (a === "--user") args.user = argv[++i] || "admin";
    else if (a === "--user-id") args.userId = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log("Usage: nova connect [--url <baseUrl>] [--plain] [--reset] [--user <username>] [--user-id <id>]");
      process.exit(0);
    }
  }
  return args;
}

const DEFAULT_URL = "http://localhost:3033";

function prompt(question: string, { hidden = false } = {}): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    if (hidden) {
      // Mute echo while typing the password.
      const output = process.stdout as any;
      const origWrite = output.write.bind(output);
      let muted = false;
      (rl as any)._writeToOutput = (str: string) => {
        if (muted && str !== question) return;
        origWrite(str);
      };
      rl.question(question, (answer) => {
        muted = false;
        origWrite("\n");
        rl.close();
        resolve(answer);
      });
      muted = true;
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    }
  });
}

/** Return a working session — reuse the saved one if valid, else interactively log in. */
async function bootstrap(args: Args): Promise<Session> {
  if (!args.reset) {
    const saved = await loadSession();
    if (saved && (!args.url || args.url === saved.baseUrl)) {
      const who = await whoami(saved.baseUrl, saved.cookie).catch(() => ({ userId: null as string | null }));
      if (who.userId || saved.userId) {
        return { ...saved, userId: (who.userId || saved.userId)! };
      }
    }
  }

  const baseUrl = (args.url || (await prompt(`Nova URL [${DEFAULT_URL}]: `)) || DEFAULT_URL).replace(/\/+$/, "");
  const username = args.user || (await prompt("Username [admin]: ")) || "admin";
  const password = await prompt("Password: ", { hidden: true });

  const { cookie } = await login(baseUrl, password, username);
  const who = await whoami(baseUrl, cookie);
  const userId = args.userId || who.userId;
  if (!userId) {
    throw new Error(
      "Logged in, but this account has no chat profile (master/bootstrap admin). " +
        "Log in as a real Nova user, or pass --user-id <id>.",
    );
  }

  const session: Session = { baseUrl, cookie, userId };
  await saveSession(session);
  return session;
}

/** Plain readline loop — no Ink. For dumb terminals / CI. */
async function runPlain(session: Session): Promise<void> {
  const { baseUrl, cookie, userId } = session;
  console.log(`nova connect (plain) — ${baseUrl}`);

  const history = await fetchHistory(baseUrl, cookie, 10, userId).catch(() => []);
  for (const m of history.slice().reverse()) {
    if (m.role === "user" || m.role === "assistant") {
      console.log(`${m.role === "user" ? "you " : "nova"} | ${String(m.content ?? "")}`);
    }
  }

  let pendingApprovalId: string | null = null;
  const controller = new AbortController();

  connectActivityStream(
    baseUrl,
    cookie,
    (event) => {
      if (event.type === "chat.reply") {
        const text = String((event.data as any)?.text ?? "");
        const approval = extractApprovalFromEvent(event);
        if (approval) {
          pendingApprovalId = approval.approvalId;
          console.log(`\n[approval ${approval.approvalId}] reply: approve | change | cancel`);
          return;
        }
        if (text.trim()) console.log(`nova | ${text}`);
      } else if (event.level === "error" || event.type.startsWith("agent.") || event.type.startsWith("task.")) {
        console.log(`  · ${describeEvent(event)}`);
      }
    },
    { signal: controller.signal },
  ).catch((e) => {
    if (e?.name !== "AbortError") console.error("stream error:", e?.message || e);
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt("> ");
  rl.prompt();

  for await (const line of rl) {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      continue;
    }
    if (text === "/exit" || text === "/quit") break;

    if (pendingApprovalId && /^(approve|change|cancel)$/i.test(text)) {
      const action = text.toLowerCase() === "change" ? "revise" : (text.toLowerCase() as "approve" | "cancel");
      await approve(baseUrl, cookie, pendingApprovalId, action).catch((e) => console.error("approval failed:", e?.message || e));
      pendingApprovalId = null;
      rl.prompt();
      continue;
    }

    const res = await sendChat(baseUrl, cookie, text, userId).catch((e) => ({ success: false, error: e?.message }));
    if (res && (res as any).success === false) console.error("send failed:", (res as any).error);
    rl.prompt();
  }

  controller.abort();
  rl.close();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let session: Session;
  try {
    session = await bootstrap(args);
  } catch (e: any) {
    console.error(`nova connect: ${e?.message || e}`);
    process.exit(1);
  }

  if (args.plain) {
    await runPlain(session);
    process.exit(0);
  }

  render(<App baseUrl={session.baseUrl} cookie={session.cookie} userId={session.userId!} />);
}

main();
