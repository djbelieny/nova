import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ApprovalAction } from "../client.ts";

const OPTIONS: Array<{ action: ApprovalAction; label: string; color: string }> = [
  { action: "approve", label: "Approve", color: "green" },
  { action: "revise", label: "Change", color: "yellow" },
  { action: "cancel", label: "Cancel", color: "red" },
];

/**
 * Inline approval prompt. Left/right (or h/l) to move, enter to choose;
 * shortcuts: a=approve, c=change, x=cancel.
 */
export function ApprovalPrompt({
  summary,
  onResolve,
}: {
  summary?: string;
  onResolve: (action: ApprovalAction) => void;
}) {
  const [idx, setIdx] = useState(0);

  useInput((input, key) => {
    if (key.leftArrow || input === "h") setIdx((i) => (i + OPTIONS.length - 1) % OPTIONS.length);
    else if (key.rightArrow || input === "l") setIdx((i) => (i + 1) % OPTIONS.length);
    else if (key.return) onResolve(OPTIONS[idx].action);
    else if (input === "a") onResolve("approve");
    else if (input === "c") onResolve("revise");
    else if (input === "x") onResolve("cancel");
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text bold color="magenta">
        Approval required
      </Text>
      {summary ? <Text color="gray">{summary}</Text> : null}
      <Box marginTop={1}>
        {OPTIONS.map((opt, i) => (
          <Box key={opt.action} marginRight={2}>
            <Text
              color={i === idx ? "black" : opt.color}
              backgroundColor={i === idx ? opt.color : undefined}
              bold={i === idx}
            >
              {" "}
              {opt.label}{" "}
            </Text>
          </Box>
        ))}
      </Box>
      <Text color="gray">←/→ move · enter select · a/c/x shortcuts</Text>
    </Box>
  );
}
