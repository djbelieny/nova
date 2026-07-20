import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp } from "ink";
import TextInput from "ink-text-input";
import type { NovaEvent } from "../events.ts";
import {
  approve as approveCall,
  connectActivityStream,
  extractApprovalFromEvent,
  fetchHistory,
  sendChat,
  type ApprovalAction,
} from "./client.ts";
import { Transcript, type TranscriptMessage } from "./components/Transcript.tsx";
import { ActivityLine } from "./components/ActivityLine.tsx";
import { ApprovalPrompt } from "./components/ApprovalPrompt.tsx";

let _seq = 0;
const nextId = () => `m${Date.now()}-${_seq++}`;

// Event types that describe live agent/tool work (drive the activity line).
const ACTIVITY_TYPES = new Set<string>([
  "agent.dispatched", "agent.start", "agent.step", "agent.progress",
  "agent.completed", "agent.finish", "agent.end", "agent.error",
  "pipeline.start", "pipeline.finish", "task.created", "task.status",
  "task.completed", "error",
]);

export interface AppProps {
  baseUrl: string;
  cookie: string;
  userId: string;
}

export function App({ baseUrl, cookie, userId }: AppProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [activity, setActivity] = useState<NovaEvent | null>(null);
  const [pending, setPending] = useState<{ approvalId: string; summary?: string } | null>(null);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("connecting…");
  const lastAssistantRef = useRef<string>("");

  const addMessage = (role: TranscriptMessage["role"], text: string) =>
    setMessages((prev) => [...prev, { id: nextId(), role, text }]);

  // Load history + open the activity stream.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    (async () => {
      try {
        const history = await fetchHistory(baseUrl, cookie, 20, userId);
        if (!cancelled) {
          setMessages(
            history
              .slice()
              .reverse()
              .filter((m) => m.role === "user" || m.role === "assistant")
              .map((m) => ({ id: nextId(), role: m.role as "user" | "assistant", text: String(m.content ?? "") })),
          );
        }
      } catch {
        /* history is best-effort */
      }

      try {
        setStatus("live");
        await connectActivityStream(baseUrl, cookie, onEvent, { signal: controller.signal });
        if (!cancelled) setStatus("stream ended");
      } catch (e: any) {
        if (!cancelled && e?.name !== "AbortError") setStatus(`stream error: ${e?.message || e}`);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, cookie, userId]);

  function onEvent(event: NovaEvent) {
    if (event.type === "chat.reply") {
      const text = String((event.data as any)?.text ?? "");
      const approval = extractApprovalFromEvent(event);
      if (approval) {
        // The "tap below to proceed" filler carries the keyboard — surface the
        // approval prompt using the previously streamed summary instead.
        setPending({ approvalId: approval.approvalId, summary: lastAssistantRef.current || text });
        return;
      }
      if (text.trim()) {
        lastAssistantRef.current = text;
        addMessage("assistant", text);
      }
      return;
    }
    if (event.type === "approval.resolved") {
      setPending(null);
      return;
    }
    if (ACTIVITY_TYPES.has(event.type)) setActivity(event);
  }

  async function onSubmit(value: string) {
    const text = value.trim();
    setInput("");
    if (!text) return;
    if (text === "/exit" || text === "/quit") {
      exit();
      return;
    }
    addMessage("user", text);
    try {
      const res = await sendChat(baseUrl, cookie, text, userId);
      if (res && res.success === false) addMessage("system", `send failed: ${res.error || "unknown error"}`);
    } catch (e: any) {
      addMessage("system", `send failed: ${e?.message || e}`);
    }
  }

  async function onResolve(action: ApprovalAction) {
    const target = pending;
    setPending(null);
    if (!target) return;
    addMessage("system", `approval → ${action}`);
    try {
      const res = await approveCall(baseUrl, cookie, target.approvalId, action);
      if (res && res.success === false) addMessage("system", `approval failed: ${res.error || "unknown error"}`);
    } catch (e: any) {
      addMessage("system", `approval failed: ${e?.message || e}`);
    }
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="magentaBright">nova connect</Text>
        <Text color="gray">{baseUrl} · {status}</Text>
      </Box>

      <Box flexDirection="column" marginY={1}>
        <Transcript messages={messages} />
      </Box>

      <ActivityLine event={activity} />

      {pending ? (
        <Box marginTop={1}>
          <ApprovalPrompt summary={pending.summary} onResolve={onResolve} />
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color="cyan">{"> "}</Text>
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={onSubmit}
            placeholder="type a message ( /exit to quit )"
          />
        </Box>
      )}
    </Box>
  );
}
