#!/usr/bin/env bun
/**
 * Local Zoom MCP Server
 *
 * Minimal stdio MCP server that reads ZOOM_ACCESS_TOKEN from env
 * and exposes 7 tools: meetings CRUD + recordings/transcripts.
 *
 * Used by Nova's per-user integration system — token is refreshed automatically
 * before this process is spawned.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const TOKEN = process.env.ZOOM_ACCESS_TOKEN;
if (!TOKEN) {
  console.error("ZOOM_ACCESS_TOKEN environment variable is required");
  process.exit(1);
}

const ZOOM_API = "https://api.zoom.us/v2";

async function zoomFetch(path: string, opts?: RequestInit) {
  const res = await fetch(`${ZOOM_API}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...opts?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Zoom API ${res.status}: ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

const server = new McpServer({
  name: "zoom",
  version: "1.0.0",
});

// --- get_meetings ---
server.tool(
  "get_meetings",
  "List upcoming meetings for the authenticated user",
  {
    type: z.enum(["scheduled", "live", "upcoming", "upcoming_meetings", "previous_meetings"]).optional(),
    page_size: z.number().min(1).max(300).optional(),
  },
  async ({ type, page_size }) => {
    const params = new URLSearchParams();
    if (type) params.set("type", type);
    if (page_size) params.set("page_size", String(page_size));
    const qs = params.toString();
    const data = await zoomFetch(`/users/me/meetings${qs ? `?${qs}` : ""}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// --- create_meeting ---
server.tool(
  "create_meeting",
  "Create a new Zoom meeting",
  {
    topic: z.string(),
    type: z.number().optional().describe("1=instant, 2=scheduled, 3=recurring no fixed time, 8=recurring fixed time"),
    start_time: z.string().optional().describe("ISO 8601 datetime, e.g. 2024-01-15T10:00:00Z"),
    duration: z.number().optional().describe("Duration in minutes"),
    timezone: z.string().optional(),
    agenda: z.string().optional(),
    password: z.string().optional(),
  },
  async (params) => {
    const body: Record<string, any> = { topic: params.topic };
    if (params.type !== undefined) body.type = params.type;
    if (params.start_time) body.start_time = params.start_time;
    if (params.duration !== undefined) body.duration = params.duration;
    if (params.timezone) body.timezone = params.timezone;
    if (params.agenda) body.agenda = params.agenda;
    if (params.password) body.password = params.password;
    const data = await zoomFetch("/users/me/meetings", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// --- update_meeting ---
server.tool(
  "update_meeting",
  "Update an existing Zoom meeting",
  {
    meeting_id: z.number().describe("The meeting ID to update"),
    topic: z.string().optional(),
    start_time: z.string().optional(),
    duration: z.number().optional(),
    timezone: z.string().optional(),
    agenda: z.string().optional(),
    password: z.string().optional(),
  },
  async ({ meeting_id, ...updates }) => {
    const body: Record<string, any> = {};
    for (const [k, v] of Object.entries(updates)) {
      if (v !== undefined) body[k] = v;
    }
    await zoomFetch(`/meetings/${meeting_id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: `Meeting ${meeting_id} updated successfully.` }] };
  }
);

// --- delete_meeting ---
server.tool(
  "delete_meeting",
  "Delete a Zoom meeting",
  {
    meeting_id: z.number().describe("The meeting ID to delete"),
  },
  async ({ meeting_id }) => {
    await zoomFetch(`/meetings/${meeting_id}`, { method: "DELETE" });
    return { content: [{ type: "text", text: `Meeting ${meeting_id} deleted successfully.` }] };
  }
);

// --- get_recordings ---
server.tool(
  "get_recordings",
  "List cloud recordings for a meeting. Returns recording files with download URLs.",
  {
    meeting_id: z.string().describe("The meeting ID or UUID"),
  },
  async ({ meeting_id }) => {
    const data = await zoomFetch(`/meetings/${encodeURIComponent(meeting_id)}/recordings`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// --- get_transcript ---
server.tool(
  "get_transcript",
  "Download the transcript (VTT) for a meeting recording. Returns the raw VTT text content.",
  {
    meeting_id: z.string().describe("The meeting ID or UUID"),
  },
  async ({ meeting_id }) => {
    // First get recordings to find the transcript file
    const recordings = await zoomFetch(`/meetings/${encodeURIComponent(meeting_id)}/recordings`);
    const transcriptFile = recordings?.recording_files?.find(
      (f: any) => f.file_type === "TRANSCRIPT" || f.recording_type === "audio_transcript"
    );
    if (!transcriptFile) {
      return { content: [{ type: "text", text: "No transcript found for this meeting. Ensure cloud recording with audio transcript is enabled in Zoom settings." }] };
    }

    // Download the transcript VTT content
    const downloadUrl = `${transcriptFile.download_url}?access_token=${TOKEN}`;
    const res = await fetch(downloadUrl);
    if (!res.ok) {
      throw new Error(`Failed to download transcript: ${res.status}`);
    }
    const vtt = await res.text();
    return { content: [{ type: "text", text: vtt }] };
  }
);

// --- share_recording ---
server.tool(
  "share_recording",
  "Update sharing settings for a meeting's cloud recording (e.g. make publicly viewable, set password, enable download).",
  {
    meeting_id: z.string().describe("The meeting ID or UUID"),
    share_recording: z.enum(["publicly", "internally", "none"]).optional().describe("Who can view: publicly, internally (same account), or none"),
    recording_authentication: z.boolean().optional().describe("Require authentication to view"),
    viewer_download: z.boolean().optional().describe("Allow viewers to download the recording"),
    password: z.string().optional().describe("Set a passcode for the shared recording"),
    on_demand: z.boolean().optional().describe("Require registration before viewing"),
  },
  async ({ meeting_id, ...settings }) => {
    const body: Record<string, any> = {};
    if (settings.share_recording !== undefined) body.share_recording = settings.share_recording;
    if (settings.recording_authentication !== undefined) body.recording_authentication = settings.recording_authentication;
    if (settings.viewer_download !== undefined) body.viewer_download = settings.viewer_download;
    if (settings.password !== undefined) body.password = settings.password;
    if (settings.on_demand !== undefined) body.on_demand = settings.on_demand;

    await zoomFetch(`/meetings/${encodeURIComponent(meeting_id)}/recordings/settings`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });

    // Fetch updated settings to confirm + return share link
    const updated = await zoomFetch(`/meetings/${encodeURIComponent(meeting_id)}/recordings/settings`);
    const recordings = await zoomFetch(`/meetings/${encodeURIComponent(meeting_id)}/recordings`);
    const shareUrl = recordings?.share_url || "(no share URL available)";

    return {
      content: [{
        type: "text",
        text: `Recording sharing updated.\nShare URL: ${shareUrl}\nSettings: ${JSON.stringify(updated, null, 2)}`,
      }],
    };
  }
);

// --- get_meeting ---
server.tool(
  "get_meeting",
  "Get full details of a single meeting by ID (topic, start time, duration, join URL, settings, etc.)",
  {
    meeting_id: z.number().describe("The meeting ID"),
  },
  async ({ meeting_id }) => {
    const data = await zoomFetch(`/meetings/${meeting_id}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// --- list_recordings ---
server.tool(
  "list_recordings",
  "List all cloud recordings for the authenticated user within a date range",
  {
    from: z.string().describe("Start date in yyyy-mm-dd format"),
    to: z.string().optional().describe("End date in yyyy-mm-dd format (defaults to today, max 30-day range)"),
    page_size: z.number().min(1).max(300).optional(),
  },
  async ({ from, to, page_size }) => {
    const params = new URLSearchParams({ from });
    if (to) params.set("to", to);
    if (page_size) params.set("page_size", String(page_size));
    const data = await zoomFetch(`/users/me/recordings?${params}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// --- delete_recording ---
server.tool(
  "delete_recording",
  "Delete a meeting's cloud recording. Use action='trash' (default) to move to trash, or 'delete' to permanently remove.",
  {
    meeting_id: z.string().describe("The meeting ID or UUID"),
    action: z.enum(["trash", "delete"]).optional().describe("trash (recoverable) or delete (permanent). Defaults to trash."),
  },
  async ({ meeting_id, action }) => {
    const params = action ? `?action=${action}` : "";
    await zoomFetch(`/meetings/${encodeURIComponent(meeting_id)}/recordings${params}`, { method: "DELETE" });
    return { content: [{ type: "text", text: `Recording for meeting ${meeting_id} ${action === "delete" ? "permanently deleted" : "moved to trash"}.` }] };
  }
);

// --- get_meeting_participants ---
server.tool(
  "get_meeting_participants",
  "Get the list of participants who attended a past meeting. Only works for ended meetings.",
  {
    meeting_id: z.string().describe("The meeting ID or UUID"),
    page_size: z.number().min(1).max(300).optional(),
  },
  async ({ meeting_id, page_size }) => {
    const params = page_size ? `?page_size=${page_size}` : "";
    const data = await zoomFetch(`/past_meetings/${encodeURIComponent(meeting_id)}/participants${params}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// --- get_meeting_summary ---
server.tool(
  "get_meeting_summary",
  "Get Zoom's AI-generated meeting summary (requires Meeting Summary enabled in Zoom account settings)",
  {
    meeting_id: z.string().describe("The meeting ID or UUID"),
  },
  async ({ meeting_id }) => {
    const data = await zoomFetch(`/meetings/${encodeURIComponent(meeting_id)}/meeting_summary`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// --- add_meeting_registrant ---
server.tool(
  "add_meeting_registrant",
  "Register a person for a meeting that has registration enabled. Returns the registrant ID and join URL.",
  {
    meeting_id: z.number().describe("The meeting ID"),
    email: z.string().describe("Registrant's email address"),
    first_name: z.string().describe("Registrant's first name"),
    last_name: z.string().optional(),
    phone: z.string().optional(),
    organization: z.string().optional(),
    job_title: z.string().optional(),
  },
  async ({ meeting_id, ...registrant }) => {
    const body: Record<string, any> = { email: registrant.email, first_name: registrant.first_name };
    if (registrant.last_name) body.last_name = registrant.last_name;
    if (registrant.phone) body.phone = registrant.phone;
    if (registrant.organization) body.org = registrant.organization;
    if (registrant.job_title) body.job_title = registrant.job_title;
    const data = await zoomFetch(`/meetings/${meeting_id}/registrants`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
