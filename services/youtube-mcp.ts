#!/usr/bin/env bun
/**
 * Local YouTube MCP Server
 *
 * Minimal stdio MCP server for YouTube uploads via Data API v3.
 * Reads YOUTUBE_ACCESS_TOKEN from env.
 *
 * Used by Nova's per-user integration system — token is refreshed automatically
 * before this process is spawned.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { tmpdir } from "os";
import { join } from "path";
import { writeFile, unlink } from "fs/promises";

const TOKEN = process.env.YOUTUBE_ACCESS_TOKEN;
if (!TOKEN) {
  console.error("YOUTUBE_ACCESS_TOKEN environment variable is required");
  process.exit(1);
}

const API_BASE = "https://www.googleapis.com/youtube/v3";
const UPLOAD_BASE = "https://www.googleapis.com/upload/youtube/v3";

async function ytFetch(path: string, opts?: RequestInit) {
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...opts?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`YouTube API ${res.status}: ${text}`);
  }
  return res.json();
}

const server = new McpServer({
  name: "youtube",
  version: "1.0.0",
});

// --- upload_video ---
server.tool(
  "upload_video",
  "Upload a video to YouTube from a URL. For Shorts, video must be ≤60s vertical and include #Shorts in title.",
  {
    video_url: z.string().describe("Public URL of the video to upload"),
    title: z.string().describe("Video title (include #Shorts for YouTube Shorts)"),
    description: z.string().optional().describe("Video description"),
    tags: z.array(z.string()).optional().describe("Video tags"),
    privacy: z.enum(["public", "unlisted", "private"]).optional().describe("Privacy status (default public)"),
    category_id: z.string().optional().describe("YouTube category ID (default 22 = People & Blogs)"),
  },
  async ({ video_url, title, description, tags, privacy, category_id }) => {
    // Download video to temp file
    const videoRes = await fetch(video_url);
    if (!videoRes.ok) throw new Error(`Failed to download video: ${videoRes.status}`);
    const videoBuffer = await videoRes.arrayBuffer();
    const tmpPath = join(tmpdir(), `yt-upload-${Date.now()}.mp4`);
    await writeFile(tmpPath, Buffer.from(videoBuffer));

    try {
      // Resumable upload: init
      const metadata = {
        snippet: {
          title,
          description: description || "",
          tags: tags || [],
          categoryId: category_id || "22",
        },
        status: {
          privacyStatus: privacy || "public",
          selfDeclaredMadeForKids: false,
        },
      };

      const initRes = await fetch(
        `${UPLOAD_BASE}/videos?uploadType=resumable&part=snippet,status`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            "Content-Type": "application/json",
            "X-Upload-Content-Type": "video/mp4",
            "X-Upload-Content-Length": String(videoBuffer.byteLength),
          },
          body: JSON.stringify(metadata),
        }
      );

      if (!initRes.ok) {
        const err = await initRes.text();
        throw new Error(`Upload init failed: ${initRes.status} ${err}`);
      }

      const uploadUrl = initRes.headers.get("location");
      if (!uploadUrl) throw new Error("No upload URL returned");

      // Upload the video data
      const uploadRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(videoBuffer.byteLength),
        },
        body: Buffer.from(videoBuffer),
      });

      if (!uploadRes.ok) {
        const err = await uploadRes.text();
        throw new Error(`Video upload failed: ${uploadRes.status} ${err}`);
      }

      const result = await uploadRes.json();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            video_id: result.id,
            title: result.snippet?.title,
            url: `https://youtu.be/${result.id}`,
            privacy: result.status?.privacyStatus,
          }, null, 2),
        }],
      };
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  }
);

// --- list_videos ---
server.tool(
  "list_videos",
  "List the channel's uploaded videos.",
  {
    max_results: z.number().min(1).max(50).optional().describe("Number of videos to return (default 10)"),
  },
  async ({ max_results }) => {
    // Get channel's upload playlist
    const channels = await ytFetch("/channels?part=contentDetails&mine=true");
    const uploadsPlaylistId = channels.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsPlaylistId) throw new Error("Could not find uploads playlist");

    const data = await ytFetch(`/playlistItems?part=snippet,status&playlistId=${uploadsPlaylistId}&maxResults=${max_results || 10}`);
    const videos = (data.items || []).map((item: any) => ({
      video_id: item.snippet.resourceId.videoId,
      title: item.snippet.title,
      description: item.snippet.description?.substring(0, 200),
      published_at: item.snippet.publishedAt,
      thumbnail: item.snippet.thumbnails?.medium?.url,
      url: `https://youtu.be/${item.snippet.resourceId.videoId}`,
    }));
    return { content: [{ type: "text", text: JSON.stringify(videos, null, 2) }] };
  }
);

// --- update_video ---
server.tool(
  "update_video",
  "Update a video's title, description, tags, or privacy.",
  {
    video_id: z.string().describe("The video ID to update"),
    title: z.string().optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    privacy: z.enum(["public", "unlisted", "private"]).optional(),
  },
  async ({ video_id, title, description, tags, privacy }) => {
    // Get current video details
    const current = await ytFetch(`/videos?part=snippet,status&id=${video_id}`);
    const video = current.items?.[0];
    if (!video) throw new Error(`Video ${video_id} not found`);

    const body: Record<string, any> = {
      id: video_id,
      snippet: {
        ...video.snippet,
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(tags !== undefined && { tags }),
        categoryId: video.snippet.categoryId,
      },
    };
    if (privacy !== undefined) {
      body.status = { ...video.status, privacyStatus: privacy };
    }

    const parts = ["snippet"];
    if (privacy !== undefined) parts.push("status");
    const result = await ytFetch(`/videos?part=${parts.join(",")}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: `Video ${video_id} updated. Title: "${result.snippet?.title}"` }] };
  }
);

// --- delete_video ---
server.tool(
  "delete_video",
  "Delete a YouTube video.",
  {
    video_id: z.string().describe("The video ID to delete"),
  },
  async ({ video_id }) => {
    await fetch(`${API_BASE}/videos?id=${video_id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    return { content: [{ type: "text", text: `Video ${video_id} deleted successfully.` }] };
  }
);

// --- get_channel_stats ---
server.tool(
  "get_channel_stats",
  "Get the channel's subscriber count, view count, and video count.",
  {},
  async () => {
    const data = await ytFetch("/channels?part=statistics,snippet&mine=true");
    const ch = data.items?.[0];
    if (!ch) throw new Error("Channel not found");
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          name: ch.snippet.title,
          subscribers: ch.statistics.subscriberCount,
          total_views: ch.statistics.viewCount,
          video_count: ch.statistics.videoCount,
        }, null, 2),
      }],
    };
  }
);

// --- get_video_stats ---
server.tool(
  "get_video_stats",
  "Get views, likes, and comments count for a specific video.",
  {
    video_id: z.string().describe("The video ID"),
  },
  async ({ video_id }) => {
    const data = await ytFetch(`/videos?part=statistics,snippet&id=${video_id}`);
    const video = data.items?.[0];
    if (!video) throw new Error(`Video ${video_id} not found`);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          title: video.snippet.title,
          views: video.statistics.viewCount,
          likes: video.statistics.likeCount,
          comments: video.statistics.commentCount,
          favorites: video.statistics.favoriteCount,
        }, null, 2),
      }],
    };
  }
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
