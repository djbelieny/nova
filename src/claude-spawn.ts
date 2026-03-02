/**
 * Lean Claude CLI spawner for background services.
 *
 * When services like smart-checkin, morning-briefing, or task-dispatcher
 * spawn `claude -p`, the CLI loads the full project context: CLAUDE.md,
 * 25+ agent files, all skill definitions, and 11 MCP servers (300+ tools
 * from gohighlevel alone). This blows past the prompt length limit.
 *
 * This module provides a stripped-down spawner that:
 * 1. Disables skill/slash-command loading
 * 2. Filters MCP servers to only what the service needs
 * 3. Runs from /tmp so CLAUDE.md and .claude/agents/ aren't loaded
 */

import { spawn } from "bun";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { existsSync } from "fs";

const PROJECT_ROOT = join(dirname(import.meta.path), "..");

export interface ClaudeSpawnOpts {
  prompt: string;
  /** MCP servers to include (empty = no MCPs). */
  mcpServers?: string[];
  /** Model to use (haiku, sonnet, opus). */
  model?: string;
  /** Max turns. Default 5 for services. */
  maxTurns?: number;
  /** Working directory. Default /tmp (avoids loading CLAUDE.md + agents). */
  cwd?: string;
}

/**
 * Create a filtered MCP config with only the specified servers.
 * Reads from the project's .mcp.json and writes a subset to /tmp.
 */
async function createFilteredMcpConfig(servers: string[]): Promise<string> {
  const tmpDir = "/tmp/nova-mcp";
  await mkdir(tmpDir, { recursive: true });
  const key = servers.sort().join("-") || "none";
  const tmpPath = join(tmpDir, `${key}.json`);

  if (servers.length === 0) {
    await writeFile(tmpPath, '{"mcpServers":{}}');
    return tmpPath;
  }

  const mcpPath = join(PROJECT_ROOT, ".mcp.json");
  try {
    const content = await readFile(mcpPath, "utf-8");
    const config = JSON.parse(content);
    const filtered: any = { mcpServers: {} };
    for (const name of servers) {
      if (config.mcpServers?.[name]) {
        filtered.mcpServers[name] = config.mcpServers[name];
      }
    }
    await writeFile(tmpPath, JSON.stringify(filtered));
  } catch {
    await writeFile(tmpPath, '{"mcpServers":{}}');
  }

  return tmpPath;
}

/**
 * Spawn a lean Claude CLI process with minimal context.
 * Returns { output, exitCode }.
 */
export async function spawnLeanClaude(opts: ClaudeSpawnOpts): Promise<{
  output: string;
  exitCode: number;
  stderr: string;
}> {
  const claudePath = process.env.CLAUDE_PATH || "claude";
  const mcpConfig = await createFilteredMcpConfig(opts.mcpServers || []);

  const args = [
    claudePath,
    "-p", opts.prompt,
    "--output-format", "text",
    "--permission-mode", "bypassPermissions",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--mcp-config", mcpConfig,
    "--max-turns", String(opts.maxTurns ?? 5),
  ];

  if (opts.model) {
    args.push("--model", opts.model);
  }

  const proc = spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts.cwd || "/tmp",
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

  return { output: output.trim(), exitCode, stderr };
}
