/**
 * AI Video Module for Nova
 *
 * Provides programmatic access to AI video generation:
 * - HeyGen: Avatar/talking head videos
 * - Fal.ai: Text-to-video (Kling, Luma, Minimax, etc.)
 *
 * Usage:
 *   bun run src/ai-video.ts <command> [args]
 */

import { trackCost } from "./cost-tracker.ts";

// ─── Config ────────────────────────────────────────────────

const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY || "";
const HEYGEN_BASE = "https://api.heygen.com";

const FAL_API_KEY = process.env.FAL_API_KEY || "";
const FAL_BASE = "https://queue.fal.run";

// ─── HeyGen Helpers ────────────────────────────────────────

async function heygenGet(endpoint: string): Promise<any> {
  const res = await fetch(`${HEYGEN_BASE}${endpoint}`, {
    headers: { "X-Api-Key": HEYGEN_API_KEY },
  });
  return res.json();
}

async function heygenPost(endpoint: string, body: any): Promise<any> {
  const res = await fetch(`${HEYGEN_BASE}${endpoint}`, {
    method: "POST",
    headers: { "X-Api-Key": HEYGEN_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ─── Fal.ai Helpers ────────────────────────────────────────

async function falPost(model: string, body: any): Promise<any> {
  const res = await fetch(`${FAL_BASE}/${model}`, {
    method: "POST",
    headers: { Authorization: `Key ${FAL_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function falStatus(requestUrl: string): Promise<any> {
  const res = await fetch(`${requestUrl}/status`, {
    headers: { Authorization: `Key ${FAL_API_KEY}` },
  });
  return res.json();
}

async function falResult(requestUrl: string): Promise<any> {
  const res = await fetch(requestUrl, {
    headers: { Authorization: `Key ${FAL_API_KEY}` },
  });
  return res.json();
}

async function falCancel(requestUrl: string): Promise<any> {
  const res = await fetch(`${requestUrl}/cancel`, {
    method: "PUT",
    headers: { Authorization: `Key ${FAL_API_KEY}` },
  });
  return res.json();
}

// ─── HeyGen: Avatars ───────────────────────────────────────

export async function listAvatars() {
  return heygenGet("/v2/avatars");
}

export async function listVoices() {
  return heygenGet("/v2/voices");
}

export async function getAvatarGroups() {
  return heygenGet("/v2/avatar_group.list");
}

export async function getRemainingQuota() {
  return heygenGet("/v2/user/remaining_quota");
}

// ─── HeyGen: Generate Avatar Video ─────────────────────────

export interface HeyGenVideoParams {
  avatar_id?: string;  // falls back to user's preferences.heygen_avatar_id
  voice_id?: string;   // falls back to user's preferences.heygen_voice_id
  script: string;
  title?: string;
  width?: number;  // default 1080
  height?: number; // default 1920 (9:16 portrait)
  test?: boolean;  // true = free low-res test
  user_preferences?: Record<string, any>; // from users.preferences — provides avatar/voice defaults
}

export async function generateAvatarVideo(params: HeyGenVideoParams) {
  const prefs = params.user_preferences || {};
  const avatarId = params.avatar_id || prefs.heygen_avatar_id;
  const voiceId = params.voice_id || prefs.heygen_voice_id;
  if (!avatarId) throw new Error("No avatar_id provided and no heygen_avatar_id in user preferences");
  if (!voiceId) throw new Error("No voice_id provided and no heygen_voice_id in user preferences");

  const start = Date.now();
  const result = await heygenPost("/v2/video/generate", {
    title: params.title || "Nova Video",
    test: params.test ?? false,
    video_inputs: [
      {
        character: {
          type: "avatar",
          avatar_id: avatarId,
          avatar_style: "normal",
        },
        voice: {
          type: "text",
          input_text: params.script,
          voice_id: voiceId,
          speed: 1.0,
        },
      },
    ],
    dimension: {
      width: params.width || 1080,
      height: params.height || 1920,
    },
  });

  // HeyGen: ~$0.10/credit, 1 credit per minute of video
  trackCost({
    provider: "heygen",
    model: "avatar-v2",
    duration_ms: Date.now() - start,
    metadata: {
      video_id: result?.data?.video_id,
      test: params.test ?? false,
      script_length: params.script.length,
      avatar_id: avatarId,
    },
  });

  return result;
}

export async function getVideoStatus(videoId: string) {
  return heygenGet(`/v1/video_status.get?video_id=${videoId}`);
}

// ─── HeyGen: Poll Until Complete ───────────────────────────

export async function waitForVideo(videoId: string, timeoutMs = 600000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await getVideoStatus(videoId);
    const status = result?.data?.status;
    if (status === "completed") return result;
    if (status === "failed") throw new Error(`HeyGen video failed: ${JSON.stringify(result.data)}`);
    console.log(`  Video status: ${status}... (${Math.round((Date.now() - start) / 1000)}s)`);
    await new Promise((r) => setTimeout(r, 10000)); // poll every 10s
  }
  throw new Error("HeyGen video timed out");
}

// ─── Fal.ai: Text-to-Video ────────────────────────────────

export type FalModel =
  | "fal-ai/kling-video/v2/master"       // Kling 2.0 Master (best quality)
  | "fal-ai/kling-video/v2/standard"     // Kling 2.0 Standard (faster)
  | "fal-ai/minimax-video/video-01-live" // Minimax Hailuo
  | "fal-ai/luma-dream-machine"          // Luma Dream Machine
  | "fal-ai/runway-gen3/turbo/image-to-video"; // Runway Gen-3

export interface TextToVideoParams {
  model?: FalModel;
  prompt: string;
  duration?: "5" | "10";           // seconds (Kling)
  aspect_ratio?: "16:9" | "9:16" | "1:1";
  image_url?: string;              // for image-to-video
  negative_prompt?: string;
}

export async function generateTextToVideo(params: TextToVideoParams) {
  const model = params.model || "fal-ai/kling-video/v2/master";
  const body: Record<string, any> = {
    prompt: params.prompt,
  };
  if (params.duration) body.duration = params.duration;
  if (params.aspect_ratio) body.aspect_ratio = params.aspect_ratio;
  if (params.image_url) body.image_url = params.image_url;
  if (params.negative_prompt) body.negative_prompt = params.negative_prompt;

  const start = Date.now();
  const result = await falPost(model, body);

  trackCost({
    provider: "fal",
    model,
    duration_ms: Date.now() - start,
    metadata: {
      request_id: result?.request_id,
      prompt_length: params.prompt.length,
      video_duration: params.duration || "5",
      aspect_ratio: params.aspect_ratio,
    },
  });

  return result;
}

export async function checkFalStatus(responseUrl: string) {
  return falStatus(responseUrl);
}

export async function getFalResult(responseUrl: string) {
  return falResult(responseUrl);
}

export async function cancelFalJob(responseUrl: string) {
  return falCancel(responseUrl);
}

// ─── Fal.ai: Poll Until Complete ───────────────────────────

export async function waitForFalVideo(responseUrl: string, timeoutMs = 600000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await falStatus(responseUrl);
    if (status.status === "COMPLETED") return falResult(responseUrl);
    if (status.status === "FAILED") throw new Error(`Fal.ai generation failed: ${JSON.stringify(status)}`);
    const pos = status.queue_position != null ? ` (queue: ${status.queue_position})` : "";
    console.log(`  Fal status: ${status.status}${pos}... (${Math.round((Date.now() - start) / 1000)}s)`);
    await new Promise((r) => setTimeout(r, 5000)); // poll every 5s
  }
  throw new Error("Fal.ai generation timed out");
}

// ─── Fal.ai: Image-to-Video ───────────────────────────────

export async function imageToVideo(imageUrl: string, prompt: string, model?: FalModel) {
  return generateTextToVideo({
    model: model || "fal-ai/kling-video/v2/master",
    prompt,
    image_url: imageUrl,
  });
}

// ─── CLI ───────────────────────────────────────────────────

if (import.meta.main) {
  const cmd = process.argv[2];
  const arg = process.argv[3];

  const commands: Record<string, () => Promise<void>> = {
    // HeyGen
    avatars: async () => {
      const data = await listAvatars();
      const avatars = data?.data?.avatars || [];
      console.log(`${avatars.length} avatars available. Showing first 20:\n`);
      avatars.slice(0, 20).forEach((a: any) =>
        console.log(`  ${a.avatar_id}: ${a.avatar_name} (${a.gender || "?"})`)
      );
    },
    voices: async () => {
      const data = await listVoices();
      const voices = data?.data?.voices || [];
      const english = voices.filter((v: any) => (v.language || "").startsWith("en"));
      console.log(`${voices.length} total voices, ${english.length} English. Showing first 20 English:\n`);
      english.slice(0, 20).forEach((v: any) =>
        console.log(`  ${v.voice_id}: ${v.name || v.voice_id} (${v.gender || "?"})`)
      );
    },
    quota: async () => {
      const data = await getRemainingQuota();
      console.log(JSON.stringify(data, null, 2));
    },
    "video-status": async () => {
      if (!arg) { console.log("Usage: bun run src/ai-video.ts video-status <video_id>"); return; }
      console.log(JSON.stringify(await getVideoStatus(arg), null, 2));
    },

    // Fal.ai
    "text-to-video": async () => {
      const prompt = process.argv.slice(3).join(" ");
      if (!prompt) { console.log("Usage: bun run src/ai-video.ts text-to-video <prompt>"); return; }
      console.log("Submitting to Kling 2.0 Master...");
      const result = await generateTextToVideo({ prompt, duration: "5", aspect_ratio: "9:16" });
      console.log(`\nQueued! Request ID: ${result.request_id}`);
      console.log(`Status URL: ${result.status_url}`);
      console.log(`Response URL: ${result.response_url}`);
      console.log("\nRun: bun run src/ai-video.ts fal-status <response_url>");
    },
    "fal-status": async () => {
      if (!arg) { console.log("Usage: bun run src/ai-video.ts fal-status <response_url>"); return; }
      console.log(JSON.stringify(await checkFalStatus(arg), null, 2));
    },
    "fal-result": async () => {
      if (!arg) { console.log("Usage: bun run src/ai-video.ts fal-result <response_url>"); return; }
      console.log(JSON.stringify(await getFalResult(arg), null, 2));
    },
    "fal-wait": async () => {
      if (!arg) { console.log("Usage: bun run src/ai-video.ts fal-wait <response_url>"); return; }
      console.log("Waiting for Fal.ai generation...");
      const result = await waitForFalVideo(arg);
      console.log("\nDone!");
      console.log(JSON.stringify(result, null, 2));
    },
  };

  if (!cmd || !commands[cmd]) {
    console.log("Nova AI Video CLI");
    console.log("Usage: bun run src/ai-video.ts <command> [args]\n");
    console.log("HeyGen (Avatar Videos):");
    console.log("  avatars          List available avatars");
    console.log("  voices           List English voices");
    console.log("  quota            Check remaining credits");
    console.log("  video-status <id>  Check video generation status");
    console.log("\nFal.ai (Text-to-Video):");
    console.log("  text-to-video <prompt>   Generate video from text (Kling 2.0)");
    console.log("  fal-status <url>         Check generation status");
    console.log("  fal-result <url>         Get completed result");
    console.log("  fal-wait <url>           Wait for completion and get result");
  } else {
    await commands[cmd]();
  }
}
