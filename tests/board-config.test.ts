import { test, expect } from "bun:test";
import { resolveBoardConfig, isBoardConfigured } from "../src/board-config.ts";

test("prefers BOARD_DB_URL / BOARD_DB_KEY when present", () => {
  const cfg = resolveBoardConfig({
    BOARD_DB_URL: "http://localhost:3005",
    BOARD_DB_KEY: "jwt-new",
    SUPABASE_URL: "https://x.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "svc",
    SUPABASE_ANON_KEY: "anon",
  });
  expect(cfg.url).toBe("http://localhost:3005");
  expect(cfg.key).toBe("jwt-new");
});

test("falls back to SUPABASE_URL and service-role key (legacy alias)", () => {
  const cfg = resolveBoardConfig({
    SUPABASE_URL: "https://x.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "svc",
    SUPABASE_ANON_KEY: "anon",
  });
  expect(cfg.url).toBe("https://x.supabase.co");
  expect(cfg.key).toBe("svc");
});

test("service-role key wins over anon key", () => {
  const cfg = resolveBoardConfig({
    SUPABASE_URL: "https://x.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "svc",
    SUPABASE_ANON_KEY: "anon",
  });
  expect(cfg.key).toBe("svc");
});

test("anon key used when no service-role key", () => {
  const cfg = resolveBoardConfig({
    SUPABASE_URL: "https://x.supabase.co",
    SUPABASE_ANON_KEY: "anon",
  });
  expect(cfg.key).toBe("anon");
});

test("new url can mix with legacy key and vice versa", () => {
  expect(resolveBoardConfig({ BOARD_DB_URL: "http://h", SUPABASE_ANON_KEY: "anon" })).toEqual({
    url: "http://h",
    key: "anon",
  });
  expect(resolveBoardConfig({ SUPABASE_URL: "http://s", BOARD_DB_KEY: "k" })).toEqual({
    url: "http://s",
    key: "k",
  });
});

test("undefined when nothing configured", () => {
  const cfg = resolveBoardConfig({});
  expect(cfg.url).toBeUndefined();
  expect(cfg.key).toBeUndefined();
});

test("isBoardConfigured requires both url and key", () => {
  expect(isBoardConfigured({})).toBe(false);
  expect(isBoardConfigured({ BOARD_DB_URL: "http://h" })).toBe(false);
  expect(isBoardConfigured({ BOARD_DB_KEY: "k" })).toBe(false);
  expect(isBoardConfigured({ BOARD_DB_URL: "http://h", BOARD_DB_KEY: "k" })).toBe(true);
  expect(isBoardConfigured({ SUPABASE_URL: "http://s", SUPABASE_ANON_KEY: "a" })).toBe(true);
});
