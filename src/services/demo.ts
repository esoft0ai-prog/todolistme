import { addDays, addMonths, startOfMonth } from '../domain/dates';
import { DEMO_TABLES } from '../db/schema';
import { createAccount } from './accounts';
import { audit } from './audit';
import type { ServiceContext } from './context';
import { createBudget } from './budgets';
import { createDebt, recordRepayment } from './debts';
import { contribute, createGoal } from './goals';
import { savePreferences } from './preferences';
import { saveRecurring } from './recurring';
import { saveCustomReminder, saveEvent } from './reminders';
import { createTransaction } from './transactions';

/**
 * Realistic Nigerian sample data. Every row is flagged `is_demo = 1` so it is
 * clearly labelled in the UI and can be removed without touching real data.
 */

const K = (naira: number) => Math.round(naira * 100);

/** Deterministic pseudo-random generator so sample data is stable. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

export async function hasDemoData(ctx: ServiceContext): Promise<boolean> {
  const r = await ctx.db.get<{ n: number }>('SELECT (SELECT count(*) FROM accounts WHERE is_demo = 1) + (SELECT count(*) FROM transactions WHERE is_demo = 1) AS n');
  return Number(r?.n ?? 0) > 0;
}

export async function loadDemoData(ctx: ServiceContext): Promise<void> {
  if (await hasDemoData(ctx)) return;
  const today = ctx.today();
  const rand = rng(42);
  const demo = { isDemo: true };

  await ctx.db.transaction(async (tx) => {
    const cash = await createAccount(ctx, { name: 'Cash (sample)', type: 'cash', currency: 'NGN', openingBalanceMinor: K(35_000), ...demo }, tx);
    const bank = await createAccount(ctx, { name: 'Bank account (sample)', type: 'bank', currency: 'NGN', openingBalanceMinor: K(180_000), ...demo }, tx);
    const wallet = await createAccount(ctx, { name: 'Mobile wallet (sample)', type: 'mobile_wallet', currency: 'NGN', openingBalanceMinor: K(12_000), ...demo }, tx);
    const savings = await createAccount(ctx, { name: 'Savings (sample)', type: 'savings', currency: 'NGN', openingBalanceMinor: K(150_000), ...demo }, tx);

    const monthStart = startOfMonth(today);
    const add = (p: Parameters<typeof createTransaction>[1]) => createTransaction(ctx, { ...p, isDemo: true }, { exec: tx, allowDuplicate: true });
    const base = {
      time: null,
      toAccountId: null,
      toAmountMinor: null,
      debtId: null,
      goalId: null,
      recurringId: null,
      notes: null,
      reference: null,
      tags: [] as string[],
    };

    // Three months of history (two full months + current month to date).
    for (let m = 2; m >= 0; m--) {
      const ms = addMonths(monthStart, -m);
      const within = (day: number) => {
        const d = addDays(ms, day - 1);
        return d <= today ? d : null;
      };
      const payday = within(25);
      if (payday) await add({ ...base, type: 'income', amountMinor: K(350_000), date: payday, accountId: bank.id, categoryId: 'sys-inc-salary', description: 'Monthly salary', paymentMethod: 'bank_transfer', tags: ['work'] });
      const gig = within(12);
      if (gig) await add({ ...base, type: 'income', amountMinor: K(60_000 + Math.round(rand() * 40_000)), date: gig, accountId: wallet.id, categoryId: 'sys-inc-freelance', description: 'Graphic design gig', paymentMethod: 'mobile_money' });
      const rent = within(1);
      if (rent) await add({ ...base, type: 'expense', amountMinor: K(85_000), date: rent, accountId: bank.id, categoryId: 'sys-exp-rent', description: 'Rent contribution', paymentMethod: 'bank_transfer' });
      const nepa = within(5);
      if (nepa) await add({ ...base, type: 'expense', amountMinor: K(15_000 + Math.round(rand() * 5_000)), date: nepa, accountId: wallet.id, categoryId: 'sys-exp-electricity', description: 'Prepaid meter token', paymentMethod: 'mobile_money' });
      const data = within(3);
      if (data) await add({ ...base, type: 'expense', amountMinor: K(11_000), date: data, accountId: wallet.id, categoryId: 'sys-exp-internet', description: 'Monthly data bundle', paymentMethod: 'ussd' });
      for (let d = 2; d <= 28; d += 3) {
        const date = within(d);
        if (!date) continue;
        await add({ ...base, type: 'expense', amountMinor: K(3_000 + Math.round(rand() * 9_000)), date, accountId: rand() > 0.5 ? cash.id : wallet.id, categoryId: 'sys-exp-food', description: rand() > 0.5 ? 'Market foodstuff' : 'Lunch', paymentMethod: 'cash', tags: rand() > 0.7 ? ['family'] : [] });
      }
      for (let d = 1; d <= 28; d += 4) {
        const date = within(d);
        if (!date) continue;
        await add({ ...base, type: 'expense', amountMinor: K(1_500 + Math.round(rand() * 4_000)), date, accountId: cash.id, categoryId: 'sys-exp-transport', description: rand() > 0.5 ? 'Bolt ride' : 'Bus fare', paymentMethod: 'cash' });
      }
      const fam = within(15);
      if (fam) await add({ ...base, type: 'expense', amountMinor: K(20_000), date: fam, accountId: bank.id, categoryId: 'sys-exp-family', description: 'Support for parents', paymentMethod: 'bank_transfer', tags: ['family'] });
      const fun = within(20);
      if (fun) await add({ ...base, type: 'expense', amountMinor: K(8_000 + Math.round(rand() * 10_000)), date: fun, accountId: wallet.id, categoryId: 'sys-exp-entertainment', description: 'Cinema & outing', paymentMethod: 'card' });
      const shop = within(18);
      if (shop && m !== 1) await add({ ...base, type: 'expense', amountMinor: K(25_000), date: shop, accountId: bank.id, categoryId: 'sys-exp-shopping', description: 'New shoes', paymentMethod: 'pos' });
      const topup = within(10);
      if (topup) await add({ ...base, type: 'transfer', amountMinor: K(30_000), date: topup, accountId: bank.id, toAccountId: cash.id, categoryId: null, description: 'ATM withdrawal', paymentMethod: 'card' });
    }

    // Debts: a loan app loan (flat 15%, 4 monthly instalments) and money owed to family.
    const loanStart = addMonths(monthStart, -2);
    const loan = await createDebt(
      ctx,
      {
        lenderName: 'QuickCredit (sample)',
        debtType: 'loan_app',
        currency: 'NGN',
        principalMinor: K(100_000),
        interestType: 'flat_percentage',
        interestValue: 15,
        paymentFrequency: 'monthly',
        minimumPaymentMinor: 0,
        installmentCount: 4,
        startDate: loanStart,
        firstDueDate: addDays(loanStart, 27),
        endDate: null,
        penaltyType: 'percentage',
        penaltyValue: 1,
        paidBeforeMinor: 0,
        totalPayableOverrideMinor: null,
        notes: 'Sample loan-app debt',
        isDemo: true,
      },
      { exec: tx, reminderOffsets: [{ days: 3, time: '09:00' }, { days: 1, time: '09:00' }, { days: 0, time: '08:00' }] },
    );
    const firstDue = addDays(loanStart, 27);
    if (firstDue <= today) await recordRepayment(ctx, loan.id, { amountMinor: K(28_750), date: firstDue, accountId: bank.id, isDemo: true }, tx);
    const secondDue = addMonths(firstDue, 1);
    if (secondDue <= today) await recordRepayment(ctx, loan.id, { amountMinor: K(28_750), date: secondDue, accountId: bank.id, isDemo: true }, tx);

    await createDebt(
      ctx,
      {
        lenderName: 'Uncle Tunde (sample)',
        debtType: 'family',
        currency: 'NGN',
        principalMinor: K(150_000),
        interestType: 'none',
        interestValue: 0,
        paymentFrequency: 'monthly',
        minimumPaymentMinor: K(25_000),
        installmentCount: 0,
        startDate: addMonths(today, -1),
        firstDueDate: addDays(today, 12),
        endDate: null,
        penaltyType: 'none',
        penaltyValue: 0,
        paidBeforeMinor: K(25_000),
        totalPayableOverrideMinor: null,
        notes: 'Borrowed for school fees',
        isDemo: true,
      },
      { exec: tx },
    );

    // Goals
    const laptop = await createGoal(
      ctx,
      {
        name: 'New Laptop',
        targetMinor: K(800_000),
        currency: 'NGN',
        initialMinor: K(250_000),
        startDate: addMonths(monthStart, -2),
        deadline: addMonths(today, 8),
        linkedAccountId: savings.id,
        icon: 'laptop',
        color: '#7C8CFF',
        reminderFrequency: 'monthly',
        notes: null,
        isDemo: true,
      },
      tx,
    );
    await contribute(ctx, laptop, 'deposit', { amountMinor: K(40_000), accountId: bank.id, date: addDays(monthStart, -5), isDemo: true }, tx);
    await createGoal(
      ctx,
      {
        name: 'Emergency fund',
        targetMinor: K(1_000_000),
        currency: 'NGN',
        initialMinor: K(120_000),
        startDate: addMonths(monthStart, -2),
        deadline: null,
        linkedAccountId: null,
        icon: 'shield-checkmark',
        color: '#22D3A6',
        reminderFrequency: 'none',
        notes: null,
        isDemo: true,
      },
      tx,
    );

    // Budgets
    await createBudget(ctx, { name: 'Food', period: 'monthly', limitMinor: K(50_000), startDate: monthStart, endDate: null, categoryIds: ['sys-exp-food'], alertThreshold: 0.8, isDemo: true }, tx);
    await createBudget(ctx, { name: 'Transport', period: 'monthly', limitMinor: K(30_000), startDate: monthStart, endDate: null, categoryIds: ['sys-exp-transport'], alertThreshold: 0.8, isDemo: true }, tx);
    await createBudget(ctx, { name: 'Internet', period: 'monthly', limitMinor: K(15_000), startDate: monthStart, endDate: null, categoryIds: ['sys-exp-internet'], alertThreshold: 0.8, isDemo: true }, tx);

    // Recurring bill + reminders + calendar event
    await saveRecurring(
      ctx,
      {
        type: 'expense',
        amountMinor: K(11_000),
        accountId: wallet.id,
        toAccountId: null,
        categoryId: 'sys-exp-internet',
        debtId: null,
        goalId: null,
        description: 'Data subscription',
        paymentMethod: 'ussd',
        frequency: 'monthly',
        interval: 1,
        unit: 'month',
        startDate: addDays(addMonths(monthStart, 1), 2),
        endDate: null,
        isBill: true,
        autoCreate: false,
        remindDaysBefore: 1,
        active: true,
        isDemo: true,
      },
      undefined,
      tx,
    );
    await saveCustomReminder(ctx, { title: 'Pay estate dues (sample)', message: 'Monthly estate security levy', date: addDays(today, 5), timeOfDay: '10:00', repeat: 'monthly', enabled: true, isDemo: true }, undefined, tx);
    await saveEvent(ctx, { title: 'School fees due (sample)', date: addDays(today, 20), kind: 'bill', amountMinor: K(95_000), notes: null, remind: true, isDemo: true }, undefined, tx);

    await audit(ctx, tx, 'demo', null, 'system', 'Loaded sample data');
  });
  await savePreferences(ctx, { demoDataLoaded: true });
}

/**
 * Removes every demo row. Demo accounts that the user has since used for real
 * transactions are kept (and converted to real accounts) so no real data is lost.
 */
export async function deleteDemoData(ctx: ServiceContext): Promise<{ keptAccounts: number }> {
  let keptAccounts = 0;
  await ctx.db.transaction(async (tx) => {
    await tx.run('DELETE FROM debt_payments WHERE is_demo = 1');
    await tx.run('DELETE FROM transactions WHERE is_demo = 1');
    const used = await tx.all<{ id: string }>(
      'SELECT DISTINCT a.id FROM accounts a JOIN transactions t ON (t.account_id = a.id OR t.to_account_id = a.id) WHERE a.is_demo = 1',
    );
    for (const u of used) await tx.run('UPDATE accounts SET is_demo = 0 WHERE id = ?', [u.id]);
    keptAccounts = used.length;
    for (const table of DEMO_TABLES) {
      if (table === 'transactions' || table === 'debt_payments') continue;
      await tx.run(`DELETE FROM ${table} WHERE is_demo = 1`);
    }
    await tx.run('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM transaction_tags)');
    await audit(ctx, tx, 'demo', null, 'system', 'Deleted sample data');
  });
  await savePreferences(ctx, { demoDataLoaded: false });
  return { keptAccounts };
}
