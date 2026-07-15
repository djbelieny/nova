/**
 * Post-execute verification phase.
 *
 * After a consequential (execute-phase) subtask runs, a cheap fast-tier model pass
 * checks whether the outcome actually achieved the task's goal — did the email send,
 * does the page render, did the campaign go live — BEFORE reporting done. The verdict
 * is written to `action_ledger.verification` and is the evidence source the autonomy
 * ladder depends on.
 *
 * This is best-effort: it must NEVER block or crash the execution path. Every failure
 * mode (bad model output, model throwing, uncheckable outcome) degrades to an explicit
 * `unverifiable` verdict rather than a false pass.
 */

import type { Database } from "./db.ts";

export type VerifyStatus = "verified" | "failed" | "unverifiable";

export interface VerifyVerdict {
  status: VerifyStatus;
  reason: string;
  confidence: number;
}

export interface VerifyInput {
  goal: string;
  result: string;
  artifacts?: { type: string; value: string }[];
  agent?: string;
}

export type VerifyModelCall = (opts: { prompt: string; systemPrompt?: string }) => Promise<string>;

const SYSTEM_PROMPT =
  "You are a verification checker. Given a task goal and the outcome that was produced, " +
  "judge whether the goal was actually achieved. Be skeptical: only answer 'verified' when " +
  "the outcome contains concrete evidence of success (a confirmation, an id, a live URL, a " +
  "200 status, a sent count). Answer 'failed' when the outcome shows the action did not " +
  "complete. Answer 'unverifiable' when the outcome cannot be cheaply checked from the text " +
  "(e.g. long-term/subjective goals, or no evidence either way). Never guess 'verified'.";

function buildPrompt(input: VerifyInput): string {
  const artifacts = (input.artifacts ?? [])
    .slice(0, 8)
    .map((a) => `- ${a.type}: ${String(a.value).slice(0, 300)}`)
    .join("\n");

  return [
    input.agent ? `Agent: ${input.agent}` : "",
    `Task goal: ${input.goal}`,
    `Produced outcome:\n${input.result.slice(0, 2000)}`,
    artifacts ? `Artifacts:\n${artifacts}` : "",
    "",
    'Reply with ONLY a JSON object: {"status":"verified"|"failed"|"unverifiable","reason":"<one sentence>","confidence":<0.0-1.0>}',
  ]
    .filter(Boolean)
    .join("\n\n");
}

function clampConfidence(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return 0.3;
  return Math.max(0, Math.min(1, v));
}

function normalizeStatus(s: unknown): VerifyStatus {
  const t = String(s ?? "").toLowerCase().trim();
  if (t === "verified") return "verified";
  if (t === "failed") return "failed";
  return "unverifiable";
}

function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Parse a model verdict. Lenient — extracts an embedded JSON object, falls back to a
 * `VERDICT: <status>` tag, and returns `unverifiable` when nothing parses. Never throws.
 */
export function parseVerdict(text: string): VerifyVerdict {
  const json = extractJson(text);
  if (json && "status" in json) {
    const status = normalizeStatus(json.status);
    return {
      status,
      reason: typeof json.reason === "string" && json.reason.trim() ? json.reason.trim().slice(0, 300) : "no reason given",
      confidence: clampConfidence(json.confidence),
    };
  }

  const tag = text.match(/VERDICT:\s*(verified|failed|unverifiable)/i);
  if (tag) {
    return {
      status: normalizeStatus(tag[1]),
      reason: text.trim().slice(0, 300) || "tag verdict",
      confidence: 0.5,
    };
  }

  return { status: "unverifiable", reason: "could not parse a verdict from the model output", confidence: 0.2 };
}

/** True when the outcome is too thin to verify without a model call. */
function isTriviallyUncheckable(input: VerifyInput): boolean {
  const hasArtifacts = (input.artifacts?.length ?? 0) > 0;
  return input.result.trim().length === 0 && !hasArtifacts;
}

/**
 * Default fast-tier model caller. Routes through the smart router to the cheapest available
 * provider. Fully wrapped so it can never throw — returns "" on any failure, which the
 * parser turns into an `unverifiable` verdict.
 */
const defaultCallModel: VerifyModelCall = async ({ prompt, systemPrompt }) => {
  try {
    const { selectProvider } = await import("./ai-router.ts");
    const route = await selectProvider({ tier: "fast" });
    const res = await route.provider.call({
      prompt,
      systemPrompt,
      model: route.model,
      outputFormat: "text",
      sandboxed: true,
      maxTurns: 1,
    });
    return res.text ?? "";
  } catch {
    return "";
  }
};

/**
 * Verify whether an executed outcome achieved its goal. Best-effort, never throws.
 */
export async function verifyOutcome(
  input: VerifyInput,
  callModel: VerifyModelCall = defaultCallModel,
): Promise<VerifyVerdict> {
  if (isTriviallyUncheckable(input)) {
    return { status: "unverifiable", reason: "no outcome text or artifacts to check", confidence: 0.2 };
  }

  let raw = "";
  try {
    raw = await callModel({ prompt: buildPrompt(input), systemPrompt: SYSTEM_PROMPT });
  } catch {
    return { status: "unverifiable", reason: "verification model call failed", confidence: 0.1 };
  }

  return parseVerdict(raw ?? "");
}

/**
 * Attach a verdict to an existing action_ledger row. Best-effort — never throws.
 */
export function recordVerification(
  userId: string,
  actionId: string | null | undefined,
  verdict: VerifyVerdict,
  db: Database,
): void {
  if (!actionId) return;
  try {
    db.updateActionVerification(userId, actionId, verdict);
  } catch (err) {
    console.error("[verify] Failed to record verification:", err);
  }
}
