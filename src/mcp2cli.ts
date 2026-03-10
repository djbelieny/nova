/**
 * mcp2cli Utility Module
 *
 * Converts MCP server configs from .mcp.json format into mcp2cli CLI commands.
 * This lets agents call MCP tools via Bash on-demand instead of loading all
 * 400+ tool schemas into context via --mcp-config (96-99% token savings).
 *
 * Usage flow:
 * 1. Agent prompt includes mcp2cli instructions for its assigned servers
 * 2. Agent discovers tools: mcp2cli --mcp-stdio "..." --list
 * 3. Agent calls tools: mcp2cli --mcp-stdio "..." --tool <name> --param key=val
 */

import { existsSync, readFileSync } from "fs";
import { spawn } from "bun";

let _available: boolean | null = null;

/**
 * Check if mcp2cli binary is available on the system.
 * Cached after first call.
 */
export async function isMcp2cliAvailable(): Promise<boolean> {
  if (_available !== null) return _available;
  try {
    const proc = spawn(["which", "mcp2cli"], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    _available = proc.exitCode === 0;
  } catch {
    _available = false;
  }
  if (_available) {
    console.log("[mcp2cli] Binary available");
  } else {
    console.warn("[mcp2cli] Binary not found — agents will use --mcp-config fallback");
  }
  return _available;
}

/**
 * Reset the availability cache (useful for testing).
 */
export function resetAvailabilityCache(): void {
  _available = null;
}

/**
 * Represents a parsed MCP server config entry.
 */
interface McpServerConfig {
  type?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Build a mcp2cli base command string for a given MCP server config.
 *
 * Converts:
 *   { command: "node", args: ["/path/cli.mjs"], env: { KEY: "${VAR}" } }
 * To:
 *   mcp2cli --mcp-stdio "node /path/cli.mjs" --env 'KEY=resolved_value'
 *
 * Environment variable placeholders like ${VAR} are resolved from process.env.
 */
export function buildMcp2cliCommand(
  serverName: string,
  config: McpServerConfig
): string | null {
  const cmd = config.command;
  const args = config.args || [];

  // Build the stdio command string
  const stdioCmd = [cmd, ...args].map(shellEscape).join(" ");

  const parts = ["mcp2cli", "--mcp-stdio", `"${stdioCmd}"`];

  // Resolve env vars and add --env flags
  if (config.env) {
    for (const [key, value] of Object.entries(config.env)) {
      const resolved = resolveEnvValue(value);
      if (resolved) {
        parts.push("--env", `'${key}=${resolved}'`);
      }
    }
  }

  return parts.join(" ");
}

/**
 * Build prompt instructions teaching an agent how to use mcp2cli for specific servers.
 * Returns a formatted text block to inject into the agent's system prompt.
 */
export function buildMcp2cliInstructions(
  serverNames: string[],
  mcpConfig: Record<string, McpServerConfig>
): string {
  const commands: { name: string; base: string }[] = [];

  for (const name of serverNames) {
    const config = mcpConfig[name];
    if (!config) continue;
    const base = buildMcp2cliCommand(name, config);
    if (base) {
      commands.push({ name, base });
    }
  }

  if (commands.length === 0) return "";

  const lines = [
    "MCP TOOLS — Available via mcp2cli (call from Bash):",
    "",
    "DISCOVERY — List all tools for a server:",
  ];

  for (const { name, base } of commands) {
    lines.push(`  # ${name}:`);
    lines.push(`  ${base} --list`);
  }

  lines.push("");
  lines.push("USAGE — Call a specific tool:");
  lines.push("  # After discovering tool names with --list, call them:");

  for (const { name, base } of commands) {
    lines.push(`  # ${name}:`);
    lines.push(`  ${base} --tool <tool_name> --param key=value --param key2=value2`);
  }

  lines.push("");
  lines.push("HELP — Get parameter details for a tool:");
  for (const { name, base } of commands) {
    lines.push(`  # ${name}:`);
    lines.push(`  ${base} --tool <tool_name> --help`);
  }

  lines.push("");
  lines.push("TIPS:");
  lines.push("- Use --list first to discover available tool names for each server.");
  lines.push("- Use --help on a tool to see its required and optional parameters.");
  lines.push("- For complex JSON values, use --stdin and pipe JSON input.");
  lines.push("- Tool calls are executed via Bash — wrap in Bash tool calls.");

  return lines.join("\n");
}

/**
 * Generate mcp2cli commands for a specific user's MCP config file.
 * Returns a map of serverName → mcp2cli base command string.
 */
export function generateMcp2cliCommands(
  mcpConfigPath: string
): Map<string, string> {
  const commands = new Map<string, string>();

  if (!existsSync(mcpConfigPath)) return commands;

  try {
    const raw = readFileSync(mcpConfigPath, "utf-8");
    const config = JSON.parse(raw);
    const servers = config.mcpServers || {};

    for (const [name, serverConfig] of Object.entries(servers)) {
      const cmd = buildMcp2cliCommand(name, serverConfig as McpServerConfig);
      if (cmd) {
        commands.set(name, cmd);
      }
    }
  } catch (err) {
    console.warn(`[mcp2cli] Failed to parse MCP config at ${mcpConfigPath}:`, err);
  }

  return commands;
}

/**
 * Load the project-level MCP config and return the mcpServers record.
 */
export function loadProjectMcpConfig(projectRoot: string): Record<string, McpServerConfig> {
  try {
    const raw = readFileSync(`${projectRoot}/.mcp.json`, "utf-8");
    const config = JSON.parse(raw);
    return config.mcpServers || {};
  } catch {
    return {};
  }
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Resolve a ${VAR} placeholder from process.env.
 * Returns the resolved value or the original string if no placeholder.
 * Returns empty string if the env var is not set.
 */
function resolveEnvValue(value: string): string {
  const match = value.match(/^\$\{(\w+)\}$/);
  if (match) {
    return process.env[match[1]] || "";
  }
  return value;
}

/**
 * Shell-escape a string for safe inclusion in a command.
 */
function shellEscape(s: string): string {
  // If the string contains spaces or special chars, wrap in single quotes
  if (/[^a-zA-Z0-9_\-./=@:]/.test(s)) {
    return `'${s.replace(/'/g, "'\\''")}'`;
  }
  return s;
}
