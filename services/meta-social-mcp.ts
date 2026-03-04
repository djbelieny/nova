#!/usr/bin/env bun
/**
 * Local Meta Social MCP Server
 *
 * Minimal stdio MCP server for Instagram posting via Instagram Graph API v21.0.
 * Uses Instagram Business Login tokens.
 * Reads META_ACCESS_TOKEN, META_IG_USER_ID from env.
 * Optionally reads META_PAGE_ID for Facebook page posting.
 *
 * Used by Nova's per-user integration system — token is refreshed automatically
 * before this process is spawned.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const TOKEN = process.env.META_ACCESS_TOKEN;
if (!TOKEN) {
  console.error("META_ACCESS_TOKEN environment variable is required");
  process.exit(1);
}

const PAGE_ID = process.env.META_PAGE_ID || "";
const IG_USER_ID = process.env.META_IG_USER_ID || "";
const IG_BASE_URL = "https://graph.instagram.com/v21.0";
const FB_BASE_URL = "https://graph.facebook.com/v21.0";

async function igFetch(path: string, opts?: RequestInit) {
  const url = path.startsWith("http") ? path : `${IG_BASE_URL}${path}`;
  const separator = url.includes("?") ? "&" : "?";
  const res = await fetch(`${url}${separator}access_token=${TOKEN}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...opts?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Instagram API ${res.status}: ${text}`);
  }
  return res.json();
}

async function fbFetch(path: string, opts?: RequestInit) {
  const url = path.startsWith("http") ? path : `${FB_BASE_URL}${path}`;
  const separator = url.includes("?") ? "&" : "?";
  const res = await fetch(`${url}${separator}access_token=${TOKEN}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...opts?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Facebook API ${res.status}: ${text}`);
  }
  return res.json();
}

const server = new McpServer({
  name: "meta-social",
  version: "1.0.0",
});

// --- create_instagram_post ---
server.tool(
  "create_instagram_post",
  "Create an Instagram photo post. Requires a publicly accessible image URL.",
  {
    image_url: z.string().describe("Public URL of the image to post"),
    caption: z.string().optional().describe("Post caption (max 2200 characters)"),
  },
  async ({ image_url, caption }) => {
    if (!IG_USER_ID) throw new Error("META_IG_USER_ID not configured");
    // Step 1: Create media container
    const container = await igFetch(`/${IG_USER_ID}/media`, {
      method: "POST",
      body: JSON.stringify({ image_url, caption: caption || "" }),
    });
    // Step 2: Publish
    const result = await igFetch(`/${IG_USER_ID}/media_publish`, {
      method: "POST",
      body: JSON.stringify({ creation_id: container.id }),
    });
    return { content: [{ type: "text", text: JSON.stringify({ media_id: result.id, container_id: container.id }, null, 2) }] };
  }
);

// --- create_instagram_carousel ---
server.tool(
  "create_instagram_carousel",
  "Create an Instagram carousel post with multiple images.",
  {
    image_urls: z.array(z.string()).min(2).max(10).describe("Array of public image URLs (2-10)"),
    caption: z.string().optional().describe("Post caption"),
  },
  async ({ image_urls, caption }) => {
    if (!IG_USER_ID) throw new Error("META_IG_USER_ID not configured");
    // Create individual item containers
    const children: string[] = [];
    for (const url of image_urls) {
      const item = await igFetch(`/${IG_USER_ID}/media`, {
        method: "POST",
        body: JSON.stringify({ image_url: url, is_carousel_item: true }),
      });
      children.push(item.id);
    }
    // Create carousel container
    const container = await igFetch(`/${IG_USER_ID}/media`, {
      method: "POST",
      body: JSON.stringify({ media_type: "CAROUSEL", children, caption: caption || "" }),
    });
    // Publish
    const result = await igFetch(`/${IG_USER_ID}/media_publish`, {
      method: "POST",
      body: JSON.stringify({ creation_id: container.id }),
    });
    return { content: [{ type: "text", text: JSON.stringify({ media_id: result.id }, null, 2) }] };
  }
);

// --- create_instagram_reel ---
server.tool(
  "create_instagram_reel",
  "Create an Instagram Reel from a video URL.",
  {
    video_url: z.string().describe("Public URL of the video"),
    caption: z.string().optional().describe("Reel caption"),
    cover_url: z.string().optional().describe("Public URL for cover image"),
    share_to_feed: z.boolean().optional().describe("Also show in main feed (default true)"),
  },
  async ({ video_url, caption, cover_url, share_to_feed }) => {
    if (!IG_USER_ID) throw new Error("META_IG_USER_ID not configured");
    const body: Record<string, any> = { media_type: "REELS", video_url, caption: caption || "" };
    if (cover_url) body.cover_url = cover_url;
    if (share_to_feed !== undefined) body.share_to_feed = share_to_feed;

    const container = await igFetch(`/${IG_USER_ID}/media`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    // Poll for processing completion (videos need time)
    let status = "IN_PROGRESS";
    for (let i = 0; i < 30 && status === "IN_PROGRESS"; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const check = await igFetch(`/${container.id}?fields=status_code`);
      status = check.status_code;
    }
    if (status !== "FINISHED") {
      return { content: [{ type: "text", text: `Reel container created (${container.id}) but processing status: ${status}. May need more time.` }] };
    }

    const result = await igFetch(`/${IG_USER_ID}/media_publish`, {
      method: "POST",
      body: JSON.stringify({ creation_id: container.id }),
    });
    return { content: [{ type: "text", text: JSON.stringify({ media_id: result.id }, null, 2) }] };
  }
);

// --- create_instagram_story ---
server.tool(
  "create_instagram_story",
  "Create an Instagram Story from an image or video URL.",
  {
    media_url: z.string().describe("Public URL of image or video"),
    media_type: z.enum(["IMAGE", "VIDEO"]).optional().describe("Type of media (default IMAGE)"),
  },
  async ({ media_url, media_type }) => {
    if (!IG_USER_ID) throw new Error("META_IG_USER_ID not configured");
    const isVideo = media_type === "VIDEO";
    const body: Record<string, any> = { media_type: "STORIES" };
    if (isVideo) {
      body.video_url = media_url;
    } else {
      body.image_url = media_url;
    }

    const container = await igFetch(`/${IG_USER_ID}/media`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (isVideo) {
      let status = "IN_PROGRESS";
      for (let i = 0; i < 30 && status === "IN_PROGRESS"; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const check = await igFetch(`/${container.id}?fields=status_code`);
        status = check.status_code;
      }
    }

    const result = await igFetch(`/${IG_USER_ID}/media_publish`, {
      method: "POST",
      body: JSON.stringify({ creation_id: container.id }),
    });
    return { content: [{ type: "text", text: JSON.stringify({ media_id: result.id }, null, 2) }] };
  }
);

// --- get_instagram_media ---
server.tool(
  "get_instagram_media",
  "List recent Instagram posts with engagement stats.",
  {
    limit: z.number().min(1).max(100).optional().describe("Number of posts to return (default 25)"),
  },
  async ({ limit }) => {
    if (!IG_USER_ID) throw new Error("META_IG_USER_ID not configured");
    const fields = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count";
    const data = await igFetch(`/${IG_USER_ID}/media?fields=${fields}&limit=${limit || 25}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// --- create_facebook_post ---
server.tool(
  "create_facebook_post",
  "Create a post on a Facebook page. Can be text-only or include a photo.",
  {
    message: z.string().describe("Post text content"),
    image_url: z.string().optional().describe("Public URL of image to attach"),
    link: z.string().optional().describe("URL to share as a link post"),
  },
  async ({ message, image_url, link }) => {
    if (!PAGE_ID) throw new Error("META_PAGE_ID not configured — Facebook page posting requires Pages permissions");
    if (image_url) {
      const data = await fbFetch(`/${PAGE_ID}/photos`, {
        method: "POST",
        body: JSON.stringify({ url: image_url, message }),
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
    const body: Record<string, any> = { message };
    if (link) body.link = link;
    const data = await fbFetch(`/${PAGE_ID}/feed`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// --- create_facebook_reel ---
server.tool(
  "create_facebook_reel",
  "Create a Facebook Reel on a page from a video URL.",
  {
    video_url: z.string().describe("Public URL of the video"),
    description: z.string().optional().describe("Reel description"),
  },
  async ({ video_url, description }) => {
    if (!PAGE_ID) throw new Error("META_PAGE_ID not configured — Facebook page posting requires Pages permissions");
    const init = await fbFetch(`/${PAGE_ID}/video_reels`, {
      method: "POST",
      body: JSON.stringify({ upload_phase: "start" }),
    });
    const uploadRes = await fetch(init.upload_url, {
      method: "POST",
      headers: {
        Authorization: `OAuth ${TOKEN}`,
        file_url: video_url,
      },
    });
    if (!uploadRes.ok) throw new Error(`Video upload failed: ${uploadRes.status}`);

    const result = await fbFetch(`/${PAGE_ID}/video_reels`, {
      method: "POST",
      body: JSON.stringify({
        upload_phase: "finish",
        video_id: init.video_id,
        description: description || "",
      }),
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// --- get_facebook_posts ---
server.tool(
  "get_facebook_posts",
  "List recent posts from the Facebook page.",
  {
    limit: z.number().min(1).max(100).optional().describe("Number of posts (default 25)"),
  },
  async ({ limit }) => {
    if (!PAGE_ID) throw new Error("META_PAGE_ID not configured — Facebook page posting requires Pages permissions");
    const fields = "id,message,created_time,permalink_url,shares,likes.summary(true),comments.summary(true)";
    const data = await fbFetch(`/${PAGE_ID}/posts?fields=${fields}&limit=${limit || 25}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// --- get_post_insights ---
server.tool(
  "get_post_insights",
  "Get engagement metrics for an Instagram or Facebook post.",
  {
    media_id: z.string().describe("The post/media ID"),
    platform: z.enum(["instagram", "facebook"]).optional().describe("Platform (default instagram)"),
  },
  async ({ media_id, platform }) => {
    if (platform === "facebook") {
      const data = await fbFetch(`/${media_id}?fields=id,message,shares,likes.summary(true),comments.summary(true),insights.metric(post_impressions,post_engagements,post_clicks)`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
    // Instagram
    const data = await igFetch(`/${media_id}/insights?metric=impressions,reach,engagement,saved,shares`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// --- delete_post ---
server.tool(
  "delete_post",
  "Delete an Instagram or Facebook post by ID.",
  {
    post_id: z.string().describe("The post/media ID to delete"),
  },
  async ({ post_id }) => {
    await igFetch(`/${post_id}`, { method: "DELETE" });
    return { content: [{ type: "text", text: `Post ${post_id} deleted successfully.` }] };
  }
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
