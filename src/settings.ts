/**
 * User Settings Module
 *
 * Per-user preferences backed by the SQLite `users` table.
 * Falls back to file-based settings if database is not available.
 */

import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import type { Database } from "./db.ts";

const NOVA_DIR = process.env.NOVA_DIR || process.env.RELAY_DIR || join(process.env.HOME || "~", ".nova");
const SETTINGS_FILE = join(NOVA_DIR, "settings.json");

export interface Settings {
  voiceResponses: boolean;
}

const defaults: Settings = {
  voiceResponses: false,
};

// Per-user cache: userId -> Settings
const cached = new Map<string, Settings>();

// Legacy single-user cache for fallback
let legacyCached: Settings | null = null;

/**
 * Load settings for a specific user from the database.
 * Falls back to file-based settings if no db/userId provided.
 */
export async function loadSettings(
  db?: Database | null,
  userId?: string
): Promise<Settings> {
  // DB-backed path
  if (db && userId) {
    const cachedSettings = cached.get(userId);
    if (cachedSettings) return cachedSettings;

    try {
      const user = db.getUserById(userId);

      if (user?.preferences) {
        const settings: Settings = {
          voiceResponses: user.preferences.voice_responses ?? defaults.voiceResponses,
        };
        cached.set(userId, settings);
        return settings;
      }
    } catch (error) {
      console.warn("Settings load error:", error);
    }

    cached.set(userId, { ...defaults });
    return { ...defaults };
  }

  // Legacy file-based fallback
  if (legacyCached) return legacyCached;
  try {
    const content = await readFile(SETTINGS_FILE, "utf-8");
    legacyCached = { ...defaults, ...JSON.parse(content) };
  } catch {
    legacyCached = { ...defaults };
  }
  return legacyCached;
}

/**
 * Toggle voice responses for a specific user.
 * Returns the new state (true = on, false = off).
 */
export async function toggleVoiceResponses(
  db?: Database | null,
  userId?: string
): Promise<boolean> {
  if (db && userId) {
    const settings = await loadSettings(db, userId);
    const newValue = !settings.voiceResponses;

    try {
      db.updateUserPreference(userId, "voice_responses", newValue);
    } catch (error) {
      console.warn("Settings save error:", error);
    }

    settings.voiceResponses = newValue;
    cached.set(userId, settings);
    return newValue;
  }

  // Legacy file-based fallback
  const settings = await loadSettings();
  settings.voiceResponses = !settings.voiceResponses;
  legacyCached = settings;
  await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  return settings.voiceResponses;
}

/**
 * Invalidate cached settings for a user (or all users).
 */
export function invalidateSettingsCache(userId?: string): void {
  if (userId) {
    cached.delete(userId);
  } else {
    cached.clear();
  }
}
