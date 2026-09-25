import { addDays, addMonths, daysInRange, diffDays, endOfMonth, startOfWeek, today as todayFn, type DateRange } from './dates';
import type { Budget, ISODate } from './types';

/**
 * Budget calculations: current period resolution, spending pace, and early
 * "you will run out in N days" warnings. All computed locally.
 */

export interface BudgetStatus {
  range: DateRange;
  limitMinor: number;
  spentMinor: number;
  remainingMinor: number;
  percentUsed: number; // 0..∞
  totalDays: number;
  daysElapsed: number; // including today
  daysRemaining: number; // after today
  dailyPaceMinor: number; // actual average spend per elapsed day
  safeDailyMinor: number; // what can be spent per remaining day
  projectedSpendMinor: number;
  daysUntilExceeded: number | null; // null when not expected to exceed
  state: 'ok' | 'warning' | 'at_risk' | 'exceeded' | 'upcoming' | 'ended';
  message: string;
}

/** Resolves the budget period containing `ref`. */
export function budgetPeriodRange(budget: Pick<Budget, 'period' | 'startDate' | 'endDate'>, ref: ISODate = todayFn(), weekStartsOn: 0 | 1 = 1): DateRange {
  if (budget.period === 'custom') {
    return { start: budget.startDate, end: budget.endDate ?? budget.startDate };
  }
  if (budget.period === 'weekly') {
    // Weekly budgets follow the anchor's weekday if set, otherwise the preferred week start.
    const anchor = budget.startDate;
    if (anchor && anchor <= ref) {
      const diff = diffDays(anchor, ref);
      const start = addDays(anchor, Math.floor(diff / 7) * 7);
      return { start, end: addDays(start, 6) };
    }
    const start = startOfWeek(ref, weekStartsOn);
    return { start, end: addDays(start, 6) };
  }
  // Monthly: period starts on the anchor's day of month (e.g. salary day 25th).
  const anchorDay = budget.startDate ? Number(budget.startDate.slice(8, 10)) : 1;
  if (anchorDay <= 1) {
    const start = `${ref.slice(0, 7)}-01`;
    return { start, end: endOfMonth(start) };
  }
  let start = addMonths(`${ref.slice(0, 7)}-01`, 0, anchorDay);
  if (start > ref) start = addMonths(start, -1, anchorDay);
  const end = addDays(addMonths(start, 1, anchorDay), -1);
  return { start, end };
}

export function computeBudgetStatus(
  limitMinor: number,
  spentMinor: number,
  range: DateRange,
  ref: ISODate = todayFn(),
  alertThreshold = 0.8,
): BudgetStatus {
  const totalDays = daysInRange(range.start, range.end);
  const remainingMinor = limitMinor - spentMinor;
  const percentUsed = limitMinor > 0 ? spentMinor / limitMinor : 0;
  const base = { range, limitMinor, spentMinor, remainingMinor, percentUsed, totalDays };

  if (ref < range.start) {
    return {
      ...base,
      daysElapsed: 0,
      daysRemaining: totalDays,
      dailyPaceMinor: 0,
      safeDailyMinor: Math.round(limitMinor / totalDays),
      projectedSpendMinor: spentMinor,
      daysUntilExceeded: null,
      state: 'upcoming',
      message: 'This budget has not started yet.',
    };
  }
  if (ref > range.end) {
    const exceeded = spentMinor > limitMinor;
    return {
      ...base,
      daysElapsed: totalDays,
      daysRemaining: 0,
      dailyPaceMinor: Math.round(spentMinor / totalDays),
      safeDailyMinor: 0,
      projectedSpendMinor: spentMinor,
      daysUntilExceeded: null,
      state: exceeded ? 'exceeded' : 'ended',
      message: exceeded ? 'This budget period ended over the limit.' : 'This budget period ended within the limit.',
    };
  }

  const daysElapsed = diffDays(range.start, ref) + 1;
  const daysRemaining = totalDays - daysElapsed;
  const dailyPace = spentMinor / daysElapsed;
  const projected = Math.round(dailyPace * totalDays);
  const safeDaily = daysRemaining > 0 ? Math.max(0, Math.floor(remainingMinor / daysRemaining)) : Math.max(0, remainingMinor);

  let daysUntilExceeded: number | null = null;
  let state: BudgetStatus['state'] = 'ok';
  let message: string;

  if (spentMinor > limitMinor) {
    state = 'exceeded';
    message = 'You have exceeded this budget.';
  } else if (projected > limitMinor && dailyPace > 0) {
    daysUntilExceeded = Math.max(0, Math.ceil(remainingMinor / dailyPace));
    state = 'at_risk';
    message =
      daysUntilExceeded === 0
        ? 'At your current spending rate, this budget will be exceeded today.'
        : `At your current spending rate, this budget may be exceeded in approximately ${daysUntilExceeded} day${daysUntilExceeded === 1 ? '' : 's'}.`;
  } else if (percentUsed >= alertThreshold) {
    state = 'warning';
    message = `You have used ${Math.round(percentUsed * 100)}% of this budget.`;
  } else {
    message = spentMinor === 0 ? 'No spending yet in this period.' : 'On track.';
  }

  return {
    ...base,
    daysElapsed,
    daysRemaining,
    dailyPaceMinor: Math.round(dailyPace),
    safeDailyMinor: safeDaily,
    projectedSpendMinor: projected,
    daysUntilExceeded,
    state,
    message,
  };
}

export function validateBudget(b: Partial<Budget>): { field: string; message: string }[] {
  const errors: { field: string; message: string }[] = [];
  if (!b.name || !b.name.trim()) errors.push({ field: 'name', message: 'Name is required' });
  if (!(Number(b.limitMinor) > 0)) errors.push({ field: 'limitMinor', message: 'Budget limit must be greater than zero' });
  if (!b.startDate) errors.push({ field: 'startDate', message: 'Start date is required' });
  if (b.period === 'custom') {
    if (!b.endDate) errors.push({ field: 'endDate', message: 'End date is required for a custom budget' });
    else if (b.startDate && b.endDate < b.startDate) errors.push({ field: 'endDate', message: 'End date must be after the start date' });
  }
  if (b.alertThreshold != null && (b.alertThreshold <= 0 || b.alertThreshold > 1)) {
    errors.push({ field: 'alertThreshold', message: 'Alert threshold must be between 1% and 100%' });
  }
  return errors;
}

/** Previous period for adherence history. */
export function previousBudgetRange(budget: Pick<Budget, 'period' | 'startDate' | 'endDate'>, current: DateRange, weekStartsOn: 0 | 1 = 1): DateRange | null {
  if (budget.period === 'custom') return null;
  return budgetPeriodRange(budget, addDays(current.start, -1), weekStartsOn);
}
