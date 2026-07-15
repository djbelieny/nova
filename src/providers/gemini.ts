/**
 * Gemini CLI Provider
 *
 * Wraps the `gemini` CLI binary. Uses `-p` for headless mode, `--output-format json`
 * for structured output, and `--yolo` for auto-approving actions.
 *
 * Key differences from Claude:
 * - JSON output: { response, stats: { models: { [name]: { tokens } }, tools, files } }
 * - MCP config: reads from ~/.gemini/settings.json (no --mcp-config flag)
 * - No --max-turns flag
 * - No auto-loading of .claude/agents/ or .claude/skills/
 */

import { spawn } from "bun";
import { writeFile, mkdir, rm } from "fs/promises";
import { mkdirSync } from "fs";
import { wrapForExecution } from "../sandbox/index.ts";
import { join } from "path";
import { readFileSync, readdirSync, copyFileSync } from "fs";
import type { AIProvider, AIProviderCallOpts, AIProviderResult, ModelTier, ProviderCostClass } from "../ai-provider.ts";

export class GeminiProvider implements AIProvider {
  readonly name = "gemini";
  readonly models = ["gemini-2.5-flash", "gemini-2.5-pro"];
  readonly defaultModel = "gemini-2.5-flash";
  readonly costClass: ProviderCostClass = 'subscription-cli';
  readonly supportedTiers: ModelTier[] = ['fast', 'standard'];

  private binaryPath: string;
  private _availCache: { result: boolean; ts: number } | null = null;

  constructor() {
    this.binaryPath = process.env.GEMINI_PATH || "gemini";
  }

  mapModelTier(tier: ModelTier): string {
    switch (tier) {
      case "fast": return "gemini-2.5-flash";
      case "standard": return "gemini-2.5-pro";
      case "premium": return "gemini-2.5-pro";
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
      "--skip-trust",  // required for headless/non-interactive use outside trusted dirs
    ];

    // Only add --yolo for non-sandboxed calls (agent task execution).
    // Sandboxed calls (classification, summarization) run with default permissions.
    if (!opts.sandboxed) {
      args.push("--yolo");
    }

    if (opts.model) {
      args.push("-m", opts.model);
    }

    // Gemini doesn't support --max-turns, so we rely on timeout instead

    // MCP config: Gemini reads from ~/.gemini/settings.json, not a CLI flag.
    // If mcpConfigPath is provided, write a temp settings.json in a temp HOME dir.
    // Skip MCP config when using mcp2cli — tools accessed via Bash commands instead.
    const novaWorkspace = `${process.env.HOME || "~"}/.nova/workspace`;
    const userWorkspace = opts.userId ? `${novaWorkspace}/users/${opts.userId}` : novaWorkspace;
    let cwd = opts.sandboxed ? userWorkspace : (opts.cwd || "/tmp");
    let homeOverride: string | undefined;
    if (opts.mcpConfigPath && !opts.useMcp2cli) {
      homeOverride = await this.prepareMcpConfig(opts.mcpConfigPath);
    }

    const startTime = Date.now();

    const { getModelApiKey } = await import("../shared-credentials.ts");
    const { getDb } = await import("../db.ts");
    const geminiKey = getModelApiKey(getDb(), "gemini") || process.env.GEMINI_API_KEY;

    const isToolExecution = !opts.sandboxed && !opts.noMcp;
    // Never mount host /tmp (gemini's non-sandboxed cwd default) into the
    // container — use the caller's cwd when given, else the per-user workspace.
    const dockerWorkspace = opts.cwd || userWorkspace;
    if (isToolExecution) { try { mkdirSync(dockerWorkspace, { recursive: true }); } catch {} }
    const wrapped = await wrapForExecution(args, cwd, isToolExecution, {
      network: "bridge",
      envPassthrough: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "PATH"],
      workspaceDir: dockerWorkspace,
    });
    if (wrapped.argv[0] === "docker" && homeOverride) {
      console.warn("[sandbox] gemini MCP settings (temp HOME) are not applied inside the docker sandbox; use the local backend if MCP tools are required.");
    }

    const proc = spawn(wrapped.argv, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: wrapped.cwd,
      env: {
        ...process.env,
        GEMINI_API_KEY: geminiKey || undefined,
        // Override HOME so Gemini finds our temp ~/.gemini/settings.json
        ...(homeOverride ? { HOME: homeOverride } : {}),
      },
    });

    const [output, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;
    const durationMs = Date.now() - startTime;
    const modelLabel = opts.model || this.defaultModel;

    // Clean up temp MCP config dir
    if (homeOverride) {
      rm(homeOverride, { recursive: true, force: true }).catch(() => {});
    }

    if (outputFormat === "text") {
      if (exitCode !== 0) {
        throw new Error(`Gemini CLI exited with code ${exitCode}: ${stderr.trim() || "(no stderr)"}`);
      }
      return {
        text: output.trim(),
        model: modelLabel,
        provider: this.name,
        duration_ms: durationMs,
      };
    }

    // JSON output parsing
    if (exitCode !== 0) {
      console.error(`[gemini] Error (exit ${exitCode}): ${stderr.trim()}`);

      // Try to parse error from JSON output
      try {
        const json = JSON.parse(output.trim());
        if (json.error) {
          const err = new Error(`Gemini: ${json.error.message || json.error.type || "Unknown error"}`);
          (err as any).isRateLimit = (json.error.code === 429);
          throw err;
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("Gemini:")) throw e;
      }

      const isRateLimit = stderr.includes("rate") || stderr.includes("429") || stderr.includes("quota");
      const err = new Error(`Gemini CLI exited with code ${exitCode}: ${stderr.trim()}`);
      (err as any).isRateLimit = isRateLimit;
      throw err;
    }

    // Parse successful JSON response
    try {
      const json = JSON.parse(output.trim());
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

  /**
   * Convert .mcp.nova.json format to Gemini's settings.json and write to temp dir.
   * Returns the temp dir path to use as cwd.
   */
  private async prepareMcpConfig(mcpConfigPath: string): Promise<string> {
    const tmpDir = `/tmp/nova-gemini-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const geminiDir = join(tmpDir, ".gemini");
    await mkdir(geminiDir, { recursive: true });

    try {
      const mcpContent = readFileSync(mcpConfigPath, "utf-8");
      const mcpConfig = JSON.parse(mcpContent);

      // Gemini uses the same mcpServers format, just in settings.json
      const settings: any = {};
      if (mcpConfig.mcpServers) {
        settings.mcpServers = mcpConfig.mcpServers;
      }

      // Merge hooks from the real ~/.gemini/settings.json (e.g. RTK hook)
      const realHome = process.env.HOME || "/home/nova";
      try {
        const realSettings = JSON.parse(readFileSync(join(realHome, ".gemini", "settings.json"), "utf-8"));
        if (realSettings.hooks) {
          settings.hooks = realSettings.hooks;
        }
      } catch {}

      await writeFile(join(geminiDir, "settings.json"), JSON.stringify(settings, null, 2));

      // Copy hook scripts so they're accessible from the temp HOME
      try {
        const hooksDir = join(realHome, ".gemini", "hooks");
        const tmpHooksDir = join(geminiDir, "hooks");
        await mkdir(tmpHooksDir, { recursive: true });
        for (const f of readdirSync(hooksDir)) {
          copyFileSync(join(hooksDir, f), join(tmpHooksDir, f));
        }
      } catch {}
    } catch (err) {
      console.warn(`[gemini] Failed to prepare MCP config: ${err}`);
    }

    // Run with HOME set to tmpDir so Gemini finds ~/.gemini/settings.json
    return tmpDir;
  }

  private parseJsonResult(json: any, modelLabel: string, durationMs: number): AIProviderResult {
    const text = json.response || "";

    if (!text.trim()) {
      console.warn(`[gemini] Empty response (${durationMs}ms)`);
    }

    // Extract token usage from stats.models
    let usage: AIProviderResult["usage"] = undefined;
    if (json.stats?.models) {
      const modelStats = Object.values(json.stats.models)[0] as any;
      if (modelStats?.tokens) {
        usage = {
          input_tokens: modelStats.tokens.prompt || modelStats.tokens.promptTotal || 0,
          output_tokens: modelStats.tokens.response || modelStats.tokens.responseTotal || 0,
        };
      }
    }

    // Resolve model name from stats
    const resolvedModel = json.stats?.models
      ? Object.keys(json.stats.models)[0] || modelLabel
      : modelLabel;

    return {
      text: text || "I wasn't able to generate a response. Please try again.",
      model: resolvedModel,
      provider: this.name,
      usage,
      cost_usd: 0, // Gemini Flash is free tier; Pro pricing TBD
      duration_ms: durationMs,
      raw: json,
    };
  }
}
