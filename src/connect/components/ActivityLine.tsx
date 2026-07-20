import React from "react";
import { Box, Text } from "ink";
import type { NovaEvent } from "../../events.ts";

/** Turn a NovaEvent into a compact one-line description for the live activity line. */
export function describeEvent(event: NovaEvent): string {
  const who = event.agentDisplayName || event.agentSlug || event.execRole || event.data?.module || "";
  const step = event.stepMessage || event.data?.message || event.data?.description || "";
  const label = who ? `${who}` : event.type;
  switch (event.type) {
    case "agent.dispatched":
    case "agent.start":
      return `→ ${label} started${step ? `: ${step}` : ""}`;
    case "agent.step":
    case "agent.progress":
      return `· ${label}${step ? `: ${step}` : ""}`;
    case "agent.completed":
    case "agent.finish":
    case "agent.end":
      return `✓ ${label} done`;
    case "agent.error":
    case "error":
      return `✗ ${label || "error"}${step ? `: ${step}` : ""}`;
    case "pipeline.start":
      return `▶ pipeline${step ? `: ${step}` : ""}`;
    case "pipeline.finish":
      return `■ pipeline done`;
    case "task.created":
      return `+ task${step ? `: ${step}` : ""}`;
    case "task.completed":
      return `✓ task done${step ? `: ${step}` : ""}`;
    default:
      return step ? `${label}: ${step}` : label;
  }
}

export function ActivityLine({ event }: { event: NovaEvent | null }) {
  if (!event) {
    return (
      <Box>
        <Text color="gray">idle</Text>
      </Box>
    );
  }
  const isError = event.level === "error" || event.type === "error" || event.type === "agent.error";
  return (
    <Box>
      <Text color={isError ? "red" : "yellow"} dimColor={!isError}>
        {describeEvent(event)}
      </Text>
    </Box>
  );
}
