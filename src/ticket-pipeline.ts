// src/ticket-pipeline.ts
import type { Database } from "./db.ts";
import { triageTicket } from "./ticket-triage.ts";
import { resolveProject } from "./ticket-repo-resolver.ts";
import { runFix } from "./ticket-fixer.ts";

export interface PipelineDeps {
  runLLM: (systemPrompt: string, userPrompt: string) => Promise<string>;
  runAgent: (cwd: string, task: string) => Promise<void>;
}

export async function advanceTicket(db: Database, userId: string, ticketId: string, deps: PipelineDeps): Promise<string> {
  const t = db.getSupportTicket(userId, ticketId);
  if (!t) return "missing";

  try {
    if (t.status === "new") {
      const { classification, severity } = await triageTicket(t, deps.runLLM);
      db.updateSupportTicket(userId, ticketId, { classification, severity, status: "triaged" });
      return "triaged";
    }
    if (t.status === "triaged") {
      const { project, escalate } = resolveProject(db, userId, t.client_email);
      if (escalate || !project) {
        db.updateSupportTicket(userId, ticketId, { status: "escalated", last_error: "no matching project for sender" });
        return "escalated";
      }
      db.updateSupportTicket(userId, ticketId, { project_id: project.id, status: "resolving" });
      return "resolving";
    }
    if (t.status === "resolving") {
      const project = db.getUserProjectById(userId, t.project_id);
      if (!project?.local_path || !project?.test_command) {
        db.updateSupportTicket(userId, ticketId, { status: "escalated", last_error: "project missing local_path/test_command" });
        return "escalated";
      }
      db.updateSupportTicket(userId, ticketId, { status: "fixing" });
      const r = await runFix({ project, ticket: t, runAgent: deps.runAgent });
      if (!r.success) {
        db.updateSupportTicket(userId, ticketId, { status: "escalated", branch_name: r.branchName, test_results: r.testResults, last_error: "tests did not pass" });
        return "escalated";
      }
      db.updateSupportTicket(userId, ticketId, { status: "awaiting_approval", branch_name: r.branchName, diff_summary: r.diffSummary, test_results: r.testResults });
      return "awaiting_approval";
    }
    return t.status;
  } catch (e: any) {
    db.updateSupportTicket(userId, ticketId, { status: "failed", last_error: String(e?.message || e).slice(0, 500) });
    return "failed";
  }
}

// Real wiring used by the worker (Task 9). Kept here so the seam is one import.
export function defaultLLM(): (s: string, u: string) => Promise<string> {
  return async (systemPrompt, userPrompt) => {
    const { ClaudeProvider } = await import("./providers/claude.ts");
    const p = new ClaudeProvider();
    const res = await p.call({ prompt: userPrompt, systemPrompt, model: "haiku", outputFormat: "text", noMcp: true });
    return res.text || "";
  };
}

// SECURITY NOTE: defaultAgent runs with bypassPermissions while processing untrusted email
// content. It delegates to ClaudeProvider.call, whose spawn already scrubs the process env to
// least-privilege via buildAgentEnv (no wholesale inheritance of Nova's .env secrets). The
// remaining hardening for untrusted email is running this under the Docker sandbox (Fix 4) —
// isolating the working directory and filesystem/network access, not just the env.
// See: docs/superpowers/specs/2026-06-18-support-ticket-pipeline-design.md
export function defaultAgent(): (cwd: string, task: string) => Promise<void> {
  return async (cwd, task) => {
    const { ClaudeProvider } = await import("./providers/claude.ts");
    const p = new ClaudeProvider();
    await p.call({ prompt: task, cwd, model: "sonnet", outputFormat: "text", maxTurns: 40 });
  };
}
