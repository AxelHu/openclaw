/**
 * Feishu ID Mapping Store (SQLite)
 *
 * Problem: When Bot A @mentions Bot B, the open_id in the @mention is from Bot A's app context.
 * But when Bot B tries to reply @mentioning Bot A, it needs Bot A's open_id in Bot B's app context.
 * These are different values for the same user/bot.
 *
 * Solution: Cache open_id ↔ union_id ↔ app_id mappings, built from incoming message events.
 * Miss → API lookup → record result (API called at most once per miss).
 *
 * Schema:
 *   id_mappings(open_id TEXT PRIMARY KEY, union_id TEXT NOT NULL, updated_at INTEGER)
 *   app_openid(union_id TEXT, app_id TEXT, open_id TEXT, PRIMARY KEY(union_id, app_id))
 */

import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const stateOverride = env.OPENCLAW_STATE_DIR?.trim();
  if (stateOverride) {
    return stateOverride;
  }
  return path.join(os.homedir(), ".openclaw");
}

const DB_PATH = path.join(resolveStateDir(), "data", "feishu-id-mapping.db");

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) {
    return _db;
  }

  const dataDir = path.dirname(DB_PATH);
  try {
    require("node:fs")
      .promises.mkdir(dataDir, { recursive: true })
      .catch(() => {});
  } catch {}

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS id_mappings (
      open_id TEXT PRIMARY KEY,
      union_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_openid (
      union_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
      open_id TEXT NOT NULL,
      PRIMARY KEY (union_id, app_id)
    );

    CREATE INDEX IF NOT EXISTS idx_union ON id_mappings(union_id);
  `);

  return _db;
}

export async function initIdMappingStore(): Promise<void> {
  getDb();
}

// --- DB helpers ---

function upsertMapping(openId: string, unionId: string): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO id_mappings (open_id, union_id, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(open_id) DO UPDATE SET
      union_id = excluded.union_id,
      updated_at = excluded.updated_at
  `).run(openId, unionId, now);
}

function upsertAppOpenid(unionId: string, appId: string, openId: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO app_openid (union_id, app_id, open_id)
    VALUES (?, ?, ?)
    ON CONFLICT(union_id, app_id) DO UPDATE SET
      open_id = excluded.open_id
  `).run(unionId, appId, openId);
}

function getMappingUnionId(openId: string): string | undefined {
  const db = getDb();
  const row = db.prepare("SELECT union_id FROM id_mappings WHERE open_id = ?").get(openId) as
    | { union_id: string }
    | undefined;
  return row?.union_id;
}

function getAppOpenid(unionId: string, appId: string): string | undefined {
  const db = getDb();
  const row = db
    .prepare("SELECT open_id FROM app_openid WHERE union_id = ? AND app_id = ?")
    .get(unionId, appId) as { open_id: string } | undefined;
  return row?.open_id;
}

// --- Public API ---

/**
 * Record IDs from an incoming message event's sender.
 * Call this whenever a message is received to build up the cache.
 *
 * @param openId - sender's open_id in THIS app's context
 * @param unionId - sender's union_id (stable across apps)
 * @param appId - the app_id of this bot's app
 */
export function recordSenderIds(params: { openId: string; unionId: string; appId: string }): void {
  const { openId, unionId, appId } = params;
  if (!openId || !unionId || !appId) {
    return;
  }

  upsertMapping(openId, unionId);
  upsertAppOpenid(unionId, appId, openId);
}

/**
 * Get union_id for an open_id from local cache (no API fallback).
 */
export function getUnionIdForOpenId(openId: string): string | undefined {
  return getMappingUnionId(openId);
}

/**
 * Given an open_id that might be from a different app's context,
 * resolve it to the open_id for a specific target app.
 *
 * Resolution is cache-only: the Feishu Contact API only supports querying
 * real users, not app-bots, so API fallback would never succeed for the
 * cross-bot @mention scenario.  The cache is populated by recordSenderIds()
 * whenever a message is received from a bot/user.
 *
 * @param openId - the open_id to resolve (may be from wrong app context)
 * @param targetAppId - the app_id we want the open_id for
 * @returns the correct open_id for targetAppId, or undefined if unknown (caller should fallback)
 */
export function resolveOpenIdForApp(
  openId: string,
  targetAppId: string,
): string | undefined {
  // Step 1: open_id → union_id (cache only)
  const unionId = getMappingUnionId(openId);
  if (!unionId) {
    return undefined;
  }

  // Step 2: union_id → targetAppId open_id (cache only)
  return getAppOpenid(unionId, targetAppId);
}

/**
 * Get all known open_ids for a union_id.
 */
export function getOpenIdsForUnionId(unionId: string): Record<string, string> | undefined {
  const db = getDb();
  const rows = db
    .prepare("SELECT app_id, open_id FROM app_openid WHERE union_id = ?")
    .all(unionId) as Array<{ app_id: string; open_id: string }>;
  if (!rows.length) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.app_id] = row.open_id;
  }
  return result;
}

/**
 * Close the database. Call on shutdown.
 */
export async function flushIdMappingStore(): Promise<void> {
  _db?.close();
  _db = null;
}
