import { mapRecurring } from '../db/mappers';
import { addDays, isValidISODate } from '../domain/dates';
import { nextOccurrence, occurrencesBetween } from '../domain/recurrence';
import type { RecurringTransaction } from '../domain/types';
import { isValidAmountMinor, sanitizeText } from '../domain/validation';
import { newId } from '../utils/id';
import { audit } from './audit';
import { ValidationError, type Exec, type ServiceContext } from './context';
import { createTransaction } from './transactions';

export type RecurringInput = Omit<RecurringTransaction, 'id' | 'createdAt' | 'updatedAt' | 'lastGeneratedDate' | 'isDemo'> & { isDemo?: boolean };

export async function listRecurring(db: Exec, opts: { activeOnly?: boolean } = {}): Promise<RecurringTransaction[]> {
  const rows = await db.all(`SELECT * FROM recurring_transactions ${opts.activeOnly ? 'WHERE active = 1' : ''} ORDER BY active DESC, start_date`);
  return rows.map(mapRecurring);
}

export function validateRecurring(r: Partial<RecurringInput>): { field: string; message: string }[] {
  const e: { field: string; message: string }[] = [];
  if (!isValidAmountMinor(r.amountMinor)) e.push({ field: 'amountMinor', message: 'Amount must be greater than zero' });
  if (!r.accountId) e.push({ field: 'accountId', message: 'Choose an account' });
  if (!r.startDate || !isValidISODate(r.startDate)) e.push({ field: 'startDate', message: 'Enter a valid start date' });
  if (r.endDate && r.startDate && r.endDate < r.startDate) e.push({ field: 'endDate', message: 'End date must be after the start date' });
  if (r.frequency === 'custom' && !(Number(r.interval) >= 1 && Number(r.interval) <= 365)) e.push({ field: 'interval', message: 'Interval must be between 1 and 365' });
  if ((r.type === 'income' || r.type === 'expense') && !r.categoryId) e.push({ field: 'categoryId', message: 'Choose a category' });
  if (r.type === 'transfer' && (!r.toAccountId || r.toAccountId === r.accountId)) e.push({ field: 'toAccountId', message: 'Choose a different destination account' });
  if (r.type === 'debt_repayment' && !r.debtId) e.push({ field: 'debtId', message: 'Choose a debt' });
  if ((r.type === 'savings_deposit' || r.type === 'savings_withdrawal') && !r.goalId) e.push({ field: 'goalId', message: 'Choose a goal' });
  if (r.remindDaysBefore != null && (r.remindDaysBefore < -1 || r.remindDaysBefore > 60)) e.push({ field: 'remindDaysBefore', message: 'Reminder must be 0–60 days before' });
  return e;
}

/**
 * Creates or updates a rule. For a new rule whose start date is in the past,
 * earlier occurrences are only created when `backfill` is set; otherwise
 * generation starts today.
 */
export async function saveRecurring(ctx: ServiceContext, input: RecurringInput, id?: string, exec?: Exec, opts: { backfill?: boolean } = {}): Promise<string> {
  const errors = validateRecurring(input);
  if (errors.length) throw new ValidationError(errors[0].message, errors[0].field, errors);
  const recId = id ?? newId();
  const run = async (tx: Exec) => {
    const now = ctx.now().toISOString();
    const values = [
      input.type, input.amountMinor, input.accountId, input.toAccountId, input.categoryId, input.debtId, input.goalId, sanitizeText(input.description, 200),
      input.paymentMethod, input.frequency, Math.max(1, Math.floor(input.interval || 1)), input.unit, input.startDate, input.endDate || null,
      input.isBill ? 1 : 0, input.autoCreate ? 1 : 0, input.remindDaysBefore, input.active ? 1 : 0,
    ];
    if (id) {
      const r = await tx.run(
        `UPDATE recurring_transactions SET type=?, amount_minor=?, account_id=?, to_account_id=?, category_id=?, debt_id=?, goal_id=?, description=?, payment_method=?,
          frequency=?, interval=?, unit=?, start_date=?, end_date=?, is_bill=?, auto_create=?, remind_days_before=?, active=?, updated_at=? WHERE id=?`,
        [...values, now, id],
      );
      if (!r.changes) throw new ValidationError('Recurring transaction not found');
      await audit(ctx, tx, 'recurring', id, 'update', `Updated recurring "${input.description}"`);
    } else {
      const today = ctx.today();
      const lastGenerated = !opts.backfill && input.startDate < today ? addDays(today, -1) : null;
      await tx.run(
        `INSERT INTO recurring_transactions (type, amount_minor, account_id, to_account_id, category_id, debt_id, goal_id, description, payment_method,
          frequency, interval, unit, start_date, end_date, is_bill, auto_create, remind_days_before, active, id, is_demo, last_generated_date, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [...values, recId, input.isDemo ? 1 : 0, lastGenerated, now, now],
      );
      await audit(ctx, tx, 'recurring', recId, 'create', `Created recurring "${input.description}"`);
    }
  };
  if (exec) await run(exec);
  else await ctx.db.transaction(run);
  return recId;
}

export async function deleteRecurring(ctx: ServiceContext, id: string): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    await tx.run('DELETE FROM recurring_transactions WHERE id = ?', [id]);
    await audit(ctx, tx, 'recurring', id, 'delete', 'Deleted recurring transaction');
  });
}

export interface MaterializeResult {
  created: number;
  skipped: { recurringId: string; date: string; reason: string }[];
}

/**
 * Creates the transactions that have fallen due (catch-up after the app was
 * closed for days). Idempotent: last_generated_date + a unique index on
 * (recurring_id, date) guarantee each occurrence is created at most once.
 */
export async function materializeDue(ctx: ServiceContext, maxPerRule = 60): Promise<MaterializeResult> {
  const today = ctx.today();
  const result: MaterializeResult = { created: 0, skipped: [] };
  for (const r of await listRecurring(ctx.db, { activeOnly: true })) {
    if (!r.autoCreate) continue;
    const from = r.lastGeneratedDate ? addDays(r.lastGeneratedDate, 1) : r.startDate;
    const dates = occurrencesBetween(r, from, today, maxPerRule);
    for (const date of dates) {
      const exists = await ctx.db.get('SELECT 1 FROM transactions WHERE recurring_id = ? AND date = ?', [r.id, date]);
      if (!exists) {
        try {
          await createTransaction(
            ctx,
            {
              type: r.type,
              amountMinor: r.amountMinor,
              date,
              time: null,
              accountId: r.accountId,
              toAccountId: r.toAccountId,
              toAmountMinor: null,
              categoryId: r.categoryId,
              debtId: r.debtId,
              goalId: r.goalId,
              recurringId: r.id,
              description: r.description,
              paymentMethod: r.paymentMethod,
              notes: 'Created automatically from a recurring schedule',
              reference: null,
              tags: [],
              isDemo: r.isDemo,
            },
            { allowDuplicate: true },
          );
          result.created++;
        } catch (e) {
          // e.g. a debt already paid off or a goal withdrawal exceeding the balance: skip, don't block others.
          result.skipped.push({ recurringId: r.id, date, reason: e instanceof Error ? e.message : String(e) });
        }
      }
      await ctx.db.run('UPDATE recurring_transactions SET last_generated_date = ? WHERE id = ?', [date, r.id]);
    }
    // Deactivate rules that have ended.
    if (r.endDate && r.endDate < today && !nextOccurrence(r, today)) {
      await ctx.db.run('UPDATE recurring_transactions SET active = 0 WHERE id = ?', [r.id]);
    }
  }
  return result;
}

/** Future (not yet created) occurrences for the calendar and cash-flow projections. */
export async function projectedOccurrences(ctx: ServiceContext, from: string, to: string): Promise<{ recurring: RecurringTransaction; date: string }[]> {
  const out: { recurring: RecurringTransaction; date: string }[] = [];
  const today = ctx.today();
  for (const r of await listRecurring(ctx.db, { activeOnly: true })) {
    const start = r.autoCreate ? (from > today ? from : addDays(today, 1)) : from;
    for (const date of occurrencesBetween(r, start, to, 400)) out.push({ recurring: r, date });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}
