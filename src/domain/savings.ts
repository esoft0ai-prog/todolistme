import { addDays, diffDays, today as todayFn } from './dates';
import type { ISODate, SavingsGoal } from './types';

export interface GoalContribution {
  date: ISODate;
  /** Positive for deposits, negative for withdrawals. */
  amountMinor: number;
}

export interface GoalProgress {
  savedMinor: number;
  remainingMinor: number;
  percent: number; // 0..1
  daysLeft: number | null;
  weeksLeft: number | null;
  monthsLeft: number | null;
  requiredWeeklyMinor: number | null;
  requiredMonthlyMinor: number | null;
  requiredDailyMinor: number | null;
  timeProgress: number | null; // share of time elapsed between start and deadline
  /** Average monthly net contribution over the last 90 days (or since start if shorter). */
  currentMonthlyRateMinor: number;
  onTrack: boolean | null; // null when no deadline
  projectedCompletionDate: ISODate | null;
  state: 'completed' | 'on_track' | 'behind' | 'overdue' | 'no_deadline' | 'not_started';
  message: string;
}

const DAYS_PER_MONTH = 30.436875;

export function goalProgress(
  goal: Pick<SavingsGoal, 'targetMinor' | 'initialMinor' | 'startDate' | 'deadline'>,
  contributions: GoalContribution[],
  ref: ISODate = todayFn(),
): GoalProgress {
  const saved = Math.max(0, goal.initialMinor + contributions.reduce((s, c) => s + c.amountMinor, 0));
  const target = Math.max(1, goal.targetMinor);
  const remaining = Math.max(0, target - saved);
  const percent = Math.min(1, saved / target);

  // Recent saving rate (last 90 days or since start).
  const windowStart = [addDays(ref, -89), goal.startDate].sort().reverse()[0];
  const windowDays = Math.max(1, diffDays(windowStart, ref) + 1);
  const recent = contributions.filter((c) => c.date >= windowStart && c.date <= ref).reduce((s, c) => s + c.amountMinor, 0);
  const monthlyRate = windowDays >= 7 ? Math.round((recent / windowDays) * DAYS_PER_MONTH) : Math.round(recent);

  let daysLeft: number | null = null;
  let requiredWeekly: number | null = null;
  let requiredMonthly: number | null = null;
  let requiredDaily: number | null = null;
  let timeProgress: number | null = null;
  let onTrack: boolean | null = null;

  if (goal.deadline) {
    daysLeft = diffDays(ref, goal.deadline);
    const total = Math.max(1, diffDays(goal.startDate, goal.deadline));
    timeProgress = Math.min(1, Math.max(0, diffDays(goal.startDate, ref) / total));
    if (daysLeft > 0) {
      requiredDaily = Math.ceil(remaining / daysLeft);
      requiredWeekly = Math.ceil(remaining / Math.max(1, daysLeft / 7));
      requiredMonthly = Math.ceil(remaining / Math.max(1, daysLeft / DAYS_PER_MONTH));
      // On track if the recent pace would reach the target by the deadline.
      onTrack = remaining === 0 || monthlyRate >= requiredMonthly;
    } else {
      requiredDaily = remaining;
      requiredWeekly = remaining;
      requiredMonthly = remaining;
      onTrack = remaining === 0;
    }
  }

  let projected: ISODate | null = null;
  if (remaining === 0) projected = ref;
  else if (monthlyRate > 0) projected = addDays(ref, Math.ceil((remaining / monthlyRate) * DAYS_PER_MONTH));

  let state: GoalProgress['state'];
  let message: string;
  if (remaining === 0) {
    state = 'completed';
    message = 'Goal reached — well done!';
  } else if (!goal.deadline) {
    state = 'no_deadline';
    message = monthlyRate > 0 ? 'Projected completion is based on your recent saving rate.' : 'Set a deadline to get a saving plan.';
  } else if (daysLeft! <= 0) {
    state = 'overdue';
    message = 'The deadline has passed. Extend it or top up the goal.';
  } else if (saved === 0 && contributions.length === 0) {
    state = 'not_started';
    message = 'Make your first deposit to start this goal.';
  } else if (onTrack) {
    state = 'on_track';
    message = 'Your current saving rate is enough to reach this goal on time.';
  } else {
    state = 'behind';
    message = 'Your current saving rate is not enough to reach this goal on time.';
  }

  return {
    savedMinor: saved,
    remainingMinor: remaining,
    percent,
    daysLeft,
    weeksLeft: daysLeft != null ? Math.max(0, daysLeft / 7) : null,
    monthsLeft: daysLeft != null ? Math.max(0, daysLeft / DAYS_PER_MONTH) : null,
    requiredWeeklyMinor: requiredWeekly,
    requiredMonthlyMinor: requiredMonthly,
    requiredDailyMinor: requiredDaily,
    timeProgress,
    currentMonthlyRateMinor: monthlyRate,
    onTrack,
    projectedCompletionDate: projected,
    state,
    message,
  };
}

export function validateGoal(g: Partial<SavingsGoal>, ref: ISODate = todayFn()): { field: string; message: string }[] {
  const errors: { field: string; message: string }[] = [];
  if (!g.name || !g.name.trim()) errors.push({ field: 'name', message: 'Goal name is required' });
  if (!(Number(g.targetMinor) > 0)) errors.push({ field: 'targetMinor', message: 'Savings target must be greater than zero' });
  if ((g.initialMinor ?? 0) < 0) errors.push({ field: 'initialMinor', message: 'Amount saved cannot be negative' });
  if (g.deadline && g.startDate && g.deadline <= g.startDate) {
    errors.push({ field: 'deadline', message: 'Deadline must be after the start date' });
  }
  if (g.deadline && !g.id && g.deadline < ref) {
    errors.push({ field: 'deadline', message: 'Deadline cannot be in the past' });
  }
  return errors;
}
