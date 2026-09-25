/**
 * Core domain types for Finora.
 *
 * Conventions:
 *  - All monetary amounts are stored as integers in the currency's minor unit
 *    (e.g. kobo for NGN, cents for USD). Field names end with `Minor`.
 *  - Calendar dates are ISO strings `YYYY-MM-DD` (local calendar date, no timezone).
 *  - Timestamps are ISO-8601 strings with timezone (`new Date().toISOString()`).
 *  - IDs are UUID v4 strings so that records can be merged across devices/backups.
 */

export type ID = string;
export type ISODate = string; // YYYY-MM-DD
export type ISODateTime = string; // full ISO timestamp
export type CurrencyCode = string; // ISO 4217, e.g. NGN

export interface Timestamps {
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// ---------------------------------------------------------------- Accounts
export type AccountType = 'cash' | 'bank' | 'mobile_wallet' | 'savings' | 'business' | 'other';

export const ACCOUNT_TYPES: AccountType[] = ['cash', 'bank', 'mobile_wallet', 'savings', 'business', 'other'];

export interface Account extends Timestamps {
  id: ID;
  name: string;
  type: AccountType;
  currency: CurrencyCode;
  openingBalanceMinor: number;
  color: string | null;
  icon: string | null;
  archived: boolean;
  isDemo: boolean;
}

export interface AccountWithBalance extends Account {
  balanceMinor: number;
}

// ---------------------------------------------------------------- Categories
export type CategoryKind = 'income' | 'expense';

export interface Category extends Timestamps {
  id: ID;
  name: string;
  kind: CategoryKind;
  icon: string;
  color: string;
  isSystem: boolean;
  archived: boolean;
  isDemo: boolean;
}

// ---------------------------------------------------------------- Transactions
export type TransactionType =
  | 'income'
  | 'expense'
  | 'transfer'
  | 'debt_repayment'
  | 'loan_received'
  | 'savings_deposit'
  | 'savings_withdrawal';

export const TRANSACTION_TYPES: TransactionType[] = [
  'income',
  'expense',
  'transfer',
  'debt_repayment',
  'loan_received',
  'savings_deposit',
  'savings_withdrawal',
];

export type PaymentMethod = 'cash' | 'bank_transfer' | 'card' | 'ussd' | 'pos' | 'mobile_money' | 'cheque' | 'other';

export const PAYMENT_METHODS: PaymentMethod[] = [
  'cash',
  'bank_transfer',
  'card',
  'ussd',
  'pos',
  'mobile_money',
  'cheque',
  'other',
];

export interface Transaction extends Timestamps {
  id: ID;
  type: TransactionType;
  /** Amount in `currency` minor units. Always positive; `type` determines direction. */
  amountMinor: number;
  currency: CurrencyCode;
  /** Amount converted into the base currency at the time of entry. */
  baseAmountMinor: number;
  /** Rate used: 1 unit of `currency` = fxRate units of base currency. */
  fxRate: number;
  date: ISODate;
  time: string | null; // HH:MM
  accountId: ID;
  /** Destination account for transfers / linked savings accounts. */
  toAccountId: ID | null;
  /** Amount credited to `toAccountId` (in that account's currency) for cross-currency transfers. */
  toAmountMinor: number | null;
  categoryId: ID | null;
  debtId: ID | null;
  goalId: ID | null;
  recurringId: ID | null;
  description: string;
  paymentMethod: PaymentMethod | null;
  notes: string | null;
  reference: string | null;
  tags: string[];
  isDemo: boolean;
}

export type TransactionInput = Omit<
  Transaction,
  'id' | 'createdAt' | 'updatedAt' | 'baseAmountMinor' | 'fxRate' | 'currency' | 'isDemo'
> & { currency?: CurrencyCode; isDemo?: boolean };

// ---------------------------------------------------------------- Budgets
export type BudgetPeriod = 'weekly' | 'monthly' | 'custom';

export interface Budget extends Timestamps {
  id: ID;
  name: string;
  period: BudgetPeriod;
  limitMinor: number;
  /** For custom budgets: explicit range. For weekly/monthly: anchor (first period start). */
  startDate: ISODate;
  endDate: ISODate | null;
  /** Empty = all expense categories. */
  categoryIds: ID[];
  alertThreshold: number; // 0..1, e.g. 0.8
  archived: boolean;
  isDemo: boolean;
}

// ---------------------------------------------------------------- Debts
export type DebtType =
  | 'personal_loan'
  | 'bank_loan'
  | 'loan_app'
  | 'family'
  | 'friend'
  | 'business'
  | 'credit_purchase'
  | 'other';

export const DEBT_TYPES: DebtType[] = [
  'personal_loan',
  'bank_loan',
  'loan_app',
  'family',
  'friend',
  'business',
  'credit_purchase',
  'other',
];

/**
 * - none: no interest.
 * - fixed_amount: a fixed interest/fee amount (interestValue is minor units).
 * - flat_percentage: flat percentage of principal for the whole loan (typical for loan apps).
 * - simple_annual: simple interest, annual rate % × principal × years.
 * - reducing_balance: amortised loan, annual rate % compounded per payment period.
 * - custom_schedule: user-defined instalments; interest = sum(instalments) − principal.
 */
export type InterestType =
  | 'none'
  | 'fixed_amount'
  | 'flat_percentage'
  | 'simple_annual'
  | 'reducing_balance'
  | 'custom_schedule';

export const INTEREST_TYPES: InterestType[] = [
  'none',
  'fixed_amount',
  'flat_percentage',
  'simple_annual',
  'reducing_balance',
  'custom_schedule',
];

export type PaymentFrequency = 'one_time' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';

export const PAYMENT_FREQUENCIES: PaymentFrequency[] = [
  'one_time',
  'weekly',
  'biweekly',
  'monthly',
  'quarterly',
  'yearly',
];

export type DebtStatus = 'active' | 'paid_off' | 'archived';

export type PenaltyType = 'none' | 'fixed' | 'percentage';

export interface DebtScheduleItem {
  id: ID;
  debtId: ID;
  dueDate: ISODate;
  amountMinor: number;
}

export interface Debt extends Timestamps {
  id: ID;
  lenderName: string;
  debtType: DebtType;
  currency: CurrencyCode;
  principalMinor: number;
  interestType: InterestType;
  /** Percent for percentage-based types, minor units for fixed_amount. */
  interestValue: number;
  paymentFrequency: PaymentFrequency;
  /** Instalment amount per period. 0 = derive from total payable / number of payments. */
  minimumPaymentMinor: number;
  /** Number of instalments; 0 = derive from end date. */
  installmentCount: number;
  startDate: ISODate;
  firstDueDate: ISODate;
  endDate: ISODate | null;
  penaltyType: PenaltyType;
  penaltyValue: number;
  /** Amount already repaid before the debt was recorded in Finora. */
  paidBeforeMinor: number;
  notes: string | null;
  status: DebtStatus;
  /** Optional manual override of the total payable. */
  totalPayableOverrideMinor: number | null;
  isDemo: boolean;
}

export type DebtPaymentKind = 'payment' | 'penalty' | 'adjustment';

export interface DebtPayment extends Timestamps {
  id: ID;
  debtId: ID;
  kind: DebtPaymentKind;
  amountMinor: number;
  date: ISODate;
  transactionId: ID | null;
  notes: string | null;
  isDemo: boolean;
}

// ---------------------------------------------------------------- Savings goals
export interface SavingsGoal extends Timestamps {
  id: ID;
  name: string;
  targetMinor: number;
  currency: CurrencyCode;
  initialMinor: number;
  startDate: ISODate;
  deadline: ISODate | null;
  linkedAccountId: ID | null;
  icon: string;
  color: string;
  reminderFrequency: 'none' | 'weekly' | 'monthly';
  status: 'active' | 'completed' | 'archived';
  notes: string | null;
  isDemo: boolean;
}

// ---------------------------------------------------------------- Recurring
export type RecurrenceFrequency =
  | 'daily'
  | 'weekly'
  | 'biweekly'
  | 'monthly'
  | 'quarterly'
  | 'yearly'
  | 'custom';

export const RECURRENCE_FREQUENCIES: RecurrenceFrequency[] = [
  'daily',
  'weekly',
  'biweekly',
  'monthly',
  'quarterly',
  'yearly',
  'custom',
];

export type CustomUnit = 'day' | 'week' | 'month' | 'year';

export interface RecurrenceRule {
  frequency: RecurrenceFrequency;
  /** For `custom`: every N units. */
  interval: number;
  unit: CustomUnit;
  startDate: ISODate;
  endDate: ISODate | null;
}

export interface RecurringTransaction extends Timestamps, RecurrenceRule {
  id: ID;
  type: Exclude<TransactionType, 'loan_received'>;
  amountMinor: number;
  accountId: ID;
  toAccountId: ID | null;
  categoryId: ID | null;
  debtId: ID | null;
  goalId: ID | null;
  description: string;
  paymentMethod: PaymentMethod | null;
  isBill: boolean;
  autoCreate: boolean;
  remindDaysBefore: number; // -1 = no reminder
  lastGeneratedDate: ISODate | null;
  active: boolean;
  isDemo: boolean;
}

// ---------------------------------------------------------------- Reminders
export type ReminderKind = 'debt' | 'custom' | 'bill' | 'savings';

export interface Reminder extends Timestamps {
  id: ID;
  kind: ReminderKind;
  entityId: ID | null;
  title: string;
  message: string;
  /** For debt reminders: days before due date (0 = on due date). */
  offsetDays: number | null;
  /** For custom reminders: first fire date. */
  date: ISODate | null;
  timeOfDay: string; // HH:MM
  repeat: 'none' | RecurrenceFrequency;
  enabled: boolean;
  isDemo: boolean;
}

export type NotificationChannel = 'debts' | 'bills' | 'budgets' | 'savings' | 'reminders' | 'general';

export const NOTIFICATION_CHANNELS: NotificationChannel[] = [
  'debts',
  'bills',
  'budgets',
  'savings',
  'reminders',
  'general',
];

export interface NotificationRecord {
  id: ID;
  key: string;
  channel: NotificationChannel;
  title: string;
  body: string;
  firedAt: ISODateTime;
  entityType: string | null;
  entityId: ID | null;
  read: boolean;
}

/** A calendar event (user-defined one-off bill / income date / note). */
export interface FinancialEvent extends Timestamps {
  id: ID;
  title: string;
  date: ISODate;
  kind: 'bill' | 'income' | 'savings' | 'note';
  amountMinor: number | null;
  notes: string | null;
  remind: boolean;
  isDemo: boolean;
}

// ---------------------------------------------------------------- Preferences
export type ThemeMode = 'dark' | 'light' | 'system';

export interface Preferences {
  baseCurrency: CurrencyCode;
  locale: string;
  themeMode: ThemeMode;
  monthlyIncomeMinor: number;
  mainGoal: string;
  onboardingComplete: boolean;
  notificationsEnabled: boolean;
  notificationChannels: Record<NotificationChannel, boolean>;
  reminderTime: string; // HH:MM default time for reminders
  defaultDebtReminderOffsets: number[];
  appLockEnabled: boolean;
  biometricEnabled: boolean;
  autoLockSeconds: number;
  hideInRecents: boolean;
  weekStartsOn: 0 | 1; // 0 = Sunday, 1 = Monday
  largeText: boolean;
  demoDataLoaded: boolean;
  duplicateWindowMinutes: number;
}

export interface ExchangeRate {
  currency: CurrencyCode;
  /** 1 unit of currency = rate units of base currency. */
  rate: number;
  updatedAt: ISODateTime;
}
