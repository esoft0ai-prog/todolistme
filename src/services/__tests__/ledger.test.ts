import { migrate, getSchemaVersion } from '../../db/migrate';
import { LATEST_SCHEMA_VERSION } from '../../db/schema';
import type { TransactionInput } from '../../domain/types';
import { naira, setupTestContext } from '../../test-utils/harness';
import { createAccount, deleteAccount, getAccount, listAccounts } from '../accounts';
import { totals } from '../analytics';
import { budgetViews, createBudget } from '../budgets';
import { createCategory, deleteCategory, listCategories } from '../categories';
import type { ServiceContext } from '../context';
import { addDebtCharge, createDebt, deleteDebt, deleteDebtPayment, getDebtView, recordRepayment, type DebtInput } from '../debts';
import { contribute, createGoal, getGoalView } from '../goals';
import { setRate } from '../rates';
import { materializeDue, projectedOccurrences, saveRecurring } from '../recurring';
import { searchAll } from '../search';
import { createTransaction, deleteTransaction, DuplicateTransactionError, getTransaction, listTags, listTransactions, updateTransaction } from '../transactions';

function tx(p: Partial<TransactionInput>): TransactionInput {
  return {
    type: 'expense',
    amountMinor: naira(1000),
    date: '2026-03-10',
    time: null,
    accountId: '',
    toAccountId: null,
    toAmountMinor: null,
    categoryId: 'sys-exp-food',
    debtId: null,
    goalId: null,
    recurringId: null,
    description: 'Lunch',
    paymentMethod: 'cash',
    notes: null,
    reference: null,
    tags: [],
    ...p,
  };
}

const debtInput = (p: Partial<DebtInput> = {}): DebtInput => ({
  lenderName: 'QuickCash',
  debtType: 'loan_app',
  currency: 'NGN',
  principalMinor: naira(100_000),
  interestType: 'flat_percentage',
  interestValue: 20,
  paymentFrequency: 'monthly',
  minimumPaymentMinor: 0,
  installmentCount: 4,
  startDate: '2026-03-01',
  firstDueDate: '2026-04-01',
  endDate: null,
  penaltyType: 'fixed',
  penaltyValue: naira(2000),
  paidBeforeMinor: 0,
  totalPayableOverrideMinor: null,
  notes: null,
  ...p,
});

async function setup() {
  const { ctx, clock } = await setupTestContext();
  const cash = await createAccount(ctx, { name: 'Cash', type: 'cash', currency: 'NGN', openingBalanceMinor: naira(50_000) });
  const bank = await createAccount(ctx, { name: 'Bank', type: 'bank', currency: 'NGN', openingBalanceMinor: naira(200_000) });
  return { ctx, clock, cash, bank };
}

const balance = async (ctx: ServiceContext, id: string) => (await getAccount(ctx.db, id))!.balanceMinor;

describe('database migrations', () => {
  it('applies the schema and is idempotent', async () => {
    const { ctx } = await setupTestContext();
    expect(await getSchemaVersion(ctx.db)).toBe(LATEST_SCHEMA_VERSION);
    await migrate(ctx.db);
    expect(await getSchemaVersion(ctx.db)).toBe(LATEST_SCHEMA_VERSION);
    expect((await listCategories(ctx.db)).length).toBeGreaterThanOrEqual(19);
  });

  it('refuses to open a database from a newer app version', async () => {
    const { ctx } = await setupTestContext();
    await ctx.db.exec('PRAGMA user_version = 99');
    await expect(migrate(ctx.db)).rejects.toThrow(/newer version/);
  });

  it('enforces constraints at the database level', async () => {
    const { ctx, cash } = await setup();
    await expect(
      ctx.db.run("INSERT INTO transactions (id,type,amount_minor,currency,base_amount_minor,date,account_id,created_at,updated_at) VALUES ('x','expense',-5,'NGN',-5,'2026-01-01',?, 'a','a')", [cash.id]),
    ).rejects.toThrow();
    await expect(
      ctx.db.run("INSERT INTO transactions (id,type,amount_minor,currency,base_amount_minor,date,account_id,created_at,updated_at) VALUES ('y','expense',5,'NGN',5,'2026-01-01','no-account','a','a')"),
    ).rejects.toThrow(/FOREIGN KEY/);
  });
});

describe('transactions & balances', () => {
  it('adds, edits and deletes a transaction, keeping balances correct', async () => {
    const { ctx, cash } = await setup();
    const t = await createTransaction(ctx, tx({ accountId: cash.id, amountMinor: naira(2_500), tags: ['market', 'Market', 'family'] }));
    expect(await balance(ctx, cash.id)).toBe(naira(47_500));
    expect(t.tags.sort()).toEqual(['family', 'market']);
    expect(t.baseAmountMinor).toBe(naira(2_500));

    await updateTransaction(ctx, t.id, tx({ accountId: cash.id, amountMinor: naira(4_000), description: 'Dinner', tags: ['family'] }));
    expect(await balance(ctx, cash.id)).toBe(naira(46_000));
    expect((await getTransaction(ctx.db, t.id))!.description).toBe('Dinner');
    expect((await listTags(ctx.db)).map((x) => x.name)).toEqual(['family']);

    await deleteTransaction(ctx, t.id);
    expect(await balance(ctx, cash.id)).toBe(naira(50_000));
    expect(await getTransaction(ctx.db, t.id)).toBeNull();
    const audit = await ctx.db.all<{ action: string }>('SELECT action FROM audit_logs WHERE entity_id = ?', [t.id]);
    expect(audit.map((a) => a.action)).toEqual(['create', 'update', 'delete']);
  });

  it('keeps transfers out of income and expense totals', async () => {
    const { ctx, cash, bank } = await setup();
    await createTransaction(ctx, tx({ type: 'transfer', accountId: bank.id, toAccountId: cash.id, amountMinor: naira(30_000), categoryId: null }));
    expect(await balance(ctx, bank.id)).toBe(naira(170_000));
    expect(await balance(ctx, cash.id)).toBe(naira(80_000));
    const t = await totals(ctx.db, { range: { start: '2026-03-01', end: '2026-03-31' } });
    expect(t.incomeMinor).toBe(0);
    expect(t.expenseMinor).toBe(0);
    expect(t.transferMinor).toBe(naira(30_000));
  });

  it('converts foreign-currency transfers with exchange rates', async () => {
    const { ctx, bank } = await setup();
    await setRate(ctx, 'USD', 1500);
    const usd = await createAccount(ctx, { name: 'Dom account', type: 'bank', currency: 'USD', openingBalanceMinor: 0 });
    await createTransaction(ctx, tx({ type: 'transfer', accountId: bank.id, toAccountId: usd.id, amountMinor: naira(150_000), categoryId: null }));
    expect(await balance(ctx, usd.id)).toBe(10_000); // $100.00
    const inc = await createTransaction(ctx, tx({ type: 'income', accountId: usd.id, amountMinor: 5_000, categoryId: 'sys-inc-freelance' }));
    expect(inc.baseAmountMinor).toBe(naira(75_000));
    expect(inc.currency).toBe('USD');
  });

  it('validates input and rejects mismatched categories', async () => {
    const { ctx, cash, bank } = await setup();
    await expect(createTransaction(ctx, tx({ accountId: cash.id, amountMinor: 0 }))).rejects.toThrow('Amount must be greater than zero');
    await expect(createTransaction(ctx, tx({ accountId: cash.id, date: '2026-02-30' }))).rejects.toThrow('Enter a valid date');
    await expect(createTransaction(ctx, tx({ accountId: cash.id, categoryId: 'sys-inc-salary' }))).rejects.toThrow(/does not match/);
    await expect(createTransaction(ctx, tx({ type: 'transfer', accountId: cash.id, toAccountId: cash.id, categoryId: null }))).rejects.toThrow(/different accounts/);
    await expect(createTransaction(ctx, tx({ accountId: 'nope' }))).rejects.toThrow('Choose an account');
    expect(await balance(ctx, bank.id)).toBe(naira(200_000));
  });

  it('detects accidental duplicates but allows confirmed ones', async () => {
    const { ctx, cash } = await setup();
    await createTransaction(ctx, tx({ accountId: cash.id }));
    await expect(createTransaction(ctx, tx({ accountId: cash.id }))).rejects.toBeInstanceOf(DuplicateTransactionError);
    await createTransaction(ctx, tx({ accountId: cash.id }), { allowDuplicate: true });
    expect(await listTransactions(ctx.db)).toHaveLength(2);
  });

  it('filters, paginates and searches safely', async () => {
    const { ctx, cash, bank } = await setup();
    await createTransaction(ctx, tx({ accountId: cash.id, description: '100% jollof_rice', tags: ['party'] }));
    await createTransaction(ctx, tx({ type: 'income', accountId: bank.id, categoryId: 'sys-inc-salary', description: 'Salary', amountMinor: naira(350_000), date: '2026-03-01' }));
    expect((await listTransactions(ctx.db, { search: '100%' })).map((t) => t.description)).toEqual(['100% jollof_rice']);
    expect(await listTransactions(ctx.db, { search: "'; DROP TABLE transactions; --" })).toEqual([]);
    expect((await listTransactions(ctx.db, { types: ['income'] }))[0].description).toBe('Salary');
    expect((await listTransactions(ctx.db, { tag: 'PARTY' }))).toHaveLength(1);
    expect((await listTransactions(ctx.db, { limit: 1, offset: 1, order: 'date_asc' }))[0].description).toBe('100% jollof_rice');
    const res = await searchAll(ctx.db, 'bank');
    expect(res.accounts.map((a) => a.name)).toEqual(['Bank']);
    expect(res.transactions.map((t) => t.description)).toEqual(['Salary']);
    expect((await searchAll(ctx.db, '350000')).transactions).toHaveLength(1);
    expect((await searchAll(ctx.db, 'food')).categories.length).toBe(1);
  });

  it('protects accounts and categories that are in use', async () => {
    const { ctx, cash } = await setup();
    await createTransaction(ctx, tx({ accountId: cash.id }));
    await expect(deleteAccount(ctx, cash.id)).rejects.toThrow(/Archive it instead/);
    const cat = await createCategory(ctx, { name: 'Suya', kind: 'expense' });
    await expect(createCategory(ctx, { name: 'suya ', kind: 'expense' })).rejects.toThrow(/already exists/);
    const t = await createTransaction(ctx, tx({ accountId: cash.id, categoryId: cat.id, amountMinor: naira(700) }));
    await deleteCategory(ctx, cat.id, 'sys-exp-food');
    expect((await getTransaction(ctx.db, t.id))!.categoryId).toBe('sys-exp-food');
    expect((await listAccounts(ctx.db)).length).toBe(2);
  });
});

describe('debts & repayments', () => {
  it('adds a debt with the loan received into an account', async () => {
    const { ctx, bank } = await setup();
    const debt = await createDebt(ctx, debtInput(), { disburseToAccountId: bank.id });
    expect(await balance(ctx, bank.id)).toBe(naira(300_000));
    const view = (await getDebtView(ctx.db, debt.id, ctx.today()))!;
    expect(view.summary.totalPayableMinor).toBe(naira(120_000));
    expect(view.summary.outstandingMinor).toBe(naira(120_000));
    expect(view.summary.nextInstallment?.dueDate).toBe('2026-04-01');
    const t = await totals(ctx.db, { range: { start: '2026-03-01', end: '2026-03-31' } });
    expect(t.incomeMinor).toBe(0); // a loan is not income
    expect(t.loanReceivedMinor).toBe(naira(100_000));
  });

  it('records repayments, updates the balance automatically and marks paid off', async () => {
    const { ctx, bank } = await setup();
    const debt = await createDebt(ctx, debtInput());
    await recordRepayment(ctx, debt.id, { amountMinor: naira(30_000), date: '2026-03-14', accountId: bank.id });
    let view = (await getDebtView(ctx.db, debt.id, ctx.today()))!;
    expect(view.summary.outstandingMinor).toBe(naira(90_000));
    expect(await balance(ctx, bank.id)).toBe(naira(170_000));
    const t = await totals(ctx.db, { range: { start: '2026-03-01', end: '2026-03-31' } });
    expect(t.debtRepaymentMinor).toBe(naira(30_000));
    expect(t.expenseMinor).toBe(0);

    await expect(recordRepayment(ctx, debt.id, { amountMinor: naira(90_001), date: '2026-03-14', accountId: bank.id })).rejects.toThrow(/larger than the outstanding/);
    await recordRepayment(ctx, debt.id, { amountMinor: naira(90_000), date: '2026-03-15' }); // paid from outside tracked accounts
    view = (await getDebtView(ctx.db, debt.id, ctx.today()))!;
    expect(view.summary.outstandingMinor).toBe(0);
    expect(view.debt.status).toBe('paid_off');

    // Deleting the last payment re-opens the debt.
    const outside = view.payments.find((p) => !p.transactionId)!;
    await deleteDebtPayment(ctx, outside.id);
    view = (await getDebtView(ctx.db, debt.id, ctx.today()))!;
    expect(view.debt.status).toBe('active');
    expect(view.summary.outstandingMinor).toBe(naira(90_000));
  });

  it('keeps the debt in sync when a repayment transaction is edited or deleted', async () => {
    const { ctx, bank } = await setup();
    const debt = await createDebt(ctx, debtInput());
    await recordRepayment(ctx, debt.id, { amountMinor: naira(30_000), date: '2026-03-14', accountId: bank.id });
    const [t] = await listTransactions(ctx.db, { debtId: debt.id });
    await updateTransaction(ctx, t.id, { ...t, amountMinor: naira(20_000) });
    expect((await getDebtView(ctx.db, debt.id, ctx.today()))!.summary.outstandingMinor).toBe(naira(100_000));
    await expect(updateTransaction(ctx, t.id, { ...t, amountMinor: naira(130_000) })).rejects.toThrow(/larger than the outstanding/);
    await deleteTransaction(ctx, t.id);
    const view = (await getDebtView(ctx.db, debt.id, ctx.today()))!;
    expect(view.payments).toHaveLength(0);
    expect(view.summary.outstandingMinor).toBe(naira(120_000));
  });

  it('applies penalties and adjustments and rejects negative balances', async () => {
    const { ctx } = await setup();
    const debt = await createDebt(ctx, debtInput());
    await addDebtCharge(ctx, debt.id, 'penalty', naira(2_000), '2026-03-15', 'Late fee');
    expect((await getDebtView(ctx.db, debt.id, ctx.today()))!.summary.outstandingMinor).toBe(naira(122_000));
    await expect(addDebtCharge(ctx, debt.id, 'adjustment', -naira(200_000), '2026-03-15')).rejects.toThrow(/negative/);
    await addDebtCharge(ctx, debt.id, 'adjustment', -naira(22_000), '2026-03-15');
    expect((await getDebtView(ctx.db, debt.id, ctx.today()))!.summary.outstandingMinor).toBe(naira(100_000));
  });

  it('deletes a debt with or without its transactions', async () => {
    const { ctx, bank } = await setup();
    const debt = await createDebt(ctx, debtInput(), { disburseToAccountId: bank.id });
    await recordRepayment(ctx, debt.id, { amountMinor: naira(10_000), date: '2026-03-14', accountId: bank.id });
    await deleteDebt(ctx, debt.id, false);
    expect(await balance(ctx, bank.id)).toBe(naira(290_000)); // history kept
    const debt2 = await createDebt(ctx, debtInput({ lenderName: 'Other' }), { disburseToAccountId: bank.id });
    await deleteDebt(ctx, debt2.id, true);
    expect(await balance(ctx, bank.id)).toBe(naira(290_000));
  });

  it('validates debt input', async () => {
    const { ctx } = await setup();
    await expect(createDebt(ctx, debtInput({ principalMinor: 0 }))).rejects.toThrow(/Principal/);
    await expect(createDebt(ctx, debtInput({ firstDueDate: '2026-01-01' }))).rejects.toThrow(/before the start date/);
  });
});

describe('budgets, goals and recurring', () => {
  it('computes budget spending and pace warnings from transactions', async () => {
    const { ctx, cash } = await setup();
    await createBudget(ctx, { name: 'Food', period: 'monthly', limitMinor: naira(50_000), startDate: '2026-03-01', endDate: null, categoryIds: ['sys-exp-food'], alertThreshold: 0.8 });
    await createTransaction(ctx, tx({ accountId: cash.id, amountMinor: naira(30_000), date: '2026-03-05' }));
    await createTransaction(ctx, tx({ accountId: cash.id, amountMinor: naira(9_000), categoryId: 'sys-exp-transport', date: '2026-03-06' }));
    const [v] = await budgetViews(ctx);
    expect(v.status.spentMinor).toBe(naira(30_000));
    expect(v.status.state).toBe('at_risk'); // ₦2,000/day for 31 days → ₦62k
    expect(v.status.daysUntilExceeded).toBe(10);
    await expect(createBudget(ctx, { name: 'Bad', period: 'monthly', limitMinor: 0, startDate: '2026-03-01', endDate: null, categoryIds: [], alertThreshold: 0.8 })).rejects.toThrow();
    await expect(createBudget(ctx, { name: 'Bad', period: 'monthly', limitMinor: 10, startDate: '2026-03-01', endDate: null, categoryIds: ['sys-inc-salary'], alertThreshold: 0.8 })).rejects.toThrow(/expense categories/);
  });

  it('tracks goal deposits, withdrawals and completion', async () => {
    const { ctx, bank } = await setup();
    const savings = await createAccount(ctx, { name: 'Savings', type: 'savings', currency: 'NGN', openingBalanceMinor: 0 });
    const goalId = await createGoal(ctx, {
      name: 'Laptop', targetMinor: naira(100_000), currency: 'NGN', initialMinor: naira(20_000), startDate: '2026-03-01', deadline: '2026-12-20',
      linkedAccountId: savings.id, icon: 'laptop', color: '#fff', reminderFrequency: 'monthly', notes: null,
    });
    await contribute(ctx, goalId, 'deposit', { amountMinor: naira(50_000), accountId: bank.id, date: '2026-03-10' });
    expect(await balance(ctx, bank.id)).toBe(naira(150_000));
    expect(await balance(ctx, savings.id)).toBe(naira(50_000));
    let g = (await getGoalView(ctx, goalId))!;
    expect(g.progress.savedMinor).toBe(naira(70_000));
    await expect(contribute(ctx, goalId, 'deposit', { amountMinor: 1, accountId: savings.id, date: '2026-03-10' })).rejects.toThrow(/other than the goal/);
    await expect(contribute(ctx, goalId, 'withdraw', { amountMinor: naira(80_000), accountId: bank.id, date: '2026-03-11' })).rejects.toThrow(/more than has been saved/);
    await contribute(ctx, goalId, 'withdraw', { amountMinor: naira(10_000), accountId: bank.id, date: '2026-03-11' });
    expect(await balance(ctx, savings.id)).toBe(naira(40_000));
    await contribute(ctx, goalId, 'deposit', { amountMinor: naira(40_000), accountId: bank.id, date: '2026-03-12' });
    g = (await getGoalView(ctx, goalId))!;
    expect(g.progress.savedMinor).toBe(naira(100_000));
    expect(g.goal.status).toBe('completed');
    const t = await totals(ctx.db, { range: { start: '2026-03-01', end: '2026-03-31' } });
    expect(t.expenseMinor).toBe(0); // saving is not spending
  });

  it('materialises recurring transactions exactly once, even across restarts', async () => {
    const { ctx, clock, bank } = await setup();
    const id = await saveRecurring(ctx, {
      type: 'income', amountMinor: naira(350_000), accountId: bank.id, toAccountId: null, categoryId: 'sys-inc-salary', debtId: null, goalId: null,
      description: 'Salary', paymentMethod: 'bank_transfer', frequency: 'monthly', interval: 1, unit: 'month', startDate: '2026-01-25', endDate: null,
      isBill: false, autoCreate: true, remindDaysBefore: -1, active: true,
    }, undefined, undefined, { backfill: true });
    expect((await materializeDue(ctx)).created).toBe(2); // Jan 25, Feb 25
    expect((await materializeDue(ctx)).created).toBe(0);
    clock.set('2026-05-30');
    expect((await materializeDue(ctx)).created).toBe(3); // Mar, Apr, May
    const created = await listTransactions(ctx.db, { types: ['income'], order: 'date_asc' });
    expect(created.map((t) => t.date)).toEqual(['2026-01-25', '2026-02-25', '2026-03-25', '2026-04-25', '2026-05-25']);
    expect(created.every((t) => t.recurringId === id)).toBe(true);
    const projected = await projectedOccurrences(ctx, '2026-05-01', '2026-08-31');
    expect(projected.map((p) => p.date)).toEqual(['2026-06-25', '2026-07-25', '2026-08-25']);
  });

  it('does not back-fill a new rule unless asked', async () => {
    const { ctx, cash } = await setup();
    await saveRecurring(ctx, {
      type: 'expense', amountMinor: naira(1000), accountId: cash.id, toAccountId: null, categoryId: 'sys-exp-transport', debtId: null, goalId: null,
      description: 'Bus', paymentMethod: 'cash', frequency: 'daily', interval: 1, unit: 'day', startDate: '2026-03-01', endDate: null,
      isBill: false, autoCreate: true, remindDaysBefore: -1, active: true,
    });
    expect((await materializeDue(ctx)).created).toBe(1); // only today
  });
});
