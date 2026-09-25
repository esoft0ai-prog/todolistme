/**
 * Storage-engine-agnostic SQL interface. The app uses an expo-sqlite (SQLCipher)
 * implementation; tests use Node's built-in SQLite. Repositories only ever see
 * `SqlExecutor`, so the engine can be swapped (e.g. for a future sync layer).
 */

export type SqlValue = string | number | null;
export type SqlParams = SqlValue[];

export interface RunResult {
  changes: number;
  lastInsertRowId: number;
}

export interface SqlExecutor {
  run(sql: string, params?: SqlParams): Promise<RunResult>;
  all<T = Record<string, unknown>>(sql: string, params?: SqlParams): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: SqlParams): Promise<T | null>;
  exec(sql: string): Promise<void>;
}

export interface SqlDriver extends SqlExecutor {
  /**
   * Runs `fn` atomically. All statements inside must use the provided `tx`
   * executor; other callers are queued until the transaction finishes.
   */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Simple FIFO async mutex. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const prev = this.tail;
    this.tail = prev.then(() => next);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/**
 * Wraps a raw (non-thread-safe) executor with a mutex so ad-hoc queries never
 * interleave with an open transaction on the same connection.
 */
export function createSerializedDriver(raw: SqlExecutor & { close(): Promise<void> }): SqlDriver {
  const lock = new Mutex();
  return {
    run: (sql, params) => lock.run(() => raw.run(sql, params)),
    all: <T>(sql: string, params?: SqlParams) => lock.run(() => raw.all<T>(sql, params)),
    get: <T>(sql: string, params?: SqlParams) => lock.run(() => raw.get<T>(sql, params)),
    exec: (sql) => lock.run(() => raw.exec(sql)),
    transaction: <T>(fn: (tx: SqlExecutor) => Promise<T>) =>
      lock.run(async () => {
        await raw.exec('BEGIN IMMEDIATE');
        try {
          const result = await fn(raw);
          await raw.exec('COMMIT');
          return result;
        } catch (e) {
          try {
            await raw.exec('ROLLBACK');
          } catch {
            // ignore rollback failure; original error is more useful
          }
          throw e;
        }
      }),
    close: () => lock.run(() => raw.close()),
  };
}
