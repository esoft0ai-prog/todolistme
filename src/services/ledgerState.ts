import { mapDebt, mapDebtPayment, mapGoal, mapSchedule } from '../db/mappers';
import { summarizeDebt, type DebtSummary } from '../domain/debt';
import { convertMinor } from '../domain/money';
import { goalProgress, type GoalContribution, type GoalProgress } from '../domain/savings';
import type { Debt, DebtPayment, DebtScheduleItem, ISODate, SavingsGoal } from '../domain/types';
import type { Exec } from './context';

/** Loads a debt with everything needed to summarise it. */
export async function loadDebtState(
  db: Exec,
  debtId: string,
  ref: ISODate,
  opts: { excludeTransactionId?: string } = {},
): Promise<{ debt: Debt; payments: DebtPayment[]; schedule: DebtScheduleItem[]; summary: DebtSummary } | null> {
  const row = await db.get('SELECT * FROM debts WHERE id = ?', [debtId]);
  if (!row) return null;
  const debt = mapDebt(row);
  let payments = (await db.all('SELECT * FROM debt_payments WHERE debt_id = ? ORDER BY date, created_at', [debtId])).map(mapDebtPayment);
  if (opts.excludeTransactionId) payments = payments.filter((p) => p.transactionId !== opts.excludeTransactionId);
  const schedule = (await db.all('SELECT * FROM debt_schedule WHERE debt_id = ? ORDER BY due_date', [debtId])).map(mapSchedule);
  return { debt, payments, schedule, summary: summarizeDebt(debt, payments, schedule, ref) };
}

/** Keeps `status` in sync: active ↔ paid_off (archived is user-controlled). */
export async function syncDebtStatus(db: Exec, debtId: string, ref: ISODate, nowISO: string): Promise<void> {
  const st = await loadDebtState(db, debtId, ref);
  if (!st || st.debt.status === 'archived') return;
  const outstanding = summarizeDebt({ ...st.debt, status: 'active' }, st.payments, st.schedule, ref).outstandingMinor;
  const next = outstanding <= 0 ? 'paid_off' : 'active';
  if (next !== st.debt.status) await db.run('UPDATE debts SET status = ?, updated_at = ? WHERE id = ?', [next, nowISO, debtId]);
}

/** Contributions to a goal in the goal's currency (deposits positive, withdrawals negative). */
export async function goalContributions(db: Exec, goal: SavingsGoal, base: string, excludeTransactionId?: string): Promise<GoalContribution[]> {
  const rows = await db.all<{ id: string; type: string; amount_minor: number; currency: string; base_amount_minor: number; date: string }>(
    "SELECT id, type, amount_minor, currency, base_amount_minor, date FROM transactions WHERE goal_id = ? AND type IN ('savings_deposit','savings_withdrawal') ORDER BY date",
    [goal.id],
  );
  const rates = await db.all<{ currency: string; rate: number }>('SELECT currency, rate FROM exchange_rates');
  const rateOf = (c: string) => (c === base ? 1 : Number(rates.find((r) => r.currency === c)?.rate ?? 1));
  return rows
    .filter((r) => r.id !== excludeTransactionId)
    .map((r) => {
      let amt = Number(r.amount_minor);
      if (r.currency !== goal.currency) {
        // Convert via base currency: amount(base) → goal currency.
        amt = convertMinor(Number(r.base_amount_minor), base, goal.currency, 1 / rateOf(goal.currency));
      }
      return { date: r.date, amountMinor: r.type === 'savings_deposit' ? amt : -amt };
    });
}

export async function loadGoalState(
  db: Exec,
  goalId: string,
  base: string,
  ref: ISODate,
  excludeTransactionId?: string,
): Promise<{ goal: SavingsGoal; contributions: GoalContribution[]; progress: GoalProgress } | null> {
  const row = await db.get('SELECT * FROM savings_goals WHERE id = ?', [goalId]);
  if (!row) return null;
  const goal = mapGoal(row);
  const contributions = await goalContributions(db, goal, base, excludeTransactionId);
  return { goal, contributions, progress: goalProgress(goal, contributions, ref) };
}

export async function syncGoalStatus(db: Exec, goalId: string, base: string, ref: ISODate, nowISO: string): Promise<void> {
  const st = await loadGoalState(db, goalId, base, ref);
  if (!st || st.goal.status === 'archived') return;
  const next = st.progress.remainingMinor <= 0 ? 'completed' : 'active';
  if (next !== st.goal.status) await db.run('UPDATE savings_goals SET status = ?, updated_at = ? WHERE id = ?', [next, nowISO, goalId]);
}
