/**
 * Notion Board Integration
 *
 * Saves board meeting summaries, decisions, strategic plans, and
 * executive reports to the Nova Executive Board workspace in Notion.
 *
 * Database IDs are read from env vars:
 *   NOTION_DB_BOARD_MEETINGS, NOTION_DB_DECISIONS,
 *   NOTION_DB_STRATEGIC_PLANS, NOTION_DB_EXEC_REPORTS
 */

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

function getHeaders() {
  const key = process.env.NOTION_API_KEY;
  if (!key) throw new Error("NOTION_API_KEY not set");
  return {
    Authorization: `Bearer ${key}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

function formatDbId(raw: string): string {
  // Notion IDs need dashes: 31eacd3da115814e8021d8aaf331b433 → 31eacd3d-a115-814e-8021-d8aaf331b433
  if (raw.includes("-")) return raw;
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

// ============================================================
// Board Meeting Summaries
// ============================================================

export async function saveBoardMeeting(opts: {
  topic: string;
  sessionId: string;
  participants: string[];
  summary: string;
  decisionMade: boolean;
  confidenceScore?: number;
  bodyMarkdown?: string;
}): Promise<string | null> {
  const dbId = process.env.NOTION_DB_BOARD_MEETINGS;
  if (!dbId) {
    console.warn("[notion-board] NOTION_DB_BOARD_MEETINGS not set, skipping");
    return null;
  }

  try {
    const body: any = {
      parent: { database_id: formatDbId(dbId) },
      properties: {
        "Meeting Topic": { title: [{ text: { content: opts.topic.slice(0, 200) } }] },
        Date: { date: { start: new Date().toISOString().split("T")[0] } },
        Status: { select: { name: opts.decisionMade ? "Completed" : "Pending Decision" } },
        Participants: { multi_select: opts.participants.map((p) => ({ name: p.toUpperCase() })) },
        "Decision Made": { checkbox: opts.decisionMade },
        "Session ID": { rich_text: [{ text: { content: opts.sessionId } }] },
        Summary: { rich_text: [{ text: { content: opts.summary.slice(0, 2000) } }] },
      },
    };

    if (opts.confidenceScore !== undefined) {
      body.properties["Confidence Score"] = { number: opts.confidenceScore };
    }

    // Add body content blocks if provided
    if (opts.bodyMarkdown) {
      body.children = markdownToBlocks(opts.bodyMarkdown);
    }

    const res = await fetch(`${NOTION_API}/pages`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify(body),
    });

    const data = await res.json() as any;
    if (!res.ok) {
      console.error("[notion-board] Failed to save meeting:", data.message);
      return null;
    }

    console.log(`[notion-board] Saved board meeting: ${data.id}`);
    return data.id;
  } catch (err) {
    console.error("[notion-board] Error saving meeting:", err);
    return null;
  }
}

// ============================================================
// Decisions Log
// ============================================================

export async function saveDecision(opts: {
  decision: string;
  proposedBy: string;
  rationale: string;
  confidence?: number;
  impactAreas?: string[];
  meetingPageId?: string;
}): Promise<string | null> {
  const dbId = process.env.NOTION_DB_DECISIONS;
  if (!dbId) {
    console.warn("[notion-board] NOTION_DB_DECISIONS not set, skipping");
    return null;
  }

  try {
    const body: any = {
      parent: { database_id: formatDbId(dbId) },
      properties: {
        Decision: { title: [{ text: { content: opts.decision.slice(0, 200) } }] },
        Date: { date: { start: new Date().toISOString().split("T")[0] } },
        "Proposed By": { select: { name: opts.proposedBy.toUpperCase() } },
        Status: { select: { name: "Approved" } },
        Rationale: { rich_text: [{ text: { content: opts.rationale.slice(0, 2000) } }] },
      },
    };

    if (opts.confidence !== undefined) {
      body.properties.Confidence = { number: opts.confidence };
    }

    if (opts.impactAreas?.length) {
      body.properties["Impact Area"] = {
        multi_select: opts.impactAreas.map((a) => ({ name: a })),
      };
    }

    // Note: relation to meeting requires the meeting page ID (not session ID)
    // We skip this for now since it requires the Notion page ID from saveBoardMeeting

    const res = await fetch(`${NOTION_API}/pages`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify(body),
    });

    const data = await res.json() as any;
    if (!res.ok) {
      console.error("[notion-board] Failed to save decision:", data.message);
      return null;
    }

    console.log(`[notion-board] Saved decision: ${data.id}`);
    return data.id;
  } catch (err) {
    console.error("[notion-board] Error saving decision:", err);
    return null;
  }
}

// ============================================================
// Executive Reports
// ============================================================

export async function saveExecReport(opts: {
  title: string;
  author: string;
  type: "Briefing" | "Analysis" | "Recommendation" | "Status Update" | "Research Report" | "Risk Assessment" | "Morning Briefing";
  summary: string;
  tags?: string[];
  bodyMarkdown?: string;
}): Promise<string | null> {
  const dbId = process.env.NOTION_DB_EXEC_REPORTS;
  if (!dbId) {
    console.warn("[notion-board] NOTION_DB_EXEC_REPORTS not set, skipping");
    return null;
  }

  try {
    const body: any = {
      parent: { database_id: formatDbId(dbId) },
      properties: {
        "Report Title": { title: [{ text: { content: opts.title.slice(0, 200) } }] },
        Date: { date: { start: new Date().toISOString().split("T")[0] } },
        Author: { select: { name: opts.author.toUpperCase() } },
        Type: { select: { name: opts.type } },
        Summary: { rich_text: [{ text: { content: opts.summary.slice(0, 2000) } }] },
      },
    };

    if (opts.tags?.length) {
      body.properties.Tags = { multi_select: opts.tags.map((t) => ({ name: t })) };
    }

    if (opts.bodyMarkdown) {
      body.children = markdownToBlocks(opts.bodyMarkdown);
    }

    const res = await fetch(`${NOTION_API}/pages`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify(body),
    });

    const data = await res.json() as any;
    if (!res.ok) {
      console.error("[notion-board] Failed to save report:", data.message);
      return null;
    }

    console.log(`[notion-board] Saved exec report: ${data.id}`);
    return data.id;
  } catch (err) {
    console.error("[notion-board] Error saving report:", err);
    return null;
  }
}

// ============================================================
// Strategic Plans
// ============================================================

export async function saveStrategicPlan(opts: {
  title: string;
  owner: string;
  priority?: "P0 — Critical" | "P1 — High" | "P2 — Medium" | "P3 — Low";
  timeline?: string;
  keyMetrics?: string;
  bodyMarkdown?: string;
}): Promise<string | null> {
  const dbId = process.env.NOTION_DB_STRATEGIC_PLANS;
  if (!dbId) {
    console.warn("[notion-board] NOTION_DB_STRATEGIC_PLANS not set, skipping");
    return null;
  }

  try {
    const body: any = {
      parent: { database_id: formatDbId(dbId) },
      properties: {
        "Plan Title": { title: [{ text: { content: opts.title.slice(0, 200) } }] },
        "Created Date": { date: { start: new Date().toISOString().split("T")[0] } },
        Owner: { select: { name: opts.owner.toUpperCase() } },
        Status: { select: { name: "Draft" } },
      },
    };

    if (opts.priority) {
      body.properties.Priority = { select: { name: opts.priority } };
    }
    if (opts.timeline) {
      body.properties.Timeline = { rich_text: [{ text: { content: opts.timeline.slice(0, 500) } }] };
    }
    if (opts.keyMetrics) {
      body.properties["Key Metrics"] = { rich_text: [{ text: { content: opts.keyMetrics.slice(0, 500) } }] };
    }

    if (opts.bodyMarkdown) {
      body.children = markdownToBlocks(opts.bodyMarkdown);
    }

    const res = await fetch(`${NOTION_API}/pages`, {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify(body),
    });

    const data = await res.json() as any;
    if (!res.ok) {
      console.error("[notion-board] Failed to save plan:", data.message);
      return null;
    }

    console.log(`[notion-board] Saved strategic plan: ${data.id}`);
    return data.id;
  } catch (err) {
    console.error("[notion-board] Error saving plan:", err);
    return null;
  }
}

// ============================================================
// Helpers — Simple markdown to Notion blocks
// ============================================================

function markdownToBlocks(md: string): any[] {
  const blocks: any[] = [];
  const lines = md.split("\n");

  for (const line of lines) {
    if (!line.trim()) continue;

    if (line.startsWith("### ")) {
      blocks.push({
        object: "block",
        type: "heading_3",
        heading_3: { rich_text: [{ type: "text", text: { content: line.slice(4).trim() } }] },
      });
    } else if (line.startsWith("## ")) {
      blocks.push({
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: [{ type: "text", text: { content: line.slice(3).trim() } }] },
      });
    } else if (line.startsWith("# ")) {
      blocks.push({
        object: "block",
        type: "heading_1",
        heading_1: { rich_text: [{ type: "text", text: { content: line.slice(2).trim() } }] },
      });
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: [{ type: "text", text: { content: line.slice(2).trim() } }] },
      });
    } else if (/^\d+\.\s/.test(line)) {
      blocks.push({
        object: "block",
        type: "numbered_list_item",
        numbered_list_item: { rich_text: [{ type: "text", text: { content: line.replace(/^\d+\.\s/, "").trim() } }] },
      });
    } else if (line.startsWith("> ")) {
      blocks.push({
        object: "block",
        type: "quote",
        quote: { rich_text: [{ type: "text", text: { content: line.slice(2).trim() } }] },
      });
    } else if (line.startsWith("---")) {
      blocks.push({ object: "block", type: "divider", divider: {} });
    } else {
      // Truncate long paragraphs (Notion limit: 2000 chars per rich_text)
      const content = line.trim().slice(0, 2000);
      blocks.push({
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content } }] },
      });
    }
  }

  // Notion allows max 100 blocks per request
  return blocks.slice(0, 100);
}
