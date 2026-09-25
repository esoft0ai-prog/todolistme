import * as SQLite from 'expo-sqlite';
import { createSerializedDriver, type SqlDriver, type SqlExecutor, type SqlParams } from './driver';

export const DB_NAME = 'finora.db';

/**
 * Opens the encrypted application database.
 *
 * The database file lives in the app's private storage and is encrypted with
 * SQLCipher (AES-256) using a random 256-bit key kept in the Android Keystore
 * (via expo-secure-store). `hexKey` must be 64 hex characters.
 */
export async function openExpoDatabase(hexKey: string | null): Promise<SqlDriver> {
  const db = await SQLite.openDatabaseAsync(DB_NAME);
  if (hexKey) {
    if (!/^[0-9a-f]{64}$/i.test(hexKey)) throw new Error('Invalid database key format');
    // Must be the first statement on the connection. Raw key (no KDF) — it is already random.
    await db.execAsync(`PRAGMA key = "x'${hexKey}'"`);
  }
  // Verify the key works (throws "file is not a database" on a wrong key).
  await db.getFirstAsync('SELECT count(*) AS n FROM sqlite_master');
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;');

  const raw: SqlExecutor & { close(): Promise<void> } = {
    async run(sql: string, params: SqlParams = []) {
      const r = await db.runAsync(sql, params);
      return { changes: r.changes, lastInsertRowId: r.lastInsertRowId };
    },
    async all<T>(sql: string, params: SqlParams = []) {
      return (await db.getAllAsync(sql, params)) as T[];
    },
    async get<T>(sql: string, params: SqlParams = []) {
      return ((await db.getFirstAsync(sql, params)) ?? null) as T | null;
    },
    async exec(sql: string) {
      await db.execAsync(sql);
    },
    async close() {
      await db.closeAsync();
    },
  };
  return createSerializedDriver(raw);
}

export async function deleteExpoDatabase(): Promise<void> {
  await SQLite.deleteDatabaseAsync(DB_NAME);
}
