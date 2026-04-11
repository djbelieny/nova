/**
 * Service Integrations — Direct API fetchers for proactive services
 *
 * These bypass MCP and call APIs directly so Groq-powered services
 * can include real data from ClickUp, Notion, and Google Calendar
 * in their context.
 */

const CLICKUP_API = "https://api.clickup.com/api/v2";
const NOTION_API = "https://api.notion.com/v1";

// ============================================================
// CLICKUP
// ============================================================

interface ClickUpTask {
  id: string;
  name: string;
  status: { status: string };
  due_date: string | null;
  priority: { priority: string } | null;
  list: { name: string };
}

export async function getClickUpTasks(): Promise<string> {
  const token = process.env.CLICKUP_API_TOKEN;
  if (!token) return "";

  try {
    // Get teams first
    const teamsRes = await fetch(`${CLICKUP_API}/team`, {
      headers: { Authorization: token },
    });
    if (!teamsRes.ok) return "";
    const teamsData = await teamsRes.json() as any;
    const teamId = teamsData.teams?.[0]?.id;
    if (!teamId) return "";

    // Get tasks assigned to me or recently updated
    const tasksRes = await fetch(
      `${CLICKUP_API}/team/${teamId}/task?order_by=updated&reverse=true&subtasks=true&include_closed=false&page=0`,
      { headers: { Authorization: token } }
    );
    if (!tasksRes.ok) return "";
    const tasksData = await tasksRes.json() as any;
    const tasks: ClickUpTask[] = (tasksData.tasks || []).slice(0, 10);

    if (!tasks.length) return "";

    const lines = tasks.map((t) => {
      const due = t.due_date
        ? ` (due ${new Date(parseInt(t.due_date)).toLocaleDateString()})`
        : "";
      const priority = t.priority?.priority ? ` [${t.priority.priority}]` : "";
      return `- [${t.status.status}] ${t.name}${priority}${due} (${t.list.name})`;
    });

    return `CLICKUP TASKS:\n${lines.join("\n")}`;
  } catch (error) {
    console.error("ClickUp fetch error:", error);
    return "";
  }
}

// ============================================================
// NOTION
// ============================================================

export async function getNotionTasks(): Promise<string> {
  const token = process.env.NOTION_API_KEY;
  if (!token) return "";

  try {
    // Search for databases that look like task lists
    const searchRes = await fetch(`${NOTION_API}/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: { property: "object", value: "database" },
        page_size: 5,
      }),
    });
    if (!searchRes.ok) return "";
    const searchData = await searchRes.json() as any;
    const databases = searchData.results || [];

    if (!databases.length) return "";

    // Query the first database for recent/open items
    const dbId = databases[0].id;
    const dbTitle = databases[0].title?.[0]?.plain_text || "Notion DB";

    const queryRes = await fetch(`${NOTION_API}/databases/${dbId}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        page_size: 10,
        sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      }),
    });
    if (!queryRes.ok) return "";
    const queryData = await queryRes.json() as any;
    const pages = queryData.results || [];

    if (!pages.length) return "";

    const lines = pages.map((p: any) => {
      const title =
        p.properties?.Name?.title?.[0]?.plain_text ||
        p.properties?.Title?.title?.[0]?.plain_text ||
        Object.values(p.properties || {}).find(
          (prop: any) => prop.type === "title"
        )?.title?.[0]?.plain_text ||
        "Untitled";
      const status =
        p.properties?.Status?.status?.name ||
        p.properties?.Status?.select?.name ||
        "";
      const statusStr = status ? ` [${status}]` : "";
      return `- ${title}${statusStr}`;
    });

    return `NOTION (${dbTitle}):\n${lines.join("\n")}`;
  } catch (error) {
    console.error("Notion fetch error:", error);
    return "";
  }
}

// ============================================================
// GOOGLE CALENDAR (via service or OAuth — simplified)
// ============================================================

export async function getGoogleCalendarEvents(): Promise<string> {
  // Google Calendar requires OAuth tokens which are managed by the MCP.
  // For now, return empty — the relay handles Calendar via MCP during chat.
  return "";
}

// ============================================================
// OAUTH TOKEN REFRESH
// ============================================================

/**
 * Refresh an OAuth token if it expires within 5 minutes.
 * Supports Google OAuth2 refresh_token grant.
 * Returns true if refresh succeeded or wasn't needed, false on failure.
 */
export async function refreshTokenIfNeeded(
  provider: string,
  userId: string,
  db: import("./db.ts").Database
): Promise<boolean> {
  try {
    const integration = db.getIntegrationCredentials(userId, provider);
    if (!integration?.credentials) return true; // Not connected — skip

    const creds = typeof integration.credentials === "string"
      ? JSON.parse(integration.credentials)
      : integration.credentials;

    if (!creds.expiry_date && !creds.expires_in) return true; // No expiry info

    const expiresAt = creds.expiry_date || (Date.now() + (creds.expires_in * 1000));
    const fiveMinutes = 5 * 60 * 1000;

    if (expiresAt - Date.now() > fiveMinutes) return true; // Still valid

    // Token is expiring — refresh it
    if (!creds.refresh_token) {
      console.warn(`[service-integrations] ${provider} token expiring for user ${userId} but no refresh_token`);
      return false;
    }

    // Google OAuth2 refresh
    if (provider.startsWith("google")) {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      if (!clientId || !clientSecret) return false;

      const resp = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: creds.refresh_token,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      });

      if (!resp.ok) {
        console.error(`[service-integrations] Token refresh failed for ${provider}/${userId}: ${resp.status}`);
        return false;
      }

      const tokens = await resp.json() as any;
      const updated = {
        ...creds,
        access_token: tokens.access_token,
        expiry_date: Date.now() + (tokens.expires_in * 1000),
      };

      db.upsertIntegration({
        user_id: userId,
        provider,
        status: "connected",
        credentials: updated,
        metadata: integration.metadata || {},
      });
      console.log(`[service-integrations] Refreshed ${provider} token for user ${userId}`);
      return true;
    }

    // Other providers: log and return true (don't block the service)
    console.warn(`[service-integrations] Token refresh not implemented for provider: ${provider}`);
    return true;

  } catch (err) {
    console.error(`[service-integrations] refreshTokenIfNeeded error:`, err);
    return true; // Don't block the service on refresh errors
  }
}

// ============================================================
// TAVILY (web search for news)
// ============================================================

export async function searchTavily(
  query: string,
  opts?: { maxResults?: number; topic?: string }
): Promise<{ title: string; url: string; content: string }[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return [];

  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: opts?.maxResults ?? 8,
        topic: opts?.topic ?? "news",
        include_answer: false,
      }),
    });
    if (!res.ok) return [];
    const data = await res.json() as any;
    return (data.results || []).map((r: any) => ({
      title: r.title || "",
      url: r.url || "",
      content: (r.content || "").substring(0, 200),
    }));
  } catch (error) {
    console.error("Tavily search error:", error);
    return [];
  }
}

// ============================================================
// COMBINED CONTEXT (for services)
// ============================================================

export async function getIntegrationContext(): Promise<string> {
  const [clickup, notion] = await Promise.all([
    getClickUpTasks(),
    getNotionTasks(),
  ]);

  const parts = [clickup, notion].filter(Boolean);
  return parts.join("\n\n");
}
