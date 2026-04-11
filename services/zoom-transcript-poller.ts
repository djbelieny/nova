/**
 * Zoom Transcript Poller
 *
 * Runs hourly. For each user who has Zoom configured, fetches cloud recordings
 * completed in the last ~70 minutes (overlap to avoid gaps), downloads the
 * VTT transcript, strips formatting, and feeds it through processCallTranscript.
 *
 * Skip logic: meetings whose topic matches ZOOM_SKIP_TOPICS (comma-separated,
 * case-insensitive) are silently ignored. Defaults: "game over,shift"
 *
 * State: processed recording UUIDs and last-poll timestamp are stored in
 * service_state (shared.db) so recordings are never processed twice.
 *
 * Auth: Zoom server-to-server OAuth using ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID,
 * ZOOM_CLIENT_SECRET from .env — same credentials used by the Zoom MCP server.
 */

import { getDb, type Database } from "../src/db.ts";
import { emit } from "../src/events.ts";
import { processCallTranscript } from "./call-processor.ts";

// ============================================================
// Config
// ============================================================

const POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const LOOKBACK_MINUTES = 70; // slight overlap to avoid edge-of-hour gaps
const MAX_RECORDINGS_PER_POLL = 20;

// Topics to skip (classes, lectures, etc.) — comma-separated, case-insensitive
const RAW_SKIP = process.env.ZOOM_SKIP_TOPICS || "game over,shift";
const SKIP_KEYWORDS = RAW_SKIP.split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);

const ZOOM_API = "https://api.zoom.us/v2";

// ============================================================
// Public types
// ============================================================

export interface ZoomMeeting {
  uuid: string;
  id: number;
  topic: string;
  start_time: string;
  duration: number;
  participants: string[];
  transcriptDownloadUrl: string;
}

// ============================================================
// Module state
// ============================================================

let _db: Database | null = null;
function db(): Database {
  if (!_db) _db = getDb();
  return _db;
}

// Cached OAuth token (shared across users — account-level credentials)
let _cachedToken: string | null = null;
let _tokenExpiry = 0;

// ============================================================
// Zoom OAuth — server-to-server (account credentials)
// ============================================================

async function getZoomToken(): Promise<string> {
  const now = Date.now();
  if (_cachedToken && now < _tokenExpiry) return _cachedToken;

  const accountId = process.env.ZOOM_ACCOUNT_ID;
  const clientId = process.env.ZOOM_CLIENT_ID;
  const clientSecret = process.env.ZOOM_CLIENT_SECRET;

  if (!accountId || !clientId || !clientSecret) {
    throw new Error("Zoom credentials not configured (ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET)");
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${accountId}`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Zoom OAuth failed: ${res.status} ${body.slice(0, 200)}`);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  _cachedToken = data.access_token;
  // Expire 2 minutes early to be safe
  _tokenExpiry = now + (data.expires_in - 120) * 1000;
  return _cachedToken;
}

// ============================================================
// Zoom API helpers
// ============================================================

async function listRecordingsSince(token: string, since: Date): Promise<any[]> {
  // Zoom's recordings API uses date-range (day granularity), so we query today
  // (and possibly yesterday if we're polling near midnight) then filter by time
  const fromDate = new Date(since);
  fromDate.setHours(0, 0, 0, 0);
  const from = fromDate.toISOString().split("T")[0]; // YYYY-MM-DD
  const to = new Date().toISOString().split("T")[0];

  const url = `${ZOOM_API}/users/me/recordings?from=${from}&to=${to}&page_size=${MAX_RECORDINGS_PER_POLL}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Zoom recordings list failed: ${res.status} ${body.slice(0, 200)}`);
  }

  const data = await res.json() as { meetings?: any[] };
  const meetings = data.meetings || [];

  // Filter to only recordings that completed after `since`
  return meetings.filter((m) => {
    if (!m.start_time) return false;
    const meetingEnd = new Date(m.start_time);
    meetingEnd.setMinutes(meetingEnd.getMinutes() + (m.duration || 0));
    return meetingEnd >= since;
  });
}

async function downloadTranscript(token: string, downloadUrl: string): Promise<string> {
  // Zoom requires Bearer token for file downloads
  const res = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "follow",
  });

  if (!res.ok) {
    throw new Error(`Transcript download failed: ${res.status}`);
  }

  return res.text();
}

// ============================================================
// VTT / transcript parsing
// ============================================================

/**
 * Strip WebVTT formatting to plain readable text.
 * Deduplicates consecutive speaker lines.
 */
function stripVTT(vtt: string): string {
  const lines = vtt.split("\n");
  const textLines: string[] = [];
  let lastLine = "";

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip WEBVTT header, timestamps, cue numbers, and blank lines
    if (
      !trimmed ||
      trimmed === "WEBVTT" ||
      /^\d+$/.test(trimmed) ||
      /^\d{2}:\d{2}:\d{2}/.test(trimmed) ||
      trimmed.startsWith("NOTE") ||
      trimmed.startsWith("STYLE")
    ) {
      continue;
    }
    // Deduplicate (Zoom sometimes repeats lines in live captions)
    if (trimmed !== lastLine) {
      textLines.push(trimmed);
      lastLine = trimmed;
    }
  }

  return textLines.join("\n").trim();
}

// ============================================================
// Skip logic
// ============================================================

function shouldSkipMeeting(topic: string): boolean {
  const lower = topic.toLowerCase();
  return SKIP_KEYWORDS.some((kw) => lower.includes(kw));
}

// ============================================================
// State: processed recording IDs
// ============================================================

const STATE_SERVICE = "zoom_poller";

function getProcessedIds(userId: string): Set<string> {
  try {
    const raw = db().getServiceState(STATE_SERVICE, `processed_${userId}`);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(arr);
  } catch {
    return new Set();
  }
}

function markProcessed(userId: string, ids: string[]): void {
  if (!ids.length) return;
  try {
    const existing = getProcessedIds(userId);
    for (const id of ids) existing.add(id);
    // Keep last 200 IDs to bound storage
    const trimmed = Array.from(existing).slice(-200);
    db().setServiceState(STATE_SERVICE, `processed_${userId}`, JSON.stringify(trimmed));
  } catch (err) {
    console.error("[zoom-poller] Failed to persist processed IDs:", (err as Error).message);
  }
}

// ============================================================
// Per-user poll
// ============================================================

async function pollForUser(userId: string, user: any): Promise<void> {
  const token = await getZoomToken();
  const since = new Date(Date.now() - LOOKBACK_MINUTES * 60 * 1000);
  const meetings = await listRecordingsSince(token, since);

  if (!meetings.length) return;

  const processed = getProcessedIds(userId);
  const newlyProcessed: string[] = [];

  for (const meeting of meetings) {
    const recordingId = meeting.uuid || String(meeting.id);

    // Skip already-processed recordings
    if (processed.has(recordingId)) continue;

    const topic: string = meeting.topic || "Zoom Call";

    // Skip classes/lectures
    if (shouldSkipMeeting(topic)) {
      console.log(`[zoom-poller] Skipped: "${topic}" (matched skip keyword)`);
      newlyProcessed.push(recordingId); // mark so we don't check again
      continue;
    }

    // Find the transcript file in recording_files
    const transcriptFile = (meeting.recording_files || []).find(
      (f: any) => f.file_type === "TRANSCRIPT" && f.status === "completed"
    );

    if (!transcriptFile) {
      console.log(`[zoom-poller] No transcript for: "${topic}" — skipped`);
      continue;
    }

    // Download and parse VTT
    let plainText: string;
    try {
      const vtt = await downloadTranscript(token, transcriptFile.download_url);
      plainText = stripVTT(vtt);
    } catch (err) {
      console.error(`[zoom-poller] Download failed for "${topic}":`, (err as Error).message);
      continue;
    }

    if (!plainText.trim()) {
      console.log(`[zoom-poller] Empty transcript for "${topic}" — skipped`);
      newlyProcessed.push(recordingId);
      continue;
    }

    // Parse participants
    const participants: string[] = (meeting.participants || [])
      .map((p: any) => p.name || p.email)
      .filter(Boolean)
      .slice(0, 10);

    emit({
      type: "system.health",
      level: "info",
      userId,
      data: { message: `Processing Zoom transcript: "${topic}"`, recordingId, module: "zoom-poller" },
    });

    // Feed through the call processor pipeline
    await processCallTranscript(userId, plainText, {
      title: topic,
      participants,
      duration_minutes: meeting.duration || undefined,
    });

    newlyProcessed.push(recordingId);
  }

  if (newlyProcessed.length) {
    markProcessed(userId, newlyProcessed);
  }
}

// ============================================================
// Main poll loop
// ============================================================

async function runPoll(): Promise<void> {
  // Check that Zoom credentials are configured
  if (!process.env.ZOOM_ACCOUNT_ID || !process.env.ZOOM_CLIENT_ID || !process.env.ZOOM_CLIENT_SECRET) {
    return; // Silently skip — credentials not configured
  }

  const users = db().getAllActiveUsers();
  if (!users?.length) return;

  for (const user of users) {
    try {
      await pollForUser(user.id, user);
    } catch (err) {
      console.error(`[zoom-poller] Error for ${user.name}:`, (err as Error).message);
      emit({
        type: "error",
        level: "warn",
        userId: user.id,
        data: { message: `Zoom poll failed: ${(err as Error).message}`, module: "zoom-poller" },
      });
    }
  }
}

// ============================================================
// Search + manual ingest (public API)
// ============================================================

/**
 * Search Zoom cloud recordings by topic keyword.
 * Returns up to 5 matches that have a completed transcript file.
 */
export async function searchZoomRecordings(
  query: string,
  daysBack = 30
): Promise<ZoomMeeting[]> {
  if (!process.env.ZOOM_ACCOUNT_ID) return [];

  const token = await getZoomToken();
  const from = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];
  const to = new Date().toISOString().split("T")[0];

  const url = `${ZOOM_API}/users/me/recordings?from=${from}&to=${to}&page_size=100`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Zoom search failed: ${res.status}`);

  const data = await res.json() as { meetings?: any[] };
  const lower = query.toLowerCase();

  const matches: ZoomMeeting[] = [];
  for (const m of data.meetings || []) {
    if (matches.length >= 5) break;
    if (!m.topic?.toLowerCase().includes(lower)) continue;

    const transcriptFile = (m.recording_files || []).find(
      (f: any) => f.file_type === "TRANSCRIPT" && f.status === "completed"
    );
    if (!transcriptFile) continue;

    matches.push({
      uuid: m.uuid || String(m.id),
      id: m.id,
      topic: m.topic || "Zoom Call",
      start_time: m.start_time || new Date().toISOString(),
      duration: m.duration || 0,
      participants: (m.participants || []).map((p: any) => p.name || p.email).filter(Boolean).slice(0, 10),
      transcriptDownloadUrl: transcriptFile.download_url,
    });
  }

  return matches;
}

/**
 * Download and process a specific Zoom recording into Nova's pipeline.
 * Safe to call multiple times — skips if already processed.
 */
export async function processRecordingById(
  userId: string,
  meeting: ZoomMeeting
): Promise<void> {
  const processed = getProcessedIds(userId);
  if (processed.has(meeting.uuid)) {
    console.log(`[zoom-poller] Already processed: "${meeting.topic}" (${meeting.uuid})`);
    return;
  }

  const token = await getZoomToken();
  const vtt = await downloadTranscript(token, meeting.transcriptDownloadUrl);
  const plainText = stripVTT(vtt);

  if (!plainText.trim()) {
    console.log(`[zoom-poller] Empty transcript for "${meeting.topic}" — skipped`);
    markProcessed(userId, [meeting.uuid]);
    return;
  }

  emit({
    type: "system.health",
    level: "info",
    userId,
    data: { message: `Manual ingest: "${meeting.topic}"`, uuid: meeting.uuid, module: "zoom-poller" },
  });

  await processCallTranscript(userId, plainText, {
    title: meeting.topic,
    participants: meeting.participants,
    duration_minutes: meeting.duration || undefined,
  });

  markProcessed(userId, [meeting.uuid]);
}

// ============================================================
// Public API
// ============================================================

export function startZoomPoller(): void {
  if (!process.env.ZOOM_ACCOUNT_ID) {
    console.log("[zoom-poller] Disabled — ZOOM_ACCOUNT_ID not set");
    return;
  }

  setInterval(() => {
    runPoll().catch((err) =>
      console.error("[zoom-poller] Unhandled error:", (err as Error).message)
    );
  }, POLL_INTERVAL_MS);

  console.log(`[zoom-poller] Started — polling every ${POLL_INTERVAL_MS / 60000} min, skip: [${SKIP_KEYWORDS.join(", ")}]`);
}

/** Run one poll immediately (for testing / manual trigger). */
export async function runZoomPollNow(): Promise<void> {
  await runPoll();
}
