/**
 * Board backend configuration resolution.
 *
 * The Executive Board talks to a PostgREST HTTP endpoint. Historically that was
 * a supabase.com project (SUPABASE_URL + service-role/anon key). Nova can now
 * self-host the same wire format (Postgres + PostgREST, see deploy/board/), so
 * the canonical env names are BOARD_DB_URL / BOARD_DB_KEY. The old SUPABASE_*
 * names remain as back-compat aliases so existing deployments keep working.
 */

export interface BoardConfig {
  url?: string;
  key?: string;
}

type Env = Record<string, string | undefined>;

export function resolveBoardConfig(env: Env = process.env): BoardConfig {
  const url = env.BOARD_DB_URL || env.SUPABASE_URL || undefined;
  const key = env.BOARD_DB_KEY || env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY || undefined;
  return { url, key };
}

export function isBoardConfigured(env: Env = process.env): boolean {
  const { url, key } = resolveBoardConfig(env);
  return Boolean(url && key);
}
