import { test, expect } from "bun:test";
import { existsSync, statSync } from "fs";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const BOARD = join(ROOT, "deploy", "board");
const read = (p: string) => readFileSync(join(BOARD, p), "utf8");

test("board deploy files all exist", () => {
  for (const f of [
    "docker-compose.yml",
    "setup.sh",
    "nginx.conf",
    ".env.example",
    "init/00-roles.sh",
    "init/01-run-migration.sh",
    "init/02-grants.sql",
  ]) {
    expect(existsSync(join(BOARD, f))).toBe(true);
  }
});

test("setup.sh and init shell scripts are executable", () => {
  for (const f of ["setup.sh", "init/00-roles.sh", "init/01-run-migration.sh"]) {
    const mode = statSync(join(BOARD, f)).mode;
    expect(mode & 0o100).toBeGreaterThan(0);
  }
});

test("compose defines postgres, postgrest and the nginx wire-compat proxy", () => {
  const c = read("docker-compose.yml");
  expect(c).toContain("postgres:");
  expect(c).toContain("postgrest:");
  expect(c).toContain("board-proxy:");
  expect(c).toMatch(/image:\s*postgres:16/);
  expect(c).toMatch(/image:\s*postgrest\/postgrest:v12/);
  expect(c).toMatch(/image:\s*nginx:/);
});

test("compose applies the shared migration and init scripts on first boot", () => {
  const c = read("docker-compose.yml");
  expect(c).toContain("/docker-entrypoint-initdb.d");
  expect(c).toContain("supabase/migrations/001_executive_board.sql:/migrations/001_executive_board.sql");
  expect(existsSync(join(ROOT, "supabase/migrations/001_executive_board.sql"))).toBe(true);
});

test("only the proxy publishes a port; postgres stays internal", () => {
  const c = read("docker-compose.yml");
  // proxy publishes BOARD_PROXY_PORT -> 80
  expect(c).toMatch(/\$\{BOARD_PROXY_PORT:-3005\}:80/);
  // postgres block must not publish 5432 to the host
  const pgBlock = c.slice(c.indexOf("postgres:"), c.indexOf("postgrest:"));
  expect(pgBlock).not.toMatch(/5432:5432/);
});

test("postgrest wired to the anon role and JWT secret", () => {
  const c = read("docker-compose.yml");
  expect(c).toContain("PGRST_DB_ANON_ROLE: nova_board_anon");
  expect(c).toContain("PGRST_JWT_SECRET");
  expect(c).toContain("PGRST_DB_SCHEMAS: public");
});

test("roles: single trusted BYPASSRLS role plus locked-down anon", () => {
  const roles = read("init/00-roles.sh");
  expect(roles).toMatch(/CREATE ROLE nova_board NOLOGIN BYPASSRLS/);
  expect(roles).toContain("CREATE ROLE nova_board_anon NOLOGIN");
  expect(roles).toContain("CREATE ROLE authenticator");
  const grants = read("init/02-grants.sql");
  expect(grants).toContain("GRANT ALL ON ALL TABLES IN SCHEMA public TO nova_board");
});

test("nginx maps the Supabase /rest/v1 prefix onto bare PostgREST", () => {
  const n = read("nginx.conf");
  expect(n).toContain("location /rest/v1/");
  expect(n).toMatch(/rewrite\s+\^\/rest\/v1\/\(\.\*\)\$\s+\/\$1\s+break/);
  expect(n).toContain("proxy_pass http://postgrest:3000");
});

test("setup.sh mints a nova_board JWT and smoke-tests a real round-trip", () => {
  const s = read("setup.sh");
  expect(s).toContain('"role":"nova_board"');
  expect(s).toContain("openssl dgst -sha256 -hmac");
  // INSERT + SELECT + DELETE through /rest/v1
  expect(s).toContain("-X POST");
  expect(s).toContain("-X DELETE");
  expect(s).toContain("/rest/v1/proactive_runs");
});

test(".env.example documents the board vars without real secrets", () => {
  const e = read(".env.example");
  expect(e).toContain("PGRST_JWT_SECRET");
  expect(e).toContain("AUTHENTICATOR_PASSWORD");
  expect(e).toContain("change-me");
});
