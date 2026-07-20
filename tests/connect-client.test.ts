// tests/connect-client.test.ts
//
// Pure transport tests for `nova connect`. No Ink rendering, no real network —
// every function is exercised with a stubbed fetch.

import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approve,
  connectActivityStream,
  extractApprovalFromEvent,
  extractSessionCookie,
  fetchHistory,
  loadSession,
  login,
  parseSseLine,
  saveSession,
  sendChat,
  type Session,
} from "../src/connect/client.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

function stubResponse(opts: {
  status?: number;
  headers?: Record<string, string>;
  json?: unknown;
  bodyStream?: ReadableStream<Uint8Array>;
}): Response {
  const headers = new Headers(opts.headers || {});
  return {
    ok: (opts.status ?? 200) < 400,
    status: opts.status ?? 200,
    headers,
    json: async () => opts.json,
    body: opts.bodyStream,
  } as unknown as Response;
}

function streamFromLines(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(l));
      c.close();
    },
  });
}

// ── extractSessionCookie ─────────────────────────────────────────────────────

test("extractSessionCookie pulls the nova_session pair out of a Set-Cookie header", () => {
  const raw = "nova_session=deadbeef123; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400";
  expect(extractSessionCookie(raw)).toBe("nova_session=deadbeef123");
  expect(extractSessionCookie(null)).toBeNull();
  expect(extractSessionCookie("other=1; Path=/")).toBeNull();
});

// ── login → cookie extraction ────────────────────────────────────────────────

test("login extracts the cookie from the Set-Cookie response header", async () => {
  let calledUrl = "";
  let calledInit: RequestInit | undefined;
  const fetchStub = (async (url: string, init?: RequestInit) => {
    calledUrl = url;
    calledInit = init;
    return stubResponse({
      status: 302,
      headers: { "set-cookie": "nova_session=abc123; Path=/; HttpOnly" },
    });
  }) as unknown as typeof fetch;

  const { cookie } = await login("http://localhost:3033", "hunter2", "admin", fetchStub);
  expect(cookie).toBe("nova_session=abc123");
  expect(calledUrl).toBe("http://localhost:3033/login");
  expect(calledInit?.method).toBe("POST");
  expect(calledInit?.redirect).toBe("manual");
  const body = String(calledInit?.body);
  expect(body).toContain("username=admin");
  expect(body).toContain("password=hunter2");
});

test("login throws when no cookie is returned (bad credentials)", async () => {
  const fetchStub = (async () => stubResponse({ status: 200 })) as unknown as typeof fetch;
  await expect(login("http://x", "bad", "admin", fetchStub)).rejects.toThrow(/invalid credentials/i);
});

// ── parseSseLine ─────────────────────────────────────────────────────────────

test("parseSseLine parses a data line into a NovaEvent", () => {
  const line = 'data: {"type":"agent.step","timestamp":"2026-07-20T00:00:00Z","data":{"message":"working"},"level":"info"}';
  const ev = parseSseLine(line);
  expect(ev).not.toBeNull();
  expect(ev!.type).toBe("agent.step");
  expect(ev!.data.message).toBe("working");
});

test("parseSseLine returns null for heartbeats, comments, and blanks", () => {
  expect(parseSseLine(": connected")).toBeNull();
  expect(parseSseLine(": ping")).toBeNull();
  expect(parseSseLine("")).toBeNull();
  expect(parseSseLine("data: not-json")).toBeNull();
  expect(parseSseLine("event: foo")).toBeNull();
});

// ── sendChat request shape ───────────────────────────────────────────────────

test("sendChat issues the right method/URL/body with the cookie header", async () => {
  let captured: { url?: string; init?: RequestInit } = {};
  const fetchStub = (async (url: string, init?: RequestInit) => {
    captured = { url, init };
    return stubResponse({ json: { success: true } });
  }) as unknown as typeof fetch;

  const res = await sendChat("http://localhost:3033", "nova_session=abc", "hello nova", "user-42", fetchStub);
  expect(res).toEqual({ success: true });
  expect(captured.url).toBe("http://localhost:3033/api/chat");
  expect(captured.init?.method).toBe("POST");
  expect((captured.init?.headers as any).Cookie).toBe("nova_session=abc");
  expect((captured.init?.headers as any)["Content-Type"]).toBe("application/json");
  const body = JSON.parse(String(captured.init?.body));
  expect(body).toEqual({ role: "user", content: "hello nova", userId: "user-42" });
});

// ── fetchHistory ─────────────────────────────────────────────────────────────

test("fetchHistory sends the cookie and returns the messages array", async () => {
  let capturedUrl = "";
  let capturedCookie = "";
  const fetchStub = (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedCookie = (init?.headers as any).Cookie;
    return stubResponse({ json: { messages: [{ role: "user", content: "hi" }] } });
  }) as unknown as typeof fetch;

  const msgs = await fetchHistory("http://h", "nova_session=z", 5, "u1", fetchStub);
  expect(msgs).toEqual([{ role: "user", content: "hi" }]);
  expect(capturedUrl).toContain("/api/messages?");
  expect(capturedUrl).toContain("limit=5");
  expect(capturedUrl).toContain("user_id=u1");
  expect(capturedCookie).toBe("nova_session=z");
});

// ── approve → /api/approvals/resolve ─────────────────────────────────────────

test("approve posts {id, action} to the existing resolve route", async () => {
  let captured: { url?: string; init?: RequestInit } = {};
  const fetchStub = (async (url: string, init?: RequestInit) => {
    captured = { url, init };
    return stubResponse({ json: { success: true } });
  }) as unknown as typeof fetch;

  await approve("http://h", "nova_session=z", "apv-1", "approve", undefined, fetchStub);
  expect(captured.url).toBe("http://h/api/approvals/resolve");
  expect(captured.init?.method).toBe("POST");
  const body = JSON.parse(String(captured.init?.body));
  expect(body.id).toBe("apv-1");
  expect(body.action).toBe("approve");
});

// ── connectActivityStream drives onEvent per parsed event ────────────────────

test("connectActivityStream parses the SSE body and calls onEvent per event", async () => {
  const lines = [
    ": connected\n\n",
    'data: {"type":"agent.start","timestamp":"t","data":{},"level":"info"}\n\n',
    ": ping\n\n",
    'data: {"type":"chat.reply","timestamp":"t","data":{"text":"done"},"level":"info"}\n\n',
  ];
  const fetchStub = (async () => stubResponse({ bodyStream: streamFromLines(lines) })) as unknown as typeof fetch;

  const got: string[] = [];
  await connectActivityStream("http://h", "nova_session=z", (e) => got.push(e.type), { fetchImpl: fetchStub });
  expect(got).toEqual(["agent.start", "chat.reply"]);
});

// ── extractApprovalFromEvent ─────────────────────────────────────────────────

test("extractApprovalFromEvent finds the approval id in an inline keyboard", () => {
  const event: any = {
    type: "chat.reply",
    timestamp: "t",
    level: "info",
    data: {
      text: "Tap below to proceed:",
      options: {
        reply_markup: {
          inline_keyboard: [[
            { text: "Approve & Execute", callback_data: "apv:apv-99:approve" },
            { text: "Revise", callback_data: "apv:apv-99:revise" },
            { text: "Cancel", callback_data: "apv:apv-99:cancel" },
          ]],
        },
      },
    },
  };
  expect(extractApprovalFromEvent(event)).toEqual({ approvalId: "apv-99" });
  expect(extractApprovalFromEvent({ type: "chat.reply", timestamp: "t", level: "info", data: {} } as any)).toBeNull();
});

// ── loadSession / saveSession round-trip ─────────────────────────────────────

test("saveSession / loadSession round-trip via an explicit path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nova-connect-"));
  const file = join(dir, "connect.json");
  const session: Session = { baseUrl: "http://localhost:3033", cookie: "nova_session=xyz", userId: "u7" };

  await saveSession(session, file);
  const loaded = await loadSession(file);
  expect(loaded).toEqual(session);

  // Missing file → null, not a throw.
  expect(await loadSession(join(dir, "nope.json"))).toBeNull();
});

test("loadSession honors HOME for the default path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nova-home-"));
  const origHome = process.env.HOME;
  const origPath = process.env.NOVA_CONNECT_PATH;
  delete process.env.NOVA_CONNECT_PATH;
  process.env.HOME = dir;
  try {
    const session: Session = { baseUrl: "http://x", cookie: "nova_session=h", userId: "uH" };
    await saveSession(session);
    const loaded = await loadSession();
    expect(loaded).toEqual(session);
  } finally {
    if (origHome !== undefined) process.env.HOME = origHome;
    if (origPath !== undefined) process.env.NOVA_CONNECT_PATH = origPath;
  }
});
