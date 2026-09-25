import { computeHealthScore, explainScoreChange, gradeFor, type HealthInputs } from '../health';

const base: HealthInputs = {
  months: [
    { key: '2026-01', incomeMinor: 50_000_000, expenseMinor: 35_000_000, debtRepaymentMinor: 5_000_000 },
    { key: '2026-02', incomeMinor: 50_000_000, expenseMinor: 36_000_000, debtRepaymentMinor: 5_000_000 },
    { key: '2026-03', incomeMinor: 50_000_000, expenseMinor: 34_000_000, debtRepaymentMinor: 5_000_000 },
  ],
  liquidAssetsMinor: 60_000_000,
  monthlyDebtObligationMinor: 5_000_000,
  declaredMonthlyIncomeMinor: 0,
  debtOwedMinor: 30_000_000,
  debtRepaidMinor: 15_000_000,
  budgets: [
    { limitMinor: 100, spentMinor: 90, projectedMinor: 90, isCurrent: false },
    { limitMinor: 100, spentMinor: 120, projectedMinor: 120, isCurrent: false },
  ],
  installmentsDue: 4,
  installmentsOnTime: 3,
  installmentsOverdueNow: 0,
};

describe('financial health score', () => {
  it('is the sum of five transparent components', () => {
    const h = computeHealthScore(base);
    expect(h.components.map((c) => c.key)).toEqual(['savings', 'debt', 'budget', 'cashflow', 'payments']);
    expect(h.components.every((c) => c.max === 20 && c.score >= 0 && c.score <= 20)).toBe(true);
    expect(h.total).toBe(Math.round(h.components.reduce((s, c) => s + c.score, 0)));
    expect(h.components.every((c) => c.explanation.length > 10)).toBe(true);
  });

  it('scores each component from its inputs', () => {
    const h = computeHealthScore(base);
    const by = Object.fromEntries(h.components.map((c) => [c.key, c.score]));
    // savings rate = (50-35-5)/50 = 20% → 12 pts; emergency fund = 60/(35+5)=1.5 months → 4 pts
    expect(by.savings).toBe(16);
    // DTI 10% → 14 pts; progress 50% → 3 pts
    expect(by.debt).toBe(17);
    // 1 of 2 budgets within, the other 20% over → 1 + 0.8 = 1.8/2 → 18
    expect(by.budget).toBe(18);
    // 3/3 months positive → 14, spending very stable → 6
    expect(by.cashflow).toBe(20);
    // 3 of 4 on time → 15
    expect(by.payments).toBe(15);
    expect(h.total).toBe(86);
    expect(h.grade).toBe('Excellent');
  });

  it('uses neutral scores when there is no data', () => {
    const h = computeHealthScore({
      months: [],
      liquidAssetsMinor: 0,
      monthlyDebtObligationMinor: 0,
      declaredMonthlyIncomeMinor: 0,
      debtOwedMinor: 0,
      debtRepaidMinor: 0,
      budgets: [],
      installmentsDue: 0,
      installmentsOnTime: 0,
      installmentsOverdueNow: 0,
    });
    expect(h.total).toBe(8 + 20 + 10 + 10 + 20);
    expect(h.components.find((c) => c.key === 'budget')!.hasData).toBe(false);
  });

  it('penalises heavy debt and overdue payments', () => {
    const h = computeHealthScore({ ...base, monthlyDebtObligationMinor: 30_000_000, installmentsOverdueNow: 2 });
    const by = Object.fromEntries(h.components.map((c) => [c.key, c.score]));
    expect(by.debt).toBeLessThan(5);
    expect(by.payments).toBe(7);
  });

  it('explains changes between snapshots', () => {
    const before = computeHealthScore(base);
    const after = computeHealthScore({ ...base, installmentsOverdueNow: 1 });
    const change = explainScoreChange(
      { total: before.total, components: before.components.map((c) => ({ key: c.key, score: c.score })) },
      after,
    );
    expect(change.delta).toBe(after.total - before.total);
    expect(change.changes[0]).toMatchObject({ key: 'payments', delta: -4 });
    expect(change.changes[0].text).toBe('Payment consistency dropped by 4 points.');
    expect(explainScoreChange(null, after)).toEqual({ delta: 0, changes: [] });
  });

  it('grades scores', () => {
    expect(gradeFor(90)).toBe('Excellent');
    expect(gradeFor(72)).toBe('Good');
    expect(gradeFor(60)).toBe('Fair');
    expect(gradeFor(45)).toBe('Needs attention');
    expect(gradeFor(10)).toBe('Critical');
  });
});
