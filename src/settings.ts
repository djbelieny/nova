/**
 * User Settings Module
 *
 * Per-user preferences backed by the Supabase `users` table.
 * Falls back to file-based settings if Supabase is not configured.
 */

import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import type { SupabaseClient } from "@supabase/supabase-js";

const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".nova");
const SETTINGS_FILE = join(RELAY_DIR, "settings.json");

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
 * Load settings for a specific user from Supabase.
 * Falls back to file-based settings if no supabase/userId provided.
 */
export async function loadSettings(
  supabase?: SupabaseClient | null,
  userId?: string
): Promise<Settings> {
  // DB-backed path
  if (supabase && userId) {
    const cachedSettings = cached.get(userId);
    if (cachedSettings) return cachedSettings;

    try {
      const { data } = await supabase
        .from("users")
        .select("preferences")
        .eq("id", userId)
        .single();

      if (data?.preferences) {
        const settings: Settings = {
          voiceResponses: data.preferences.voice_responses ?? defaults.voiceResponses,
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
  supabase?: SupabaseClient | null,
  userId?: string
): Promise<boolean> {
  if (supabase && userId) {
    const settings = await loadSettings(supabase, userId);
    const newValue = !settings.voiceResponses;

    try {
      await supabase.rpc("update_user_preference", {
        p_user_id: userId,
        p_key: "voice_responses",
        p_value: JSON.stringify(newValue),
      });
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
