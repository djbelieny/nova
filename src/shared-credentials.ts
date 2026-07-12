import type { Database } from "./db.ts";

export function resolveCredential(
  db: Database,
  userId: string,
  provider: string
): { credentials: Record<string, any>; source: "user" | "shared" } | null {
  // 1) the user's own connected integration
  try {
    const own = db.getIntegrationCredentials(userId, provider);
    if (own && own.credentials && Object.keys(own.credentials).length > 0) {
      return { credentials: own.credentials, source: "user" };
    }
  } catch { /* no per-user db / not connected */ }
  // 2) admin-set shared credential
  const shared = db.getSharedCredential(provider);
  if (shared && shared.credentials && Object.keys(shared.credentials).length > 0) {
    return { credentials: shared.credentials, source: "shared" };
  }
  return null;
}

const MODEL_ENV: Record<string, string> = {
  gemini: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  "anthropic-api": "ANTHROPIC_API_KEY",
};

export function getModelApiKey(db: Database, provider: string): string | undefined {
  let shared = null; try { shared = db.getSharedCredential(provider); } catch { shared = null; }
  if (shared?.kind === "model_key" && shared.credentials?.api_key) {
    return String(shared.credentials.api_key);
  }
  const envKey = MODEL_ENV[provider];
  return envKey ? process.env[envKey] : undefined;
}
