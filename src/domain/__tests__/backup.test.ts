import { buildBackup, checksumOf, parseBackup, planMerge, sanitizeRow, type BackupData } from '../backup';
import { BACKUP_TABLES } from '../../db/schema';

const T = '2026-03-01T10:00:00.000Z';
const T2 = '2026-03-05T10:00:00.000Z';

function sample(): BackupData {
  return {
    accounts: [
      { id: 'a1', name: 'Cash', type: 'cash', currency: 'NGN', opening_balance_minor: 1000, color: null, icon: null, archived: 0, is_demo: 0, created_at: T, updated_at: T },
    ],
    categories: [
      { id: 'c1', name: 'Food', kind: 'expense', icon: 'fast-food', color: '#f00', is_system: 1, archived: 0, is_demo: 0, created_at: T, updated_at: T },
    ],
    transactions: [
      {
        id: 't1', type: 'expense', amount_minor: 500, currency: 'NGN', base_amount_minor: 500, fx_rate: 1, date: '2026-03-01', time: '09:00',
        account_id: 'a1', to_account_id: null, to_amount_minor: null, category_id: 'c1', debt_id: null, goal_id: null, recurring_id: null,
        description: 'Lunch', payment_method: 'cash', notes: null, reference: null, is_demo: 0, created_at: T, updated_at: T,
      },
    ],
  };
}

const opts = { maxSchemaVersion: 1 };
const meta = { schemaVersion: 1, appVersion: '1.0.0', baseCurrency: 'NGN', createdAt: T };

describe('backup build & parse', () => {
  it('round-trips a valid backup with a valid checksum', () => {
    const file = buildBackup(sample(), meta);
    expect(file.counts.transactions).toBe(1);
    expect(file.counts.debts).toBe(0);
    const parsed = parseBackup(JSON.stringify(file), opts);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.summary.checksumValid).toBe(true);
      expect(parsed.summary.createdAt).toBe(T);
      expect(parsed.backup.data.transactions[0].description).toBe('Lunch');
      expect(parsed.warnings).toEqual([]);
    }
  });

  it('rejects non-backups, corrupt JSON and newer versions', () => {
    expect(parseBackup('', opts).ok).toBe(false);
    expect(parseBackup('{not json', opts)).toMatchObject({ ok: false });
    expect(parseBackup('{"hello":1}', opts)).toEqual({ ok: false, errors: ['This is not a Finora backup file.'] });
    const newer = { ...buildBackup(sample(), meta), version: 99 };
    expect(parseBackup(JSON.stringify(newer), opts).ok).toBe(false);
    const newerSchema = { ...buildBackup(sample(), meta), schemaVersion: 7 };
    expect(parseBackup(JSON.stringify(newerSchema), opts).ok).toBe(false);
  });

  it('detects tampering via checksum', () => {
    const file = buildBackup(sample(), meta);
    (file.data.transactions[0] as Record<string, unknown>).amount_minor = 999_999;
    const parsed = parseBackup(JSON.stringify(file), opts);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.summary.checksumValid).toBe(false);
      expect(parsed.warnings.join(' ')).toMatch(/checksum/);
    }
  });

  it('rejects malformed rows, bad enums, invalid dates and broken references', () => {
    const bad = sample();
    bad.transactions[0].type = 'steal_money';
    expect(parseBackup(JSON.stringify(buildBackup(bad, meta)), opts).ok).toBe(false);

    const badDate = sample();
    badDate.transactions[0].date = '2026-02-31';
    const r1 = parseBackup(JSON.stringify(buildBackup(badDate, meta)), opts);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.errors[0]).toMatch(/not a valid date/);

    const orphan = sample();
    orphan.transactions[0].account_id = 'missing';
    const r2 = parseBackup(JSON.stringify(buildBackup(orphan, meta)), opts);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.errors[0]).toMatch(/missing accounts record/);

    const dup = sample();
    dup.accounts.push({ ...dup.accounts[0] });
    expect(parseBackup(JSON.stringify(buildBackup(dup, meta)), opts).ok).toBe(false);
  });

  it('drops unknown columns and nulls dangling optional references', () => {
    const data = sample();
    (data.transactions[0] as Record<string, unknown>)['evil); DROP TABLE accounts;--'] = 'x';
    data.transactions[0].goal_id = 'no-such-goal';
    const file = buildBackup(data, meta);
    file.checksum = checksumOf(file.data);
    const parsed = parseBackup(JSON.stringify(file), opts);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(Object.keys(parsed.backup.data.transactions[0])).not.toContain('evil); DROP TABLE accounts;--');
      expect(parsed.backup.data.transactions[0].goal_id).toBeNull();
      expect(parsed.warnings.join(' ')).toMatch(/unknown field/);
    }
  });

  it('normalises booleans and numeric strings', () => {
    const spec = BACKUP_TABLES.find((t) => t.name === 'accounts')!;
    const res = sanitizeRow(spec, { id: 'x', name: 'n', type: 'bank', currency: 'NGN', opening_balance_minor: '100', archived: true, is_demo: false, created_at: T, updated_at: T });
    expect(res.row).toMatchObject({ opening_balance_minor: 100, archived: 1, is_demo: 0, color: null });
    expect(sanitizeRow(spec, { id: 'x', name: 'n', type: 'bank', currency: 'NGN', opening_balance_minor: 1.5, created_at: T, updated_at: T }).row).toBeNull();
  });
});

describe('merge planning', () => {
  it('inserts new records, keeps newer local edits and applies newer incoming edits', () => {
    const local = sample();
    const incoming = sample();
    incoming.accounts[0] = { ...incoming.accounts[0], name: 'Cash wallet', updated_at: T2 };
    incoming.transactions.push({ ...incoming.transactions[0], id: 't2', amount_minor: 700, description: 'Dinner' });
    const plan = planMerge(local, incoming);
    expect(plan.updates.accounts).toHaveLength(1);
    expect(plan.stats.transactions).toEqual({ inserted: 1, updated: 0, skipped: 1, duplicates: 0 });

    const olderIncoming = sample();
    olderIncoming.accounts[0] = { ...olderIncoming.accounts[0], name: 'Old', updated_at: '2020-01-01T00:00:00.000Z' };
    expect(planMerge(local, olderIncoming).updates.accounts).toHaveLength(0);
  });

  it('detects duplicates created independently and remaps references', () => {
    const local = sample();
    const incoming: BackupData = {
      accounts: [{ ...local.accounts[0], id: 'other-cash' }],
      categories: [{ ...local.categories[0], id: 'other-food', name: ' FOOD ' }],
      transactions: [
        // same transaction recorded on the other phone → duplicate
        { ...local.transactions[0], id: 'other-t1', account_id: 'other-cash', category_id: 'other-food' },
        // genuinely new transaction → inserted but pointing at the LOCAL account/category
        { ...local.transactions[0], id: 'other-t2', account_id: 'other-cash', category_id: 'other-food', amount_minor: 1234 },
      ],
    };
    const plan = planMerge(local, incoming);
    expect(plan.stats.accounts.duplicates).toBe(1);
    expect(plan.stats.categories.duplicates).toBe(1);
    expect(plan.stats.transactions).toEqual({ inserted: 1, updated: 0, skipped: 0, duplicates: 1 });
    expect(plan.inserts.transactions[0]).toMatchObject({ id: 'other-t2', account_id: 'a1', category_id: 'c1' });
  });

  it('never overwrites local preferences', () => {
    const local: BackupData = { preferences: [{ key: 'baseCurrency', value: '"NGN"', updated_at: T }] };
    const incoming: BackupData = {
      preferences: [
        { key: 'baseCurrency', value: '"USD"', updated_at: T2 },
        { key: 'locale', value: '"en-NG"', updated_at: T2 },
      ],
    };
    const plan = planMerge(local, incoming);
    expect(plan.updates.preferences).toHaveLength(0);
    expect(plan.inserts.preferences).toEqual([{ key: 'locale', value: '"en-NG"', updated_at: T2 }]);
  });
});
