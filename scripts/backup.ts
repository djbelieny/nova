#!/usr/bin/env bun
/**
 * Nova backup script
 * Usage: bun scripts/backup.ts
 * Creates: ~/.nova/backups/nova-YYYY-MM-DDTHH-MM-SS.tar.gz
 */

import { execSync } from "child_process";
import { mkdirSync, existsSync, rmSync } from "fs";
import { join } from "path";

const PROJECT_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const BACKUP_DIR = `${process.env.HOME}/.nova/backups`;
const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const BACKUP_FILE = join(BACKUP_DIR, `nova-${timestamp}.tar.gz`);

// Ensure backup directory exists
mkdirSync(BACKUP_DIR, { recursive: true });

// Items to back up
const items = [
  "data/",    // SQLite databases
  "config/",  // profile.md, identity.md, etc.
];

// Add .env if it exists
if (existsSync(join(PROJECT_ROOT, ".env"))) {
  items.push(".env");
}

const itemList = items.join(" ");

console.log(`[backup] Creating ${BACKUP_FILE}...`);
execSync(`tar -czf "${BACKUP_FILE}" -C "${PROJECT_ROOT}" ${itemList}`, { stdio: "inherit" });

// Prune old backups — keep last 7
const listCmd = `ls -t "${BACKUP_DIR}"/nova-*.tar.gz 2>/dev/null`;
try {
  const files = execSync(listCmd, { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  const toDelete = files.slice(7);
  for (const f of toDelete) {
    rmSync(f);
    console.log(`[backup] Pruned old backup: ${f}`);
  }
} catch (err) {
  console.warn(`[backup] Warning: prune step failed — ${(err as Error).message}`);
}

console.log(`[backup] Done: ${BACKUP_FILE}`);
