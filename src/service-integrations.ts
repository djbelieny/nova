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
  // TODO: Add OAuth token refresh flow for background services
  return "";
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
