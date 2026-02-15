/**
 * ElevenLabs Text-to-Speech Module
 *
 * Converts text to speech audio using the ElevenLabs API.
 * Returns an MP3 buffer ready to send via Telegram.
 */

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb"; // Default: George

const API_BASE = "https://api.elevenlabs.io/v1";

export function isTTSEnabled(): boolean {
  return !!ELEVENLABS_API_KEY;
}

export async function textToSpeech(text: string): Promise<Buffer | null> {
  if (!ELEVENLABS_API_KEY) return null;

  // ElevenLabs has a 5000 char limit per request — truncate if needed
  const truncated = text.length > 4500 ? text.substring(0, 4500) + "..." : text;

  try {
    const response = await fetch(
      `${API_BASE}/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: truncated,
          model_id: "eleven_turbo_v2_5",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
      }
    );

    if (!response.ok) {
      console.error(`ElevenLabs error: ${response.status} ${response.statusText}`);
      return null;
    }

    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    console.error("TTS error:", error);
    return null;
  }
}
