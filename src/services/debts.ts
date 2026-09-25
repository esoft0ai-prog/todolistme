import { mapDebt, mapDebtPayment, mapReminder, mapSchedule } from '../db/mappers';
import { summarizeDebt, validateDebt, validateRepayment, type DebtSummary } from '../domain/debt';
import type { Debt, DebtPayment, DebtScheduleItem, PaymentMethod, Reminder } from '../domain/types';
import { isValidISODate, isValidTime } from '../domain/dates';
import { sanitizeText } from '../domain/validation';
import { newId } from '../utils/id';
import { audit } from './audit';
import { throwIfErrors, ValidationError, type Exec, type ServiceContext } from './context';
import { loadDebtState, syncDebtStatus } from './ledgerState';
import { createTransaction, deleteTransaction } from './transactions';

export const DEBT_CATEGORY_ID = 'sys-exp-debt';

export type DebtInput = Omit<Debt, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'isDemo'> & { status?: Debt['status']; isDemo?: boolean };

export interface DebtView {
  debt: Debt;
  payments: DebtPayment[];
  schedule: DebtScheduleItem[];
  summary: DebtSummary;
  reminders: Reminder[];
}

export async function listDebts(db: Exec, ref: string, opts: { includeArchived?: boolean } = {}): Promise<DebtView[]> {
  const debts = (await db.all(`SELECT * FROM debts ${opts.includeArchived ? '' : "WHERE status <> 'archived'"} ORDER BY status, first_due_date`)).map(mapDebt);
  if (!debts.length) return [];
  const payments = (await db.all('SELECT * FROM debt_payments ORDER BY date, created_at')).map(mapDebtPayment);
  const schedule = (await db.all('SELECT * FROM debt_schedule ORDER BY due_date')).map(mapSchedule);
  const reminders = (await db.all("SELECT * FROM reminders WHERE kind = 'debt'")).map(mapReminder);
  return debts.map((debt) => {
    const p = payments.filter((x) => x.debtId === debt.id);
    const s = schedule.filter((x) => x.debtId === debt.id);
    return { debt, payments: p, schedule: s, summary: summarizeDebt(debt, p, s, ref), reminders: reminders.filter((r) => r.entityId === debt.id) };
  });
}

export async function getDebtView(db: Exec, id: string, ref: string): Promise<DebtView | null> {
  const st = await loadDebtState(db, id, ref);
  if (!st) return null;
  const reminders = (await db.all("SELECT * FROM reminders WHERE kind = 'debt' AND entity_id = ?", [id])).map(mapReminder);
  return { ...st, reminders };
}

function normalise(input: DebtInput): DebtInput {
  return {
    ...input,
    lenderName: sanitizeText(input.lenderName, 80),
    notes: input.notes ? sanitizeText(input.notes, 2000) || null : null,
    interestValue: input.interestType === 'none' ? 0 : Math.max(0, Number(input.interestValue) || 0),
    installmentCount: input.paymentFrequency === 'one_time' ? 1 : Math.max(0, Math.floor(input.installmentCount || 0)),
    endDate: input.endDate || null,
    totalPayableOverrideMinor: input.totalPayableOverrideMinor && input.totalPayableOverrideMinor > 0 ? input.totalPayableOverrideMinor : null,
  };
}

async function writeSchedule(tx: Exec, debtId: string, schedule: { dueDate: string; amountMinor: number }[]) {
  await tx.run('DELETE FROM debt_schedule WHERE debt_id = ?', [debtId]);
  for (const s of schedule) {
    if (!isValidISODate(s.dueDate) || !(s.amountMinor > 0)) throw new ValidationError('Every instalment needs a valid date and amount', 'schedule');
    await tx.run('INSERT INTO debt_schedule (id, debt_id, due_date, amount_minor) VALUES (?,?,?,?)', [newId(), debtId, s.dueDate, s.amountMinor]);
  }
}

export interface ReminderOffset {
  days: number;
  time: string;
}

export async function setDebtReminders(ctx: ServiceContext, tx: Exec, debtId: string, offsets: ReminderOffset[] | null, isDemo = false): Promise<void> {
  await tx.run("DELETE FROM reminders WHERE kind = 'debt' AND entity_id = ?", [debtId]);
  if (!offsets) return; // null = use defaults from settings
  const now = ctx.now().toISOString();
  const seen = new Set<number>();
  for (const o of offsets) {
    if (!Number.isInteger(o.days) || o.days < 0 || o.days > 365 || seen.has(o.days)) continue;
    seen.add(o.days);
    await tx.run(
      "INSERT INTO reminders (id, kind, entity_id, title, message, offset_days, date, time_of_day, repeat, enabled, is_demo, created_at, updated_at) VALUES (?,'debt',?,?,'',?,NULL,?,'none',1,?,?,?)",
      [newId(), debtId, o.days === 0 ? 'On due date' : `${o.days} day(s) before`, o.days, isValidTime(o.time) ? o.time : '09:00', isDemo ? 1 : 0, now, now],
    );
  }
}

export interface CreateDebtOptions {
  schedule?: { dueDate: string; amountMinor: number }[];
  reminderOffsets?: ReminderOffset[] | null;
  /** Record the borrowed money as received into this account ("Loan received" transaction). */
  disburseToAccountId?: string | null;
  exec?: Exec;
}

export async function createDebt(ctx: ServiceContext, raw: DebtInput, opts: CreateDebtOptions = {}): Promise<Debt> {
  const input = normalise(raw);
  const schedule = (opts.schedule ?? []).map((s, i) => ({ id: String(i), debtId: '', ...s }));
  throwIfErrors(validateDebt(input, input.interestType === 'custom_schedule' ? schedule : []));
  const id = newId();
  const run = async (tx: Exec) => {
    const now = ctx.now().toISOString();
    await tx.run(
      `INSERT INTO debts (id, lender_name, debt_type, currency, principal_minor, interest_type, interest_value, payment_frequency, minimum_payment_minor,
        installment_count, start_date, first_due_date, end_date, penalty_type, penalty_value, paid_before_minor, total_payable_override_minor, notes, status, is_demo, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, input.lenderName, input.debtType, input.currency, input.principalMinor, input.interestType, input.interestValue, input.paymentFrequency,
        input.minimumPaymentMinor, input.installmentCount, input.startDate, input.firstDueDate, input.endDate, input.penaltyType, input.penaltyValue,
        input.paidBeforeMinor, input.totalPayableOverrideMinor, input.notes, input.status ?? 'active', input.isDemo ? 1 : 0, now, now,
      ],
    );
    if (input.interestType === 'custom_schedule') await writeSchedule(tx, id, opts.schedule ?? []);
    await setDebtReminders(ctx, tx, id, opts.reminderOffsets ?? null, input.isDemo);
    if (opts.disburseToAccountId) {
      await createTransaction(
        ctx,
        {
          type: 'loan_received',
          amountMinor: input.principalMinor,
          date: input.startDate,
          time: null,
          accountId: opts.disburseToAccountId,
          toAccountId: null,
          toAmountMinor: null,
          categoryId: null,
          debtId: id,
          goalId: null,
          recurringId: null,
          description: `Loan from ${input.lenderName}`,
          paymentMethod: null,
          notes: null,
          reference: null,
          tags: [],
          isDemo: input.isDemo,
        },
        { exec: tx, allowDuplicate: true },
      );
    }
    await syncDebtStatus(tx, id, ctx.today(), now);
    await audit(ctx, tx, 'debt', id, 'create', `Added debt to ${input.lenderName}`);
  };
  if (opts.exec) await run(opts.exec);
  else await ctx.db.transaction(run);
  return mapDebt((await (opts.exec ?? ctx.db).get('SELECT * FROM debts WHERE id = ?', [id]))!);
}

export async function updateDebt(ctx: ServiceContext, id: string, raw: DebtInput, opts: { schedule?: { dueDate: string; amountMinor: number }[]; reminderOffsets?: ReminderOffset[] | null } = {}): Promise<void> {
  const input = normalise(raw);
  const schedule = (opts.schedule ?? []).map((s, i) => ({ id: String(i), debtId: id, ...s }));
  throwIfErrors(validateDebt(input, input.interestType === 'custom_schedule' ? schedule : []));
  await ctx.db.transaction(async (tx) => {
    const existing = await tx.get<{ status: string }>('SELECT status FROM debts WHERE id = ?', [id]);
    if (!existing) throw new ValidationError('Debt not found');
    const now = ctx.now().toISOString();
    await tx.run(
      `UPDATE debts SET lender_name=?, debt_type=?, currency=?, principal_minor=?, interest_type=?, interest_value=?, payment_frequency=?, minimum_payment_minor=?,
        installment_count=?, start_date=?, first_due_date=?, end_date=?, penalty_type=?, penalty_value=?, paid_before_minor=?, total_payable_override_minor=?, notes=?,
        status=?, updated_at=? WHERE id=?`,
      [
        input.lenderName, input.debtType, input.currency, input.principalMinor, input.interestType, input.interestValue, input.paymentFrequency,
        input.minimumPaymentMinor, input.installmentCount, input.startDate, input.firstDueDate, input.endDate, input.penaltyType, input.penaltyValue,
        input.paidBeforeMinor, input.totalPayableOverrideMinor, input.notes, input.status === 'archived' ? 'archived' : existing.status === 'archived' ? 'active' : existing.status, now, id,
      ],
    );
    if (input.interestType === 'custom_schedule') await writeSchedule(tx, id, opts.schedule ?? []);
    else await tx.run('DELETE FROM debt_schedule WHERE debt_id = ?', [id]);
    if (opts.reminderOffsets !== undefined) await setDebtReminders(ctx, tx, id, opts.reminderOffsets);
    // Terms changed: payments must not exceed the new total.
    const st = await loadDebtState(tx, id, ctx.today());
    if (st && st.summary.paidMinor > st.summary.totalPayableMinor + st.summary.penaltiesMinor + st.summary.adjustmentsMinor) {
      throw new ValidationError('Recorded repayments exceed the new total payable. Adjust the terms or the payments.');
    }
    await syncDebtStatus(tx, id, ctx.today(), now);
    await audit(ctx, tx, 'debt', id, 'update', `Updated debt to ${input.lenderName}`);
  });
}

export async function setDebtArchived(ctx: ServiceContext, id: string, archived: boolean): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    await tx.run('UPDATE debts SET status = ?, updated_at = ? WHERE id = ?', [archived ? 'archived' : 'active', ctx.now().toISOString(), id]);
    if (!archived) await syncDebtStatus(tx, id, ctx.today(), ctx.now().toISOString());
    await audit(ctx, tx, 'debt', id, 'update', archived ? 'Archived debt' : 'Unarchived debt');
  });
}

/**
 * Deletes a debt and its payment history. Linked repayment/loan transactions are
 * deleted too when `deleteTransactions` is set; otherwise they stay in the ledger
 * (so account balances remain correct) but are unlinked.
 */
export async function deleteDebt(ctx: ServiceContext, id: string, deleteTransactions: boolean): Promise<void> {
  const txIds = (await ctx.db.all<{ id: string }>('SELECT id FROM transactions WHERE debt_id = ?', [id])).map((r) => r.id);
  if (deleteTransactions) for (const t of txIds) await deleteTransaction(ctx, t);
  await ctx.db.transaction(async (tx) => {
    await tx.run('UPDATE recurring_transactions SET active = 0 WHERE debt_id = ?', [id]);
    await tx.run("DELETE FROM reminders WHERE kind = 'debt' AND entity_id = ?", [id]);
    await tx.run('DELETE FROM debts WHERE id = ?', [id]);
    await audit(ctx, tx, 'debt', id, 'delete', `Deleted debt${deleteTransactions ? ' and its transactions' : ''}`);
  });
}

export interface RepaymentInput {
  amountMinor: number;
  date: string;
  /** Account the money was paid from. Omit to record a payment made outside tracked accounts. */
  accountId?: string | null;
  notes?: string | null;
  paymentMethod?: PaymentMethod | null;
  isDemo?: boolean;
}

export async function recordRepayment(ctx: ServiceContext, debtId: string, input: RepaymentInput, exec?: Exec): Promise<void> {
  const db = exec ?? ctx.db;
  const st = await loadDebtState(db, debtId, ctx.today());
  if (!st) throw new ValidationError('Debt not found');
  const err = validateRepayment(input.amountMinor, st.summary.outstandingMinor);
  if (err) throw new ValidationError(err, 'amountMinor');
  if (!isValidISODate(input.date)) throw new ValidationError('Enter a valid date', 'date');
  if (input.accountId) {
    await createTransaction(
      ctx,
      {
        type: 'debt_repayment',
        amountMinor: input.amountMinor,
        date: input.date,
        time: null,
        accountId: input.accountId,
        toAccountId: null,
        toAmountMinor: null,
        categoryId: DEBT_CATEGORY_ID,
        debtId,
        goalId: null,
        recurringId: null,
        description: `Repayment to ${st.debt.lenderName}`,
        paymentMethod: input.paymentMethod ?? null,
        notes: input.notes ?? null,
        reference: null,
        tags: [],
        isDemo: input.isDemo ?? st.debt.isDemo,
      },
      { exec, allowDuplicate: true },
    );
    return;
  }
  const run = async (tx: Exec) => {
    const now = ctx.now().toISOString();
    await tx.run(
      "INSERT INTO debt_payments (id, debt_id, kind, amount_minor, date, transaction_id, notes, is_demo, created_at, updated_at) VALUES (?,?,'payment',?,?,NULL,?,?,?,?)",
      [newId(), debtId, input.amountMinor, input.date, input.notes ? sanitizeText(input.notes, 500) : null, st.debt.isDemo ? 1 : 0, now, now],
    );
    await syncDebtStatus(tx, debtId, ctx.today(), now);
    await audit(ctx, tx, 'debt', debtId, 'update', `Recorded repayment of ${input.amountMinor}`);
  };
  if (exec) await run(exec);
  else await ctx.db.transaction(run);
}

/** Adds a penalty/late fee (kind=penalty) or a manual balance correction (kind=adjustment, signed). */
export async function addDebtCharge(
  ctx: ServiceContext,
  debtId: string,
  kind: 'penalty' | 'adjustment',
  amountMinor: number,
  date: string,
  notes?: string | null,
): Promise<void> {
  if (kind === 'penalty' && !(amountMinor > 0)) throw new ValidationError('Penalty must be greater than zero', 'amountMinor');
  if (kind === 'adjustment' && (!Number.isInteger(amountMinor) || amountMinor === 0)) throw new ValidationError('Adjustment cannot be zero', 'amountMinor');
  if (!isValidISODate(date)) throw new ValidationError('Enter a valid date', 'date');
  await ctx.db.transaction(async (tx) => {
    const st = await loadDebtState(tx, debtId, ctx.today());
    if (!st) throw new ValidationError('Debt not found');
    if (kind === 'adjustment' && st.summary.outstandingMinor + amountMinor < 0) {
      throw new ValidationError('This adjustment would make the balance negative', 'amountMinor');
    }
    const now = ctx.now().toISOString();
    await tx.run(
      'INSERT INTO debt_payments (id, debt_id, kind, amount_minor, date, transaction_id, notes, is_demo, created_at, updated_at) VALUES (?,?,?,?,?,NULL,?,?,?,?)',
      [newId(), debtId, kind, amountMinor, date, notes ? sanitizeText(notes, 500) : null, st.debt.isDemo ? 1 : 0, now, now],
    );
    await syncDebtStatus(tx, debtId, ctx.today(), now);
    await audit(ctx, tx, 'debt', debtId, 'update', `Added ${kind} of ${amountMinor}`);
  });
}

export async function deleteDebtPayment(ctx: ServiceContext, paymentId: string): Promise<void> {
  const p = await ctx.db.get<{ id: string; debt_id: string; transaction_id: string | null }>('SELECT id, debt_id, transaction_id FROM debt_payments WHERE id = ?', [paymentId]);
  if (!p) return;
  if (p.transaction_id) {
    await deleteTransaction(ctx, p.transaction_id);
    return;
  }
  await ctx.db.transaction(async (tx) => {
    await tx.run('DELETE FROM debt_payments WHERE id = ?', [paymentId]);
    await syncDebtStatus(tx, p.debt_id, ctx.today(), ctx.now().toISOString());
    await audit(ctx, tx, 'debt', p.debt_id, 'delete', 'Deleted debt payment record');
  });
}
