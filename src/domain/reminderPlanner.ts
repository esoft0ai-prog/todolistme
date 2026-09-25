import { addDays, diffDays, formatDate, toLocalDateTime } from './dates';
import type { DebtSummary } from './debt';
import { formatMoney } from './money';
import { occurrencesBetween } from './recurrence';
import type { GoalProgress } from './savings';
import type {
  Debt,
  FinancialEvent,
  ISODate,
  NotificationChannel,
  Preferences,
  RecurringTransaction,
  Reminder,
  SavingsGoal,
} from './types';

/**
 * Pure notification planner. Given the current data it returns the complete set of
 * local notifications that *should* be scheduled. The notification service diffs
 * this plan against what is already scheduled with the OS (by stable key + content
 * hash), so the plan can be recomputed after every change, on every app start and
 * after a restore without creating duplicates.
 */

export interface PlannedNotification {
  key: string;
  channel: NotificationChannel;
  title: string;
  body: string;
  fireAt: Date;
  entityType: string | null;
  entityId: string | null;
}

export interface PlannerInput {
  now: Date;
  today: ISODate;
  prefs: Pick<Preferences, 'notificationsEnabled' | 'notificationChannels' | 'reminderTime' | 'defaultDebtReminderOffsets' | 'baseCurrency'>;
  debts: { debt: Debt; summary: DebtSummary }[];
  debtReminders: Reminder[]; // kind = 'debt'
  customReminders: Reminder[]; // kind = 'custom'
  bills: RecurringTransaction[];
  goals: { goal: SavingsGoal; progress: GoalProgress }[];
  events: FinancialEvent[];
  currencyOf?: (accountId: string) => string;
}

export const PLAN_HORIZON_DAYS = 120;
/** Android allows ~500 alarms per app; stay well below. */
export const MAX_SCHEDULED = 200;
export const OVERDUE_OFFSETS = [1, 3, 7, 14, 30];

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function hashContent(n: Pick<PlannedNotification, 'title' | 'body' | 'fireAt' | 'channel'>): string {
  const s = `${n.channel}|${n.title}|${n.body}|${n.fireAt.getTime()}`;
  // djb2 — small stable hash; collisions are harmless (worst case a re-schedule).
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function planNotifications(input: PlannerInput): PlannedNotification[] {
  const { prefs, now, today } = input;
  if (!prefs.notificationsEnabled) return [];
  const horizonEnd = addDays(today, PLAN_HORIZON_DAYS);
  const time = prefs.reminderTime || '09:00';
  const out: PlannedNotification[] = [];
  const push = (n: PlannedNotification) => {
    if (!prefs.notificationChannels[n.channel]) return;
    if (n.fireAt.getTime() <= now.getTime() + 5_000) return; // never schedule in the past
    out.push(n);
  };

  // ---------------------------------------------------------------- Debts
  for (const { debt, summary } of input.debts) {
    if (debt.status !== 'active' || summary.isPaidOff) continue;
    const custom = input.debtReminders.filter((r) => r.entityId === debt.id);
    const offsets = custom.length
      ? custom.filter((r) => r.enabled && r.offsetDays != null).map((r) => ({ days: r.offsetDays!, time: r.timeOfDay || time }))
      : prefs.defaultDebtReminderOffsets.map((d) => ({ days: d, time }));
    const unpaid = summary.installments.filter((i) => i.status !== 'paid');
    const lastIndex = summary.installments.length - 1;

    for (const inst of unpaid) {
      if (inst.dueDate > horizonEnd) break;
      const due = inst.amountMinor - inst.paidMinor;
      const amount = formatMoney(due, debt.currency);
      const isFinal = inst.index === lastIndex;
      const prefix = isFinal ? 'Final payment' : 'Loan payment reminder';
      for (const off of offsets) {
        const date = addDays(inst.dueDate, -off.days);
        const when = off.days === 0 ? 'today' : off.days === 1 ? 'tomorrow' : `in ${plural(off.days, 'day')} (${formatDate(inst.dueDate, 'short')})`;
        push({
          key: `debt:${debt.id}:${inst.dueDate}:before:${off.days}`,
          channel: 'debts',
          title: off.days === 0 ? `${prefix}: due today` : `${prefix}`,
          body: `${amount} payment to ${debt.lenderName} is due ${when}.${isFinal ? ' This is your final payment!' : ''}`,
          fireAt: toLocalDateTime(date, off.time),
          entityType: 'debt',
          entityId: debt.id,
        });
      }
      // Overdue follow-ups are pre-scheduled; paying the instalment removes them on the next sync.
      for (const o of OVERDUE_OFFSETS) {
        const date = addDays(inst.dueDate, o);
        if (date > horizonEnd) break;
        push({
          key: `debt:${debt.id}:${inst.dueDate}:overdue:${o}`,
          channel: 'debts',
          title: 'Payment overdue',
          body: `${amount} payment to ${debt.lenderName} is overdue by ${plural(diffDays(inst.dueDate, date), 'day')}.`,
          fireAt: toLocalDateTime(date, time),
          entityType: 'debt',
          entityId: debt.id,
        });
      }
    }
  }

  // ---------------------------------------------------------------- Bills (recurring)
  for (const bill of input.bills) {
    if (!bill.active || bill.remindDaysBefore < 0) continue;
    const from = addDays(today, 0);
    const occ = occurrencesBetween(bill, from, addDays(horizonEnd, bill.remindDaysBefore), 60);
    const cur = input.currencyOf ? input.currencyOf(bill.accountId) : prefs.baseCurrency;
    for (const d of occ) {
      const fire = addDays(d, -bill.remindDaysBefore);
      const when = bill.remindDaysBefore === 0 ? 'today' : bill.remindDaysBefore === 1 ? 'tomorrow' : `on ${formatDate(d, 'short')}`;
      const verb = bill.type === 'income' ? 'is expected' : 'is due';
      push({
        key: `bill:${bill.id}:${d}`,
        channel: 'bills',
        title: bill.type === 'income' ? 'Expected income' : 'Bill reminder',
        body: `${bill.description || 'Recurring payment'} (${formatMoney(bill.amountMinor, cur)}) ${verb} ${when}.`,
        fireAt: toLocalDateTime(fire, time),
        entityType: 'recurring',
        entityId: bill.id,
      });
    }
  }

  // ---------------------------------------------------------------- Savings goals
  for (const { goal, progress } of input.goals) {
    if (goal.status !== 'active' || goal.reminderFrequency === 'none' || progress.remainingMinor <= 0) continue;
    const rule = {
      frequency: goal.reminderFrequency === 'weekly' ? ('weekly' as const) : ('monthly' as const),
      interval: 1,
      unit: 'month' as const,
      startDate: goal.startDate,
      endDate: goal.deadline,
    };
    const amount =
      goal.reminderFrequency === 'weekly' ? progress.requiredWeeklyMinor : progress.requiredMonthlyMinor;
    for (const d of occurrencesBetween(rule, addDays(today, 1), horizonEnd, 20)) {
      push({
        key: `goal:${goal.id}:${d}`,
        channel: 'savings',
        title: `Savings reminder: ${goal.name}`,
        body: amount
          ? `Put aside ${formatMoney(amount, goal.currency)} this ${goal.reminderFrequency === 'weekly' ? 'week' : 'month'} to stay on track (${Math.round(progress.percent * 100)}% saved).`
          : `Keep going — you have saved ${Math.round(progress.percent * 100)}% of your target.`,
        fireAt: toLocalDateTime(d, time),
        entityType: 'goal',
        entityId: goal.id,
      });
    }
    if (goal.deadline && goal.deadline > today) {
      const d = addDays(goal.deadline, -7);
      if (d > today) {
        push({
          key: `goal:${goal.id}:deadline`,
          channel: 'savings',
          title: `Goal deadline in 7 days`,
          body: `${goal.name}: ${formatMoney(progress.remainingMinor, goal.currency)} still to save before ${formatDate(goal.deadline)}.`,
          fireAt: toLocalDateTime(d, time),
          entityType: 'goal',
          entityId: goal.id,
        });
      }
    }
  }

  // ---------------------------------------------------------------- Custom reminders
  for (const r of input.customReminders) {
    if (!r.enabled || !r.date) continue;
    const dates =
      r.repeat === 'none'
        ? r.date >= today && r.date <= horizonEnd
          ? [r.date]
          : []
        : occurrencesBetween({ frequency: r.repeat, interval: 1, unit: 'month', startDate: r.date, endDate: null }, today, horizonEnd, 60);
    for (const d of dates) {
      push({
        key: `custom:${r.id}:${d}`,
        channel: 'reminders',
        title: r.title,
        body: r.message || 'Reminder from Finora',
        fireAt: toLocalDateTime(d, r.timeOfDay || time),
        entityType: 'reminder',
        entityId: r.id,
      });
    }
  }

  // ---------------------------------------------------------------- Calendar events
  for (const e of input.events) {
    if (!e.remind || e.date < today || e.date > horizonEnd) continue;
    const amount = e.amountMinor ? ` (${formatMoney(e.amountMinor, prefs.baseCurrency)})` : '';
    if (e.kind === 'bill') {
      const before = addDays(e.date, -1);
      push({
        key: `event:${e.id}:before`,
        channel: 'bills',
        title: 'Bill due tomorrow',
        body: `${e.title}${amount} is due tomorrow.`,
        fireAt: toLocalDateTime(before, time),
        entityType: 'event',
        entityId: e.id,
      });
    }
    push({
      key: `event:${e.id}:on`,
      channel: e.kind === 'bill' ? 'bills' : 'reminders',
      title: e.kind === 'bill' ? 'Bill due today' : e.kind === 'income' ? 'Expected income today' : e.title,
      body: `${e.title}${amount}${e.kind === 'bill' ? ' is due today.' : ''}`,
      fireAt: toLocalDateTime(e.date, time),
      entityType: 'event',
      entityId: e.id,
    });
  }

  // ---------------------------------------------------------------- Backup nudge (offline-first safety)
  const monthStart = nextMonthFirst(today);
  push({
    key: `general:backup:${monthStart}`,
    channel: 'general',
    title: 'Back up your finances',
    body: 'Finora stores everything on this phone only. Export a backup now and keep it somewhere safe.',
    fireAt: toLocalDateTime(monthStart, time),
    entityType: null,
    entityId: null,
  });

  out.sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime());
  // De-duplicate keys (defensive) and cap.
  const seen = new Set<string>();
  const unique = out.filter((n) => (seen.has(n.key) ? false : (seen.add(n.key), true)));
  return unique.slice(0, MAX_SCHEDULED);
}

function nextMonthFirst(d: ISODate): ISODate {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

export interface ScheduledEntry {
  key: string;
  hash: string;
  osId: string;
}

/** Diff between desired plan and what is currently scheduled. */
export function diffSchedule(
  plan: PlannedNotification[],
  scheduled: ScheduledEntry[],
): { toCancel: ScheduledEntry[]; toSchedule: PlannedNotification[]; unchanged: number } {
  const desired = new Map(plan.map((p) => [p.key, p]));
  const toCancel: ScheduledEntry[] = [];
  const keep = new Set<string>();
  for (const s of scheduled) {
    const p = desired.get(s.key);
    if (p && hashContent(p) === s.hash && !keep.has(s.key)) keep.add(s.key);
    else toCancel.push(s);
  }
  const toSchedule = plan.filter((p) => !keep.has(p.key));
  return { toCancel, toSchedule, unchanged: keep.size };
}
