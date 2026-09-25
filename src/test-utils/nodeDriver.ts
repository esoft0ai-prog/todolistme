import { createSerializedDriver, type SqlDriver, type SqlExecutor, type SqlParams } from '../db/driver';

/**
 * Test-only driver backed by Node's built-in `node:sqlite` so integration tests
 * exercise the real SQL, constraints and migrations used on the device.
 */
export function openNodeDatabase(): SqlDriver {
  // getBuiltinModule bypasses Jest's module resolver, which does not know `node:sqlite`.
  const { DatabaseSync } = (process as unknown as { getBuiltinModule(n: string): any }).getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const norm = (row: Record<string, unknown> | undefined) => (row ? { ...row } : row);
  const raw: SqlExecutor & { close(): Promise<void> } = {
    async run(sql: string, params: SqlParams = []) {
      const r = db.prepare(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
    },
    async all<T>(sql: string, params: SqlParams = []) {
      return db.prepare(sql).all(...params).map(norm) as T[];
    },
    async get<T>(sql: string, params: SqlParams = []) {
      return (norm(db.prepare(sql).get(...params)) ?? null) as T | null;
    },
    async exec(sql: string) {
      db.exec(sql);
    },
    async close() {
      db.close();
    },
  };
  return createSerializedDriver(raw);
}
