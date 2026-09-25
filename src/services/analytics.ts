import {
  addDays,
  addMonths,
  daysInRange,
  eachDay,
  eachMonth,
  endOfMonth,
  formatMonthKey,
  previousRange,
  startOfMonth,
  startOfWeek,
  type DateRange,
} from '../domain/dates';
import { debtToIncome, paymentPunctuality } from '../domain/debt';
import { computeHealthScore, explainScoreChange, type HealthComponentKey, type HealthScore } from '../domain/health';
import { occurrencesBetween } from '../domain/recurrence';
import type { AccountWithBalance, ISODate, RecurrenceFrequency } from '../domain/types';
import { listAccounts } from './accounts';
import { budgetHistory, budgetViews, type BudgetView } from './budgets';
import type { Exec, ServiceContext } from './context';
import { listDebts, type DebtView } from './debts';
import { listGoals, type GoalView } from './goals';
import { loadPreferences } from './preferences';
import { makeConverter } from './rates';
import { projectedOccurrences } from './recurring';
import { listEvents } from './reminders';
import { buildFilterSQL, type TransactionFilter } from './transactions';

export interface Totals {
  incomeMinor: number;
  expenseMinor: number;
  debtRepaymentMinor: number;
  loanReceivedMinor: number;
  savingsDepositMinor: number;
  savingsWithdrawalMinor: number;
  transferMinor: number;
  count: number;
}

export function netCashFlow(t: Pick<Totals, 'incomeMinor' | 'expenseMinor' | 'debtRepaymentMinor' | 'loanReceivedMinor'>): number {
  return t.incomeMinor + t.loanReceivedMinor - t.expenseMinor - t.debtRepaymentMinor;
}

/** Aggregates in base currency. Transfers never count as income or spending. */
export async function totals(db: Exec, f: TransactionFilter): Promise<Totals> {
  const { where, params } = buildFilterSQL(f);
  const rows = await db.all<{ type: string; s: number; n: number }>(
    `SELECT t.type AS type, COALESCE(SUM(t.base_amount_minor),0) AS s, count(*) AS n FROM transactions t ${where} GROUP BY t.type`,
    params,
  );
  const get = (type: string) => Number(rows.find((r) => r.type === type)?.s ?? 0);
  return {
    incomeMinor: get('income'),
    expenseMinor: get('expense'),
    debtRepaymentMinor: get('debt_repayment'),
    loanReceivedMinor: get('loan_received'),
    savingsDepositMinor: get('savings_deposit'),
    savingsWithdrawalMinor: get('savings_withdrawal'),
    transferMinor: get('transfer'),
    count: rows.reduce((s, r) => s + Number(r.n), 0),
  };
}

export interface SeriesPoint {
  key: string;
  label: string;
  incomeMinor: number;
  expenseMinor: number;
  debtRepaymentMinor: number;
  netMinor: number;
}

/** Income/expense series bucketed by day (≤31 days), week (≤120 days) or month. */
export async function series(db: Exec, range: DateRange, f: Omit<TransactionFilter, 'range'> = {}, weekStartsOn: 0 | 1 = 1): Promise<SeriesPoint[]> {
  const days = daysInRange(range.start, range.end);
  const bucket: 'day' | 'week' | 'month' = days <= 31 ? 'day' : days <= 120 ? 'week' : 'month';
  const { where, params } = buildFilterSQL({ ...f, range, types: ['income', 'expense', 'debt_repayment', 'loan_received'] });
  const rows = await db.all<{ date: string; type: string; s: number }>(
    `SELECT t.date AS date, t.type AS type, SUM(t.base_amount_minor) AS s FROM transactions t ${where} GROUP BY t.date, t.type`,
    params,
  );
  const keyOf = (d: ISODate) => (bucket === 'day' ? d : bucket === 'week' ? startOfWeek(d, weekStartsOn) : d.slice(0, 7));
  const keys =
    bucket === 'day'
      ? eachDay(range.start, range.end)
      : bucket === 'week'
        ? [...new Set(eachDay(range.start, range.end).map(keyOf))]
        : eachMonth(range.start, range.end);
  const map = new Map<string, SeriesPoint>(
    keys.map((k) => [
      k,
      {
        key: k,
        label: bucket === 'month' ? formatMonthKey(k, true) : `${Number(k.slice(8, 10))}/${Number(k.slice(5, 7))}`,
        incomeMinor: 0,
        expenseMinor: 0,
        debtRepaymentMinor: 0,
        netMinor: 0,
      },
    ]),
  );
  for (const r of rows) {
    const p = map.get(keyOf(r.date));
    if (!p) continue;
    const v = Number(r.s);
    if (r.type === 'income') p.incomeMinor += v;
    else if (r.type === 'loan_received') p.netMinor += v;
    else if (r.type === 'expense') p.expenseMinor += v;
    else if (r.type === 'debt_repayment') p.debtRepaymentMinor += v;
  }
  for (const p of map.values()) p.netMinor += p.incomeMinor - p.expenseMinor - p.debtRepaymentMinor;
  return [...map.values()];
}

export async function monthlyTotals(db: Exec, months: string[]): Promise<{ key: string; incomeMinor: number; expenseMinor: number; debtRepaymentMinor: number }[]> {
  if (!months.length) return [];
  const start = `${months[0]}-01`;
  const end = endOfMonth(`${months[months.length - 1]}-01`);
  const rows = await db.all<{ m: string; type: string; s: number }>(
    "SELECT substr(date,1,7) AS m, type, SUM(base_amount_minor) AS s FROM transactions WHERE date BETWEEN ? AND ? AND type IN ('income','expense','debt_repayment') GROUP BY m, type",
    [start, end],
  );
  return months.map((key) => {
    const g = (t: string) => Number(rows.find((r) => r.m === key && r.type === t)?.s ?? 0);
    return { key, incomeMinor: g('income'), expenseMinor: g('expense'), debtRepaymentMinor: g('debt_repayment') };
  });
}

export async function categoryTotals(
  db: Exec,
  range: DateRange,
  kind: 'income' | 'expense',
  f: Omit<TransactionFilter, 'range' | 'types'> = {},
): Promise<{ categoryId: string; name: string; color: string; icon: string; totalMinor: number; count: number }[]> {
  const types = kind === 'income' ? ['income'] : ['expense', 'debt_repayment'];
  const { where, params } = buildFilterSQL({ ...f, range, types: types as TransactionFilter['types'] });
  const rows = await db.all<{ category_id: string | null; name: string | null; color: string | null; icon: string | null; s: number; n: number }>(
    `SELECT t.category_id, c.name, c.color, c.icon, SUM(t.base_amount_minor) AS s, count(*) AS n
     FROM transactions t LEFT JOIN categories c ON c.id = t.category_id ${where}
     GROUP BY t.category_id ORDER BY s DESC`,
    params,
  );
  return rows.map((r) => ({
    categoryId: r.category_id ?? 'uncategorised',
    name: r.name ?? 'Uncategorised',
    color: r.color ?? '#94A3B8',
    icon: r.icon ?? 'help-circle',
    totalMinor: Number(r.s),
    count: Number(r.n),
  }));
}

export async function topExpenses(db: Exec, range: DateRange, limit: number, f: Omit<TransactionFilter, 'range' | 'types'> = {}) {
  const { where, params } = buildFilterSQL({ ...f, range, types: ['expense'] });
  const rows = await db.all<{ id: string; date: string; description: string; name: string | null; base_amount_minor: number }>(
    `SELECT t.id, t.date, t.description, c.name, t.base_amount_minor FROM transactions t LEFT JOIN categories c ON c.id = t.category_id ${where} ORDER BY t.base_amount_minor DESC LIMIT ?`,
    [...params, Math.min(50, Math.max(1, limit))],
  );
  return rows.map((r) => ({ id: r.id, date: r.date, description: r.description, category: r.name ?? 'Uncategorised', amountMinor: Number(r.base_amount_minor) }));
}

// ---------------------------------------------------------------- Balances

export interface BalanceSummary {
  accounts: AccountWithBalance[];
  totalMinor: number;
  spendableMinor: number;
  savingsAccountsMinor: number;
  goalSavingsMinor: number; // saved in goals without a linked account (money set aside)
  savingsMinor: number;
  netWorthMinor: number;
  debtMinor: number;
}

export async function balanceSummary(ctx: ServiceContext, goals?: GoalView[], debts?: DebtView[]): Promise<BalanceSummary> {
  const conv = await makeConverter(ctx.db);
  const accounts = await listAccounts(ctx.db);
  goals = goals ?? (await listGoals(ctx));
  debts = debts ?? (await listDebts(ctx.db, ctx.today()));
  let spendable = 0;
  let savingsAcc = 0;
  for (const a of accounts) {
    const v = conv.toBase(a.balanceMinor, a.currency);
    if (a.type === 'savings') savingsAcc += v;
    else spendable += v;
  }
  const goalSavings = goals
    .filter((g) => !g.goal.linkedAccountId && g.goal.status !== 'archived')
    .reduce((s, g) => s + conv.toBase(g.progress.savedMinor, g.goal.currency), 0);
  const debt = debts.filter((d) => d.debt.status === 'active').reduce((s, d) => s + conv.toBase(d.summary.outstandingMinor, d.debt.currency), 0);
  const total = spendable + savingsAcc;
  return {
    accounts,
    totalMinor: total,
    spendableMinor: spendable,
    savingsAccountsMinor: savingsAcc,
    goalSavingsMinor: goalSavings,
    savingsMinor: savingsAcc + goalSavings,
    netWorthMinor: total + goalSavings - debt,
    debtMinor: debt,
  };
}

// ---------------------------------------------------------------- Debts overview

export async function debtOverview(ctx: ServiceContext, debts?: DebtView[]) {
  const conv = await makeConverter(ctx.db);
  const prefs = await loadPreferences(ctx.db);
  debts = debts ?? (await listDebts(ctx.db, ctx.today()));
  const active = debts.filter((d) => d.debt.status === 'active');
  const outstanding = active.reduce((s, d) => s + conv.toBase(d.summary.outstandingMinor, d.debt.currency), 0);
  const monthly = active.reduce((s, d) => s + conv.toBase(d.summary.monthlyObligationMinor, d.debt.currency), 0);
  const income = await averageMonthlyIncome(ctx, 3, prefs.monthlyIncomeMinor);
  return {
    debts: active,
    totalOutstandingMinor: outstanding,
    monthlyObligationMinor: monthly,
    averageMonthlyIncomeMinor: income,
    dti: debtToIncome(monthly, income),
    overdueCount: active.filter((d) => d.summary.overdueInstallments.length > 0).length,
  };
}

/** Average of the last N complete months of recorded income; falls back to the declared income. */
export async function averageMonthlyIncome(ctx: ServiceContext, months: number, declared: number): Promise<number> {
  const keys = eachMonth(addMonths(startOfMonth(ctx.today()), -months), addDays(startOfMonth(ctx.today()), -1));
  const m = await monthlyTotals(ctx.db, keys);
  const withIncome = m.filter((x) => x.incomeMinor > 0);
  if (!withIncome.length) {
    // Use this month's income if nothing earlier was recorded.
    const cur = await monthlyTotals(ctx.db, [ctx.today().slice(0, 7)]);
    return cur[0].incomeMinor > 0 ? Math.max(cur[0].incomeMinor, declared) : declared;
  }
  return Math.round(withIncome.reduce((s, x) => s + x.incomeMinor, 0) / withIncome.length);
}

export async function monthlyAverages(ctx: ServiceContext, months: number) {
  const keys = eachMonth(addMonths(startOfMonth(ctx.today()), -months), addDays(startOfMonth(ctx.today()), -1));
  const m = (await monthlyTotals(ctx.db, keys)).filter((x) => x.incomeMinor || x.expenseMinor || x.debtRepaymentMinor);
  if (!m.length) {
    const cur = (await monthlyTotals(ctx.db, [ctx.today().slice(0, 7)]))[0];
    return { incomeMinor: cur.incomeMinor, expenseMinor: cur.expenseMinor, debtRepaymentMinor: cur.debtRepaymentMinor, months: 0 };
  }
  const avg = (k: 'incomeMinor' | 'expenseMinor' | 'debtRepaymentMinor') => Math.round(m.reduce((s, x) => s + x[k], 0) / m.length);
  return { incomeMinor: avg('incomeMinor'), expenseMinor: avg('expenseMinor'), debtRepaymentMinor: avg('debtRepaymentMinor'), months: m.length };
}

// ---------------------------------------------------------------- Upcoming obligations & calendar

export interface UpcomingItem {
  id: string;
  kind: 'debt' | 'bill' | 'income' | 'event' | 'goal' | 'reminder' | 'budget';
  title: string;
  subtitle: string;
  date: ISODate;
  amountMinor: number | null;
  currency: string;
  overdue: boolean;
  entityId: string | null;
}

export async function upcomingItems(ctx: ServiceContext, from: ISODate, to: ISODate, opts: { includeOverdue?: boolean; debts?: DebtView[] } = {}): Promise<UpcomingItem[]> {
  const prefs = await loadPreferences(ctx.db);
  const base = prefs.baseCurrency;
  const today = ctx.today();
  const out: UpcomingItem[] = [];
  const debts = opts.debts ?? (await listDebts(ctx.db, today));
  for (const d of debts) {
    if (d.debt.status !== 'active') continue;
    for (const inst of d.summary.installments) {
      if (inst.status === 'paid') continue;
      const overdue = inst.dueDate < today;
      if ((inst.dueDate >= from && inst.dueDate <= to) || (overdue && opts.includeOverdue)) {
        out.push({
          id: `debt-${d.debt.id}-${inst.index}`,
          kind: 'debt',
          title: `Pay ${d.debt.lenderName}`,
          subtitle: inst.index === d.summary.installments.length - 1 ? 'Final payment' : `Instalment ${inst.index + 1} of ${d.summary.installments.length}`,
          date: inst.dueDate,
          amountMinor: inst.amountMinor - inst.paidMinor,
          currency: d.debt.currency,
          overdue,
          entityId: d.debt.id,
        });
      }
    }
  }
  const accounts = await ctx.db.all<{ id: string; currency: string }>('SELECT id, currency FROM accounts');
  const curOf = (id: string) => accounts.find((a) => a.id === id)?.currency ?? base;
  for (const o of await projectedOccurrences(ctx, from, to)) {
    const r = o.recurring;
    if (r.type === 'debt_repayment' && r.debtId) continue; // already represented by the debt schedule
    out.push({
      id: `rec-${r.id}-${o.date}`,
      kind: r.type === 'income' ? 'income' : r.type === 'savings_deposit' ? 'goal' : 'bill',
      title: r.description || (r.type === 'income' ? 'Recurring income' : 'Recurring payment'),
      subtitle: r.isBill ? 'Bill' : r.type === 'income' ? 'Expected income' : r.type.replace('_', ' '),
      date: o.date,
      amountMinor: r.amountMinor,
      currency: curOf(r.accountId),
      overdue: false,
      entityId: r.id,
    });
  }
  for (const e of await listEvents(ctx.db, from, to)) {
    out.push({
      id: `event-${e.id}`,
      kind: e.kind === 'income' ? 'income' : e.kind === 'savings' ? 'goal' : e.kind === 'bill' ? 'bill' : 'event',
      title: e.title,
      subtitle: e.kind === 'note' ? 'Note' : e.kind[0].toUpperCase() + e.kind.slice(1),
      date: e.date,
      amountMinor: e.amountMinor,
      currency: base,
      overdue: false,
      entityId: e.id,
    });
  }
  const goals = await listGoals(ctx);
  for (const g of goals) {
    if (g.goal.deadline && g.goal.status === 'active' && g.goal.deadline >= from && g.goal.deadline <= to) {
      out.push({
        id: `goal-${g.goal.id}`,
        kind: 'goal',
        title: `${g.goal.name} deadline`,
        subtitle: `${Math.round(g.progress.percent * 100)}% saved`,
        date: g.goal.deadline,
        amountMinor: g.progress.remainingMinor,
        currency: g.goal.currency,
        overdue: false,
        entityId: g.goal.id,
      });
    }
  }
  const custom = await ctx.db.all<{ id: string; title: string; message: string; date: string; repeat: string }>(
    "SELECT id, title, message, date, repeat FROM reminders WHERE kind = 'custom' AND enabled = 1 AND date IS NOT NULL",
  );
  for (const r of custom) {
    const dates =
      r.repeat === 'none'
        ? r.date >= from && r.date <= to
          ? [r.date]
          : []
        : occurrencesBetween({ frequency: r.repeat as RecurrenceFrequency, interval: 1, unit: 'month', startDate: r.date, endDate: null }, from, to, 100);
    for (const d of dates) {
      out.push({ id: `rem-${r.id}-${d}`, kind: 'reminder', title: r.title, subtitle: r.message || 'Reminder', date: d, amountMinor: null, currency: base, overdue: false, entityId: r.id });
    }
  }
  // Budget period ends (within range) for calendar awareness.
  for (const b of await budgetViews(ctx)) {
    if (b.status.range.end >= from && b.status.range.end <= to && b.budget.period !== 'custom') {
      out.push({
        id: `budget-${b.budget.id}-${b.status.range.end}`,
        kind: 'budget',
        title: `${b.budget.name} budget resets`,
        subtitle: `${Math.round(b.status.percentUsed * 100)}% used this period`,
        date: addDays(b.status.range.end, 1),
        amountMinor: null,
        currency: base,
        overdue: false,
        entityId: b.budget.id,
      });
    }
  }
  return out.sort((a, b) => (a.date === b.date ? (a.overdue === b.overdue ? 0 : a.overdue ? -1 : 1) : a.date < b.date ? -1 : 1));
}

// ---------------------------------------------------------------- Health score

export interface HealthResult extends HealthScore {
  change: { delta: number; changes: { key: HealthComponentKey; label: string; delta: number; text: string }[] };
  previousMonth: string | null;
}

export async function healthScore(ctx: ServiceContext, pre?: { debts?: DebtView[]; goals?: GoalView[]; balances?: BalanceSummary }): Promise<HealthResult> {
  const prefs = await loadPreferences(ctx.db);
  const today = ctx.today();
  const monthKeys = eachMonth(addMonths(startOfMonth(today), -5), today);
  const months = await monthlyTotals(ctx.db, monthKeys);
  // Exclude the current month if it has barely started (< 7 days) to avoid noisy data.
  const usable = Number(today.slice(8, 10)) < 7 ? months.slice(0, -1) : months;
  const debts = pre?.debts ?? (await listDebts(ctx.db, today, { includeArchived: false }));
  const goals = pre?.goals ?? (await listGoals(ctx));
  const bal = pre?.balances ?? (await balanceSummary(ctx, goals, debts));
  const conv = await makeConverter(ctx.db);
  const windowStart = addMonths(today, -6);
  let due = 0;
  let onTime = 0;
  let overdueNow = 0;
  let owed = 0;
  let repaid = 0;
  for (const d of debts) {
    const p = paymentPunctuality(d.debt, d.payments, d.schedule, windowStart, today);
    due += p.due;
    onTime += p.onTime;
    overdueNow += d.debt.status === 'active' ? p.overdueNow : 0;
    const owedTotal = d.summary.totalPayableMinor + d.summary.penaltiesMinor + d.summary.adjustmentsMinor;
    owed += conv.toBase(owedTotal, d.debt.currency);
    repaid += conv.toBase(Math.min(owedTotal, d.summary.paidMinor), d.debt.currency);
  }
  const monthlyObligation = debts
    .filter((d) => d.debt.status === 'active')
    .reduce((s, d) => s + conv.toBase(d.summary.monthlyObligationMinor, d.debt.currency), 0);

  const score = computeHealthScore({
    months: usable,
    liquidAssetsMinor: Math.max(0, bal.totalMinor + bal.goalSavingsMinor),
    monthlyDebtObligationMinor: monthlyObligation,
    declaredMonthlyIncomeMinor: prefs.monthlyIncomeMinor,
    debtOwedMinor: owed,
    debtRepaidMinor: repaid,
    budgets: await budgetHistory(ctx, 3),
    installmentsDue: due,
    installmentsOnTime: onTime,
    installmentsOverdueNow: overdueNow,
  });

  // Compare with the most recent snapshot from a previous month and store this month's.
  const month = today.slice(0, 7);
  const prev = await ctx.db.get<{ month: string; total: number; components: string }>('SELECT * FROM health_snapshots WHERE month < ? ORDER BY month DESC LIMIT 1', [month]);
  let parsedPrev: { total: number; components: { key: HealthComponentKey; score: number }[] } | null = null;
  if (prev) {
    try {
      parsedPrev = { total: Number(prev.total), components: JSON.parse(prev.components) };
    } catch {
      parsedPrev = null;
    }
  }
  await ctx.db.run(
    'INSERT INTO health_snapshots (month, total, components, created_at) VALUES (?,?,?,?) ON CONFLICT(month) DO UPDATE SET total = excluded.total, components = excluded.components, created_at = excluded.created_at',
    [month, score.total, JSON.stringify(score.components.map((c) => ({ key: c.key, score: c.score }))), ctx.now().toISOString()],
  );
  return { ...score, change: explainScoreChange(parsedPrev, score), previousMonth: prev?.month ?? null };
}

export async function healthHistory(db: Exec): Promise<{ month: string; total: number }[]> {
  const rows = await db.all<{ month: string; total: number }>('SELECT month, total FROM health_snapshots ORDER BY month DESC LIMIT 12');
  return rows.reverse().map((r) => ({ month: r.month, total: Number(r.total) }));
}

// ---------------------------------------------------------------- Debt reduction series

/** Total outstanding debt (base currency) at the end of each of the last N months. */
export async function debtReductionSeries(ctx: ServiceContext, months = 6, debts?: DebtView[]): Promise<{ key: string; label: string; outstandingMinor: number }[]> {
  const conv = await makeConverter(ctx.db);
  debts = debts ?? (await listDebts(ctx.db, ctx.today(), { includeArchived: true }));
  const keys = eachMonth(addMonths(startOfMonth(ctx.today()), -(months - 1)), ctx.today());
  return keys.map((key) => {
    const end = key === ctx.today().slice(0, 7) ? ctx.today() : endOfMonth(`${key}-01`);
    let total = 0;
    for (const d of debts!) {
      if (d.debt.startDate > end) continue;
      const owed = d.summary.totalPayableMinor;
      const paid = d.debt.paidBeforeMinor + d.payments.filter((p) => p.kind === 'payment' && p.date <= end).reduce((s, p) => s + p.amountMinor, 0);
      const extra = d.payments.filter((p) => p.kind !== 'payment' && p.date <= end).reduce((s, p) => s + p.amountMinor, 0);
      total += conv.toBase(Math.max(0, owed + extra - paid), d.debt.currency);
    }
    return { key, label: formatMonthKey(key, true), outstandingMinor: total };
  });
}

// ---------------------------------------------------------------- Dashboard

export interface DashboardData {
  range: DateRange;
  totals: Totals;
  previousTotals: Totals;
  netCashFlowMinor: number;
  previousNetCashFlowMinor: number;
  balances: BalanceSummary;
  debt: Awaited<ReturnType<typeof debtOverview>>;
  budgetRemainingMinor: number;
  budgetLimitMinor: number;
  budgets: BudgetView[];
  goals: GoalView[];
  upcoming: UpcomingItem[];
  reminders: { key: string; title: string; body: string; fireAt: string }[];
  health: HealthResult;
  series: SeriesPoint[];
  categories: Awaited<ReturnType<typeof categoryTotals>>;
  debtSeries: Awaited<ReturnType<typeof debtReductionSeries>>;
  baseCurrency: string;
}

export async function dashboard(ctx: ServiceContext, range: DateRange): Promise<DashboardData> {
  const prefs = await loadPreferences(ctx.db);
  const today = ctx.today();
  const debts = await listDebts(ctx.db, today, { includeArchived: true });
  const activeDebts = debts.filter((d) => d.debt.status !== 'archived');
  const goals = await listGoals(ctx);
  const [t, pt, balances, budgets] = await Promise.all([
    totals(ctx.db, { range }),
    totals(ctx.db, { range: previousRange(range) }),
    balanceSummary(ctx, goals, activeDebts),
    budgetViews(ctx),
  ]);
  const debt = await debtOverview(ctx, activeDebts);
  const upcoming = await upcomingItems(ctx, today, addDays(today, 30), { includeOverdue: true, debts: activeDebts });
  const reminders = await ctx.db.all<{ key: string; title: string; body: string; fire_at: string }>(
    'SELECT key, title, body, fire_at FROM scheduled_notifications WHERE fire_at >= ? ORDER BY fire_at LIMIT 5',
    [ctx.now().toISOString()],
  );
  const current = budgets.filter((b) => b.status.state !== 'upcoming' && b.status.state !== 'ended');
  return {
    range,
    totals: t,
    previousTotals: pt,
    netCashFlowMinor: netCashFlow(t),
    previousNetCashFlowMinor: netCashFlow(pt),
    balances,
    debt,
    budgetRemainingMinor: current.reduce((s, b) => s + Math.max(0, b.status.remainingMinor), 0),
    budgetLimitMinor: current.reduce((s, b) => s + b.status.limitMinor, 0),
    budgets,
    goals,
    upcoming,
    reminders: reminders.map((r) => ({ key: r.key, title: r.title, body: r.body, fireAt: r.fire_at })),
    health: await healthScore(ctx, { debts: activeDebts, goals, balances }),
    series: await series(ctx.db, range, {}, prefs.weekStartsOn),
    categories: await categoryTotals(ctx.db, range, 'expense'),
    debtSeries: await debtReductionSeries(ctx, 6, debts),
    baseCurrency: prefs.baseCurrency,
  };
}

/** Converts an amount to the base currency using the current rate table. */
export async function toBaseAmount(db: Exec, minor: number, currency: string): Promise<number> {
  const conv = await makeConverter(db);
  return conv.toBase(minor, currency);
}

