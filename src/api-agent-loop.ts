/**
 * API Agent Loop
 *
 * Makes an OpenAI-compatible API model agentic by driving the SAME bash + mcp2cli
 * machinery the subscription CLIs use — no new tool registry, no MCP client, no
 * schema injection. The model is handed exactly one native function-calling tool,
 * `bash(command)`, and each returned tool_call is executed in the existing sandbox
 * (via wrapForExecution) with its stdout/stderr fed back as a role:'tool' message.
 *
 * The loop terminates when the model returns assistant content with no tool_calls,
 * or at maxTurns. Usage is summed across turns and priced from the profile.
 */

import { spawn } from "bun";
import { mkdirSync, readFileSync } from "fs";
import { dirname } from "path";
import type { AIProviderResult } from "./ai-provider.ts";
import type { ProviderProfile } from "./providers/openai-compatible.ts";
import { wrapForExecution } from "./sandbox/index.ts";
import { buildMcp2cliInstructions, loadProjectMcpConfig } from "./mcp2cli.ts";
import { maybeWrapWithRtk } from "./rtk.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));
const MAX_TOOL_OUTPUT = 10_000;

export type BashRunner = (command: string) => Promise<string>;

interface McpServerConfig {
  type?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ApiAgentLoopArgs {
  profile: ProviderProfile;
  model: string;
  systemPrompt?: string;
  userPrompt: string;
  mcpConfigPath?: string;
  userId?: string;
  maxTurns: number;
  sandboxed: boolean;
  /** Injectable seams for testing. */
  fetchImpl?: typeof fetch;
  runBash?: BashRunner;
}

const BASH_TOOL = {
  type: "function",
  function: {
    name: "bash",
    description:
      "Execute a bash command in the sandbox and return its stdout/stderr. Use this to run mcp2cli (and other CLI tools) to accomplish the task.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The bash command to execute" },
      },
      required: ["command"],
    },
  },
};

function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name) => process.env[name] ?? "");
}

export function chatCompletionsUrl(profile: ProviderProfile): string {
  return `${profile.baseUrl.replace(/\/$/, "")}/chat/completions`;
}

export function buildProviderHeaders(profile: ProviderProfile, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
  };
  if (profile.headers) {
    for (const [k, v] of Object.entries(profile.headers)) headers[k] = expandEnv(v);
  }
  return headers;
}

export function computeApiCost(
  profile: ProviderProfile,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  if (profile.pricePerMTokIn == null && profile.pricePerMTokOut == null) return undefined;
  return (
    (inputTokens / 1_000_000) * (profile.pricePerMTokIn ?? 0) +
    (outputTokens / 1_000_000) * (profile.pricePerMTokOut ?? 0)
  );
}

/**
 * Remove leaked tool/reasoning XML that weak models emit into content. Handles
 * paired <tool_call>…</tool_call> / <tool_calls>… / <think>…</think> / <thinking>…
 * blocks as well as unterminated openings (strip to end of string).
 */
export function stripLeakedToolXml(text: string): string {
  if (!text) return text;
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<tool_calls>[\s\S]*?<\/tool_calls>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    // Unterminated openings — strip from the tag to end of string.
    .replace(/<tool_call>[\s\S]*$/gi, "")
    .replace(/<tool_calls>[\s\S]*$/gi, "")
    .replace(/<thinking>[\s\S]*$/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .trim();
}

function resolveMcpServers(mcpConfigPath?: string): Record<string, McpServerConfig> {
  if (mcpConfigPath) {
    try {
      const config = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
      return config.mcpServers || {};
    } catch {
      return {};
    }
  }
  return loadProjectMcpConfig(PROJECT_ROOT) as Record<string, McpServerConfig>;
}

function buildSystemContent(systemPrompt: string | undefined, mcpConfigPath?: string): string {
  const parts: string[] = [];
  if (systemPrompt) parts.push(systemPrompt);
  const servers = resolveMcpServers(mcpConfigPath);
  const names = Object.keys(servers);
  if (names.length > 0) {
    const block = buildMcp2cliInstructions(names, servers);
    if (block) parts.push(block);
  }
  return parts.join("\n\n");
}

/** Default bash runner — executes the command in the existing sandbox. */
function makeDefaultRunBash(userId?: string): BashRunner {
  const novaWorkspace = `${process.env.HOME || "~"}/.nova/workspace`;
  const cwd = userId ? `${novaWorkspace}/users/${userId}` : novaWorkspace;
  return async (command: string): Promise<string> => {
    try { mkdirSync(cwd, { recursive: true }); } catch {}
    // Route through RTK (token-compressed output) when installed + enabled; passthrough otherwise.
    const finalCommand = await maybeWrapWithRtk(command);
    const argv = ["bash", "-lc", finalCommand];
    const wrapped = await wrapForExecution(argv, cwd, true, {
      network: "bridge",
      workspaceDir: cwd,
    });
    const proc = spawn(wrapped.argv, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: wrapped.cwd,
      env: { ...process.env },
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    const combined = [stdout, stderr].filter((s) => s.trim()).join("\n").trim();
    return combined.slice(0, MAX_TOOL_OUTPUT) || "(no output)";
  };
}

export async function runApiAgentLoop(args: ApiAgentLoopArgs): Promise<AIProviderResult> {
  const apiKey = process.env[args.profile.apiKeyEnv];
  if (!apiKey) throw new Error(`${args.profile.apiKeyEnv} not set`);

  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  const runBash = args.runBash ?? makeDefaultRunBash(args.userId);
  const maxTurns = args.maxTurns > 0 ? args.maxTurns : 25;

  const systemContent = buildSystemContent(args.systemPrompt, args.mcpConfigPath);
  const messages: any[] = [];
  if (systemContent) messages.push({ role: "system", content: systemContent });
  messages.push({ role: "user", content: args.userPrompt });

  const url = chatCompletionsUrl(args.profile);
  const headers = buildProviderHeaders(args.profile, apiKey);

  const startMs = performance.now();
  let inputTokens = 0;
  let outputTokens = 0;
  let finalText = "";
  let turns = 0;

  for (let i = 0; i < maxTurns; i++) {
    turns++;
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: args.model,
        messages,
        tools: [BASH_TOOL],
        temperature: 0.3,
        ...args.profile.extraBody,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`${args.profile.name} API error ${res.status}: ${body.slice(0, 300)}`);
    }

    const json = (await res.json()) as any;
    inputTokens += json?.usage?.prompt_tokens ?? 0;
    outputTokens += json?.usage?.completion_tokens ?? 0;

    const message = json?.choices?.[0]?.message ?? {};
    const toolCalls: any[] = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    messages.push({ role: "assistant", content: message.content ?? "", tool_calls: message.tool_calls });
    finalText = message.content ?? finalText;

    if (toolCalls.length === 0) break;

    for (const tc of toolCalls) {
      let output: string;
      if (tc?.function?.name === "bash") {
        let command = "";
        try {
          command = JSON.parse(tc.function.arguments ?? "{}").command ?? "";
        } catch {
          command = "";
        }
        output = command ? await runBash(command) : "(no command provided)";
      } else {
        output = `Unknown tool: ${tc?.function?.name ?? "(unnamed)"}`;
      }
      messages.push({ role: "tool", tool_call_id: tc.id, content: output });
    }
  }

  return {
    text: stripLeakedToolXml(finalText),
    model: args.model,
    provider: args.profile.name,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    cost_usd: computeApiCost(args.profile, inputTokens, outputTokens),
    duration_ms: Math.round(performance.now() - startMs),
    num_turns: turns,
  };
}
