/**
 * Web implementation of the database driver (used only for the browser preview
 * and automated UI smoke tests — the Android app uses expo-sqlite + SQLCipher).
 * Backed by sql.js (asm.js build: no wasm, no special server headers) and
 * persisted to localStorage so a page reload keeps the data.
 */
import { createSerializedDriver, type SqlDriver, type SqlExecutor, type SqlParams } from './driver';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const initSqlJs = require('sql.js/dist/sql-asm.js');

export const DB_NAME = 'finora.db';
const STORAGE_KEY = 'finora.web.db';

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function openExpoDatabase(_hexKey: string | null): Promise<SqlDriver> {
  const SQL = await initSqlJs();
  let saved: string | null = null;
  try {
    saved = globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    saved = null;
  }
  const db = saved ? new SQL.Database(fromBase64(saved)) : new SQL.Database();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const persist = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        globalThis.localStorage?.setItem(STORAGE_KEY, toBase64(db.export()));
      } catch {
        // storage full or unavailable — preview keeps working in memory
      }
    }, 300);
  };
  const rows = (sql: string, params: SqlParams) => {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params);
      const out: Record<string, unknown>[] = [];
      while (stmt.step()) out.push(stmt.getAsObject());
      return out;
    } finally {
      stmt.free();
    }
  };
  const raw: SqlExecutor & { close(): Promise<void> } = {
    async run(sql, params = []) {
      db.run(sql, params);
      persist();
      return { changes: db.getRowsModified(), lastInsertRowId: 0 };
    },
    async all<T>(sql: string, params: SqlParams = []) {
      return rows(sql, params) as T[];
    },
    async get<T>(sql: string, params: SqlParams = []) {
      return (rows(sql, params)[0] ?? null) as T | null;
    },
    async exec(sql) {
      db.exec(sql);
      persist();
    },
    async close() {
      db.close();
    },
  };
  return createSerializedDriver(raw);
}

export async function deleteExpoDatabase(): Promise<void> {
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
