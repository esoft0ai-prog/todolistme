import { budgetPeriodRange, computeBudgetStatus, validateBudget } from '../budget';
import { goalProgress, validateGoal } from '../savings';

describe('budget periods', () => {
  it('resolves calendar monthly budgets', () => {
    expect(budgetPeriodRange({ period: 'monthly', startDate: '2026-01-01', endDate: null }, '2026-03-15')).toEqual({ start: '2026-03-01', end: '2026-03-31' });
  });

  it('resolves salary-day anchored monthly budgets', () => {
    const b = { period: 'monthly' as const, startDate: '2026-01-25', endDate: null };
    expect(budgetPeriodRange(b, '2026-03-15')).toEqual({ start: '2026-02-25', end: '2026-03-24' });
    expect(budgetPeriodRange(b, '2026-03-25')).toEqual({ start: '2026-03-25', end: '2026-04-24' });
  });

  it('resolves weekly budgets from their anchor weekday', () => {
    const b = { period: 'weekly' as const, startDate: '2026-01-05', endDate: null }; // Monday
    expect(budgetPeriodRange(b, '2026-01-21')).toEqual({ start: '2026-01-19', end: '2026-01-25' });
  });

  it('resolves custom budgets', () => {
    expect(budgetPeriodRange({ period: 'custom', startDate: '2026-12-01', endDate: '2026-12-31' }, '2026-03-01')).toEqual({ start: '2026-12-01', end: '2026-12-31' });
  });
});

describe('budget status & pace warnings', () => {
  const range = { start: '2026-03-01', end: '2026-03-30' }; // 30 days

  it('warns early when pace will exceed the limit', () => {
    // ₦50,000 food budget, ₦25,000 spent in 10 days → ₦2,500/day → exceeds in 10 more days
    const s = computeBudgetStatus(5_000_000, 2_500_000, range, '2026-03-10');
    expect(s.state).toBe('at_risk');
    expect(s.daysUntilExceeded).toBe(10);
    expect(s.message).toBe('At your current spending rate, this budget may be exceeded in approximately 10 days.');
    expect(s.projectedSpendMinor).toBe(7_500_000);
    expect(s.daysRemaining).toBe(20);
    expect(s.safeDailyMinor).toBe(125_000);
  });

  it('reports on-track, threshold warning and exceeded states', () => {
    expect(computeBudgetStatus(5_000_000, 1_000_000, range, '2026-03-15').state).toBe('ok');
    expect(computeBudgetStatus(5_000_000, 4_100_000, range, '2026-03-28').state).toBe('warning');
    const over = computeBudgetStatus(5_000_000, 5_000_001, range, '2026-03-28');
    expect(over.state).toBe('exceeded');
    expect(over.remainingMinor).toBe(-1);
  });

  it('handles periods that have not started or have ended', () => {
    expect(computeBudgetStatus(100, 0, range, '2026-02-01').state).toBe('upcoming');
    expect(computeBudgetStatus(100, 50, range, '2026-04-01').state).toBe('ended');
    expect(computeBudgetStatus(100, 150, range, '2026-04-01').state).toBe('exceeded');
  });

  it('validates budgets', () => {
    expect(validateBudget({ name: 'Food', limitMinor: 0, startDate: '2026-01-01', period: 'monthly' })[0].field).toBe('limitMinor');
    expect(validateBudget({ name: 'Trip', limitMinor: 10, startDate: '2026-02-01', endDate: '2026-01-01', period: 'custom' })[0].field).toBe('endDate');
    expect(validateBudget({ name: 'Food', limitMinor: 10, startDate: '2026-01-01', period: 'monthly', alertThreshold: 0.8 })).toEqual([]);
  });
});

describe('savings goals', () => {
  const goal = { targetMinor: 80_000_000, initialMinor: 25_000_000, startDate: '2026-01-01', deadline: '2026-12-20' };

  it('computes progress and required saving', () => {
    const p = goalProgress(goal, [], '2026-06-20');
    expect(p.savedMinor).toBe(25_000_000);
    expect(p.remainingMinor).toBe(55_000_000);
    expect(p.percent).toBeCloseTo(0.3125);
    expect(p.daysLeft).toBe(183);
    expect(p.requiredMonthlyMinor).toBe(Math.ceil(55_000_000 / (183 / 30.436875)));
    expect(p.requiredWeeklyMinor).toBe(Math.ceil(55_000_000 / (183 / 7)));
    expect(p.timeProgress).toBeGreaterThan(0.48);
  });

  it('decides whether the current saving rate is sufficient', () => {
    const slow = goalProgress(goal, [{ date: '2026-06-01', amountMinor: 1_000_000 }], '2026-06-20');
    expect(slow.onTrack).toBe(false);
    expect(slow.state).toBe('behind');
    const contributions = [
      { date: '2026-04-01', amountMinor: 10_000_000 },
      { date: '2026-05-01', amountMinor: 10_000_000 },
      { date: '2026-06-01', amountMinor: 10_000_000 },
    ];
    const fast = goalProgress(goal, contributions, '2026-06-20');
    expect(fast.onTrack).toBe(true);
    expect(fast.state).toBe('on_track');
    expect(fast.projectedCompletionDate).not.toBeNull();
  });

  it('handles completion, withdrawals and no deadline', () => {
    expect(goalProgress(goal, [{ date: '2026-02-01', amountMinor: 60_000_000 }], '2026-03-01').state).toBe('completed');
    const w = goalProgress(goal, [{ date: '2026-02-01', amountMinor: -30_000_000 }], '2026-03-01');
    expect(w.savedMinor).toBe(0);
    expect(goalProgress({ ...goal, deadline: null }, [], '2026-03-01').state).toBe('no_deadline');
    expect(goalProgress(goal, [], '2027-01-01').state).toBe('overdue');
  });

  it('validates goals', () => {
    expect(validateGoal({ name: 'Laptop', targetMinor: 0, startDate: '2026-01-01' })[0].message).toBe('Savings target must be greater than zero');
    expect(validateGoal({ name: 'Laptop', targetMinor: 1, startDate: '2026-01-01', deadline: '2025-01-01' }, '2026-01-01').length).toBeGreaterThan(0);
  });
});
