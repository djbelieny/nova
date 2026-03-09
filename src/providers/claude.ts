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
import type { AIProvider, AIProviderCallOpts, AIProviderResult, ModelTier } from "../ai-provider.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

export class ClaudeProvider implements AIProvider {
  readonly name = "claude";
  readonly models = ["haiku", "sonnet", "opus"];
  readonly defaultModel = "sonnet";

  private binaryPath: string;

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
    try {
      const proc = spawn([this.binaryPath, "--version"], { stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      return true;
    } catch {
      return false;
    }
  }

  async call(opts: AIProviderCallOpts): Promise<AIProviderResult> {
    const outputFormat = opts.outputFormat || "json";
    const args = [
      this.binaryPath,
      "-p", opts.prompt,
      "--output-format", outputFormat,
      "--permission-mode", "bypassPermissions",
      "--max-turns", String(opts.maxTurns ?? process.env.MAX_CLAUDE_TURNS ?? 50),
    ];

    if (opts.model) {
      args.push("--model", opts.model);
    }

    if (opts.noMcp) {
      // Don't pass --mcp-config at all — rely on /tmp cwd having no .mcp.json
      // Passing literal "{}" as --mcp-config breaks text output in newer CLI versions
    } else if (opts.mcpConfigPath) {
      args.push("--mcp-config", opts.mcpConfigPath, "--strict-mcp-config");
    }

    const cwd = opts.noMcp ? "/tmp" : (opts.cwd || PROJECT_ROOT);
    const startTime = Date.now();

    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd,
      env: {
        ...process.env,
        CLAUDECODE: undefined,
      },
    });

    const [output, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;
    const durationMs = Date.now() - startTime;
    const modelLabel = opts.model || this.defaultModel;

    if (outputFormat === "text") {
      if (exitCode !== 0) {
        throw new Error(`Claude CLI exited with code ${exitCode}: ${stderr.trim() || "(no stderr)"}`);
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
      const stderrSnippet = stderr.trim() || "(empty stderr)";
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
        : stderr.trim() || `Claude CLI exited with code ${exitCode}`;

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
      // JSON parse failed — return raw text
      return {
        text: output.trim(),
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
