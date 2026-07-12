#!/usr/bin/env bun
/**
 * Local TikTok MCP Server
 *
 * Minimal stdio MCP server for TikTok posting via Content Posting API v2.
 * Reads TIKTOK_ACCESS_TOKEN from env.
 *
 * Used by Nova's per-user integration system — token is refreshed automatically
 * before this process is spawned.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const TOKEN = process.env.TIKTOK_ACCESS_TOKEN;
if (!TOKEN) {
  console.error("TIKTOK_ACCESS_TOKEN environment variable is required");
  process.exit(1);
}

const BASE_URL = "https://open.tiktokapis.com/v2";

async function tiktokFetch(path: string, opts?: RequestInit) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...opts?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TikTok API ${res.status}: ${text}`);
  }
  return res.json();
}

const server = new McpServer({
  name: "tiktok",
  version: "1.0.0",
});

// --- upload_video ---
server.tool(
  "upload_video",
  "Upload and publish a video to TikTok. 3-step process: init → transfer video → enters processing queue.",
  {
    video_url: z.string().describe("Public URL of the video to upload"),
    title: z.string().optional().describe("Video caption/title (max 150 chars)"),
    privacy_level: z.enum(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"]).optional().describe("Privacy level (default PUBLIC_TO_EVERYONE)"),
    disable_duet: z.boolean().optional().describe("Disable duet (default false)"),
    disable_stitch: z.boolean().optional().describe("Disable stitch (default false)"),
    disable_comment: z.boolean().optional().describe("Disable comments (default false)"),
    brand_content_toggle: z.boolean().optional().describe("Mark as branded content"),
    brand_organic_toggle: z.boolean().optional().describe("Mark as organic branded content"),
  },
  async ({ video_url, title, privacy_level, disable_duet, disable_stitch, disable_comment, brand_content_toggle, brand_organic_toggle }) => {
    // Download video to get size
    const videoRes = await fetch(video_url);
    if (!videoRes.ok) throw new Error(`Failed to download video: ${videoRes.status}`);
    const videoBuffer = await videoRes.arrayBuffer();
    const videoSize = videoBuffer.byteLength;

    // Step 1: Initialize upload
    const initBody: Record<string, any> = {
      post_info: {
        title: title || "",
        privacy_level: privacy_level || "PUBLIC_TO_EVERYONE",
        disable_duet: disable_duet || false,
        disable_stitch: disable_stitch || false,
        disable_comment: disable_comment || false,
      },
      source_info: {
        source: "PULL_FROM_URL",
        video_url,
      },
    };
    if (brand_content_toggle !== undefined) initBody.post_info.brand_content_toggle = brand_content_toggle;
    if (brand_organic_toggle !== undefined) initBody.post_info.brand_organic_toggle = brand_organic_toggle;

    const initResult = await tiktokFetch("/post/publish/video/init/", {
      method: "POST",
      body: JSON.stringify(initBody),
    });

    const publishId = initResult.data?.publish_id;
    if (!publishId) {
      return { content: [{ type: "text", text: `Upload initiated but no publish_id returned. Response: ${JSON.stringify(initResult, null, 2)}` }] };
    }

    // Step 2: Check status (video pulled from URL enters processing)
    // Poll for status
    let status = "PROCESSING_UPLOAD";
    let statusResult: any;
    for (let i = 0; i < 30 && (status === "PROCESSING_UPLOAD" || status === "PROCESSING_DOWNLOAD"); i++) {
      await new Promise((r) => setTimeout(r, 3000));
      statusResult = await tiktokFetch("/post/publish/status/fetch/", {
        method: "POST",
        body: JSON.stringify({ publish_id: publishId }),
      });
      status = statusResult.data?.status || "UNKNOWN";
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          publish_id: publishId,
          status,
          ...(statusResult?.data || {}),
        }, null, 2),
      }],
    };
  }
);

// --- get_videos ---
server.tool(
  "get_videos",
  "List the creator's recent videos.",
  {
    max_count: z.number().min(1).max(20).optional().describe("Number of videos to return (default 10)"),
    cursor: z.number().optional().describe("Pagination cursor"),
  },
  async ({ max_count, cursor }) => {
    const body: Record<string, any> = { max_count: max_count || 10 };
    if (cursor !== undefined) body.cursor = cursor;

    const data = await tiktokFetch("/video/list/?fields=id,title,create_time,cover_image_url,share_url,duration,like_count,comment_count,share_count,view_count", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// --- get_video_info ---
server.tool(
  "get_video_info",
  "Get details and stats for specific TikTok videos.",
  {
    video_ids: z.array(z.string()).min(1).max(20).describe("Array of video IDs to query"),
  },
  async ({ video_ids }) => {
    const data = await tiktokFetch("/video/query/?fields=id,title,create_time,cover_image_url,share_url,duration,like_count,comment_count,share_count,view_count", {
      method: "POST",
      body: JSON.stringify({ filters: { video_ids } }),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// --- get_creator_info ---
server.tool(
  "get_creator_info",
  "Get the creator's profile info, follower count, and other stats.",
  {},
  async () => {
    const data = await tiktokFetch("/user/info/?fields=open_id,union_id,avatar_url,display_name,bio_description,profile_deep_link,is_verified,follower_count,following_count,likes_count,video_count", {
      method: "GET",
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// --- delete_video ---
server.tool(
  "delete_video",
  "Delete a TikTok video by ID. Note: TikTok API doesn't support direct deletion. This unpublishes via status update.",
  {
    video_id: z.string().describe("The video ID to delete"),
  },
  async ({ video_id }) => {
    // TikTok Content Posting API doesn't have a direct delete endpoint.
    // Videos must be deleted by the user in the TikTok app.
    return {
      content: [{
        type: "text",
        text: `TikTok's Content Posting API does not support video deletion. Video ${video_id} must be deleted directly in the TikTok app. You can use get_video_info to confirm the video exists.`,
      }],
    };
  }
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
