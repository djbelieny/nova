// src/web-auth.ts
import type { Database } from "./db.ts";

export const MASTER_USER_ID = "__master__";

export async function hashPassword(pw: string): Promise<string> {
  return await Bun.password.hash(pw); // argon2id by default
}

export async function verifyPassword(pw: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(pw, hash);
  } catch {
    return false;
  }
}

export async function verifyLogin(
  db: Database,
  username: string,
  password: string
): Promise<{ userId: string; role: string; mustChange: boolean } | null> {
  // 1) Real per-user account
  const user = db.getUserByUsername(username);
  if (user?.password_hash && (await verifyPassword(password, user.password_hash))) {
    return { userId: user.id, role: user.role || "member", mustChange: user.must_change_password === 1 };
  }
  // 2) Master bootstrap (break-glass super-admin)
  const mu = process.env.DASHBOARD_USER || "admin";
  const mp = process.env.DASHBOARD_PASS;
  if (mp && username === mu && password === mp) {
    return { userId: MASTER_USER_ID, role: "admin", mustChange: false };
  }
  return null;
}
