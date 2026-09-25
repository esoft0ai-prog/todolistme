import { summarizeDebt } from '../debt';
import { diffSchedule, hashContent, planNotifications, type PlannerInput } from '../reminderPlanner';
import { goalProgress } from '../savings';
import type { Preferences, RecurringTransaction, Reminder, SavingsGoal } from '../types';
import { makeDebt } from './debt.test';

const prefs: PlannerInput['prefs'] = {
  notificationsEnabled: true,
  notificationChannels: { debts: true, bills: true, budgets: true, savings: true, reminders: true, general: true } as Preferences['notificationChannels'],
  reminderTime: '09:00',
  defaultDebtReminderOffsets: [3, 1, 0],
  baseCurrency: 'NGN',
};

function input(p: Partial<PlannerInput> = {}): PlannerInput {
  return {
    now: new Date(2026, 0, 15, 12, 0),
    today: '2026-01-15',
    prefs,
    debts: [],
    debtReminders: [],
    customReminders: [],
    bills: [],
    goals: [],
    events: [],
    ...p,
  };
}

describe('notification planner', () => {
  it('plans before-due, on-due and overdue reminders for a debt', () => {
    const debt = makeDebt({ installmentCount: 1, paymentFrequency: 'one_time', firstDueDate: '2026-01-20', principalMinor: 2_500_000 });
    const plan = planNotifications(input({ debts: [{ debt, summary: summarizeDebt(debt, [], [], '2026-01-15') }] }));
    const debtPlan = plan.filter((n) => n.channel === 'debts');
    const keys = debtPlan.map((n) => n.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'debt:d1:2026-01-20:before:3',
        'debt:d1:2026-01-20:before:1',
        'debt:d1:2026-01-20:before:0',
        'debt:d1:2026-01-20:overdue:1',
        'debt:d1:2026-01-20:overdue:3',
      ]),
    );
    const tomorrow = debtPlan.find((n) => n.key.endsWith('before:1'))!;
    expect(tomorrow.body).toBe('₦25,000 payment to QuickCash is due tomorrow. This is your final payment!');
    expect(tomorrow.title).toBe('Final payment');
    expect(tomorrow.fireAt).toEqual(new Date(2026, 0, 19, 9, 0));
    const overdue = debtPlan.find((n) => n.key.endsWith('overdue:3'))!;
    expect(overdue.body).toBe('₦25,000 payment to QuickCash is overdue by 3 days.');
  });

  it('does not schedule anything in the past, for paid-off debts, or when disabled', () => {
    const debt = makeDebt({ installmentCount: 1, paymentFrequency: 'one_time', firstDueDate: '2026-01-15' });
    const plan = planNotifications(input({ debts: [{ debt, summary: summarizeDebt(debt, [], [], '2026-01-15') }] }));
    expect(plan.every((n) => n.fireAt.getTime() > new Date(2026, 0, 15, 12, 0).getTime())).toBe(true);
    expect(plan.find((n) => n.key.endsWith('before:0'))).toBeUndefined(); // 09:00 today already passed

    const paid = makeDebt({ status: 'paid_off' });
    expect(planNotifications(input({ debts: [{ debt: paid, summary: summarizeDebt(paid, [], []) }] })).filter((n) => n.channel === 'debts')).toEqual([]);
    expect(planNotifications(input({ prefs: { ...prefs, notificationsEnabled: false } }))).toEqual([]);
  });

  it('respects per-debt custom reminder offsets and channel toggles', () => {
    const debt = makeDebt({ installmentCount: 1, paymentFrequency: 'one_time', firstDueDate: '2026-02-20' });
    const r: Reminder = {
      id: 'r1', kind: 'debt', entityId: 'd1', title: 't', message: '', offsetDays: 14, date: null, timeOfDay: '18:30',
      repeat: 'none', enabled: true, isDemo: false, createdAt: '', updatedAt: '',
    };
    const plan = planNotifications(input({ debts: [{ debt, summary: summarizeDebt(debt, [], [], '2026-01-15') }], debtReminders: [r] }));
    const before = plan.filter((n) => n.key.includes(':before:'));
    expect(before.map((n) => n.key)).toEqual(['debt:d1:2026-02-20:before:14']);
    expect(before[0].fireAt).toEqual(new Date(2026, 1, 6, 18, 30));

    const off = planNotifications(input({ prefs: { ...prefs, notificationChannels: { ...prefs.notificationChannels, debts: false } }, debts: [{ debt, summary: summarizeDebt(debt, [], []) }] }));
    expect(off.some((n) => n.channel === 'debts')).toBe(false);
  });

  it('plans bills, savings, custom reminders and a monthly backup nudge', () => {
    const bill: RecurringTransaction = {
      id: 'b1', type: 'expense', amountMinor: 1_500_000, accountId: 'a1', toAccountId: null, categoryId: null, debtId: null, goalId: null,
      description: 'Internet', paymentMethod: null, isBill: true, autoCreate: false, remindDaysBefore: 1, lastGeneratedDate: null, active: true,
      frequency: 'monthly', interval: 1, unit: 'month', startDate: '2026-01-20', endDate: null, isDemo: false, createdAt: '', updatedAt: '',
    };
    const goal: SavingsGoal = {
      id: 'g1', name: 'Laptop', targetMinor: 80_000_000, currency: 'NGN', initialMinor: 0, startDate: '2026-01-01', deadline: '2026-12-20',
      linkedAccountId: null, icon: 'laptop', color: '#fff', reminderFrequency: 'monthly', status: 'active', notes: null, isDemo: false, createdAt: '', updatedAt: '',
    };
    const custom: Reminder = {
      id: 'c1', kind: 'custom', entityId: null, title: 'Pay dues', message: 'Estate dues', offsetDays: null, date: '2026-01-16', timeOfDay: '07:00',
      repeat: 'weekly', enabled: true, isDemo: false, createdAt: '', updatedAt: '',
    };
    const plan = planNotifications(input({ bills: [bill], goals: [{ goal, progress: goalProgress(goal, [], '2026-01-15') }], customReminders: [custom] }));
    const billN = plan.find((n) => n.key === 'bill:b1:2026-01-20')!;
    expect(billN.body).toBe('Internet (₦15,000) is due tomorrow.');
    expect(billN.fireAt).toEqual(new Date(2026, 0, 19, 9, 0));
    expect(plan.some((n) => n.key === 'goal:g1:2026-02-01')).toBe(true);
    expect(plan.filter((n) => n.key.startsWith('custom:c1:')).length).toBeGreaterThan(10);
    expect(plan.some((n) => n.key === 'general:backup:2026-02-01')).toBe(true);
    // Sorted by time
    for (let i = 1; i < plan.length; i++) expect(plan[i].fireAt.getTime()).toBeGreaterThanOrEqual(plan[i - 1].fireAt.getTime());
  });

  it('diffs a plan against scheduled notifications', () => {
    const debt = makeDebt({ installmentCount: 1, paymentFrequency: 'one_time', firstDueDate: '2026-01-20' });
    const plan = planNotifications(input({ debts: [{ debt, summary: summarizeDebt(debt, [], [], '2026-01-15') }] }));
    const first = diffSchedule(plan, []);
    expect(first.toSchedule).toHaveLength(plan.length);
    const scheduled = plan.map((p, i) => ({ key: p.key, hash: hashContent(p), osId: `os${i}` }));
    const second = diffSchedule(plan, scheduled);
    expect(second).toMatchObject({ toCancel: [], toSchedule: [], unchanged: plan.length });
    // Debt paid → all its reminders cancelled
    const third = diffSchedule(plan.filter((p) => p.channel !== 'debts'), scheduled);
    expect(third.toCancel.length).toBe(plan.filter((p) => p.channel === 'debts').length);
    // Changed content → cancel + reschedule
    const changed = plan.map((p) => (p.key === plan[0].key ? { ...p, body: 'changed' } : p));
    const fourth = diffSchedule(changed, scheduled);
    expect(fourth.toCancel.map((c) => c.key)).toEqual([plan[0].key]);
    expect(fourth.toSchedule.map((c) => c.key)).toEqual([plan[0].key]);
  });
});
