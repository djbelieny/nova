import React from "react";
import { Box, Text } from "ink";

export interface TranscriptMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
}

const ROLE_LABEL: Record<TranscriptMessage["role"], string> = {
  user: "you",
  assistant: "nova",
  system: "···",
};

const ROLE_COLOR: Record<TranscriptMessage["role"], string> = {
  user: "cyan",
  assistant: "green",
  system: "gray",
};

/** Scrolling transcript — renders the last `max` messages. */
export function Transcript({ messages, max = 20 }: { messages: TranscriptMessage[]; max?: number }) {
  const visible = messages.slice(-max);
  return (
    <Box flexDirection="column">
      {visible.length === 0 ? (
        <Text color="gray">No messages yet. Say hi.</Text>
      ) : (
        visible.map((m) => (
          <Box key={m.id} flexDirection="row">
            <Text color={ROLE_COLOR[m.role]} bold>
              {ROLE_LABEL[m.role].padEnd(4)}{" "}
            </Text>
            <Box flexGrow={1}>
              <Text color={m.role === "system" ? "gray" : undefined}>{m.text}</Text>
            </Box>
          </Box>
        ))
      )}
    </Box>
  );
}
