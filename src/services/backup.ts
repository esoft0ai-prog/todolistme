import { buildBackup, planMerge, type BackupData, type BackupFile, type Row } from '../domain/backup';
import { BACKUP_TABLES, LATEST_SCHEMA_VERSION, type TableSpec } from '../db/schema';
import type { Exec, ServiceContext } from './context';
import { audit } from './audit';
import { loadPreferences } from './preferences';
import { syncDebtStatus, syncGoalStatus } from './ledgerState';

/**
 * Preferences that describe *this device's* security set-up. They are never
 * taken from a backup: restoring a backup made on a phone with an app lock must
 * not lock you out of a phone that has no PIN.
 */
export const DEVICE_LOCAL_PREFS = ['appLockEnabled', 'biometricEnabled', 'autoLockSeconds', 'hideInRecents', 'onboardingComplete'];

export async function readAllData(db: Exec): Promise<BackupData> {
  const data: BackupData = {};
  for (const spec of BACKUP_TABLES) {
    const cols = Object.keys(spec.columns).map((c) => `"${c}"`).join(', ');
    data[spec.name] = await db.all<Row>(`SELECT ${cols} FROM ${spec.name}`);
  }
  data.preferences = (data.preferences ?? []).filter((p) => !DEVICE_LOCAL_PREFS.includes(String(p.key)));
  return data;
}

export async function createBackup(ctx: ServiceContext, appVersion: string): Promise<BackupFile> {
  const prefs = await loadPreferences(ctx.db);
  const data = await readAllData(ctx.db);
  await audit(ctx, ctx.db, 'backup', null, 'export', 'Exported a full backup');
  return buildBackup(data, { schemaVersion: LATEST_SCHEMA_VERSION, appVersion, baseCurrency: prefs.baseCurrency, createdAt: ctx.now().toISOString() });
}

/** Column names come from the static schema whitelist — never from the file. */
function insertSQL(spec: TableSpec, mode: 'insert' | 'upsert'): string {
  const cols = Object.keys(spec.columns);
  const colList = cols.map((c) => `"${c}"`).join(', ');
  const placeholders = cols.map(() => '?').join(', ');
  if (mode === 'insert') return `INSERT INTO ${spec.name} (${colList}) VALUES (${placeholders})`;
  const pk = spec.primaryKey.map((c) => `"${c}"`).join(', ');
  const updates = cols.filter((c) => !spec.primaryKey.includes(c)).map((c) => `"${c}" = excluded."${c}"`);
  return `INSERT INTO ${spec.name} (${colList}) VALUES (${placeholders}) ON CONFLICT(${pk}) ${updates.length ? `DO UPDATE SET ${updates.join(', ')}` : 'DO NOTHING'}`;
}

function values(spec: TableSpec, row: Row): (string | number | null)[] {
  return Object.keys(spec.columns).map((c) => (row[c] === undefined ? null : row[c]));
}

export interface RestoreStats {
  mode: 'replace' | 'merge';
  tables: Record<string, { inserted: number; updated: number; skipped: number; duplicates: number }>;
  totalInserted: number;
  totalUpdated: number;
  totalDuplicates: number;
}

async function postRestore(ctx: ServiceContext, tx: Exec) {
  const prefs = await loadPreferences(tx);
  const now = ctx.now().toISOString();
  for (const d of await tx.all<{ id: string }>('SELECT id FROM debts')) await syncDebtStatus(tx, d.id, ctx.today(), now);
  for (const g of await tx.all<{ id: string }>('SELECT id FROM savings_goals')) await syncGoalStatus(tx, g.id, prefs.baseCurrency, ctx.today(), now);
  // OS-level schedule is rebuilt by the notification sync after restore.
  await tx.run('DELETE FROM scheduled_notifications');
  const fk = await tx.all('PRAGMA foreign_key_check');
  if (fk.length) throw new Error('The backup contains records that reference missing data.');
}

/**
 * Restores a validated backup atomically: either everything is applied or
 * nothing changes (the transaction is rolled back on any error).
 */
export async function restoreBackup(ctx: ServiceContext, backup: BackupFile, mode: 'replace' | 'merge'): Promise<RestoreStats> {
  const stats: RestoreStats = { mode, tables: {}, totalInserted: 0, totalUpdated: 0, totalDuplicates: 0 };
  const incoming: BackupData = { ...backup.data, preferences: (backup.data.preferences ?? []).filter((p) => !DEVICE_LOCAL_PREFS.includes(String(p.key))) };

  await ctx.db.transaction(async (tx) => {
    if (mode === 'replace') {
      const devicePrefs = await tx.all<Row>(`SELECT key, value, updated_at FROM preferences WHERE key IN (${DEVICE_LOCAL_PREFS.map(() => '?').join(',')})`, DEVICE_LOCAL_PREFS);
      for (const spec of [...BACKUP_TABLES].reverse()) await tx.run(`DELETE FROM ${spec.name}`);
      await tx.run('DELETE FROM notifications');
      for (const spec of BACKUP_TABLES) {
        const sql = insertSQL(spec, 'insert');
        const rows = incoming[spec.name] ?? [];
        for (const row of rows) await tx.run(sql, values(spec, row));
        stats.tables[spec.name] = { inserted: rows.length, updated: 0, skipped: 0, duplicates: 0 };
        if (spec.name !== 'preferences') stats.totalInserted += rows.length;
      }
      const prefSpec = BACKUP_TABLES.find((t) => t.name === 'preferences')!;
      for (const p of devicePrefs) await tx.run(insertSQL(prefSpec, 'upsert'), values(prefSpec, p));
    } else {
      const local = await readAllData(tx);
      const plan = planMerge(local, incoming);
      for (const spec of BACKUP_TABLES) {
        const ins = insertSQL(spec, 'insert');
        const ups = insertSQL(spec, 'upsert');
        for (const row of plan.inserts[spec.name] ?? []) await tx.run(ins, values(spec, row));
        for (const row of plan.updates[spec.name] ?? []) await tx.run(ups, values(spec, row));
        stats.tables[spec.name] = plan.stats[spec.name];
        if (spec.name !== 'preferences') {
          stats.totalInserted += plan.stats[spec.name].inserted;
          stats.totalUpdated += plan.stats[spec.name].updated;
          stats.totalDuplicates += plan.stats[spec.name].duplicates;
        }
      }
    }
    await postRestore(ctx, tx);
    await audit(ctx, tx, 'backup', null, 'restore', `Restored backup from ${backup.createdAt} (${mode})`);
  });
  return stats;
}
