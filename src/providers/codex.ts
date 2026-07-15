/**
 * OpenAI Codex CLI Provider
 *
 * Wraps the `codex` CLI binary (`codex exec` for non-interactive mode).
 * Supports JSONL output via `--json`, text output via `-o`, model selection,
 * and full sandbox bypass for automated use.
 *
 * JSONL events: { type: "message", role: "assistant", content: [...] }
 * Text output: last agent message written to temp file via `-o`
 */

import { spawn } from "bun";
import { readFile, unlink } from "fs/promises";
import { join } from "path";
import { mkdirSync } from "fs";
import { resolveSandboxBackend, wrapForExecution } from "../sandbox/index.ts";
import type { AIProvider, AIProviderCallOpts, AIProviderResult, ModelTier, ProviderCostClass } from "../ai-provider.ts";

export class CodexProvider implements AIProvider {
  readonly name = "codex";
  readonly models = ["o4-mini", "o3", "gpt-4.1"];
  readonly defaultModel = "o4-mini";
  readonly costClass: ProviderCostClass = 'subscription-cli';
  readonly supportedTiers: ModelTier[] = ['fast', 'standard'];

  private binaryPath: string;
  private _availCache: { result: boolean; ts: number } | null = null;

  constructor() {
    this.binaryPath = process.env.CODEX_PATH || "codex";
  }

  mapModelTier(tier: ModelTier): string {
    switch (tier) {
      case "fast": return "o4-mini";
      case "standard": return "o3";
      case "premium": return "o3";
    }
  }

  async isAvailable(): Promise<boolean> {
    if (this._availCache && Date.now() - this._availCache.ts < 300_000) {
      return this._availCache.result;
    }
    try {
      const proc = spawn([this.binaryPath, "--version"], { stdout: "pipe", stderr: "pipe" });
      const exitCode = await proc.exited;
      this._availCache = { result: exitCode === 0, ts: Date.now() };
      return exitCode === 0;
    } catch {
      this._availCache = { result: false, ts: Date.now() };
      return false;
    }
  }

  async call(opts: AIProviderCallOpts): Promise<AIProviderResult> {
    const outputFormat = opts.outputFormat || "json";
    const tmpFile = `/tmp/nova-codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;

    const args = [
      this.binaryPath,
      "exec",
      opts.prompt,
      "-o", tmpFile,
      "--skip-git-repo-check",
    ];

    // Only add bypass flag for non-sandboxed calls (agent task execution).
    // Sandboxed calls (classification, summarization) run with default permissions.
    if (!opts.sandboxed) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }

    if (outputFormat === "json") {
      args.push("--json");
    }

    if (opts.model) {
      args.push("-m", opts.model);
    }

    // Scope cwd to user workspace for sandboxed calls; otherwise use caller-supplied cwd
    const novaWorkspace = `${process.env.HOME || "~"}/.nova/workspace`;
    const userWorkspace = opts.userId ? `${novaWorkspace}/users/${opts.userId}` : novaWorkspace;
    const resolvedCwd = opts.sandboxed ? userWorkspace : opts.cwd;

    const isToolExecution = !opts.sandboxed && !opts.noMcp;
    const backend = isToolExecution ? await resolveSandboxBackend() : null;
    const inDocker = backend?.name === "docker";

    // In docker the container WORKDIR is /workspace, so the host `-C` path must
    // not be passed; codex defaults to the working directory (the mount).
    if (resolvedCwd && !inDocker) {
      args.push("-C", resolvedCwd);
    }

    const dockerWorkspace = resolvedCwd || userWorkspace;
    if (isToolExecution) { try { mkdirSync(dockerWorkspace, { recursive: true }); } catch {} }
    const wrapped = await wrapForExecution(args, dockerWorkspace, isToolExecution, {
      network: "bridge",
      envPassthrough: ["OPENAI_API_KEY", "PATH"],
      workspaceDir: dockerWorkspace,
    });

    const startTime = Date.now();

    const proc = spawn(wrapped.argv, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: inDocker ? wrapped.cwd : undefined,
      env: {
        ...process.env,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || undefined,
      },
    });

    const [output, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;
    const durationMs = Date.now() - startTime;
    const modelLabel = opts.model || this.defaultModel;

    if (exitCode !== 0) {
      // Clean up temp file
      unlink(tmpFile).catch(() => {});

      const stderrSnippet = stderr.trim() || "(empty stderr)";
      console.error(`[codex] Error (exit ${exitCode}): ${stderrSnippet}`);

      const isRateLimit = stderrSnippet.includes("rate") || stderrSnippet.includes("429") || stderrSnippet.includes("quota");
      const err = new Error(`Codex CLI exited with code ${exitCode}: ${stderrSnippet.substring(0, 300)}`);
      (err as any).isRateLimit = isRateLimit;
      throw err;
    }

    // Read last message from temp file
    let lastMessage = "";
    try {
      lastMessage = (await readFile(tmpFile, "utf-8")).trim();
    } catch {}
    unlink(tmpFile).catch(() => {});

    if (outputFormat === "text") {
      return {
        text: lastMessage || output.trim(),
        model: modelLabel,
        provider: this.name,
        duration_ms: durationMs,
      };
    }

    // Parse JSONL output for usage stats
    return this.parseJsonlResult(output, lastMessage, modelLabel, durationMs);
  }

  private parseJsonlResult(
    jsonlOutput: string,
    lastMessage: string,
    modelLabel: string,
    durationMs: number,
  ): AIProviderResult {
    let inputTokens = 0;
    let outputTokens = 0;
    let resolvedModel = modelLabel;
    let sessionId: string | undefined;

    // Parse JSONL events for metadata
    for (const line of jsonlOutput.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);

        if (event.type === "thread.started" && event.thread_id) {
          sessionId = event.thread_id;
        }

        // Extract usage from response events
        if (event.usage) {
          inputTokens += event.usage.input_tokens || event.usage.prompt_tokens || 0;
          outputTokens += event.usage.output_tokens || event.usage.completion_tokens || 0;
        }

        if (event.model) {
          resolvedModel = event.model;
        }

        // Extract text from message events if lastMessage is empty
        if (!lastMessage && event.type === "message" && event.role === "assistant") {
          if (Array.isArray(event.content)) {
            const textParts = event.content
              .filter((c: any) => c.type === "text" || c.type === "output_text")
              .map((c: any) => c.text || c.content || "");
            if (textParts.length > 0) lastMessage = textParts.join("\n");
          } else if (typeof event.content === "string") {
            lastMessage = event.content;
          }
        }
      } catch {
        // Skip unparseable lines
      }
    }

    if (!lastMessage.trim()) {
      console.warn(`[codex] Empty response (${durationMs}ms)`);
      lastMessage = "I wasn't able to generate a response. Please try again.";
    }

    return {
      text: lastMessage,
      model: resolvedModel,
      provider: this.name,
      usage: (inputTokens || outputTokens) ? {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      } : undefined,
      cost_usd: 0, // Codex doesn't report cost directly
      duration_ms: durationMs,
      session_id: sessionId,
      raw: jsonlOutput,
    };
  }
}
