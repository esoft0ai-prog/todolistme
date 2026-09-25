import { addMonths, eachMonth, formatDate, formatMonthKey, startOfMonth, type DateRange } from '../domain/dates';
import { transactionsToCSV, type ReportData } from '../domain/exporters';
import { balanceSummary, categoryTotals, healthScore, monthlyTotals, topExpenses, totals } from './analytics';
import { budgetViews } from './budgets';
import type { ServiceContext } from './context';
import { listDebts } from './debts';
import { listGoals } from './goals';
import { loadPreferences } from './preferences';
import { listTransactions, type TransactionFilter } from './transactions';

export type ReportFilter = Omit<TransactionFilter, 'range' | 'limit' | 'offset' | 'order' | 'search'>;

export async function buildReportData(ctx: ServiceContext, range: DateRange, filter: ReportFilter = {}): Promise<ReportData> {
  const prefs = await loadPreferences(ctx.db);
  const t = await totals(ctx.db, { ...filter, range });
  const debts = await listDebts(ctx.db, ctx.today());
  const goals = await listGoals(ctx);
  const bal = await balanceSummary(ctx, goals, debts);
  const months = eachMonth(range.start, range.end).slice(-24);
  const monthly = await monthlyTotals(ctx.db, months);
  const health = await healthScore(ctx, { debts, goals, balances: bal });
  return {
    title: 'Finora financial report',
    generatedAt: ctx.now().toISOString(),
    currency: prefs.baseCurrency,
    range,
    totals: {
      incomeMinor: t.incomeMinor,
      expenseMinor: t.expenseMinor,
      debtRepaymentMinor: t.debtRepaymentMinor,
      loanReceivedMinor: t.loanReceivedMinor,
      savingsNetMinor: t.savingsDepositMinor - t.savingsWithdrawalMinor,
    },
    balances: bal.accounts.map((a) => ({ name: a.name, type: a.type, balanceMinor: a.balanceMinor, currency: a.currency })),
    categories: (await categoryTotals(ctx.db, range, 'expense', filter)).map((x) => ({ name: x.name, totalMinor: x.totalMinor })),
    incomeCategories: (await categoryTotals(ctx.db, range, 'income', filter)).map((x) => ({ name: x.name, totalMinor: x.totalMinor })),
    months: monthly.map((x) => ({ key: x.key, label: formatMonthKey(x.key), incomeMinor: x.incomeMinor, expenseMinor: x.expenseMinor + x.debtRepaymentMinor })),
    debts: debts
      .filter((d) => d.debt.status !== 'archived')
      .map((d) => ({
        lender: d.debt.lenderName,
        outstandingMinor: d.summary.outstandingMinor,
        currency: d.debt.currency,
        next: d.summary.nextInstallment ? formatDate(d.summary.nextInstallment.dueDate) : '—',
        status: d.summary.isPaidOff ? 'Paid off' : d.summary.overdueInstallments.length ? 'Overdue' : 'Active',
      })),
    goals: goals.map((g) => ({
      name: g.goal.name,
      savedMinor: g.progress.savedMinor,
      targetMinor: g.goal.targetMinor,
      currency: g.goal.currency,
      percent: g.progress.percent,
      deadline: g.goal.deadline ? formatDate(g.goal.deadline) : '—',
    })),
    budgets: (await budgetViews(ctx)).map((b) => ({ name: b.budget.name, spentMinor: b.status.spentMinor, limitMinor: b.status.limitMinor, state: b.status.state })),
    health: { total: health.total, grade: health.grade, components: health.components.map((c) => ({ label: c.label, score: c.score, max: c.max, explanation: c.explanation })) },
    topExpenses: await topExpenses(ctx.db, range, 10, filter),
  };
}

/** Month-by-month comparison for the last N months (base currency). */
export async function monthlyComparison(ctx: ServiceContext, months = 12) {
  const keys = eachMonth(addMonths(startOfMonth(ctx.today()), -(months - 1)), ctx.today());
  return (await monthlyTotals(ctx.db, keys)).map((m) => ({ ...m, label: formatMonthKey(m.key, true), netMinor: m.incomeMinor - m.expenseMinor - m.debtRepaymentMinor }));
}

/** Year-by-year comparison for the last N years. */
export async function yearlyComparison(ctx: ServiceContext, years = 3) {
  const current = Number(ctx.today().slice(0, 4));
  const out: { year: number; incomeMinor: number; expenseMinor: number; debtRepaymentMinor: number; netMinor: number }[] = [];
  for (let y = current - years + 1; y <= current; y++) {
    const t = await totals(ctx.db, { range: { start: `${y}-01-01`, end: `${y}-12-31` } });
    out.push({ year: y, incomeMinor: t.incomeMinor, expenseMinor: t.expenseMinor, debtRepaymentMinor: t.debtRepaymentMinor, netMinor: t.incomeMinor - t.expenseMinor - t.debtRepaymentMinor });
  }
  return out;
}

export async function exportTransactionsCSV(ctx: ServiceContext, filter: TransactionFilter = {}): Promise<{ csv: string; count: number }> {
  const prefs = await loadPreferences(ctx.db);
  const txs = await listTransactions(ctx.db, { ...filter, limit: 5000, order: 'date_asc' });
  const accounts = await ctx.db.all<{ id: string; name: string }>('SELECT id, name FROM accounts');
  const cats = await ctx.db.all<{ id: string; name: string }>('SELECT id, name FROM categories');
  const debts = await ctx.db.all<{ id: string; lender_name: string }>('SELECT id, lender_name FROM debts');
  const goals = await ctx.db.all<{ id: string; name: string }>('SELECT id, name FROM savings_goals');
  const name = (list: { id: string; name?: string; lender_name?: string }[], id: string | null) => {
    const r = id ? list.find((x) => x.id === id) : undefined;
    return r ? (r.name ?? r.lender_name ?? null) : null;
  };
  const csv = transactionsToCSV(
    txs.map((t) => ({
      date: t.date,
      time: t.time,
      type: t.type,
      amountMinor: t.amountMinor,
      currency: t.currency,
      baseAmountMinor: t.baseAmountMinor,
      baseCurrency: prefs.baseCurrency,
      account: name(accounts, t.accountId) ?? '',
      toAccount: name(accounts, t.toAccountId),
      category: name(cats, t.categoryId),
      description: t.description,
      paymentMethod: t.paymentMethod,
      tags: t.tags,
      notes: t.notes,
      reference: t.reference,
      debt: name(debts, t.debtId),
      goal: name(goals, t.goalId),
    })),
  );
  return { csv, count: txs.length };
}
