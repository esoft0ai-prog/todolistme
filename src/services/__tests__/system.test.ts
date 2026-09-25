import { parseBackup } from '../../domain/backup';
import { LATEST_SCHEMA_VERSION } from '../../db/schema';
import { createContext } from '../context';
import { FakeNotificationGateway, MemorySecureStore, naira, setupTestContext } from '../../test-utils/harness';
import { createAccount, getAccount, listAccounts } from '../accounts';
import { dashboard, healthScore } from '../analytics';
import { createAssistant } from '../assistantData';
import { createBackup, restoreBackup } from '../backup';
import { createBudget } from '../budgets';
import { createDebt, getDebtView, recordRepayment } from '../debts';
import { deleteDemoData, hasDemoData, loadDemoData } from '../demo';
import { checkBudgetAlerts, listNotificationHistory, syncNotifications, unreadCount } from '../notifications';
import { loadPreferences, savePreferences } from '../preferences';
import { saveCustomReminder } from '../reminders';
import { MAX_FREE_ATTEMPTS, SecurityService, shouldLockOnResume, validatePin } from '../security';
import { createTransaction, listTransactions } from '../transactions';

const nodeCrypto = require('crypto');
const random = { bytes: (n: number) => new Uint8Array(nodeCrypto.randomBytes(n)) };

async function withDebt() {
  const { ctx, clock } = await setupTestContext({ date: '2026-03-15' });
  const bank = await createAccount(ctx, { name: 'Bank', type: 'bank', currency: 'NGN', openingBalanceMinor: naira(200_000) });
  const debt = await createDebt(
    ctx,
    {
      lenderName: 'QuickCash',
      debtType: 'loan_app',
      currency: 'NGN',
      principalMinor: naira(25_000),
      interestType: 'none',
      interestValue: 0,
      paymentFrequency: 'one_time',
      minimumPaymentMinor: 0,
      installmentCount: 1,
      startDate: '2026-03-01',
      firstDueDate: '2026-03-20',
      endDate: null,
      penaltyType: 'none',
      penaltyValue: 0,
      paidBeforeMinor: 0,
      totalPayableOverrideMinor: null,
      notes: null,
    },
    { reminderOffsets: [{ days: 3, time: '09:00' }, { days: 1, time: '09:00' }, { days: 0, time: '09:00' }] },
  );
  return { ctx, clock, bank, debt };
}

describe('notification engine', () => {
  it('schedules debt reminders locally and does not duplicate on re-sync', async () => {
    const { ctx } = await withDebt();
    const gw = new FakeNotificationGateway();
    const r1 = await syncNotifications(ctx, gw);
    expect(r1.error).toBeUndefined();
    expect(r1.enabled).toBe(true);
    const keys = gw.keys();
    expect(keys).toEqual(expect.arrayContaining([expect.stringMatching(/before:3$/), expect.stringMatching(/before:1$/), expect.stringMatching(/before:0$/), expect.stringMatching(/overdue:3$/)]));
    const tomorrow = [...gw.scheduled.values()].find((n) => n.key.endsWith('before:1'))!;
    expect(tomorrow.body).toBe('₦25,000 payment to QuickCash is due tomorrow. This is your final payment!');
    const r2 = await syncNotifications(ctx, gw);
    expect(r2.scheduled).toBe(0);
    expect(r2.cancelled).toBe(0);
    expect(gw.keys()).toEqual(keys);
  });

  it('survives an app restart: a fresh app instance on the same database reconciles without duplicates', async () => {
    const { ctx, clock } = await withDebt();
    const gw = new FakeNotificationGateway();
    await syncNotifications(ctx, gw);
    const before = gw.keys();
    const restarted = createContext(ctx.db, clock); // new process, same DB + OS scheduler
    const r = await syncNotifications(restarted, gw);
    expect(r.scheduled).toBe(0);
    expect(gw.keys()).toEqual(before);
  });

  it('recovers after a phone restart even if the OS lost scheduled alarms', async () => {
    const { ctx } = await withDebt();
    const gw = new FakeNotificationGateway();
    await syncNotifications(ctx, gw);
    const before = gw.keys();
    // expo-notifications re-arms alarms on BOOT_COMPLETED; simulate the worst case where they were lost.
    gw.scheduled.clear();
    const r = await syncNotifications(ctx, gw);
    expect(r.scheduled).toBe(before.length);
    expect(gw.keys()).toEqual(before);
  });

  it('moves delivered notifications to history and cancels reminders once a debt is paid', async () => {
    const { ctx, clock, bank, debt } = await withDebt();
    const gw = new FakeNotificationGateway();
    await syncNotifications(ctx, gw);
    clock.set('2026-03-19', '10:00'); // the "3 days before" and "1 day before" reminders have fired
    gw.deliverDue(clock.now());
    const r = await syncNotifications(ctx, gw);
    expect(r.movedToHistory).toBe(2);
    const history = await listNotificationHistory(ctx);
    expect(history.map((h) => h.body)).toEqual(expect.arrayContaining(['₦25,000 payment to QuickCash is due tomorrow. This is your final payment!']));
    expect(await unreadCount(ctx)).toBe(2);

    await recordRepayment(ctx, debt.id, { amountMinor: naira(25_000), date: '2026-03-19', accountId: bank.id });
    await syncNotifications(ctx, gw);
    expect(gw.keys().filter((k) => k.startsWith('debt:'))).toEqual([]);
  });

  it('schedules nothing when permission is denied or notifications are off, and respects channels', async () => {
    const { ctx } = await withDebt();
    const gw = new FakeNotificationGateway();
    gw.permission = 'denied';
    const r = await syncNotifications(ctx, gw);
    expect(r.enabled).toBe(false);
    expect(gw.scheduled.size).toBe(0);

    gw.permission = 'granted';
    await syncNotifications(ctx, gw);
    expect(gw.scheduled.size).toBeGreaterThan(0);
    await savePreferences(ctx, { notificationChannels: { ...(await loadPreferences(ctx.db)).notificationChannels, debts: false } });
    await syncNotifications(ctx, gw);
    expect(gw.keys().some((k) => k.startsWith('debt:'))).toBe(false);
    await savePreferences(ctx, { notificationsEnabled: false });
    await syncNotifications(ctx, gw);
    expect(gw.scheduled.size).toBe(0);
  });

  it('schedules custom recurring reminders', async () => {
    const { ctx } = await withDebt();
    await saveCustomReminder(ctx, { title: 'Estate dues', message: 'Pay estate dues', date: '2026-03-16', timeOfDay: '07:30', repeat: 'monthly', enabled: true });
    const gw = new FakeNotificationGateway();
    await syncNotifications(ctx, gw);
    const custom = [...gw.scheduled.values()].filter((n) => n.channel === 'reminders');
    expect(custom.map((c) => c.fireAt.getMonth() + 1)).toEqual([3, 4, 5, 6]); // 120-day horizon ends 13 July
    expect(custom[0].fireAt).toEqual(new Date(2026, 2, 16, 7, 30));
    await expect(saveCustomReminder(ctx, { title: '', message: '', date: '2026-03-16', timeOfDay: '25:00', repeat: 'none', enabled: true })).rejects.toThrow();
  });

  it('fires each budget warning once per period', async () => {
    const { ctx, bank } = await withDebt();
    await createBudget(ctx, { name: 'Food', period: 'monthly', limitMinor: naira(10_000), startDate: '2026-03-01', endDate: null, categoryIds: ['sys-exp-food'], alertThreshold: 0.8 });
    await createTransaction(ctx, {
      type: 'expense', amountMinor: naira(11_000), date: '2026-03-14', time: null, accountId: bank.id, toAccountId: null, toAmountMinor: null,
      categoryId: 'sys-exp-food', debtId: null, goalId: null, recurringId: null, description: 'Party', paymentMethod: null, notes: null, reference: null, tags: [],
    });
    const gw = new FakeNotificationGateway();
    expect(await checkBudgetAlerts(ctx, gw)).toBe(1);
    expect(await checkBudgetAlerts(ctx, gw)).toBe(0);
    expect(gw.presented[0].title).toBe('Food budget exceeded');
  });
});

describe('backup & restore', () => {
  it('exports a backup and restores it into a fresh installation (replace)', async () => {
    const { ctx } = await setupTestContext();
    await loadDemoData(ctx);
    const backup = await createBackup(ctx, '1.0.0');
    const json = JSON.stringify(backup);
    const parsed = parseBackup(json, { maxSchemaVersion: LATEST_SCHEMA_VERSION });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.summary.checksumValid).toBe(true);
    expect(parsed.summary.counts.transactions).toBeGreaterThan(20);

    const fresh = await setupTestContext();
    await savePreferences(fresh.ctx, { appLockEnabled: true });
    const stats = await restoreBackup(fresh.ctx, parsed.backup, 'replace');
    expect(stats.totalInserted).toBeGreaterThan(40);
    const a = await listAccounts(ctx.db);
    const b = await listAccounts(fresh.ctx.db);
    expect(b.map((x) => [x.name, x.balanceMinor])).toEqual(a.map((x) => [x.name, x.balanceMinor]));
    expect((await listTransactions(fresh.ctx.db, { limit: 5000 })).length).toBe((await listTransactions(ctx.db, { limit: 5000 })).length);
    // Device security settings are never taken from a backup.
    expect((await loadPreferences(fresh.ctx.db)).appLockEnabled).toBe(true);
  });

  it('merges a backup, skipping duplicates and keeping local data', async () => {
    const { ctx } = await setupTestContext();
    const cash = await createAccount(ctx, { name: 'Cash', type: 'cash', currency: 'NGN', openingBalanceMinor: naira(1_000) });
    await createTransaction(ctx, {
      type: 'expense', amountMinor: naira(500), date: '2026-03-10', time: null, accountId: cash.id, toAccountId: null, toAmountMinor: null,
      categoryId: 'sys-exp-food', debtId: null, goalId: null, recurringId: null, description: 'Bread', paymentMethod: null, notes: null, reference: null, tags: [],
    });
    const backup = await createBackup(ctx, '1.0.0');

    // Other phone: same account & transaction entered independently + one new transaction.
    const other = await setupTestContext();
    const cash2 = await createAccount(other.ctx, { name: 'cash', type: 'cash', currency: 'NGN', openingBalanceMinor: naira(1_000) });
    const base = { time: null, toAccountId: null, toAmountMinor: null, categoryId: 'sys-exp-food', debtId: null, goalId: null, recurringId: null, paymentMethod: null, notes: null, reference: null, tags: [] };
    await createTransaction(other.ctx, { ...base, type: 'expense', amountMinor: naira(500), date: '2026-03-10', accountId: cash2.id, description: 'Bread' });
    await createTransaction(other.ctx, { ...base, type: 'expense', amountMinor: naira(200), date: '2026-03-11', accountId: cash2.id, description: 'Water' });

    const parsed = parseBackup(JSON.stringify(backup), { maxSchemaVersion: LATEST_SCHEMA_VERSION });
    if (!parsed.ok) throw new Error('parse failed');
    const stats = await restoreBackup(other.ctx, parsed.backup, 'merge');
    expect(stats.tables.accounts.duplicates).toBe(1);
    expect(stats.tables.transactions.duplicates).toBe(1);
    const accounts = await listAccounts(other.ctx.db);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].balanceMinor).toBe(naira(300));
    expect(await listTransactions(other.ctx.db)).toHaveLength(2);
  });

  it('rolls back completely when a restore fails midway', async () => {
    const { ctx } = await setupTestContext();
    await createAccount(ctx, { name: 'Keep me', type: 'cash', currency: 'NGN', openingBalanceMinor: 0 });
    const src = await setupTestContext();
    const acc = await createAccount(src.ctx, { name: 'X', type: 'cash', currency: 'NGN', openingBalanceMinor: 0 });
    const backup = await createBackup(src.ctx, '1.0.0');
    // Violates a CHECK constraint the sanitiser does not model (name length > 80).
    (backup.data.accounts.find((r) => r.id === acc.id) as Record<string, unknown>).name = 'x'.repeat(200);
    await expect(restoreBackup(ctx, backup, 'replace')).rejects.toThrow();
    expect((await listAccounts(ctx.db)).map((a) => a.name)).toEqual(['Keep me']);
  });
});

describe('app lock security', () => {
  it('sets and verifies a PIN with salted PBKDF2 hashing', async () => {
    const store = new MemorySecureStore();
    const sec = new SecurityService(store, random);
    expect(await sec.hasPin()).toBe(false);
    await expect(sec.setPin('1234')).rejects.toThrow(/sequence/);
    await expect(sec.setPin('1111')).rejects.toThrow(/same digit/);
    await expect(sec.setPin('12a4')).rejects.toThrow(/4 to 6 digits/);
    await sec.setPin('2580');
    const stored = [...store.data.values()].join(' ');
    expect(stored).not.toContain('2580');
    expect(stored).toMatch(/^pbkdf2-sha256\$10000\$[0-9a-f]{32}\$[0-9a-f]{64}/);
    expect((await sec.verifyPin('2580')).ok).toBe(true);
    expect((await sec.verifyPin('2581')).ok).toBe(false);
  });

  it('locks out after repeated failures and persists the lockout across restarts', async () => {
    const store = new MemorySecureStore();
    let now = 1_000_000;
    const sec = new SecurityService(store, random, () => now);
    await sec.setPin('2580');
    for (let i = 1; i < MAX_FREE_ATTEMPTS; i++) expect((await sec.verifyPin('0000')).attemptsLeft).toBe(MAX_FREE_ATTEMPTS - i);
    const locked = await sec.verifyPin('0000');
    expect(locked.lockedMs).toBe(30_000);
    // Restart the app: a new service instance still sees the lockout, even with the right PIN.
    const restarted = new SecurityService(store, random, () => now);
    expect((await restarted.verifyPin('2580')).ok).toBe(false);
    now += 30_001;
    expect((await restarted.verifyPin('0000')).lockedMs).toBe(60_000); // escalates
    now += 60_001;
    expect((await restarted.verifyPin('2580')).ok).toBe(true);
    expect(await restarted.lockoutRemainingMs()).toBe(0);
  });

  it('decides when to lock on resume', () => {
    expect(shouldLockOnResume({ enabled: true, backgroundedAt: 0, now: 60_000, autoLockSeconds: 60 })).toBe(true);
    expect(shouldLockOnResume({ enabled: true, backgroundedAt: 0, now: 59_000, autoLockSeconds: 60 })).toBe(false);
    expect(shouldLockOnResume({ enabled: true, backgroundedAt: 0, now: 1, autoLockSeconds: 0 })).toBe(true);
    expect(shouldLockOnResume({ enabled: false, backgroundedAt: 0, now: 999_999, autoLockSeconds: 0 })).toBe(false);
  });

  it('creates and reuses a 256-bit database key', async () => {
    const sec = new SecurityService(new MemorySecureStore(), random);
    const a = await sec.getOrCreateDatabaseKey();
    const b = await sec.getOrCreateDatabaseKey();
    expect(a.created).toBe(true);
    expect(b).toEqual({ key: a.key, created: false });
    expect(a.key).toMatch(/^[0-9a-f]{64}$/);
    expect(validatePin('9731')).toBeNull();
  });
});

describe('demo data', () => {
  it('loads clearly-flagged sample data and deletes it without touching real data', async () => {
    const { ctx } = await setupTestContext();
    const real = await createAccount(ctx, { name: 'My real bank', type: 'bank', currency: 'NGN', openingBalanceMinor: naira(5_000) });
    await loadDemoData(ctx);
    expect(await hasDemoData(ctx)).toBe(true);
    const demoTx = await ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM transactions WHERE is_demo = 1');
    expect(Number(demoTx!.n)).toBeGreaterThan(20);
    // User records a real transaction in a demo account → that account must survive deletion.
    const demoCash = (await listAccounts(ctx.db)).find((a) => a.name === 'Cash (sample)')!;
    await createTransaction(ctx, {
      type: 'expense', amountMinor: naira(100), date: ctx.today(), time: null, accountId: demoCash.id, toAccountId: null, toAmountMinor: null,
      categoryId: 'sys-exp-food', debtId: null, goalId: null, recurringId: null, description: 'Real snack', paymentMethod: null, notes: null, reference: null, tags: [],
    });
    const res = await deleteDemoData(ctx);
    expect(res.keptAccounts).toBe(1);
    expect(await hasDemoData(ctx)).toBe(false);
    expect((await listTransactions(ctx.db)).map((t) => t.description)).toEqual(['Real snack']);
    expect((await getAccount(ctx.db, real.id))!.balanceMinor).toBe(naira(5_000));
    for (const t of ['debts', 'savings_goals', 'budgets', 'reminders', 'financial_events', 'recurring_transactions']) {
      expect(Number((await ctx.db.get<{ n: number }>(`SELECT count(*) AS n FROM ${t}`))!.n)).toBe(0);
    }
  });
});

describe('assistant & dashboard (end to end)', () => {
  it('answers questions from local data with explanations', async () => {
    const { ctx } = await setupTestContext();
    await loadDemoData(ctx);
    const assistant = await createAssistant(ctx);
    const afford = await assistant.answer('Can I afford a ₦100,000 phone?');
    expect(afford.intent).toBe('affordability');
    expect(afford.steps.join('\n')).toMatch(/Spendable balance/);
    expect(afford.text).toMatch(/₦100,000/);

    const food = await assistant.answer('How much did I spend on food this month?');
    expect(food.intent).toBe('category_spend');
    expect(food.text).toMatch(/on Food this month/);

    const owe = await assistant.answer('How much do I owe?');
    expect(owe.text).toMatch(/You owe ₦/);
    expect(owe.items.length).toBe(2);

    const next = await assistant.answer('When is my next debt payment?');
    expect(next.text).toMatch(/QuickCredit|Uncle Tunde/);

    const goal = await assistant.answer('How much should I save each month for my laptop goal?');
    expect(goal.text).toMatch(/New Laptop/);

    for (const q of ['What category consumes most of my money?', 'How much did I earn this month?', 'How much did I spend last month?', 'How much debt did I clear this year?', 'Show me my biggest expenses']) {
      const r = await assistant.answer(q);
      expect(r.intent).not.toBe('unknown');
      expect(r.text.length).toBeGreaterThan(10);
    }
    expect((await assistant.answer('')).suggestions.length).toBeGreaterThan(0);
    expect((await assistant.answer('asdfgh')).intent).toBe('unknown');
  });

  it('builds the dashboard and an explainable health score', async () => {
    const { ctx } = await setupTestContext();
    await loadDemoData(ctx);
    const d = await dashboard(ctx, { start: `${ctx.today().slice(0, 7)}-01`, end: ctx.today() });
    expect(d.balances.totalMinor).toBeGreaterThan(0);
    expect(d.debt.totalOutstandingMinor).toBeGreaterThan(0);
    expect(d.budgets).toHaveLength(3);
    expect(d.goals).toHaveLength(2);
    expect(d.health.total).toBeGreaterThan(0);
    expect(d.health.total).toBeLessThanOrEqual(100);
    expect(d.health.components).toHaveLength(5);
    expect(d.series.length).toBeGreaterThan(0);
    expect(d.upcoming.length).toBeGreaterThan(0);
    const h = await healthScore(ctx);
    expect(h.total).toBe(d.health.total);
    expect(await ctx.db.get('SELECT * FROM health_snapshots')).not.toBeNull();
    const view = await getDebtView(ctx.db, d.debt.debts[0].debt.id, ctx.today());
    expect(view!.summary.totalPayableMinor).toBeGreaterThan(0);
  });
});
