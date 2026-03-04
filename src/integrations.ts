/**
 * Per-User Integration Manager
 *
 * Manages OAuth flows and MCP config generation for per-user integrations:
 * - Google Personal (google-personal)
 * - Google Work (google-work)
 * - Notion (notion)
 * - Zoom (zoom) — User OAuth (click "Connect" → Zoom authorize → callback)
 * - Go High Level (gohighlevel) — API-key based, no OAuth
 * - ClickUp (clickup) — API-key based, no OAuth
 *
 * Global MCP servers (cloudflare, square, playwright) are inherited from
 * the project-level .mcp.json and included in every user's config.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { existsSync } from "fs";
import { execSync } from "child_process";
import { createHmac } from "crypto";
import type { Database } from "./db.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

/** Per-provider redirect URI overrides (env var). Falls back to standard callback path. */
function getRedirectUri(provider: string, baseUrl: string): string {
  const envKey = `${provider.toUpperCase().replace(/-/g, "_")}_REDIRECT_URI`;
  const override = process.env[envKey];
  if (override) return override;
  return `${baseUrl}/api/integrations/callback`;
}
const NOVA_DIR = process.env.NOVA_DIR || process.env.RELAY_DIR || join(process.env.HOME || "~", ".nova");
const USERS_DIR = join(NOVA_DIR, "users");

// ============================================================
// OAUTH STATE SIGNING
// ============================================================

function getOAuthHmacSecret(): string {
  const secret = process.env.TELEGRAM_BOT_TOKEN;
  if (!secret) {
    throw new Error("TELEGRAM_BOT_TOKEN is required for OAuth HMAC signing — set it in .env");
  }
  return secret;
}

export function signOAuthState(payload: Record<string, any>): string {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json).toString("base64");
  const sig = createHmac("sha256", getOAuthHmacSecret()).update(b64).digest("hex").slice(0, 16);
  return encodeURIComponent(`${b64}.${sig}`);
}

export function verifyOAuthState(stateParam: string): Record<string, any> | null {
  const decoded = decodeURIComponent(stateParam);
  const dotIndex = decoded.lastIndexOf(".");
  if (dotIndex === -1) return null;

  const b64 = decoded.slice(0, dotIndex);
  const sig = decoded.slice(dotIndex + 1);

  const expected = createHmac("sha256", getOAuthHmacSecret()).update(b64).digest("hex").slice(0, 16);
  if (sig !== expected) return null;

  try {
    return JSON.parse(Buffer.from(b64, "base64").toString());
  } catch {
    return null;
  }
}

// ============================================================
// GLOBAL BINARY RESOLUTION (skip npx overhead)
// ============================================================

const _binCache = new Map<string, string | null>();

/**
 * Resolve the global binary path for an npm package.
 * Caches results so we only shell out once per package per process lifetime.
 * Returns null if the package isn't installed globally.
 */
function resolveGlobalBin(packageName: string): string | null {
  if (_binCache.has(packageName)) return _binCache.get(packageName)!;

  try {
    const npmGlobalRoot = execSync("npm root -g", { encoding: "utf-8" }).trim();
    const pkgJsonPath = join(npmGlobalRoot, packageName, "package.json");
    if (!existsSync(pkgJsonPath)) {
      _binCache.set(packageName, null);
      return null;
    }
    const pkgJson = JSON.parse(require("fs").readFileSync(pkgJsonPath, "utf-8"));
    const bin = pkgJson.bin;
    if (!bin) { _binCache.set(packageName, null); return null; }

    // bin can be a string (single) or an object (multiple)
    const binRelative = typeof bin === "string" ? bin : Object.values(bin)[0] as string;
    const binPath = join(npmGlobalRoot, packageName, binRelative);

    if (existsSync(binPath)) {
      _binCache.set(packageName, binPath);
      console.log(`[integrations] Resolved global bin: ${packageName} → ${binPath}`);
      return binPath;
    }
    _binCache.set(packageName, null);
    return null;
  } catch {
    _binCache.set(packageName, null);
    return null;
  }
}

/**
 * Build the command + args for an MCP server, preferring global bin over npx.
 */
function mcpCommand(packageName: string, extraArgs: string[] = []): { command: string; args: string[] } {
  const globalBin = resolveGlobalBin(packageName);
  if (globalBin) {
    return { command: "node", args: [globalBin, ...extraArgs] };
  }
  return { command: "npx", args: ["-y", packageName, ...extraArgs] };
}

// ============================================================
// SMART MCP SERVER ROUTING
// ============================================================

/**
 * Keyword → server name mapping for smart routing.
 * If a hint matches keywords, only those servers are included.
 */
const MCP_ROUTING_MAP: Record<string, string[]> = {
  "google-personal": ["email", "gmail", "calendar", "drive", "docs", "sheets", "slides", "meeting", "schedule", "event", "chat"],
  "google-work": ["email", "gmail", "calendar", "drive", "docs", "sheets", "slides", "meeting", "schedule", "event", "chat"],
  "notion": ["notion", "database", "page", "wiki", "notes", "workspace"],
  "zoom": ["zoom", "video call", "conference"],
  "cloudflare": ["cloudflare", "worker", "deploy", "dns", "domain", "r2", "d1", "kv"],
  "square": ["square", "payment", "invoice", "pos", "transaction", "order"],
  "gohighlevel": ["ghl", "highlevel", "crm", "pipeline", "opportunity", "funnel", "contact", "social media", "post", "publish", "instagram", "facebook", "schedule post", "blog", "invoice", "sms", "workflow"],
  "clickup": ["clickup", "task", "project", "space", "list", "ticket", "todo", "sprint", "time track"],
  "playwright": ["browse", "screenshot", "webpage", "scrape", "website", "click", "navigate"],
};

/** Agent slug → servers they commonly need */
const AGENT_SERVER_MAP: Record<string, string[]> = {
  orion: ["google-personal", "google-work", "gohighlevel"],
  zen: ["google-personal", "google-work", "notion", "clickup"],
  digit: ["square", "gohighlevel", "notion", "clickup"],
  flux: ["square", "gohighlevel", "playwright"],
  helios: ["gohighlevel", "playwright"],
  echo: ["gohighlevel", "google-personal"],
  cyra: ["playwright", "cloudflare", "notion"],
  architect: ["cloudflare", "playwright"],
  joule: ["cloudflare", "gohighlevel", "google-personal"],
  pixel: ["gohighlevel", "playwright", "notion"],
  kai: ["notion", "playwright", "google-personal"],
  athena: ["playwright", "square", "gohighlevel", "notion", "clickup"],
  aura: ["playwright", "notion"],
  morpheus: ["playwright", "notion", "google-personal"],
  magnus: ["playwright", "cloudflare", "notion"],
  oracle: ["playwright", "notion", "clickup"],
  nexus: ["playwright", "notion", "gohighlevel"],
  lex: ["playwright", "notion", "google-personal"],
  helia: ["google-personal", "playwright", "gohighlevel", "notion"],
  bridge: ["google-personal", "playwright", "gohighlevel", "zoom", "notion"],
  quill: ["playwright", "notion", "google-personal"],
  tesseract: ["playwright", "notion", "clickup"],
  cipher: ["playwright"],
  rift: ["playwright", "cloudflare"],
};

/**
 * Determine which MCP server names are relevant for a given hint.
 * Returns null if ALL servers should be included (fallback).
 */
function matchServers(hint: string): Set<string> | null {
  const lower = hint.toLowerCase();
  const matched = new Set<string>();

  // Check keyword triggers
  for (const [serverName, keywords] of Object.entries(MCP_ROUTING_MAP)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        matched.add(serverName);
      }
    }
  }

  // Check agent slug triggers
  for (const [agentSlug, servers] of Object.entries(AGENT_SERVER_MAP)) {
    if (lower.includes(agentSlug)) {
      for (const s of servers) matched.add(s);
    }
  }

  return matched.size > 0 ? matched : null;
}

/**
 * Generate a filtered MCP config file with only the servers relevant to the hint.
 * Falls back to full config if no keywords match.
 * Returns the path to the (possibly filtered) config file.
 */
export async function getFilteredMcpConfigPath(userId: string, hint?: string): Promise<string> {
  const basePath = getUserMcpConfigPath(userId);
  if (!hint || !existsSync(basePath)) return basePath;

  const matched = matchServers(hint);
  if (!matched) return basePath; // no keywords → use full config

  try {
    const raw = await readFile(basePath, "utf-8");
    const config = JSON.parse(raw);
    const allServers = config.mcpServers || {};
    const filtered: Record<string, any> = {};

    for (const [name, serverConfig] of Object.entries(allServers)) {
      if (matched.has(name)) {
        filtered[name] = serverConfig;
      }
    }

    // If filtering removed everything, fall back to full config
    if (Object.keys(filtered).length === 0) return basePath;

    const activePath = join(getUserDir(userId), "mcp-active.json");
    await writeFile(activePath, JSON.stringify({ mcpServers: filtered }, null, 2));
    console.log(`[integrations] Filtered MCP config: ${Object.keys(filtered).length}/${Object.keys(allServers).length} servers for hint "${hint.substring(0, 50)}"`);
    return activePath;
  } catch {
    return basePath;
  }
}

// Providers that are per-user (OAuth or API-key based)
export const PER_USER_PROVIDERS = [
  "google-personal",
  "google-work",
  "notion",
  "zoom",
  "gohighlevel",
  "clickup",
] as const;

// Providers that use API-key input (no OAuth redirect)
export const API_KEY_PROVIDERS = ["gohighlevel", "clickup"] as const;
export type ApiKeyProvider = (typeof API_KEY_PROVIDERS)[number];

export type Provider = (typeof PER_USER_PROVIDERS)[number];

// Global servers that every user inherits (read from project .mcp.json)
const GLOBAL_SERVERS = ["cloudflare", "square", "playwright"];

export interface IntegrationStatus {
  provider: Provider;
  status: "disconnected" | "pending" | "connected" | "error";
  metadata: Record<string, any>;
  updatedAt: string | null;
}

// ============================================================
// PATH HELPERS
// ============================================================

export function getUserDir(userId: string): string {
  return join(USERS_DIR, userId);
}

export function getUserMcpConfigPath(userId: string): string {
  return join(getUserDir(userId), "mcp.json");
}

function getGoogleMcpHome(userId: string, label: "personal" | "work"): string {
  return join(getUserDir(userId), `google-${label}`);
}

// ============================================================
// INTEGRATION STATUS
// ============================================================

export async function getIntegrationStatus(
  db: Database,
  userId: string
): Promise<IntegrationStatus[]> {
  const data = db.getUserIntegrations(userId);

  // Build a map from DB results
  const dbMap = new Map<string, any>();
  if (data) {
    for (const row of data) {
      dbMap.set(row.provider, row);
    }
  }

  // Return status for all providers (disconnected if not in DB)
  return PER_USER_PROVIDERS.map((provider) => {
    const row = dbMap.get(provider);
    return {
      provider,
      status: row?.status || "disconnected",
      metadata: row?.metadata || {},
      updatedAt: row?.updated_at || null,
    };
  });
}

// ============================================================
// OAUTH URL GENERATION
// ============================================================

export function getOAuthUrl(
  provider: Provider,
  userId: string,
  callbackBaseUrl: string
): { url: string; error?: string } {
  const redirectUri = getRedirectUri(provider, callbackBaseUrl);

  switch (provider) {
    case "google-personal":
    case "google-work": {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      if (!clientId) return { url: "", error: "GOOGLE_CLIENT_ID not configured in .env" };

      const googleRedirectUri = getRedirectUri(provider, callbackBaseUrl);

      const label = provider === "google-personal" ? "personal" : "work";
      const stateEncoded = signOAuthState({ provider, userId, label });

      const scopes = [
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/calendar",
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/documents",
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/presentations",
        "https://www.googleapis.com/auth/chat.messages",
        "https://www.googleapis.com/auth/contacts.readonly",
      ].join(" ");

      const url = `https://accounts.google.com/o/oauth2/v2/auth?` +
        `client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(googleRedirectUri)}` +
        `&response_type=code` +
        `&scope=${encodeURIComponent(scopes)}` +
        `&access_type=offline` +
        `&prompt=consent` +
        `&state=${stateEncoded}`;

      return { url };
    }

    case "notion": {
      const clientId = process.env.NOTION_CLIENT_ID;
      if (!clientId) return { url: "", error: "NOTION_CLIENT_ID not configured in .env" };

      const stateEncoded = signOAuthState({ provider, userId });

      const url = `https://api.notion.com/v1/oauth/authorize?` +
        `client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=code` +
        `&owner=user` +
        `&state=${stateEncoded}`;

      return { url };
    }

    case "zoom": {
      const clientId = process.env.ZOOM_CLIENT_ID;
      if (!clientId) return { url: "", error: "ZOOM_CLIENT_ID not configured in .env" };

      const stateEncoded = signOAuthState({ provider, userId });

      const url = `https://zoom.us/oauth/authorize?` +
        `client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=code` +
        `&state=${stateEncoded}`;

      return { url };
    }

    default:
      return { url: "", error: `Unknown provider: ${provider}` };
  }
}

// ============================================================
// OAUTH CALLBACK HANDLER
// ============================================================

export async function handleOAuthCallback(
  db: Database,
  provider: Provider,
  code: string,
  userId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    let credentials: Record<string, any> = {};
    let metadata: Record<string, any> = {};

    switch (provider) {
      case "google-personal":
      case "google-work": {
        const clientId = process.env.GOOGLE_CLIENT_ID;
        const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
          return { success: false, error: "Google OAuth not configured" };
        }

        // Exchange code for tokens
        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: getRedirectUri(provider, process.env.MINIAPP_URL || "http://localhost:3034"),
            grant_type: "authorization_code",
          }),
        });

        if (!tokenRes.ok) {
          const err = await tokenRes.text();
          return { success: false, error: `Token exchange failed: ${err}` };
        }

        const tokens = await tokenRes.json();
        credentials = {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: Date.now() + (tokens.expires_in || 3600) * 1000,
        };

        // Get user info
        try {
          const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
          });
          if (userInfoRes.ok) {
            const userInfo = await userInfoRes.json();
            metadata = { email: userInfo.email, name: userInfo.name, picture: userInfo.picture };
          }
        } catch {}

        // Set up Google Workspace MCP home directory for this user
        const label = provider === "google-personal" ? "personal" : "work";
        const mcpHome = getGoogleMcpHome(userId, label);
        await mkdir(mcpHome, { recursive: true });

        // Write credentials in the format @presto-ai/google-workspace-mcp expects
        await writeFile(
          join(mcpHome, "credentials.json"),
          JSON.stringify({
            installed: {
              client_id: clientId,
              client_secret: clientSecret,
            },
          })
        );
        await writeFile(
          join(mcpHome, "token.json"),
          JSON.stringify(tokens)
        );
        break;
      }

      case "notion": {
        const clientId = process.env.NOTION_CLIENT_ID;
        const clientSecret = process.env.NOTION_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
          return { success: false, error: "Notion OAuth not configured" };
        }

        const tokenRes = await fetch("https://api.notion.com/v1/oauth/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          },
          body: JSON.stringify({
            grant_type: "authorization_code",
            code,
            redirect_uri: getRedirectUri(provider, process.env.MINIAPP_URL || "http://localhost:3034"),
          }),
        });

        if (!tokenRes.ok) {
          const err = await tokenRes.text();
          return { success: false, error: `Notion token exchange failed: ${err}` };
        }

        const tokens = await tokenRes.json();
        credentials = { access_token: tokens.access_token };
        metadata = {
          workspace_name: tokens.workspace_name,
          workspace_id: tokens.workspace_id,
          bot_id: tokens.bot_id,
        };
        break;
      }

      case "zoom": {
        const clientId = process.env.ZOOM_CLIENT_ID;
        const clientSecret = process.env.ZOOM_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
          return { success: false, error: "Zoom OAuth not configured" };
        }

        const tokenRes = await fetch("https://zoom.us/oauth/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: getRedirectUri(provider, process.env.MINIAPP_URL || "http://localhost:3034"),
          }),
        });

        if (!tokenRes.ok) {
          const err = await tokenRes.text();
          return { success: false, error: `Zoom token exchange failed: ${err}` };
        }

        const tokens = await tokenRes.json();
        credentials = {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: Date.now() + (tokens.expires_in || 3600) * 1000,
        };

        // Get user info
        try {
          const userInfoRes = await fetch("https://api.zoom.us/v2/users/me", {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
          });
          if (userInfoRes.ok) {
            const userInfo = await userInfoRes.json();
            metadata = { email: userInfo.email, name: `${userInfo.first_name} ${userInfo.last_name}`.trim() };
          }
        } catch {}
        break;
      }
    }

    // Store in DB
    db.upsertIntegration({ user_id: userId, provider, status: "connected", credentials, metadata });

    // Regenerate MCP config
    await regenerateMcpConfig(db, userId);

    return { success: true };
  } catch (error: any) {
    console.error(`[integrations] OAuth callback error for ${provider}:`, error);

    // Mark as error in DB
    db.upsertIntegration({ user_id: userId, provider, status: "error", metadata: { error: error.message } });

    return { success: false, error: error.message };
  }
}

// ============================================================
// API-KEY INTEGRATION (no OAuth)
// ============================================================

export async function saveApiKeyIntegration(
  db: Database,
  userId: string,
  provider: ApiKeyProvider,
  credentials: Record<string, any>,
  metadata: Record<string, any> = {}
): Promise<{ success: boolean; error?: string }> {
  try {
    db.upsertIntegration({ user_id: userId, provider, status: "connected", credentials, metadata });

    await regenerateMcpConfig(db, userId);
    return { success: true };
  } catch (error: any) {
    console.error(`[integrations] saveApiKeyIntegration error for ${provider}:`, error);
    return { success: false, error: error.message };
  }
}

export async function getIntegrationCredentials(
  db: Database,
  userId: string,
  provider: string
): Promise<{ credentials: Record<string, any>; metadata: Record<string, any> } | null> {
  try {
    return db.getIntegrationCredentials(userId, provider);
  } catch {
    return null;
  }
}

// ============================================================
// DISCONNECT
// ============================================================

export async function disconnectIntegration(
  db: Database,
  userId: string,
  provider: Provider
): Promise<{ success: boolean; error?: string }> {
  try {
    db.upsertIntegration({ user_id: userId, provider, status: "disconnected" });

    await regenerateMcpConfig(db, userId);
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// ============================================================
// ZOOM TOKEN REFRESH
// ============================================================

async function refreshZoomToken(
  db: Database,
  userId: string,
  credentials: Record<string, any>
): Promise<string> {
  // Still valid (with 60s buffer)
  if (credentials.expires_at && Date.now() < credentials.expires_at - 60_000) {
    return credentials.access_token;
  }

  const clientId = process.env.ZOOM_CLIENT_ID;
  const clientSecret = process.env.ZOOM_CLIENT_SECRET;
  if (!clientId || !clientSecret || !credentials.refresh_token) {
    return credentials.access_token; // Can't refresh — return current token
  }

  console.log(`[integrations] Refreshing Zoom token for user ${userId}`);

  const res = await fetch("https://zoom.us/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.refresh_token,
    }),
  });

  if (!res.ok) {
    console.error(`[integrations] Zoom token refresh failed: ${res.status}`);
    return credentials.access_token; // Return stale token as fallback
  }

  const tokens = await res.json();
  const newCredentials = {
    ...credentials,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || credentials.refresh_token,
    expires_at: Date.now() + (tokens.expires_in || 3600) * 1000,
  };

  // Update DB with new tokens
  db.upsertIntegration({ user_id: userId, provider: "zoom", status: "connected", credentials: newCredentials });

  return tokens.access_token;
}

// ============================================================
// MCP CONFIG GENERATION
// ============================================================

export async function regenerateMcpConfig(
  db: Database,
  userId: string
): Promise<void> {
  const userDir = getUserDir(userId);
  await mkdir(userDir, { recursive: true });

  // Read global MCP config
  let globalConfig: any = { mcpServers: {} };
  try {
    const raw = await readFile(join(PROJECT_ROOT, ".mcp.json"), "utf-8");
    globalConfig = JSON.parse(raw);
  } catch {}

  // Start with global servers
  const mcpServers: Record<string, any> = {};
  for (const [name, config] of Object.entries(globalConfig.mcpServers || {})) {
    if (GLOBAL_SERVERS.includes(name)) {
      mcpServers[name] = config;
    }
  }

  // Get user's connected integrations
  const integrations = db.getConnectedIntegrations(userId);

  if (integrations) {
    for (const integration of integrations) {
      switch (integration.provider) {
        case "google-personal":
        case "google-work": {
          const label = integration.provider === "google-personal" ? "personal" : "work";
          const mcpHome = getGoogleMcpHome(userId, label);
          const googleCmd = mcpCommand("@presto-ai/google-workspace-mcp");
          mcpServers[`google-${label}`] = {
            type: "stdio",
            command: googleCmd.command,
            args: googleCmd.args,
            env: {
              GOOGLE_WORKSPACE_MCP_HOME: mcpHome,
            },
          };
          break;
        }

        case "notion": {
          const token = integration.credentials?.access_token;
          if (token) {
            const headers = JSON.stringify({
              Authorization: `Bearer ${token}`,
              "Notion-Version": "2022-06-28",
            });
            const notionCmd = mcpCommand("@notionhq/notion-mcp-server");
            mcpServers["notion"] = {
              type: "stdio",
              command: notionCmd.command,
              args: notionCmd.args,
              env: {
                OPENAPI_MCP_HEADERS: headers,
              },
            };
          }
          break;
        }

        case "zoom": {
          const zoomCreds = integration.credentials || {};
          if (zoomCreds.access_token && zoomCreds.refresh_token) {
            // User OAuth — refresh if needed, use local MCP server
            const accessToken = await refreshZoomToken(db, userId, zoomCreds);
            mcpServers["zoom"] = {
              type: "stdio",
              command: "bun",
              args: ["run", join(PROJECT_ROOT, "services/zoom-mcp.ts")],
              env: { ZOOM_ACCESS_TOKEN: accessToken },
            };
          } else if (zoomCreds.account_id && zoomCreds.client_id && zoomCreds.client_secret) {
            // S2S fallback for existing users who saved credentials via old flow
            const globalZoom = globalConfig.mcpServers?.["zoom"];
            if (globalZoom) {
              mcpServers["zoom"] = {
                ...globalZoom,
                env: {
                  ZOOM_ACCOUNT_ID: zoomCreds.account_id,
                  ZOOM_CLIENT_ID: zoomCreds.client_id,
                  ZOOM_CLIENT_SECRET: zoomCreds.client_secret,
                },
              };
            } else {
              const zoomCmd = mcpCommand("@prathamesh0901/zoom-mcp-server");
              mcpServers["zoom"] = {
                type: "stdio",
                command: zoomCmd.command,
                args: zoomCmd.args,
                env: {
                  ZOOM_ACCOUNT_ID: zoomCreds.account_id,
                  ZOOM_CLIENT_ID: zoomCreds.client_id,
                  ZOOM_CLIENT_SECRET: zoomCreds.client_secret,
                },
              };
            }
          }
          break;
        }

        case "gohighlevel": {
          const creds = integration.credentials || {};
          if (creds.bearer_token) {
            const ghlCmd = mcpCommand("@drausal/gohighlevel-mcp");
            mcpServers["gohighlevel"] = {
              type: "stdio",
              command: ghlCmd.command,
              args: ghlCmd.args,
              env: {
                BEARER_TOKEN_BEARERAUTH: creds.bearer_token,
                BEARER_TOKEN_BEARER: creds.bearer_token,
              },
            };
          }
          break;
        }

        case "clickup": {
          const creds = integration.credentials || {};
          if (creds.api_token) {
            const cmd = mcpCommand("@chykalophia/clickup-mcp-server");
            mcpServers["clickup"] = {
              type: "stdio",
              command: cmd.command,
              args: cmd.args,
              env: { CLICKUP_API_TOKEN: creds.api_token },
            };
          }
          break;
        }
      }
    }
  }

  // Write the user's MCP config
  const configPath = getUserMcpConfigPath(userId);
  await writeFile(configPath, JSON.stringify({ mcpServers }, null, 2));
  console.log(`[integrations] Regenerated MCP config for user ${userId}: ${Object.keys(mcpServers).length} servers`);
}

// ============================================================
// CHECK IF USER HAS CUSTOM MCP CONFIG
// ============================================================

export function hasUserMcpConfig(userId: string): boolean {
  return existsSync(getUserMcpConfigPath(userId));
}
