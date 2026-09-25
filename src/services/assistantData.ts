import { LocalAssistantProvider, type AssistantDataSource, type AssistantProvider } from '../domain/assistant/engine';
import { addDays } from '../domain/dates';
import { averageMonthlyIncome, balanceSummary, categoryTotals, debtOverview, healthScore, monthlyAverages, topExpenses, totals, upcomingItems } from './analytics';
import { budgetViews } from './budgets';
import type { ServiceContext } from './context';
import { listGoals } from './goals';
import { loadPreferences } from './preferences';
import { makeConverter } from './rates';
import { listCategories } from './categories';

/** Bridges the assistant engine to the local database. */
export async function createAssistantDataSource(ctx: ServiceContext): Promise<AssistantDataSource> {
  const prefs = await loadPreferences(ctx.db);
  return {
    today: () => ctx.today(),
    baseCurrency: () => prefs.baseCurrency,
    weekStartsOn: () => prefs.weekStartsOn,
    categories: async () => (await listCategories(ctx.db)).map((c) => ({ id: c.id, name: c.name, kind: c.kind })),
    goals: async () =>
      (await listGoals(ctx)).map((g) => ({
        id: g.goal.id,
        name: g.goal.name,
        currency: g.goal.currency,
        targetMinor: g.goal.targetMinor,
        savedMinor: g.progress.savedMinor,
        deadline: g.goal.deadline,
        requiredMonthlyMinor: g.progress.requiredMonthlyMinor,
        requiredWeeklyMinor: g.progress.requiredWeeklyMinor,
        currentMonthlyRateMinor: g.progress.currentMonthlyRateMinor,
        onTrack: g.progress.onTrack,
      })),
    totals: async (range) => {
      const t = await totals(ctx.db, { range });
      return { incomeMinor: t.incomeMinor, expenseMinor: t.expenseMinor, debtRepaymentMinor: t.debtRepaymentMinor, loanReceivedMinor: t.loanReceivedMinor };
    },
    categoryTotals: async (range, kind) => (await categoryTotals(ctx.db, range, kind)).map((c) => ({ categoryId: c.categoryId, name: c.name, totalMinor: c.totalMinor })),
    topExpenses: async (range, limit) => topExpenses(ctx.db, range, limit),
    balances: async () => {
      const b = await balanceSummary(ctx);
      return {
        spendableMinor: b.spendableMinor,
        savingsMinor: b.savingsMinor,
        totalMinor: b.totalMinor + b.goalSavingsMinor,
        accounts: b.accounts.map((a) => ({ name: a.name, balanceMinor: a.balanceMinor, currency: a.currency })),
      };
    },
    debts: async () => {
      const conv = await makeConverter(ctx.db);
      const o = await debtOverview(ctx);
      return {
        items: o.debts.map((d) => ({
          lender: d.debt.lenderName,
          currency: d.debt.currency,
          outstandingMinor: d.summary.outstandingMinor,
          outstandingBaseMinor: conv.toBase(d.summary.outstandingMinor, d.debt.currency),
          nextDue: d.summary.nextInstallment?.dueDate ?? null,
          nextAmountMinor: d.summary.nextInstallment ? d.summary.nextInstallment.amountMinor - d.summary.nextInstallment.paidMinor : 0,
          overdueAmountMinor: d.summary.overdueAmountMinor,
          daysOverdue: d.summary.daysOverdue,
          paymentsRemaining: d.summary.paymentsRemaining,
        })),
        totalOutstandingMinor: o.totalOutstandingMinor,
        monthlyObligationMinor: o.monthlyObligationMinor,
        dti: o.dti,
      };
    },
    debtRepaid: async (range) => (await totals(ctx.db, { range })).debtRepaymentMinor + (await outsideRepayments(ctx, range.start, range.end)),
    upcomingObligations: async (days) => {
      const conv = await makeConverter(ctx.db);
      const items = await upcomingItems(ctx, ctx.today(), addDays(ctx.today(), days), { includeOverdue: true });
      return items
        .filter((i) => (i.kind === 'debt' || i.kind === 'bill') && i.amountMinor)
        .map((i) => ({ label: i.title, date: i.date, amountMinor: conv.toBase(i.amountMinor!, i.currency), kind: i.kind as 'debt' | 'bill' }));
    },
    monthlyAverages: async (months) => {
      const m = await monthlyAverages(ctx, months);
      if (m.incomeMinor === 0) m.incomeMinor = await averageMonthlyIncome(ctx, months, prefs.monthlyIncomeMinor);
      return m;
    },
    budgets: async () =>
      (await budgetViews(ctx)).map((b) => ({ name: b.budget.name, limitMinor: b.status.limitMinor, spentMinor: b.status.spentMinor, state: b.status.state, message: b.status.message })),
    health: async () => {
      const h = await healthScore(ctx);
      return { total: h.total, grade: h.grade, components: h.components.map((c) => ({ label: c.label, score: c.score, max: c.max })) };
    },
  };
}

/** Repayments recorded without a linked transaction (paid from outside tracked accounts). */
async function outsideRepayments(ctx: ServiceContext, start: string, end: string): Promise<number> {
  const conv = await makeConverter(ctx.db);
  const rows = await ctx.db.all<{ amount_minor: number; currency: string }>(
    "SELECT p.amount_minor, d.currency FROM debt_payments p JOIN debts d ON d.id = p.debt_id WHERE p.kind = 'payment' AND p.transaction_id IS NULL AND p.date BETWEEN ? AND ?",
    [start, end],
  );
  return rows.reduce((s, r) => s + conv.toBase(Number(r.amount_minor), r.currency), 0);
}

export async function createAssistant(ctx: ServiceContext): Promise<AssistantProvider> {
  return new LocalAssistantProvider(await createAssistantDataSource(ctx));
}

