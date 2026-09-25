import { isValidISODate, isValidTime, diffDays } from './dates';
import { MAX_MAJOR_AMOUNT } from './money';
import {
  ACCOUNT_TYPES,
  PAYMENT_METHODS,
  TRANSACTION_TYPES,
  type Account,
  type Category,
  type Reminder,
  type Transaction,
  type TransactionInput,
} from './types';

export interface FieldError {
  field: string;
  message: string;
}

export const MAX_TEXT = 500;
export const MAX_NAME = 80;
const MAX_MINOR = MAX_MAJOR_AMOUNT * 100;

export function isValidAmountMinor(v: unknown, allowZero = false): v is number {
  return typeof v === 'number' && Number.isInteger(v) && (allowZero ? v >= 0 : v > 0) && v <= MAX_MINOR;
}

/** Types that require a category. */
export function needsCategory(type: Transaction['type']): boolean {
  return type === 'income' || type === 'expense';
}

export function validateTransaction(t: Partial<TransactionInput>): FieldError[] {
  const errors: FieldError[] = [];
  if (!t.type || !TRANSACTION_TYPES.includes(t.type)) errors.push({ field: 'type', message: 'Choose a transaction type' });
  if (!isValidAmountMinor(t.amountMinor)) errors.push({ field: 'amountMinor', message: 'Amount must be greater than zero' });
  if (!t.date || !isValidISODate(t.date)) errors.push({ field: 'date', message: 'Enter a valid date' });
  else {
    // Guard against obviously mistyped years.
    const now = new Date();
    const ref = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    if (diffDays(ref, t.date) > 366 * 5) errors.push({ field: 'date', message: 'Date is too far in the future' });
  }
  if (t.time != null && t.time !== '' && !isValidTime(t.time)) errors.push({ field: 'time', message: 'Enter a valid time (HH:MM)' });
  if (!t.accountId) errors.push({ field: 'accountId', message: 'Choose an account' });
  if (t.type === 'transfer') {
    if (!t.toAccountId) errors.push({ field: 'toAccountId', message: 'Choose the destination account' });
    else if (t.toAccountId === t.accountId) errors.push({ field: 'toAccountId', message: 'Source and destination must be different accounts' });
    if (t.toAmountMinor != null && !isValidAmountMinor(t.toAmountMinor)) {
      errors.push({ field: 'toAmountMinor', message: 'Received amount must be greater than zero' });
    }
  }
  if (t.type && needsCategory(t.type) && !t.categoryId) errors.push({ field: 'categoryId', message: 'Choose a category' });
  if (t.type === 'debt_repayment' && !t.debtId) errors.push({ field: 'debtId', message: 'Choose the debt being repaid' });
  if ((t.type === 'savings_deposit' || t.type === 'savings_withdrawal') && !t.goalId) {
    errors.push({ field: 'goalId', message: 'Choose a savings goal' });
  }
  if (t.paymentMethod && !PAYMENT_METHODS.includes(t.paymentMethod)) errors.push({ field: 'paymentMethod', message: 'Unknown payment method' });
  if ((t.description ?? '').length > MAX_TEXT) errors.push({ field: 'description', message: 'Description is too long' });
  if ((t.notes ?? '').length > 2000) errors.push({ field: 'notes', message: 'Notes are too long' });
  if ((t.reference ?? '').length > 200) errors.push({ field: 'reference', message: 'Reference is too long' });
  if (t.tags && (t.tags.length > 20 || t.tags.some((x) => !x || x.length > 40))) {
    errors.push({ field: 'tags', message: 'Tags must be 1–40 characters (max 20 tags)' });
  }
  return errors;
}

export function validateAccount(a: Partial<Account>): FieldError[] {
  const errors: FieldError[] = [];
  if (!a.name || !a.name.trim()) errors.push({ field: 'name', message: 'Account name is required' });
  else if (a.name.length > MAX_NAME) errors.push({ field: 'name', message: 'Name is too long' });
  if (!a.type || !ACCOUNT_TYPES.includes(a.type)) errors.push({ field: 'type', message: 'Choose an account type' });
  if (!a.currency || !/^[A-Z]{3}$/.test(a.currency)) errors.push({ field: 'currency', message: 'Choose a valid currency' });
  if (typeof a.openingBalanceMinor !== 'number' || !Number.isInteger(a.openingBalanceMinor) || Math.abs(a.openingBalanceMinor) > MAX_MINOR) {
    errors.push({ field: 'openingBalanceMinor', message: 'Opening balance must be a valid amount' });
  }
  return errors;
}

export function validateCategory(c: Partial<Category>, existing: Category[] = []): FieldError[] {
  const errors: FieldError[] = [];
  const name = (c.name ?? '').trim();
  if (!name) errors.push({ field: 'name', message: 'Category name is required' });
  else if (name.length > 40) errors.push({ field: 'name', message: 'Name is too long' });
  if (c.kind !== 'income' && c.kind !== 'expense') errors.push({ field: 'kind', message: 'Choose income or expense' });
  if (
    name &&
    existing.some((e) => e.id !== c.id && !e.archived && e.kind === c.kind && e.name.trim().toLowerCase() === name.toLowerCase())
  ) {
    errors.push({ field: 'name', message: 'A category with this name already exists' });
  }
  return errors;
}

export function validateReminder(r: Partial<Reminder>): FieldError[] {
  const errors: FieldError[] = [];
  if (!r.title || !r.title.trim()) errors.push({ field: 'title', message: 'Title is required' });
  if (!isValidTime(r.timeOfDay)) errors.push({ field: 'timeOfDay', message: 'Enter a valid time' });
  if (r.kind === 'custom' && (!r.date || !isValidISODate(r.date))) errors.push({ field: 'date', message: 'Enter a valid date' });
  if (r.kind === 'debt' && (r.offsetDays == null || r.offsetDays < 0 || r.offsetDays > 365)) {
    errors.push({ field: 'offsetDays', message: 'Days before must be between 0 and 365' });
  }
  return errors;
}

/**
 * Detects a probable accidental duplicate: same type, amount, account, date and
 * category/description, created within `windowMinutes` of a previous entry.
 */
export function findProbableDuplicate(
  candidate: Pick<Transaction, 'type' | 'amountMinor' | 'accountId' | 'date' | 'categoryId' | 'description'> & { id?: string },
  recent: Pick<Transaction, 'id' | 'type' | 'amountMinor' | 'accountId' | 'date' | 'categoryId' | 'description' | 'createdAt'>[],
  windowMinutes = 10,
  now: Date = new Date(),
): string | null {
  const cutoff = now.getTime() - windowMinutes * 60_000;
  for (const r of recent) {
    if (r.id === candidate.id) continue;
    if (
      r.type === candidate.type &&
      r.amountMinor === candidate.amountMinor &&
      r.accountId === candidate.accountId &&
      r.date === candidate.date &&
      (r.categoryId ?? null) === (candidate.categoryId ?? null) &&
      (r.description ?? '').trim().toLowerCase() === (candidate.description ?? '').trim().toLowerCase() &&
      new Date(r.createdAt).getTime() >= cutoff
    ) {
      return r.id;
    }
  }
  return null;
}

export function firstError(errors: FieldError[], field?: string): string | undefined {
  return (field ? errors.find((e) => e.field === field) : errors[0])?.message;
}

export function sanitizeText(s: string | null | undefined, max = MAX_TEXT): string {
  // Strip control characters (except newline/tab) and trim to length.
  return (s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, max).trim();
}
