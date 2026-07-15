/**
 * Claude Code CLI Provider
 *
 * Wraps the `claude` CLI binary. Supports JSON output parsing, MCP config
 * passthrough, model selection, and max turns limiting.
 *
 * JSON output format: { result, usage, cost_usd, model, session_id, num_turns, subtype }
 */

import { spawn } from "bun";
import { dirname } from "path";
import { mkdirSync } from "fs";
import type { AIProvider, AIProviderCallOpts, AIProviderResult, ModelTier, ProviderCostClass } from "../ai-provider.ts";
import { wrapForExecution } from "../sandbox/index.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));
const CLI_TIMEOUT_MS = 300_000;

// Credential env vars forwarded into the docker sandbox so the CLI can
// authenticate against the model API over the bridge network.
const CLAUDE_ENV_PASSTHROUGH = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "PATH",
];

export { wrapForExecution };

export class ClaudeProvider implements AIProvider {
  readonly name = "claude";
  readonly models = ["haiku", "sonnet", "opus"];
  readonly defaultModel = "sonnet";
  readonly costClass: ProviderCostClass = 'subscription-cli';
  readonly supportedTiers: ModelTier[] = ['fast', 'standard', 'premium'];

  private binaryPath: string;
  private _availCache: { result: boolean; ts: number } | null = null;

  constructor() {
    this.binaryPath = process.env.CLAUDE_PATH || "claude";
  }

  mapModelTier(tier: ModelTier): string {
    switch (tier) {
      case "fast": return "haiku";
      case "standard": return "sonnet";
      case "premium": return "opus";
    }
  }

  async isAvailable(): Promise<boolean> {
    if (this._availCache && Date.now() - this._availCache.ts < 300_000) {
      return this._availCache.result;
    }
    try {
      const proc = spawn([this.binaryPath, "--version"], { stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      this._availCache = { result: true, ts: Date.now() };
      return true;
    } catch {
      this._availCache = { result: false, ts: Date.now() };
      return false;
    }
  }

  async call(opts: AIProviderCallOpts): Promise<AIProviderResult> {
    const outputFormat = opts.outputFormat || "json";
    const args = [
      this.binaryPath,
      "-p", opts.prompt,
      "--output-format", outputFormat,
      "--max-turns", String(opts.maxTurns ?? process.env.MAX_CLAUDE_TURNS ?? 50),
    ];

    if (opts.systemPrompt) {
      args.push("--system-prompt", opts.systemPrompt);
    }

    // Only add bypass flag for non-sandboxed calls (agent task execution).
    // Sandboxed calls (classification, summarization) run with default permissions.
    if (!opts.sandboxed) {
      args.push("--permission-mode", "bypassPermissions");
    }

    if (opts.model) {
      args.push("--model", opts.model);
    }

    if (opts.noMcp || opts.useMcp2cli) {
      // Don't pass --mcp-config — either no tools needed, or tools accessed via mcp2cli Bash commands
    } else if (opts.mcpConfigPath) {
      args.push("--mcp-config", opts.mcpConfigPath, "--strict-mcp-config");
    }

    // Determine working directory:
    // - noMcp calls: /tmp (no filesystem access needed)
    // - sandboxed calls: ~/.nova/workspace (or user-scoped subdir when userId known)
    // - agent task calls: cwd passed by caller, fallback to PROJECT_ROOT for mcp2cli
    const novaWorkspace = `${process.env.HOME || "~"}/.nova/workspace`;
    const userWorkspace = opts.userId ? `${novaWorkspace}/users/${opts.userId}` : novaWorkspace;
    const cwd = opts.noMcp
      ? "/tmp"
      : opts.sandboxed
        ? userWorkspace
        : (opts.cwd || PROJECT_ROOT);
    const startTime = Date.now();
    const isToolExecution = !opts.sandboxed && !opts.noMcp;
    // Docker mounts the caller's explicit workspace when given (so flows like the
    // dev-task-dispatcher operate on the same dir the host inspects), but never
    // the repo (PROJECT_ROOT is .../nova/src; REPO_ROOT its parent holds .env,
    // .mcp.json, data/) — fall back to the per-user nova workspace there.
    const REPO_ROOT = dirname(PROJECT_ROOT);
    const dockerWorkspace = (opts.cwd && opts.cwd !== PROJECT_ROOT && opts.cwd !== REPO_ROOT)
      ? opts.cwd
      : (opts.userId ? userWorkspace : novaWorkspace);
    if (isToolExecution) {
      try { mkdirSync(dockerWorkspace, { recursive: true }); } catch {}
    }
    const wrapped = await wrapForExecution(args, cwd, isToolExecution, {
      network: "bridge",
      envPassthrough: CLAUDE_ENV_PASSTHROUGH,
      workspaceDir: dockerWorkspace,
    });
    if (wrapped.argv[0] === "docker" && !opts.noMcp && !opts.useMcp2cli && opts.mcpConfigPath) {
      console.warn("[sandbox] claude --mcp-config host path is not mounted inside the docker sandbox; MCP tools via config file are unavailable in this mode (use mcp2cli or the local backend).");
    }

    const proc = spawn(wrapped.argv, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: wrapped.cwd,
      env: {
        ...process.env,
        CLAUDECODE: undefined,
      },
    });

    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, CLI_TIMEOUT_MS);

    let output: string;
    let stderrOutput: string;
    try {
      [output, stderrOutput] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
    } finally {
      clearTimeout(timeoutId);
    }

    if (timedOut) {
      throw new Error("Claude CLI timed out after 5 minutes. Try a simpler request.");
    }

    const exitCode = await proc.exited;
    const durationMs = Date.now() - startTime;
    const modelLabel = opts.model || this.defaultModel;

    if (outputFormat === "text") {
      if (exitCode !== 0) {
        throw new Error(`Claude CLI exited with code ${exitCode}: ${stderrOutput.trim() || "(no stderr)"}`);
      }
      const text = output.trim();
      return {
        text: text || "Sorry, I wasn't able to process that. Can you try again?",
        model: modelLabel,
        provider: this.name,
        duration_ms: durationMs,
      };
    }

    // JSON output parsing
    if (exitCode !== 0) {
      const stderrSnippet = stderrOutput.trim() || "(empty stderr)";
      const stdoutTail = output.trim().slice(-500) || "(empty stdout)";
      console.error(`[claude] Error (exit ${exitCode}): stderr=${stderrSnippet} | stdout_tail=${stdoutTail}`);

      // Try to salvage a result from non-zero exit
      try {
        const json = JSON.parse(output.trim());
        if (json.result && typeof json.result === "string" && json.result.trim()) {
          console.warn(`[claude] Salvaged result from non-zero exit (code ${exitCode}, ${json.result.length} chars)`);
          return this.parseJsonResult(json, modelLabel, durationMs);
        }
      } catch {}

      const isRateLimit = stderrSnippet.includes("rate") || stderrSnippet.includes("overloaded");
      const isApiError = stderrSnippet.includes("APIError") || stderrSnippet.includes("status code");
      const detail = isApiError
        ? stderrSnippet.substring(0, 300)
        : stderrOutput.trim() || `Claude CLI exited with code ${exitCode}`;

      const err = new Error(`Claude CLI exited with code ${exitCode}: ${detail}`);
      (err as any).isRateLimit = isRateLimit;
      throw err;
    }

    // Parse successful JSON response
    try {
      const json = JSON.parse(output.trim());

      if (json.subtype === "error_max_turns") {
        console.warn(`[claude] Hit max turns (${json.num_turns} turns, ${durationMs}ms)`);
      }

      return this.parseJsonResult(json, modelLabel, durationMs);
    } catch {
      // JSON parse failed — return raw text with empty fallback
      const rawText = output.trim();
      return {
        text: rawText || "Sorry, I wasn't able to process that. Can you try again?",
        model: modelLabel,
        provider: this.name,
        duration_ms: durationMs,
      };
    }
  }

  private parseJsonResult(json: any, modelLabel: string, durationMs: number): AIProviderResult {
    let text = typeof json.result === "string" ? json.result : "";

    if (!text.trim()) {
      console.warn(`[claude] Empty result (${json.num_turns || "?"} turns, ${durationMs}ms)`);
      text = "Sorry, I wasn't able to complete that request — I ran out of processing steps. Try simplifying your request or breaking it into smaller parts.";
    }

    const resolvedModel = json.model
      || json.metadata?.model
      || (typeof json.result === "object" && json.result?.model)
      || process.env.ANTHROPIC_MODEL
      || modelLabel;

    return {
      text,
      model: resolvedModel,
      provider: this.name,
      usage: json.usage ? {
        input_tokens: json.usage.input_tokens || 0,
        output_tokens: json.usage.output_tokens || 0,
        cache_read_tokens: json.usage.cache_read_input_tokens || 0,
        cache_creation_tokens: json.usage.cache_creation_input_tokens || 0,
      } : undefined,
      cost_usd: json.cost_usd || json.total_cost_usd || 0,
      duration_ms: durationMs,
      session_id: json.session_id || undefined,
      num_turns: json.num_turns,
      raw: json,
    };
  }
}
