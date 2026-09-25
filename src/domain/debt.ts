import { addDays, diffDays, today as todayFn } from './dates';
import { monthlyEquivalent, nthOccurrence, paymentFrequencyStep } from './recurrence';
import type { Debt, DebtPayment, DebtScheduleItem, ISODate, PaymentFrequency } from './types';

/**
 * Debt mathematics. Pure functions — every figure shown in the Debts module is
 * derived here from the stored debt terms and its payment history, so balances
 * can never drift out of sync with the recorded repayments.
 */

export const PERIODS_PER_YEAR: Record<Exclude<PaymentFrequency, 'one_time'>, number> = {
  weekly: 52,
  biweekly: 26,
  monthly: 12,
  quarterly: 4,
  yearly: 1,
};

export interface Installment {
  index: number;
  dueDate: ISODate;
  amountMinor: number;
  paidMinor: number;
  status: 'paid' | 'partial' | 'due' | 'overdue' | 'upcoming';
}

export interface DebtSummary {
  totalInterestMinor: number;
  totalPayableMinor: number;
  penaltiesMinor: number;
  adjustmentsMinor: number;
  paidMinor: number; // includes paid-before
  outstandingMinor: number;
  progress: number; // 0..1 of total payable repaid
  installmentAmountMinor: number;
  installmentCount: number;
  installments: Installment[];
  nextInstallment: Installment | null;
  daysUntilNext: number | null;
  overdueInstallments: Installment[];
  overdueAmountMinor: number;
  daysOverdue: number;
  paymentsRemaining: number;
  scheduledPayoffDate: ISODate | null;
  /** Projection based on the average repayment pace so far. */
  projectedPayoffDate: ISODate | null;
  monthlyObligationMinor: number;
  isPaidOff: boolean;
}

/** Number of instalments implied by the terms. */
export function deriveInstallmentCount(debt: Pick<Debt, 'paymentFrequency' | 'installmentCount' | 'firstDueDate' | 'endDate'>): number {
  if (debt.paymentFrequency === 'one_time') return 1;
  if (debt.installmentCount > 0) return Math.floor(debt.installmentCount);
  const step = paymentFrequencyStep(debt.paymentFrequency)!;
  if (debt.endDate && debt.endDate >= debt.firstDueDate) {
    let n = 0;
    while (n < 1200 && nthOccurrence(debt.firstDueDate, step, n) <= debt.endDate) n++;
    return Math.max(1, n);
  }
  return 1;
}

/** Loan term in years (for simple interest), based on start date and final instalment. */
export function termYears(debt: Pick<Debt, 'startDate' | 'firstDueDate' | 'endDate' | 'paymentFrequency' | 'installmentCount'>): number {
  const n = deriveInstallmentCount(debt);
  let last: ISODate = debt.firstDueDate;
  const step = paymentFrequencyStep(debt.paymentFrequency);
  if (step) last = nthOccurrence(debt.firstDueDate, step, n - 1);
  if (debt.endDate && debt.endDate > last) last = debt.endDate;
  const days = Math.max(1, diffDays(debt.startDate, last));
  return days / 365.2425;
}

/** Periodic payment on an amortising (reducing balance) loan. */
export function amortizedPayment(principalMinor: number, annualRatePct: number, periodsPerYear: number, n: number): number {
  if (n <= 0) return principalMinor;
  const r = annualRatePct / 100 / periodsPerYear;
  if (r <= 0) return principalMinor / n;
  return (principalMinor * r) / (1 - Math.pow(1 + r, -n));
}

export function computeTotalInterest(debt: Debt, schedule: DebtScheduleItem[] = []): number {
  const P = debt.principalMinor;
  const v = Math.max(0, debt.interestValue || 0);
  switch (debt.interestType) {
    case 'none':
      return 0;
    case 'fixed_amount':
      return Math.round(v);
    case 'flat_percentage':
      return Math.round((P * v) / 100);
    case 'simple_annual':
      return Math.round((P * v * termYears(debt)) / 100);
    case 'reducing_balance': {
      const n = deriveInstallmentCount(debt);
      const ppy = debt.paymentFrequency === 'one_time' ? 1 : PERIODS_PER_YEAR[debt.paymentFrequency];
      if (debt.paymentFrequency === 'one_time') {
        return Math.round((P * v * termYears(debt)) / 100);
      }
      const pmt = amortizedPayment(P, v, ppy, n);
      return Math.max(0, Math.round(pmt * n - P));
    }
    case 'custom_schedule': {
      const sum = schedule.reduce((s, i) => s + i.amountMinor, 0);
      return Math.max(0, sum - P);
    }
  }
}

export function computeTotalPayable(debt: Debt, schedule: DebtScheduleItem[] = []): number {
  if (debt.totalPayableOverrideMinor != null && debt.totalPayableOverrideMinor > 0) {
    return debt.totalPayableOverrideMinor;
  }
  return debt.principalMinor + computeTotalInterest(debt, schedule);
}

/** Builds the instalment plan (amounts due per date) before applying payments. */
export function buildInstallmentPlan(
  debt: Debt,
  totalPayableMinor: number,
  schedule: DebtScheduleItem[] = [],
): { dueDate: ISODate; amountMinor: number }[] {
  if (debt.interestType === 'custom_schedule' && schedule.length > 0) {
    return [...schedule]
      .sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0))
      .map((s) => ({ dueDate: s.dueDate, amountMinor: s.amountMinor }));
  }
  const n = deriveInstallmentCount(debt);
  const step = paymentFrequencyStep(debt.paymentFrequency);
  const plan: { dueDate: ISODate; amountMinor: number }[] = [];
  let per = debt.minimumPaymentMinor > 0 ? debt.minimumPaymentMinor : Math.ceil(totalPayableMinor / n);
  if (per <= 0) per = totalPayableMinor;
  let remaining = totalPayableMinor;
  let i = 0;
  // With a user-provided instalment we keep generating until the total is covered.
  const maxInstallments = debt.minimumPaymentMinor > 0 ? 1200 : n;
  while (remaining > 0 && i < maxInstallments) {
    const due = step ? nthOccurrence(debt.firstDueDate, step, i) : debt.firstDueDate;
    const amt = Math.min(per, remaining);
    plan.push({ dueDate: due, amountMinor: amt });
    remaining -= amt;
    i++;
    if (!step) break;
  }
  if (remaining > 0 && plan.length > 0) plan[plan.length - 1].amountMinor += remaining;
  return plan;
}

export function summarizeDebt(
  debt: Debt,
  payments: DebtPayment[],
  schedule: DebtScheduleItem[] = [],
  ref: ISODate = todayFn(),
): DebtSummary {
  const totalPayable = computeTotalPayable(debt, schedule);
  const totalInterest = Math.max(0, totalPayable - debt.principalMinor);
  let paid = Math.max(0, debt.paidBeforeMinor);
  let penalties = 0;
  let adjustments = 0;
  const repayments: DebtPayment[] = [];
  for (const p of payments) {
    if (p.kind === 'payment') {
      paid += p.amountMinor;
      repayments.push(p);
    } else if (p.kind === 'penalty') penalties += p.amountMinor;
    else adjustments += p.amountMinor; // signed: positive increases balance, negative reduces
  }
  const owed = totalPayable + penalties + adjustments;
  const outstanding = Math.max(0, owed - paid);

  // Allocate payments to the instalment plan in order. Penalties are appended to the next unpaid instalment.
  const plan = buildInstallmentPlan(debt, totalPayable + adjustments, schedule);
  let pool = paid;
  const installments: Installment[] = plan.map((p, index) => {
    const covered = Math.min(pool, p.amountMinor);
    pool -= covered;
    let status: Installment['status'];
    if (covered >= p.amountMinor) status = 'paid';
    else if (p.dueDate < ref) status = 'overdue';
    else if (p.dueDate === ref) status = 'due';
    else if (covered > 0) status = 'partial';
    else status = 'upcoming';
    return { index, dueDate: p.dueDate, amountMinor: p.amountMinor, paidMinor: covered, status };
  });

  const isPaidOff = outstanding <= 0 || debt.status === 'paid_off';
  const unpaid = isPaidOff ? [] : installments.filter((i) => i.status !== 'paid');
  const nextInstallment = unpaid[0] ?? null;
  const overdue = unpaid.filter((i) => i.status === 'overdue');
  const overdueAmount = overdue.reduce((s, i) => s + (i.amountMinor - i.paidMinor), 0);
  const daysOverdue = overdue.length ? diffDays(overdue[0].dueDate, ref) : 0;
  const scheduledPayoff = unpaid.length ? unpaid[unpaid.length - 1].dueDate : null;

  // Pace-based projection: average amount repaid per day since the first repayment/start.
  let projected: ISODate | null = null;
  if (!isPaidOff) {
    const repaidInApp = repayments.reduce((s, p) => s + p.amountMinor, 0);
    const firstDate = repayments.length
      ? repayments.reduce((m, p) => (p.date < m ? p.date : m), repayments[0].date)
      : null;
    if (firstDate && repaidInApp > 0) {
      const days = Math.max(30, diffDays(debt.startDate < firstDate ? debt.startDate : firstDate, ref));
      const perDay = repaidInApp / days;
      if (perDay > 0) projected = addDays(ref, Math.ceil(outstanding / perDay));
    } else {
      projected = scheduledPayoff;
    }
  }

  const perInstallment = plan.length ? plan[0].amountMinor : totalPayable;
  const monthly = isPaidOff || debt.status === 'archived'
    ? 0
    : debt.paymentFrequency === 'one_time'
      ? oneTimeMonthlyObligation(outstanding, nextInstallment?.dueDate ?? debt.firstDueDate, ref)
      : Math.round(monthlyEquivalent(Math.min(perInstallment, outstanding), debt.paymentFrequency));

  return {
    totalInterestMinor: totalInterest,
    totalPayableMinor: totalPayable,
    penaltiesMinor: penalties,
    adjustmentsMinor: adjustments,
    paidMinor: paid,
    outstandingMinor: outstanding,
    progress: owed > 0 ? Math.min(1, paid / owed) : 1,
    installmentAmountMinor: perInstallment,
    installmentCount: plan.length,
    installments,
    nextInstallment,
    daysUntilNext: nextInstallment ? diffDays(ref, nextInstallment.dueDate) : null,
    overdueInstallments: overdue,
    overdueAmountMinor: overdueAmount,
    daysOverdue,
    paymentsRemaining: unpaid.length,
    scheduledPayoffDate: scheduledPayoff,
    projectedPayoffDate: projected,
    monthlyObligationMinor: monthly,
    isPaidOff,
  };
}

/** For a lump-sum debt, spread what's left over the months until it is due (min 1 month). */
function oneTimeMonthlyObligation(outstanding: number, due: ISODate, ref: ISODate): number {
  const months = Math.max(1, Math.ceil(diffDays(ref, due) / 30.44));
  return Math.round(outstanding / months);
}

/** Penalty for missing an instalment according to the debt's penalty terms. */
export function penaltyFor(debt: Pick<Debt, 'penaltyType' | 'penaltyValue'>, overdueAmountMinor: number): number {
  if (debt.penaltyType === 'fixed') return Math.max(0, Math.round(debt.penaltyValue));
  if (debt.penaltyType === 'percentage') return Math.max(0, Math.round((overdueAmountMinor * debt.penaltyValue) / 100));
  return 0;
}

/** Debt-to-income ratio (monthly obligations / monthly income). */
export function debtToIncome(monthlyObligationMinor: number, monthlyIncomeMinor: number): number | null {
  if (monthlyIncomeMinor <= 0) return monthlyObligationMinor > 0 ? null : 0;
  return monthlyObligationMinor / monthlyIncomeMinor;
}

export function describeDTI(dti: number | null): { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' } {
  if (dti == null) return { label: 'Add income to calculate', tone: 'neutral' };
  if (dti <= 0.2) return { label: 'Healthy', tone: 'good' };
  if (dti <= 0.36) return { label: 'Manageable', tone: 'good' };
  if (dti <= 0.5) return { label: 'High', tone: 'warn' };
  return { label: 'Critical', tone: 'bad' };
}

export type DebtValidationError = { field: string; message: string };

export function validateDebt(debt: Partial<Debt>, schedule: DebtScheduleItem[] = []): DebtValidationError[] {
  const errors: DebtValidationError[] = [];
  if (!debt.lenderName || !debt.lenderName.trim()) errors.push({ field: 'lenderName', message: 'Lender name is required' });
  if (!(Number(debt.principalMinor) > 0)) errors.push({ field: 'principalMinor', message: 'Principal must be greater than zero' });
  if (debt.interestValue != null && (debt.interestValue < 0 || !Number.isFinite(debt.interestValue))) {
    errors.push({ field: 'interestValue', message: 'Interest cannot be negative' });
  }
  if (
    debt.interestType &&
    ['flat_percentage', 'simple_annual', 'reducing_balance'].includes(debt.interestType) &&
    (debt.interestValue ?? 0) > 1000
  ) {
    errors.push({ field: 'interestValue', message: 'Interest rate looks wrong (over 1000%)' });
  }
  if (!debt.startDate) errors.push({ field: 'startDate', message: 'Start date is required' });
  if (!debt.firstDueDate) errors.push({ field: 'firstDueDate', message: 'Due date is required' });
  if (debt.startDate && debt.firstDueDate && debt.firstDueDate < debt.startDate) {
    errors.push({ field: 'firstDueDate', message: 'First due date cannot be before the start date' });
  }
  if (debt.endDate && debt.firstDueDate && debt.endDate < debt.firstDueDate) {
    errors.push({ field: 'endDate', message: 'End date cannot be before the first due date' });
  }
  if ((debt.minimumPaymentMinor ?? 0) < 0) errors.push({ field: 'minimumPaymentMinor', message: 'Minimum payment cannot be negative' });
  if ((debt.paidBeforeMinor ?? 0) < 0) errors.push({ field: 'paidBeforeMinor', message: 'Amount already paid cannot be negative' });
  if ((debt.installmentCount ?? 0) < 0 || (debt.installmentCount ?? 0) > 1200) {
    errors.push({ field: 'installmentCount', message: 'Number of payments must be between 1 and 1200' });
  }
  if (debt.penaltyValue != null && debt.penaltyValue < 0) errors.push({ field: 'penaltyValue', message: 'Penalty cannot be negative' });
  if (debt.interestType === 'custom_schedule') {
    if (schedule.length === 0) errors.push({ field: 'schedule', message: 'Add at least one instalment to the schedule' });
    if (schedule.some((s) => !(s.amountMinor > 0))) errors.push({ field: 'schedule', message: 'Every instalment must be greater than zero' });
  }
  if (
    errors.length === 0 &&
    debt.principalMinor &&
    debt.paidBeforeMinor &&
    debt.paidBeforeMinor > computeTotalPayable(debt as Debt, schedule)
  ) {
    errors.push({ field: 'paidBeforeMinor', message: 'Amount already paid exceeds the total payable' });
  }
  return errors;
}

/** Validates that a repayment does not push the balance below zero. */
export function validateRepayment(amountMinor: number, outstandingMinor: number): string | null {
  if (!(amountMinor > 0)) return 'Repayment must be greater than zero';
  if (amountMinor > outstandingMinor) {
    return 'Repayment is larger than the outstanding balance';
  }
  return null;
}

/**
 * Punctuality of instalments that fell due in [from, ref): an instalment is on time
 * when cumulative repayments made on or before its due date cover every
 * instalment up to and including it.
 */
export function paymentPunctuality(
  debt: Debt,
  payments: DebtPayment[],
  schedule: DebtScheduleItem[],
  from: ISODate,
  ref: ISODate = todayFn(),
): { due: number; onTime: number; overdueNow: number } {
  const totalPayable = computeTotalPayable(debt, schedule);
  const plan = buildInstallmentPlan(debt, totalPayable, schedule);
  const repayments = payments.filter((p) => p.kind === 'payment').sort((a, b) => (a.date < b.date ? -1 : 1));
  let due = 0;
  let onTime = 0;
  let cumulativeRequired = 0;
  for (const inst of plan) {
    cumulativeRequired += inst.amountMinor;
    if (inst.dueDate >= ref || inst.dueDate < from) continue;
    due += 1;
    let paidBy = debt.paidBeforeMinor;
    for (const p of repayments) {
      if (p.date <= inst.dueDate) paidBy += p.amountMinor;
      else break;
    }
    if (paidBy >= cumulativeRequired) onTime += 1;
  }
  const summary = summarizeDebt(debt, payments, schedule, ref);
  return { due, onTime, overdueNow: summary.overdueInstallments.length };
}
