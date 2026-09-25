/**
 * Financial Health Score (0–100).
 *
 * Five transparent components, 20 points each. Every component returns the
 * inputs it used and a plain-language explanation so the user can see exactly
 * why the score is what it is — and why it changed since the last snapshot.
 *
 *  1. Savings            – savings rate (12 pts) + emergency fund in months of expenses (8 pts)
 *  2. Debt burden        – debt-to-income ratio (14 pts) + debt reduction progress (6 pts)
 *  3. Budget discipline  – share of budgets within their limit (20 pts)
 *  4. Cash flow          – share of months with positive cash flow (14 pts) + stability (6 pts)
 *  5. Payment consistency– share of debt instalments paid on time, minus current overdue items
 */

export type HealthComponentKey = 'savings' | 'debt' | 'budget' | 'cashflow' | 'payments';

export interface HealthComponent {
  key: HealthComponentKey;
  label: string;
  score: number;
  max: number;
  explanation: string;
  tip: string | null;
  hasData: boolean;
}

export interface HealthInputs {
  /** Monthly totals for recent complete + current months, oldest first (base currency minor units). */
  months: { key: string; incomeMinor: number; expenseMinor: number; debtRepaymentMinor: number }[];
  /** Cash + bank + wallets + savings accounts + goal savings. */
  liquidAssetsMinor: number;
  monthlyDebtObligationMinor: number;
  /** Fallback income (declared in onboarding) when there is no recorded income. */
  declaredMonthlyIncomeMinor: number;
  /** Total originally owed on active + recently finished debts, and how much of it has been repaid. */
  debtOwedMinor: number;
  debtRepaidMinor: number;
  /** Budget periods evaluated (current period uses projection). */
  budgets: { limitMinor: number; spentMinor: number; projectedMinor: number; isCurrent: boolean }[];
  /** Instalments that fell due in the evaluation window. */
  installmentsDue: number;
  installmentsOnTime: number;
  installmentsOverdueNow: number;
}

export interface HealthScore {
  total: number;
  grade: 'Excellent' | 'Good' | 'Fair' | 'Needs attention' | 'Critical';
  components: HealthComponent[];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round1 = (v: number) => Math.round(v * 10) / 10;
const pct = (v: number) => `${Math.round(v * 100)}%`;

function average(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

export function computeHealthScore(input: HealthInputs): HealthScore {
  const months = input.months.filter((m) => m.incomeMinor > 0 || m.expenseMinor > 0 || m.debtRepaymentMinor > 0);
  const recordedIncome = average(months.map((m) => m.incomeMinor));
  const avgIncome = recordedIncome > 0 ? recordedIncome : input.declaredMonthlyIncomeMinor;
  const avgExpense = average(months.map((m) => m.expenseMinor));
  const avgDebtRepay = average(months.map((m) => m.debtRepaymentMinor));

  // 1. Savings
  let savings: HealthComponent;
  {
    const hasData = avgIncome > 0 || avgExpense > 0;
    const rate = avgIncome > 0 ? (avgIncome - avgExpense - avgDebtRepay) / avgIncome : 0;
    const rateScore = clamp((rate / 0.2) * 12, 0, 12);
    const monthlyNeed = avgExpense + avgDebtRepay;
    const efMonths = monthlyNeed > 0 ? input.liquidAssetsMinor / monthlyNeed : input.liquidAssetsMinor > 0 ? 3 : 0;
    const efScore = clamp((efMonths / 3) * 8, 0, 8);
    const score = hasData ? round1(rateScore + efScore) : 8;
    savings = {
      key: 'savings',
      label: 'Savings',
      score,
      max: 20,
      hasData,
      explanation: hasData
        ? `You keep ${pct(Math.max(rate, -9.99))} of your income after expenses and debt payments (target 20%), and your liquid money covers ${round1(efMonths)} month(s) of spending (target 3 months).`
        : 'Not enough income and expense records yet — a neutral score is used.',
      tip:
        rate < 0.2
          ? 'Try to keep at least 20% of income unspent each month.'
          : efMonths < 3
            ? 'Build an emergency fund worth 3 months of expenses.'
            : null,
    };
  }

  // 2. Debt burden
  let debt: HealthComponent;
  {
    const hasDebt = input.monthlyDebtObligationMinor > 0 || input.debtOwedMinor > 0;
    const dti = avgIncome > 0 ? input.monthlyDebtObligationMinor / avgIncome : input.monthlyDebtObligationMinor > 0 ? 1 : 0;
    // 0–20% DTI = full marks, falls linearly to 0 at 60%.
    const dtiScore = dti <= 0.2 ? 14 : clamp(14 - ((dti - 0.2) / 0.4) * 14, 0, 14);
    const progress = input.debtOwedMinor > 0 ? input.debtRepaidMinor / input.debtOwedMinor : 1;
    const progScore = clamp(progress * 6, 0, 6);
    const score = hasDebt ? round1(dtiScore + progScore) : 20;
    debt = {
      key: 'debt',
      label: 'Debt burden',
      score,
      max: 20,
      hasData: true,
      explanation: hasDebt
        ? `Debt payments take ${pct(dti)} of your monthly income (healthy is under 20%, risky above 40%). You have repaid ${pct(progress)} of what you owe.`
        : 'You have no active debts — full marks.',
      tip: hasDebt && dti > 0.36 ? 'Avoid new borrowing and focus on paying down the most expensive debt first.' : null,
    };
  }

  // 3. Budget discipline
  let budget: HealthComponent;
  {
    const items = input.budgets.filter((b) => b.limitMinor > 0);
    const hasData = items.length > 0;
    let within = 0;
    for (const b of items) {
      const used = b.isCurrent ? Math.max(b.spentMinor, b.projectedMinor) : b.spentMinor;
      if (used <= b.limitMinor) within += 1;
      else if (!b.isCurrent || b.spentMinor <= b.limitMinor) within += Math.max(0, 1 - (used - b.limitMinor) / b.limitMinor);
    }
    const share = hasData ? within / items.length : 0;
    const score = hasData ? round1(share * 20) : 10;
    budget = {
      key: 'budget',
      label: 'Budget discipline',
      score,
      max: 20,
      hasData,
      explanation: hasData
        ? `${pct(share)} of your budget periods are within (or on track to stay within) their limits.`
        : 'You have no budgets yet — a neutral score is used.',
      tip: !hasData ? 'Create budgets for your biggest spending categories.' : share < 0.8 ? 'Review the budgets you keep exceeding and adjust spending or limits.' : null,
    };
  }

  // 4. Cash flow
  let cashflow: HealthComponent;
  {
    const nets = months.map((m) => m.incomeMinor - m.expenseMinor - m.debtRepaymentMinor);
    const hasData = nets.length >= 1;
    const positiveShare = hasData ? nets.filter((n) => n >= 0).length / nets.length : 0;
    let stabilityScore = 3;
    const expenses = months.map((m) => m.expenseMinor).filter((e) => e > 0);
    if (expenses.length >= 2) {
      const mean = average(expenses);
      const sd = Math.sqrt(average(expenses.map((e) => (e - mean) ** 2)));
      const cv = mean > 0 ? sd / mean : 0;
      stabilityScore = clamp(6 - ((cv - 0.25) / 1.0) * 6, 0, 6);
    }
    const score = hasData ? round1(positiveShare * 14 + stabilityScore) : 10;
    cashflow = {
      key: 'cashflow',
      label: 'Cash flow',
      score,
      max: 20,
      hasData,
      explanation: hasData
        ? `Money coming in exceeded money going out in ${nets.filter((n) => n >= 0).length} of the last ${nets.length} month(s), and your monthly spending is ${stabilityScore >= 4 ? 'stable' : stabilityScore >= 2 ? 'somewhat variable' : 'very variable'}.`
        : 'Record income and expenses to evaluate cash flow — a neutral score is used.',
      tip: positiveShare < 1 && hasData ? 'Aim to spend less than you earn every month.' : null,
    };
  }

  // 5. Payment consistency
  let payments: HealthComponent;
  {
    const hasData = input.installmentsDue > 0 || input.installmentsOverdueNow > 0;
    const onTime = input.installmentsDue > 0 ? input.installmentsOnTime / input.installmentsDue : 1;
    const score = hasData ? round1(clamp(onTime * 20 - input.installmentsOverdueNow * 4, 0, 20)) : 20;
    payments = {
      key: 'payments',
      label: 'Payment consistency',
      score,
      max: 20,
      hasData,
      explanation: hasData
        ? `${input.installmentsOnTime} of ${input.installmentsDue} debt payment(s) due recently were paid on time${input.installmentsOverdueNow ? `, and ${input.installmentsOverdueNow} payment(s) are overdue right now (−4 each)` : ''}.`
        : 'No debt payments have fallen due — full marks.',
      tip: input.installmentsOverdueNow > 0 ? 'Clear overdue payments first to avoid penalties.' : null,
    };
  }

  const components = [savings, debt, budget, cashflow, payments];
  const total = Math.round(components.reduce((s, c) => s + c.score, 0));
  return { total, grade: gradeFor(total), components };
}

export function gradeFor(total: number): HealthScore['grade'] {
  if (total >= 85) return 'Excellent';
  if (total >= 70) return 'Good';
  if (total >= 55) return 'Fair';
  if (total >= 40) return 'Needs attention';
  return 'Critical';
}

export interface HealthChange {
  key: HealthComponentKey;
  label: string;
  delta: number;
  text: string;
}

/** Explains the difference between two score snapshots. */
export function explainScoreChange(
  previous: { total: number; components: { key: HealthComponentKey; score: number }[] } | null,
  current: HealthScore,
): { delta: number; changes: HealthChange[] } {
  if (!previous) return { delta: 0, changes: [] };
  const changes: HealthChange[] = [];
  for (const c of current.components) {
    const prev = previous.components.find((p) => p.key === c.key);
    if (!prev) continue;
    const delta = round1(c.score - prev.score);
    if (Math.abs(delta) >= 0.5) {
      changes.push({
        key: c.key,
        label: c.label,
        delta,
        text: `${c.label} ${delta > 0 ? 'improved' : 'dropped'} by ${Math.abs(delta)} point${Math.abs(delta) === 1 ? '' : 's'}.`,
      });
    }
  }
  changes.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return { delta: current.total - previous.total, changes };
}
