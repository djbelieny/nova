// tests/pairing.test.ts
import { test, expect } from "bun:test";
import { getDb } from "../src/db.ts";

const SAFE_ALPHABET = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;

test("create → redeem happy path returns the role and creates the user", () => {
  const db = getDb();
  const admin = db.upsertUser({ telegram_id: "tg-pair-admin-1", name: "Admin", role: "admin" });
  const code = db.createPairingCode(admin.id, "member", 60);

  expect(code).toMatch(SAFE_ALPHABET);

  const result = db.redeemPairingCode(code, "tg-pair-new-1");
  expect(result).toEqual({ ok: true, role: "member" });

  // Redemption itself doesn't create the user — the relay does — but redeeming
  // then upserting must produce a live user.
  const user = db.upsertUser({ telegram_id: "tg-pair-new-1", name: "Newbie", role: result.ok ? result.role : "member" });
  expect(user.telegram_id).toBe("tg-pair-new-1");
  expect(user.role).toBe("member");
});

test("redeeming the same code twice → second is rejected as used", () => {
  const db = getDb();
  const admin = db.upsertUser({ telegram_id: "tg-pair-admin-2", name: "Admin2", role: "admin" });
  const code = db.createPairingCode(admin.id, "member", 60);

  const first = db.redeemPairingCode(code, "tg-pair-a");
  expect(first).toEqual({ ok: true, role: "member" });

  const second = db.redeemPairingCode(code, "tg-pair-b");
  expect(second).toEqual({ ok: false, error: "used" });
});

test("redemption is case-insensitive on the code", () => {
  const db = getDb();
  const admin = db.upsertUser({ telegram_id: "tg-pair-admin-ci", name: "AdminCI", role: "admin" });
  const code = db.createPairingCode(admin.id, "admin", 60);

  const result = db.redeemPairingCode(code.toLowerCase(), "tg-pair-ci");
  expect(result).toEqual({ ok: true, role: "admin" });
});

test("an expired code is rejected", () => {
  const db = getDb();
  const admin = db.upsertUser({ telegram_id: "tg-pair-admin-3", name: "Admin3", role: "admin" });
  const code = db.createPairingCode(admin.id, "member", 60);

  // Force the code into the past.
  db.raw.run(`UPDATE pairing_codes SET expires_at = datetime('now', '-1 hour') WHERE code = ?`, [code]);

  const result = db.redeemPairingCode(code, "tg-pair-expired");
  expect(result).toEqual({ ok: false, error: "expired" });
});

test("a ttl<=0 code is immediately expired", () => {
  const db = getDb();
  const admin = db.upsertUser({ telegram_id: "tg-pair-admin-ttl0", name: "AdminTTL0", role: "admin" });
  const code = db.createPairingCode(admin.id, "member", 0);

  const result = db.redeemPairingCode(code, "tg-pair-ttl0");
  expect(result).toEqual({ ok: false, error: "expired" });
});

test("an unknown code is rejected as invalid", () => {
  const db = getDb();
  const result = db.redeemPairingCode("ZZZZ9999", "tg-pair-unknown");
  expect(result).toEqual({ ok: false, error: "invalid" });
});

test("generated codes are 8 chars from the safe alphabet and unique across many calls", () => {
  const db = getDb();
  const admin = db.upsertUser({ telegram_id: "tg-pair-admin-4", name: "Admin4", role: "admin" });
  const codes = new Set<string>();
  for (let i = 0; i < 500; i++) {
    const code = db.createPairingCode(admin.id, "member", 60);
    expect(code).toMatch(SAFE_ALPHABET);
    codes.add(code);
  }
  expect(codes.size).toBe(500);
});

test("pruneExpiredPairingCodes removes only expired, unredeemed codes", () => {
  const db = getDb();
  const admin = db.upsertUser({ telegram_id: "tg-pair-admin-5", name: "Admin5", role: "admin" });
  const live = db.createPairingCode(admin.id, "member", 60);
  const dead = db.createPairingCode(admin.id, "member", 60);
  db.raw.run(`UPDATE pairing_codes SET expires_at = datetime('now', '-1 hour') WHERE code = ?`, [dead]);

  db.pruneExpiredPairingCodes();

  // Live code still redeemable, dead code is gone (redeeming it now reads as invalid).
  expect(db.redeemPairingCode(dead, "tg-pair-pruned")).toEqual({ ok: false, error: "invalid" });
  expect(db.redeemPairingCode(live, "tg-pair-live")).toEqual({ ok: true, role: "member" });
});
