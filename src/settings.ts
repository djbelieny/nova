/**
 * User Settings Module
 *
 * Persistent user preferences stored as a JSON file.
 * Currently manages: voice response toggle.
 */

import { readFile, writeFile } from "fs/promises";
import { join, dirname } from "path";

const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
const SETTINGS_FILE = join(RELAY_DIR, "settings.json");

interface Settings {
  voiceResponses: boolean;
}

const defaults: Settings = {
  voiceResponses: false,
};

let cached: Settings | null = null;

export async function loadSettings(): Promise<Settings> {
  if (cached) return cached;
  try {
    const content = await readFile(SETTINGS_FILE, "utf-8");
    cached = { ...defaults, ...JSON.parse(content) };
  } catch {
    cached = { ...defaults };
  }
  return cached;
}

async function saveSettings(settings: Settings): Promise<void> {
  cached = settings;
  await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

export async function toggleVoiceResponses(): Promise<boolean> {
  const settings = await loadSettings();
  settings.voiceResponses = !settings.voiceResponses;
  await saveSettings(settings);
  return settings.voiceResponses;
}
