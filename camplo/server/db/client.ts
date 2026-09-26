/**
 * Database access. Production: Postgres via DATABASE_URL (postgres.js).
 * Without DATABASE_URL we fall back to embedded PGlite (real Postgres compiled
 * to WASM) — used by tests, local dev and the no-database demo deploy.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import { migrate as migratePg } from 'drizzle-orm/postgres-js/migrator';
import { drizzle as drizzleLite } from 'drizzle-orm/pglite';
import { migrate as migrateLite } from 'drizzle-orm/pglite/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';
import { config } from '../lib/config.js';

export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface Database { db: DB; kind: 'postgres' | 'pglite'; close: () => Promise<void> }

export async function createDatabase(opts: { url?: string; pgliteDir?: string } = {}): Promise<Database> {
  const url = opts.url ?? config.databaseUrl;
  if (url) {
    const { default: postgres } = await import('postgres');
    const sql = postgres(url, { max: Number(process.env.DB_POOL_MAX ?? 5), prepare: false });
    const db = drizzlePg(sql, { schema }) as unknown as DB;
    await migratePg(db as never, { migrationsFolder });
    return { db, kind: 'postgres', close: () => sql.end() };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const dir = opts.pgliteDir ?? config.pgliteDir;
  const client = dir ? new PGlite(dir) : new PGlite();
  const db = drizzleLite(client, { schema }) as unknown as DB;
  await migrateLite(db as never, { migrationsFolder });
  return { db, kind: 'pglite', close: () => client.close() };
}

let shared: Promise<Database> | null = null;
/** Process-wide database, created lazily and reused across serverless invocations. */
export function getDatabase(): Promise<Database> {
  if (!shared) {
    shared = (async () => {
      const d = await createDatabase();
      if (config.seedDemo) {
        const { seedIfEmpty } = await import('./seed.js');
        await seedIfEmpty(d.db, { deterministic: d.kind === 'pglite' });
      }
      return d;
    })();
    shared.catch(() => { shared = null; });
  }
  return shared;
}
