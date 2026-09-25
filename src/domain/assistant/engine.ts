import { addDays, endOfMonth, formatDate, relativeDays, startOfMonth, startOfYear, type DateRange } from '../dates';
import { formatMoney, formatPercent } from '../money';
import type { ISODate } from '../types';
import { parseQuery, type Intent, type ParsedQuery } from './parser';

/**
 * Rule-based financial assistant. It never calls a network service; every answer
 * is computed from the local database through `AssistantDataSource` and explained
 * step by step. Swap `LocalAssistantProvider` for another `AssistantProvider`
 * (e.g. an optional AI model) without touching the UI.
 */

export interface AssistantReply {
  intent: Intent;
  text: string;
  /** How the answer was calculated. */
  steps: string[];
  /** Optional tabular details (label → value). */
  items: { label: string; value: string; sub?: string }[];
  suggestions: string[];
  tone: 'good' | 'warn' | 'bad' | 'neutral';
}

export interface AssistantProvider {
  readonly id: string;
  readonly label: string;
  answer(question: string): Promise<AssistantReply>;
}

export interface UpcomingObligation {
  label: string;
  date: ISODate;
  amountMinor: number;
  kind: 'debt' | 'bill';
}

export interface AssistantDataSource {
  today(): ISODate;
  baseCurrency(): string;
  weekStartsOn(): 0 | 1;
  categories(): Promise<{ id: string; name: string; kind: 'income' | 'expense' }[]>;
  goals(): Promise<
    {
      id: string;
      name: string;
      currency: string;
      targetMinor: number;
      savedMinor: number;
      deadline: ISODate | null;
      requiredMonthlyMinor: number | null;
      requiredWeeklyMinor: number | null;
      currentMonthlyRateMinor: number;
      onTrack: boolean | null;
    }[]
  >;
  /** Totals in base currency for a range. */
  totals(range: DateRange): Promise<{ incomeMinor: number; expenseMinor: number; debtRepaymentMinor: number; loanReceivedMinor: number }>;
  categoryTotals(range: DateRange, kind: 'income' | 'expense'): Promise<{ categoryId: string; name: string; totalMinor: number }[]>;
  topExpenses(range: DateRange, limit: number): Promise<{ date: ISODate; description: string; category: string; amountMinor: number }[]>;
  balances(): Promise<{ spendableMinor: number; savingsMinor: number; totalMinor: number; accounts: { name: string; balanceMinor: number; currency: string }[] }>;
  debts(): Promise<{
    items: {
      lender: string;
      currency: string;
      outstandingMinor: number;
      outstandingBaseMinor: number;
      nextDue: ISODate | null;
      nextAmountMinor: number;
      overdueAmountMinor: number;
      daysOverdue: number;
      paymentsRemaining: number;
    }[];
    totalOutstandingMinor: number;
    monthlyObligationMinor: number;
    dti: number | null;
  }>;
  debtRepaid(range: DateRange): Promise<number>;
  upcomingObligations(days: number): Promise<UpcomingObligation[]>;
  monthlyAverages(months: number): Promise<{ incomeMinor: number; expenseMinor: number; debtRepaymentMinor: number }>;
  budgets(): Promise<{ name: string; limitMinor: number; spentMinor: number; state: string; message: string }[]>;
  health(): Promise<{ total: number; grade: string; components: { label: string; score: number; max: number }[] }>;
}

const EXAMPLES = [
  'Can I afford a ₦100,000 phone?',
  'How much did I spend on food this month?',
  'How much do I owe?',
  'When is my next debt payment?',
  'How much should I save each month for my goal?',
  'What category consumes most of my money?',
  'How much did I earn this month?',
  'How much did I spend last month?',
  'How much debt did I clear this year?',
  'Show me my biggest expenses',
];

export function assistantExamples(): string[] {
  return EXAMPLES;
}

function reply(intent: Intent, text: string, extra: Partial<AssistantReply> = {}): AssistantReply {
  return { intent, text, steps: [], items: [], suggestions: [], tone: 'neutral', ...extra };
}

export class LocalAssistantProvider implements AssistantProvider {
  readonly id = 'local-rules';
  readonly label = 'Finora Local Intelligence (offline)';

  constructor(private ds: AssistantDataSource) {}

  async answer(question: string): Promise<AssistantReply> {
    const q = question.trim();
    if (!q) return reply('help', 'Ask me anything about your money. For example:', { suggestions: EXAMPLES.slice(0, 5) });
    if (q.length > 500) return reply('unknown', 'That question is a bit long — please ask something shorter.');
    const [categories, goals] = await Promise.all([this.ds.categories(), this.ds.goals()]);
    const parsed = parseQuery(q, {
      today: this.ds.today(),
      currency: this.ds.baseCurrency(),
      weekStartsOn: this.ds.weekStartsOn(),
      categories,
      goals,
    });
    try {
      return await this.route(parsed, categories, goals);
    } catch (e) {
      return reply('unknown', 'Sorry, I could not calculate that from your data. Please try rephrasing.', { tone: 'warn' });
    }
  }

  private fmt(minor: number) {
    return formatMoney(minor, this.ds.baseCurrency());
  }

  private defaultRange(p: ParsedQuery, fallback: 'this_month' | 'this_year' = 'this_month'): DateRange & { label: string } {
    if (p.period) return p.period;
    const t = this.ds.today();
    if (fallback === 'this_year') return { start: startOfYear(t), end: `${t.slice(0, 4)}-12-31`, label: 'this year' };
    return { start: startOfMonth(t), end: endOfMonth(t), label: 'this month' };
  }

  private async route(
    p: ParsedQuery,
    categories: Awaited<ReturnType<AssistantDataSource['categories']>>,
    goals: Awaited<ReturnType<AssistantDataSource['goals']>>,
  ): Promise<AssistantReply> {
    switch (p.intent) {
      case 'affordability':
        return this.affordability(p);
      case 'category_spend':
        return this.categorySpend(p, categories);
      case 'spend_total':
        return this.spendTotal(p);
      case 'income_total':
        return this.incomeTotal(p, categories);
      case 'debt_total':
        return this.debtTotal();
      case 'next_debt_payment':
        return this.nextDebtPayment();
      case 'debt_cleared':
        return this.debtCleared(p);
      case 'goal_saving':
        return this.goalSaving(p, goals);
      case 'top_category':
        return this.topCategory(p);
      case 'biggest_expenses':
        return this.biggestExpenses(p);
      case 'balance':
        return this.balance();
      case 'budget_status':
        return this.budgetStatus();
      case 'health':
        return this.health();
      case 'cash_flow':
        return this.cashFlow(p);
      case 'greeting':
        return reply('greeting', 'Hello! I can answer questions about your spending, income, debts, budgets and savings — all calculated privately on this phone.', { suggestions: EXAMPLES.slice(0, 4) });
      case 'help':
        return reply('help', 'Here are some things you can ask me. I work completely offline using your own records.', { suggestions: EXAMPLES });
      default:
        if (p.amountMinor) return this.affordability(p);
        return reply(
          'unknown',
          "I'm a rule-based assistant, so I understand specific money questions. Try one of these:",
          { suggestions: EXAMPLES.slice(0, 6) },
        );
    }
  }

  private async affordability(p: ParsedQuery): Promise<AssistantReply> {
    const price = p.amountMinor;
    if (!price) {
      return reply('affordability', 'Tell me the price, for example: "Can I afford a ₦100,000 phone?"', { suggestions: ['Can I afford ₦50,000 shoes?'] });
    }
    const [bal, upcoming, goals, avg] = await Promise.all([
      this.ds.balances(),
      this.ds.upcomingObligations(30),
      this.ds.goals(),
      this.ds.monthlyAverages(3),
    ]);
    const obligations = upcoming.reduce((s, u) => s + u.amountMinor, 0);
    const goalCommit = goals.reduce((s, g) => s + (g.requiredMonthlyMinor && g.savedMinor < g.targetMinor ? g.requiredMonthlyMinor : 0), 0);
    const free = bal.spendableMinor - obligations - goalCommit;
    const surplus = avg.incomeMinor - avg.expenseMinor - avg.debtRepaymentMinor;
    const steps = [
      `Spendable balance (cash, bank & wallets): ${this.fmt(bal.spendableMinor)}`,
      `− Debt payments & bills due in the next 30 days: ${this.fmt(obligations)}`,
      `− Monthly contributions needed for your savings goals: ${this.fmt(goalCommit)}`,
      `= Money free to spend: ${this.fmt(free)}`,
      `Average monthly surplus (last 3 months): ${this.fmt(surplus)}`,
    ];
    const items = upcoming.slice(0, 6).map((u) => ({ label: u.label, value: this.fmt(u.amountMinor), sub: `${formatDate(u.date)} · ${relativeDays(u.date, this.ds.today())}` }));
    const priceStr = this.fmt(price);
    if (free > 0 && price <= free * 0.5) {
      return reply('affordability', `Yes — you can comfortably afford ${priceStr}. It uses ${formatPercent(price / free)} of the money you have free after upcoming obligations.`, { steps, items, tone: 'good' });
    }
    if (free > 0 && price <= free) {
      return reply(
        'affordability',
        `Yes, but it will be tight. ${priceStr} would use ${formatPercent(price / free)} of your free money, leaving ${this.fmt(free - price)} until your next income.`,
        { steps, items, tone: 'warn' },
      );
    }
    const shortfall = price - Math.max(0, free);
    if (surplus > 0) {
      const months = Math.ceil(shortfall / surplus);
      return reply(
        'affordability',
        `Not right now. After your upcoming obligations you are ${this.fmt(shortfall)} short. At your average surplus of ${this.fmt(surplus)}/month you could afford it in about ${months} month${months === 1 ? '' : 's'}.`,
        { steps: [...steps, `Months needed = ${this.fmt(shortfall)} ÷ ${this.fmt(surplus)} ≈ ${months}`], items, tone: 'bad', suggestions: ['How much should I save each month for my goal?'] },
      );
    }
    return reply(
      'affordability',
      `I would not recommend it. You are ${this.fmt(shortfall)} short after upcoming obligations, and your recent spending has been higher than your income.`,
      { steps, items, tone: 'bad', suggestions: ['What category consumes most of my money?'] },
    );
  }

  private async categorySpend(p: ParsedQuery, categories: { id: string; name: string; kind: string }[]): Promise<AssistantReply> {
    const range = this.defaultRange(p);
    const totals = await this.ds.categoryTotals(range, 'expense');
    const ids = p.categoryIds.filter((id) => categories.find((c) => c.id === id)?.kind === 'expense');
    if (!ids.length) return this.spendTotal(p);
    const rows = ids.map((id) => {
      const cat = categories.find((c) => c.id === id)!;
      return { name: cat.name, total: totals.find((t) => t.categoryId === id)?.totalMinor ?? 0 };
    });
    const sum = rows.reduce((s, r) => s + r.total, 0);
    const allSpend = totals.reduce((s, t) => s + t.totalMinor, 0);
    const names = rows.map((r) => r.name).join(' and ');
    return reply(
      'category_spend',
      sum === 0
        ? `You have not recorded any ${names} spending ${range.label}.`
        : `You spent ${this.fmt(sum)} on ${names} ${range.label}${allSpend ? ` — ${formatPercent(sum / allSpend)} of your total spending` : ''}.`,
      {
        steps: [`Period: ${formatDate(range.start)} – ${formatDate(range.end)}`, `Sum of expense transactions in ${names}`],
        items: rows.length > 1 ? rows.map((r) => ({ label: r.name, value: this.fmt(r.total) })) : [],
      },
    );
  }

  private async spendTotal(p: ParsedQuery): Promise<AssistantReply> {
    const range = this.defaultRange(p);
    const t = await this.ds.totals(range);
    const outflow = t.expenseMinor + t.debtRepaymentMinor;
    return reply('spend_total', `You spent ${this.fmt(t.expenseMinor)} ${range.label}${t.debtRepaymentMinor ? `, plus ${this.fmt(t.debtRepaymentMinor)} in debt repayments (${this.fmt(outflow)} total outflow)` : ''}.`, {
      steps: [`Period: ${formatDate(range.start)} – ${formatDate(range.end)}`, 'Transfers and savings deposits are not counted as spending.'],
      suggestions: ['What category consumes most of my money?', 'Show me my biggest expenses'],
    });
  }

  private async incomeTotal(p: ParsedQuery, categories: { id: string; name: string; kind: string }[]): Promise<AssistantReply> {
    const range = this.defaultRange(p);
    const ids = p.categoryIds.filter((id) => categories.find((c) => c.id === id)?.kind === 'income');
    if (ids.length) {
      const totals = await this.ds.categoryTotals(range, 'income');
      const sum = totals.filter((t) => ids.includes(t.categoryId)).reduce((s, t) => s + t.totalMinor, 0);
      const names = ids.map((id) => categories.find((c) => c.id === id)!.name).join(' and ');
      return reply('income_total', `You earned ${this.fmt(sum)} from ${names} ${range.label}.`, {
        steps: [`Period: ${formatDate(range.start)} – ${formatDate(range.end)}`],
      });
    }
    const [t, byCat] = await Promise.all([this.ds.totals(range), this.ds.categoryTotals(range, 'income')]);
    return reply('income_total', `You earned ${this.fmt(t.incomeMinor)} ${range.label}.`, {
      steps: [`Period: ${formatDate(range.start)} – ${formatDate(range.end)}`, 'Loans received are not counted as income.'],
      items: byCat.filter((c) => c.totalMinor > 0).map((c) => ({ label: c.name, value: this.fmt(c.totalMinor) })),
      tone: t.incomeMinor > 0 ? 'good' : 'neutral',
    });
  }

  private async debtTotal(): Promise<AssistantReply> {
    const d = await this.ds.debts();
    if (!d.items.length) return reply('debt_total', 'You have no active debts recorded. 🎉', { tone: 'good' });
    const dtiText = d.dti == null ? '' : ` Your debt payments take ${formatPercent(d.dti)} of your monthly income.`;
    return reply('debt_total', `You owe ${this.fmt(d.totalOutstandingMinor)} across ${d.items.length} debt${d.items.length === 1 ? '' : 's'}. Your monthly debt obligation is ${this.fmt(d.monthlyObligationMinor)}.${dtiText}`, {
      items: d.items.map((i) => ({
        label: i.lender,
        value: formatMoney(i.outstandingMinor, i.currency),
        sub: i.overdueAmountMinor > 0 ? `Overdue by ${i.daysOverdue} day(s)` : i.nextDue ? `Next: ${formatDate(i.nextDue)}` : undefined,
      })),
      tone: d.dti != null && d.dti > 0.4 ? 'bad' : d.dti != null && d.dti > 0.2 ? 'warn' : 'neutral',
      suggestions: ['When is my next debt payment?'],
    });
  }

  private async nextDebtPayment(): Promise<AssistantReply> {
    const d = await this.ds.debts();
    const upcoming = d.items.filter((i) => i.nextDue).sort((a, b) => (a.nextDue! < b.nextDue! ? -1 : 1));
    if (!upcoming.length) return reply('next_debt_payment', 'You have no upcoming debt payments.', { tone: 'good' });
    const n = upcoming[0];
    const today = this.ds.today();
    const overdue = n.nextDue! < today;
    return reply(
      'next_debt_payment',
      overdue
        ? `Your payment of ${formatMoney(n.nextAmountMinor, n.currency)} to ${n.lender} is overdue by ${n.daysOverdue} day(s) (was due ${formatDate(n.nextDue!)}).`
        : `Your next debt payment is ${formatMoney(n.nextAmountMinor, n.currency)} to ${n.lender}, due ${formatDate(n.nextDue!, 'long')} (${relativeDays(n.nextDue!, today)}).`,
      {
        items: upcoming.slice(1, 6).map((i) => ({ label: i.lender, value: formatMoney(i.nextAmountMinor, i.currency), sub: formatDate(i.nextDue!) })),
        tone: overdue ? 'bad' : 'neutral',
      },
    );
  }

  private async debtCleared(p: ParsedQuery): Promise<AssistantReply> {
    const range = this.defaultRange(p, 'this_year');
    const repaid = await this.ds.debtRepaid(range);
    const d = await this.ds.debts();
    return reply('debt_cleared', `You repaid ${this.fmt(repaid)} of debt ${range.label}. You still owe ${this.fmt(d.totalOutstandingMinor)}.`, {
      steps: [`Period: ${formatDate(range.start)} – ${formatDate(range.end)}`, 'Sum of recorded debt repayments (penalties excluded).'],
      tone: repaid > 0 ? 'good' : 'neutral',
    });
  }

  private async goalSaving(p: ParsedQuery, goals: Awaited<ReturnType<AssistantDataSource['goals']>>): Promise<AssistantReply> {
    const today = this.ds.today();
    // Ad-hoc question: "how much should I save each month to get 500k by December?"
    if (p.amountMinor && p.targetDate && !p.goalId) {
      const days = Math.max(1, (Date.parse(p.targetDate) - Date.parse(today)) / 86_400_000);
      const months = Math.max(1, days / 30.44);
      const weeks = Math.max(1, days / 7);
      const monthly = Math.ceil(p.amountMinor / months);
      return reply('goal_saving', `To save ${this.fmt(p.amountMinor)} by ${formatDate(p.targetDate)}, put aside about ${this.fmt(monthly)} per month (${this.fmt(Math.ceil(p.amountMinor / weeks))} per week).`, {
        steps: [`Time available: ${Math.round(days)} days ≈ ${months.toFixed(1)} months`, `${this.fmt(p.amountMinor)} ÷ ${months.toFixed(1)} months = ${this.fmt(monthly)}`],
      });
    }
    const active = goals.filter((g) => g.savedMinor < g.targetMinor);
    const selected = p.goalId ? active.filter((g) => g.id === p.goalId) : active;
    if (!selected.length) {
      return reply('goal_saving', goals.length ? 'All your savings goals are complete! 🎉' : 'You have no savings goals yet. Create one in the Goals section to get a saving plan.', {
        tone: goals.length ? 'good' : 'neutral',
      });
    }
    const items = selected.map((g) => ({
      label: g.name,
      value: g.requiredMonthlyMinor != null ? `${formatMoney(g.requiredMonthlyMinor, g.currency)}/month` : 'No deadline',
      sub:
        g.requiredWeeklyMinor != null
          ? `${formatMoney(g.requiredWeeklyMinor, g.currency)}/week · ${g.onTrack ? 'on track' : 'behind'} · ${formatMoney(g.targetMinor - g.savedMinor, g.currency)} left`
          : `${formatMoney(g.targetMinor - g.savedMinor, g.currency)} left`,
    }));
    const g = selected[0];
    const text =
      selected.length === 1
        ? g.requiredMonthlyMinor != null
          ? `For "${g.name}" you need to save ${formatMoney(g.requiredMonthlyMinor, g.currency)} per month (${formatMoney(g.requiredWeeklyMinor ?? 0, g.currency)} per week) to reach ${formatMoney(g.targetMinor, g.currency)} by ${formatDate(g.deadline!)}. ${g.onTrack ? 'Your current saving rate is enough.' : `You are currently saving about ${formatMoney(g.currentMonthlyRateMinor, g.currency)} per month, which is not enough.`}`
          : `"${g.name}" has no deadline. You have ${formatMoney(g.targetMinor - g.savedMinor, g.currency)} left to save. Add a deadline to get a monthly plan.`
        : `Here is what you need to save for each goal. In total: ${this.fmt(selected.reduce((s, x) => s + (x.requiredMonthlyMinor ?? 0), 0))} per month.`;
    return reply('goal_saving', text, { items: selected.length > 1 ? items : [], tone: selected.every((x) => x.onTrack !== false) ? 'good' : 'warn' });
  }

  private async topCategory(p: ParsedQuery): Promise<AssistantReply> {
    const range = this.defaultRange(p);
    const totals = (await this.ds.categoryTotals(range, 'expense')).filter((t) => t.totalMinor > 0).sort((a, b) => b.totalMinor - a.totalMinor);
    if (!totals.length) return reply('top_category', `You have no expenses recorded ${range.label}.`);
    const sum = totals.reduce((s, t) => s + t.totalMinor, 0);
    const top = totals[0];
    return reply('top_category', `${top.name} consumes most of your money ${range.label}: ${this.fmt(top.totalMinor)} (${formatPercent(top.totalMinor / sum)} of spending).`, {
      items: totals.slice(0, 6).map((t) => ({ label: t.name, value: this.fmt(t.totalMinor), sub: formatPercent(t.totalMinor / sum) })),
      steps: [`Period: ${formatDate(range.start)} – ${formatDate(range.end)}`],
    });
  }

  private async biggestExpenses(p: ParsedQuery): Promise<AssistantReply> {
    const range = this.defaultRange(p);
    const n = p.count ?? 5;
    const rows = await this.ds.topExpenses(range, n);
    if (!rows.length) return reply('biggest_expenses', `You have no expenses recorded ${range.label}.`);
    return reply('biggest_expenses', `Your ${rows.length} biggest expense${rows.length === 1 ? '' : 's'} ${range.label}:`, {
      items: rows.map((r) => ({ label: r.description || r.category, value: this.fmt(r.amountMinor), sub: `${r.category} · ${formatDate(r.date)}` })),
    });
  }

  private async balance(): Promise<AssistantReply> {
    const [b, d] = await Promise.all([this.ds.balances(), this.ds.debts()]);
    const netWorth = b.totalMinor - d.totalOutstandingMinor;
    return reply('balance', `You have ${this.fmt(b.totalMinor)} in total: ${this.fmt(b.spendableMinor)} spendable and ${this.fmt(b.savingsMinor)} in savings. After debts, your net worth is ${this.fmt(netWorth)}.`, {
      items: b.accounts.map((a) => ({ label: a.name, value: formatMoney(a.balanceMinor, a.currency) })),
      tone: netWorth >= 0 ? 'good' : 'warn',
    });
  }

  private async budgetStatus(): Promise<AssistantReply> {
    const budgets = await this.ds.budgets();
    if (!budgets.length) return reply('budget_status', 'You have no budgets yet. Create one in the Budgets section.');
    const risky = budgets.filter((b) => b.state === 'at_risk' || b.state === 'exceeded');
    return reply(
      'budget_status',
      risky.length ? `${risky.length} of your ${budgets.length} budgets need attention. ${risky[0].name}: ${risky[0].message}` : `All ${budgets.length} budgets are on track.`,
      {
        items: budgets.map((b) => ({ label: b.name, value: `${this.fmt(b.spentMinor)} / ${this.fmt(b.limitMinor)}`, sub: b.message })),
        tone: risky.length ? 'warn' : 'good',
      },
    );
  }

  private async health(): Promise<AssistantReply> {
    const h = await this.ds.health();
    return reply('health', `Your Financial Health Score is ${h.total}/100 (${h.grade}).`, {
      items: h.components.map((c) => ({ label: c.label, value: `${Math.round(c.score)}/${c.max}` })),
      tone: h.total >= 70 ? 'good' : h.total >= 50 ? 'warn' : 'bad',
    });
  }

  private async cashFlow(p: ParsedQuery): Promise<AssistantReply> {
    const range = this.defaultRange(p);
    const t = await this.ds.totals(range);
    const net = t.incomeMinor + t.loanReceivedMinor - t.expenseMinor - t.debtRepaymentMinor;
    return reply('cash_flow', `Your net cash flow ${range.label} is ${formatMoney(net, this.ds.baseCurrency(), { signed: true })}.`, {
      steps: [
        `Income: ${this.fmt(t.incomeMinor)}`,
        `+ Loans received: ${this.fmt(t.loanReceivedMinor)}`,
        `− Expenses: ${this.fmt(t.expenseMinor)}`,
        `− Debt repayments: ${this.fmt(t.debtRepaymentMinor)}`,
      ],
      tone: net >= 0 ? 'good' : 'bad',
    });
  }
}

/** Helper for the upcoming-window used by several screens. */
export function next30(today: ISODate): DateRange {
  return { start: today, end: addDays(today, 30) };
}
