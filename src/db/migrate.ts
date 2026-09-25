import type { SqlDriver } from './driver';
import { MIGRATIONS, type Migration } from './schema';

export class MigrationError extends Error {
  constructor(
    public version: number,
    cause: unknown,
  ) {
    super(`Database migration ${version} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export async function getSchemaVersion(db: SqlDriver): Promise<number> {
  const row = await db.get<{ user_version: number }>('PRAGMA user_version');
  return row?.user_version ?? 0;
}

/** Applies pending migrations in order; each one is atomic. */
export async function migrate(db: SqlDriver, migrations: Migration[] = MIGRATIONS): Promise<number> {
  await db.exec('PRAGMA foreign_keys = ON');
  let current = await getSchemaVersion(db);
  const latest = migrations[migrations.length - 1]?.version ?? 0;
  if (current > latest) {
    throw new Error(
      `This database was created by a newer version of Finora (schema ${current}). Please update the app.`,
    );
  }
  for (const m of migrations) {
    if (m.version <= current) continue;
    try {
      await db.transaction(async (tx) => {
        await tx.exec(m.sql);
        await tx.exec(`PRAGMA user_version = ${Number(m.version)}`);
      });
      current = m.version;
    } catch (e) {
      throw new MigrationError(m.version, e);
    }
  }
  return current;
}
