import { getDb } from "./db.ts";
import { getResolvedSandboxName } from "./sandbox/index.ts";

const ACTION_TYPE_RULES: Array<[RegExp, string]> = [
  [/\b(send|reply|forward)\b.*\b(email|newsletter|mail)\b|\b(email|newsletter)\b.*\bsend\b/i, "email.send"],
  [/\b(publish|post|share)\b.*\b(instagram|facebook|twitter|x\.com|linkedin|tiktok|social)\b/i, "social.publish"],
  [/\b(ad|ads|campaign)\b.*\b(create|launch|budget|spend)\b|\b(create|launch)\b.*\b(ad|ads|campaign)\b/i, "ads.spend"],
  [/\b(deploy|ship|release)\b.*\b(app|site|website|code|build|version|feature|update|prod|production)\b/i, "code.deploy"],
  [/\b(schedule|book)\b.*\b(meeting|call|event)\b/i, "calendar.create"],
];

export function deriveActionType(description: string): string {
  for (const [pattern, type] of ACTION_TYPE_RULES) {
    if (pattern.test(description)) return type;
  }
  return "task.generic";
}

export function recordSubtaskAction(
  userId: string,
  phase: "prepare" | "execute",
  r: { description: string; agent?: string; success: boolean; artifacts?: unknown[] },
): string | null {
  try {
    return getDb().recordAction({
      user_id: userId,
      agent: r.agent ?? "nova",
      action_type: deriveActionType(r.description),
      phase,
      sandbox_backend: getResolvedSandboxName() ?? "local",
      outcome: r.success ? "success" : "failed",
      artifacts: r.artifacts,
    });
  } catch (err) {
    console.error("[ledger] Failed to record action:", err);
    return null;
  }
}
