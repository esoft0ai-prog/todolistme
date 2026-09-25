import { BACKUP_TABLES, type TableSpec } from '../db/schema';
import { sha256Hex } from './crypto';
import { isValidISODate } from './dates';

/**
 * Backup file format + validation + merge planning (pure; no I/O).
 *
 * Every value that enters the database from a backup passes through
 * `sanitizeRow`: only whitelisted columns survive, types and enums are
 * enforced, and rows are later inserted with parameterised statements — a
 * crafted backup cannot inject SQL or unexpected columns.
 */

export const BACKUP_FORMAT = 'finora-backup';
export const BACKUP_VERSION = 1;
export const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_LEN = 10_000;
const MAX_ROWS_PER_TABLE = 500_000;

export type Row = Record<string, string | number | null>;
export type BackupData = Record<string, Row[]>;

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  schemaVersion: number;
  appVersion: string;
  createdAt: string;
  baseCurrency: string;
  counts: Record<string, number>;
  checksum: string;
  data: BackupData;
}

export interface BackupSummary {
  createdAt: string;
  appVersion: string;
  schemaVersion: number;
  baseCurrency: string;
  counts: Record<string, number>;
  checksumValid: boolean;
}

export type ParseBackupResult =
  | { ok: true; backup: BackupFile; summary: BackupSummary; warnings: string[] }
  | { ok: false; errors: string[] };

const specByName = new Map(BACKUP_TABLES.map((t) => [t.name, t]));

/** Deterministic JSON (sorted keys) so checksums are stable. */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  const keys = Object.keys(value as object).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

export function checksumOf(data: BackupData): string {
  return sha256Hex(canonicalJSON(data));
}

export function buildBackup(
  data: BackupData,
  meta: { schemaVersion: number; appVersion: string; baseCurrency: string; createdAt?: string },
): BackupFile {
  const clean: BackupData = {};
  for (const spec of BACKUP_TABLES) clean[spec.name] = data[spec.name] ?? [];
  const counts: Record<string, number> = {};
  for (const [k, rows] of Object.entries(clean)) counts[k] = rows.length;
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    schemaVersion: meta.schemaVersion,
    appVersion: meta.appVersion,
    createdAt: meta.createdAt ?? new Date().toISOString(),
    baseCurrency: meta.baseCurrency,
    counts,
    checksum: checksumOf(clean),
    data: clean,
  };
}

const DATE_COLUMNS = new Set(['date', 'start_date', 'end_date', 'first_due_date', 'due_date', 'deadline', 'last_generated_date']);

/** Validates and normalises one row. Returns null + error message if invalid. */
export function sanitizeRow(spec: TableSpec, input: unknown): { row: Row | null; error?: string; droppedColumns: number } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { row: null, error: 'row is not an object', droppedColumns: 0 };
  const src = input as Record<string, unknown>;
  const row: Row = {};
  let dropped = 0;
  for (const key of Object.keys(src)) if (!(key in spec.columns)) dropped++;
  for (const [col, def] of Object.entries(spec.columns)) {
    let v = src[col];
    if (v === undefined || v === null || v === '') {
      if (v === '' && def.type === 'text' && !def.nullable && !DATE_COLUMNS.has(col)) {
        row[col] = '';
        continue;
      }
      if (def.nullable) {
        row[col] = null;
        continue;
      }
      if (def.type === 'bool') {
        row[col] = 0;
        continue;
      }
      return { row: null, error: `missing required column "${col}"`, droppedColumns: dropped };
    }
    switch (def.type) {
      case 'text':
        if (typeof v !== 'string') return { row: null, error: `column "${col}" must be text`, droppedColumns: dropped };
        if (v.length > MAX_TEXT_LEN) return { row: null, error: `column "${col}" is too long`, droppedColumns: dropped };
        if (def.enum && !def.enum.includes(v)) return { row: null, error: `column "${col}" has invalid value "${v.slice(0, 30)}"`, droppedColumns: dropped };
        if (DATE_COLUMNS.has(col) && !isValidISODate(v)) return { row: null, error: `column "${col}" is not a valid date`, droppedColumns: dropped };
        if ((col === 'created_at' || col === 'updated_at') && Number.isNaN(Date.parse(v))) {
          return { row: null, error: `column "${col}" is not a valid timestamp`, droppedColumns: dropped };
        }
        row[col] = v;
        break;
      case 'int':
        if (typeof v === 'string' && /^-?\d+$/.test(v)) v = Number(v);
        if (typeof v !== 'number' || !Number.isSafeInteger(v)) return { row: null, error: `column "${col}" must be an integer`, droppedColumns: dropped };
        row[col] = v;
        break;
      case 'real':
        if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) v = Number(v);
        if (typeof v !== 'number' || !Number.isFinite(v)) return { row: null, error: `column "${col}" must be a number`, droppedColumns: dropped };
        row[col] = v;
        break;
      case 'bool':
        if (v === true || v === 1 || v === '1') row[col] = 1;
        else if (v === false || v === 0 || v === '0') row[col] = 0;
        else return { row: null, error: `column "${col}" must be true/false`, droppedColumns: dropped };
        break;
    }
  }
  return { row, droppedColumns: dropped };
}

export function pkOf(spec: TableSpec, row: Row): string {
  return spec.primaryKey.map((k) => String(row[k])).join('|');
}

export function parseBackup(text: string, opts: { maxSchemaVersion: number }): ParseBackupResult {
  if (typeof text !== 'string' || text.length === 0) return { ok: false, errors: ['The file is empty.'] };
  if (text.length > MAX_BACKUP_BYTES) return { ok: false, errors: ['The file is too large to be a Finora backup.'] };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['The file is not valid JSON. It may be corrupted or not a Finora backup.'] };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, errors: ['Unrecognised backup structure.'] };
  const f = json as Partial<BackupFile> & Record<string, unknown>;
  if (f.format !== BACKUP_FORMAT) return { ok: false, errors: ['This is not a Finora backup file.'] };
  if (typeof f.version !== 'number' || f.version > BACKUP_VERSION) {
    return { ok: false, errors: ['This backup was created by a newer version of Finora. Please update the app first.'] };
  }
  if (typeof f.schemaVersion !== 'number' || f.schemaVersion > opts.maxSchemaVersion) {
    return { ok: false, errors: ['This backup uses a newer database format. Please update the app first.'] };
  }
  if (!f.data || typeof f.data !== 'object' || Array.isArray(f.data)) return { ok: false, errors: ['The backup contains no data section.'] };

  const errors: string[] = [];
  const warnings: string[] = [];
  const data: BackupData = {};
  const pkSets = new Map<string, Set<string>>();
  let droppedCols = 0;

  for (const key of Object.keys(f.data)) if (!specByName.has(key)) warnings.push(`Ignored unknown section "${key.slice(0, 40)}".`);

  for (const spec of BACKUP_TABLES) {
    const rawRows = (f.data as Record<string, unknown>)[spec.name];
    if (rawRows === undefined) {
      data[spec.name] = [];
      continue;
    }
    if (!Array.isArray(rawRows)) {
      errors.push(`Section "${spec.name}" is malformed.`);
      continue;
    }
    if (rawRows.length > MAX_ROWS_PER_TABLE) {
      errors.push(`Section "${spec.name}" has too many records.`);
      continue;
    }
    const rows: Row[] = [];
    const pks = new Set<string>();
    rawRows.forEach((r, i) => {
      const res = sanitizeRow(spec, r);
      droppedCols += res.droppedColumns;
      if (!res.row) {
        if (errors.length < 20) errors.push(`${spec.name} #${i + 1}: ${res.error}`);
        return;
      }
      const pk = pkOf(spec, res.row);
      if (pks.has(pk)) {
        if (errors.length < 20) errors.push(`${spec.name} #${i + 1}: duplicate record id`);
        return;
      }
      pks.add(pk);
      rows.push(res.row);
    });
    data[spec.name] = rows;
    pkSets.set(spec.name, pks);
  }
  if (droppedCols > 0) warnings.push(`Ignored ${droppedCols} unknown field(s).`);

  // Referential integrity inside the backup.
  for (const spec of BACKUP_TABLES) {
    if (!spec.references) continue;
    for (const row of data[spec.name] ?? []) {
      for (const [col, target] of Object.entries(spec.references)) {
        const ref = row[col];
        if (ref == null) continue;
        if (!pkSets.get(target)?.has(String(ref))) {
          const nullable = spec.columns[col].nullable;
          if (nullable) {
            row[col] = null;
          } else if (errors.length < 20) {
            errors.push(`${spec.name} record ${String(row.id ?? '').slice(0, 8)} refers to a missing ${target.replace(/_/g, ' ')} record.`);
          }
        }
      }
    }
  }
  if (errors.length) return { ok: false, errors };

  const counts: Record<string, number> = {};
  for (const [k, rows] of Object.entries(data)) counts[k] = rows.length;
  const checksumValid = typeof f.checksum === 'string' && f.checksum === checksumOf(data);
  if (!checksumValid) warnings.push('The backup checksum does not match — the file may have been edited or damaged after it was created.');

  const backup: BackupFile = {
    format: BACKUP_FORMAT,
    version: f.version,
    schemaVersion: f.schemaVersion,
    appVersion: typeof f.appVersion === 'string' ? f.appVersion.slice(0, 20) : 'unknown',
    createdAt: typeof f.createdAt === 'string' && !Number.isNaN(Date.parse(f.createdAt)) ? f.createdAt : new Date(0).toISOString(),
    baseCurrency: typeof f.baseCurrency === 'string' && /^[A-Z]{3}$/.test(f.baseCurrency) ? f.baseCurrency : 'NGN',
    counts,
    checksum: typeof f.checksum === 'string' ? f.checksum : '',
    data,
  };
  return {
    ok: true,
    backup,
    warnings,
    summary: {
      createdAt: backup.createdAt,
      appVersion: backup.appVersion,
      schemaVersion: backup.schemaVersion,
      baseCurrency: backup.baseCurrency,
      counts,
      checksumValid,
    },
  };
}

// ------------------------------------------------------------------ Merge planning

export interface MergePlan {
  inserts: BackupData;
  updates: BackupData;
  stats: Record<string, { inserted: number; updated: number; skipped: number; duplicates: number }>;
  idMap: Record<string, Record<string, string>>;
}

function lower(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

/** Natural keys used to recognise the same record created independently on two devices. */
const NATURAL_KEYS: Record<string, (r: Row) => string> = {
  categories: (r) => `${r.kind}|${lower(r.name)}`,
  accounts: (r) => `${r.type}|${r.currency}|${lower(r.name)}`,
  tags: (r) => lower(r.name),
  transactions: (r) =>
    [r.type, r.amount_minor, r.date, r.time ?? '', r.account_id, r.to_account_id ?? '', r.category_id ?? '', lower(r.description)].join('|'),
  debts: (r) => `${lower(r.lender_name)}|${r.principal_minor}|${r.start_date}`,
  savings_goals: (r) => `${lower(r.name)}|${r.target_minor}`,
  budgets: (r) => `${lower(r.name)}|${r.period}|${r.limit_minor}`,
  debt_payments: (r) => `${r.debt_id}|${r.kind}|${r.amount_minor}|${r.date}`,
};

/**
 * Plans a merge of `incoming` into `local`:
 *  - same id: the more recently updated version wins;
 *  - different id but same natural key (e.g. both phones have a "Food" category or
 *    the same transaction): treated as a duplicate, references are remapped to
 *    the local record;
 *  - otherwise inserted.
 * Local preferences are kept (only missing keys are added).
 */
export function planMerge(local: BackupData, incoming: BackupData): MergePlan {
  const plan: MergePlan = { inserts: {}, updates: {}, stats: {}, idMap: {} };
  for (const spec of BACKUP_TABLES) {
    const table = spec.name;
    const stats = { inserted: 0, updated: 0, skipped: 0, duplicates: 0 };
    plan.stats[table] = stats;
    plan.inserts[table] = [];
    plan.updates[table] = [];
    plan.idMap[table] = {};

    const localRows = local[table] ?? [];
    const localByPk = new Map(localRows.map((r) => [pkOf(spec, r), r]));
    const naturalFn = NATURAL_KEYS[table];
    const localByNatural = new Map<string, Row>();
    if (naturalFn) for (const r of localRows) localByNatural.set(naturalFn(r), r);

    for (const original of incoming[table] ?? []) {
      // Remap references to parents that were de-duplicated.
      const row: Row = { ...original };
      if (spec.references) {
        for (const [col, target] of Object.entries(spec.references)) {
          const v = row[col];
          if (v != null && plan.idMap[target]?.[String(v)]) row[col] = plan.idMap[target][String(v)];
        }
      }
      const pk = pkOf(spec, row);
      const existing = localByPk.get(pk);
      if (existing) {
        if (table === 'preferences') {
          stats.skipped++;
          continue;
        }
        if (spec.hasUpdatedAt && String(row.updated_at) > String(existing.updated_at)) {
          plan.updates[table].push(row);
          stats.updated++;
        } else stats.skipped++;
        continue;
      }
      if (naturalFn) {
        const dup = localByNatural.get(naturalFn(row));
        if (dup) {
          if ('id' in row && 'id' in dup) plan.idMap[table][String(row.id)] = String(dup.id);
          stats.duplicates++;
          continue;
        }
      }
      plan.inserts[table].push(row);
      localByPk.set(pk, row);
      if (naturalFn) localByNatural.set(naturalFn(row), row);
      stats.inserted++;
    }
  }
  return plan;
}

export function totalRecords(counts: Record<string, number>): number {
  return Object.entries(counts)
    .filter(([k]) => k !== 'preferences')
    .reduce((s, [, n]) => s + n, 0);
}
