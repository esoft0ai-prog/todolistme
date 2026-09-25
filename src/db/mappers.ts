import type {
  Account,
  Budget,
  Category,
  Debt,
  DebtPayment,
  DebtScheduleItem,
  FinancialEvent,
  NotificationRecord,
  RecurringTransaction,
  Reminder,
  SavingsGoal,
  Transaction,
} from '../domain/types';

/** Row ↔ entity mapping. Rows use snake_case columns and 0/1 booleans. */

type R = Record<string, any>;
const b = (v: unknown) => v === 1 || v === true || v === '1';
const n = (v: unknown) => (v == null ? 0 : Number(v));
const nn = (v: unknown) => (v == null ? null : Number(v));
const s = (v: unknown) => (v == null ? '' : String(v));
const sn = (v: unknown) => (v == null ? null : String(v));

export const mapAccount = (r: R): Account => ({
  id: r.id,
  name: r.name,
  type: r.type,
  currency: r.currency,
  openingBalanceMinor: n(r.opening_balance_minor),
  color: sn(r.color),
  icon: sn(r.icon),
  archived: b(r.archived),
  isDemo: b(r.is_demo),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const mapCategory = (r: R): Category => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  icon: r.icon,
  color: r.color,
  isSystem: b(r.is_system),
  archived: b(r.archived),
  isDemo: b(r.is_demo),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const mapTransaction = (r: R, tags: string[] = []): Transaction => ({
  id: r.id,
  type: r.type,
  amountMinor: n(r.amount_minor),
  currency: r.currency,
  baseAmountMinor: n(r.base_amount_minor),
  fxRate: Number(r.fx_rate ?? 1),
  date: r.date,
  time: sn(r.time),
  accountId: r.account_id,
  toAccountId: sn(r.to_account_id),
  toAmountMinor: nn(r.to_amount_minor),
  categoryId: sn(r.category_id),
  debtId: sn(r.debt_id),
  goalId: sn(r.goal_id),
  recurringId: sn(r.recurring_id),
  description: s(r.description),
  paymentMethod: r.payment_method ?? null,
  notes: sn(r.notes),
  reference: sn(r.reference),
  tags: r.tag_names ? String(r.tag_names).split('\u001f').filter(Boolean) : tags,
  isDemo: b(r.is_demo),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const mapBudget = (r: R, categoryIds: string[] = []): Budget => ({
  id: r.id,
  name: r.name,
  period: r.period,
  limitMinor: n(r.limit_minor),
  startDate: r.start_date,
  endDate: sn(r.end_date),
  categoryIds: r.category_ids ? String(r.category_ids).split(',').filter(Boolean) : categoryIds,
  alertThreshold: Number(r.alert_threshold ?? 0.8),
  archived: b(r.archived),
  isDemo: b(r.is_demo),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const mapDebt = (r: R): Debt => ({
  id: r.id,
  lenderName: r.lender_name,
  debtType: r.debt_type,
  currency: r.currency,
  principalMinor: n(r.principal_minor),
  interestType: r.interest_type,
  interestValue: Number(r.interest_value ?? 0),
  paymentFrequency: r.payment_frequency,
  minimumPaymentMinor: n(r.minimum_payment_minor),
  installmentCount: n(r.installment_count),
  startDate: r.start_date,
  firstDueDate: r.first_due_date,
  endDate: sn(r.end_date),
  penaltyType: r.penalty_type,
  penaltyValue: Number(r.penalty_value ?? 0),
  paidBeforeMinor: n(r.paid_before_minor),
  totalPayableOverrideMinor: nn(r.total_payable_override_minor),
  notes: sn(r.notes),
  status: r.status,
  isDemo: b(r.is_demo),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const mapDebtPayment = (r: R): DebtPayment => ({
  id: r.id,
  debtId: r.debt_id,
  kind: r.kind,
  amountMinor: n(r.amount_minor),
  date: r.date,
  transactionId: sn(r.transaction_id),
  notes: sn(r.notes),
  isDemo: b(r.is_demo),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const mapSchedule = (r: R): DebtScheduleItem => ({
  id: r.id,
  debtId: r.debt_id,
  dueDate: r.due_date,
  amountMinor: n(r.amount_minor),
});

export const mapGoal = (r: R): SavingsGoal => ({
  id: r.id,
  name: r.name,
  targetMinor: n(r.target_minor),
  currency: r.currency,
  initialMinor: n(r.initial_minor),
  startDate: r.start_date,
  deadline: sn(r.deadline),
  linkedAccountId: sn(r.linked_account_id),
  icon: r.icon,
  color: r.color,
  reminderFrequency: r.reminder_frequency,
  status: r.status,
  notes: sn(r.notes),
  isDemo: b(r.is_demo),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const mapRecurring = (r: R): RecurringTransaction => ({
  id: r.id,
  type: r.type,
  amountMinor: n(r.amount_minor),
  accountId: r.account_id,
  toAccountId: sn(r.to_account_id),
  categoryId: sn(r.category_id),
  debtId: sn(r.debt_id),
  goalId: sn(r.goal_id),
  description: s(r.description),
  paymentMethod: r.payment_method ?? null,
  frequency: r.frequency,
  interval: n(r.interval) || 1,
  unit: r.unit,
  startDate: r.start_date,
  endDate: sn(r.end_date),
  isBill: b(r.is_bill),
  autoCreate: b(r.auto_create),
  remindDaysBefore: Number(r.remind_days_before ?? -1),
  lastGeneratedDate: sn(r.last_generated_date),
  active: b(r.active),
  isDemo: b(r.is_demo),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const mapReminder = (r: R): Reminder => ({
  id: r.id,
  kind: r.kind,
  entityId: sn(r.entity_id),
  title: r.title,
  message: s(r.message),
  offsetDays: nn(r.offset_days),
  date: sn(r.date),
  timeOfDay: r.time_of_day,
  repeat: r.repeat,
  enabled: b(r.enabled),
  isDemo: b(r.is_demo),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const mapEvent = (r: R): FinancialEvent => ({
  id: r.id,
  title: r.title,
  date: r.date,
  kind: r.kind,
  amountMinor: nn(r.amount_minor),
  notes: sn(r.notes),
  remind: b(r.remind),
  isDemo: b(r.is_demo),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export const mapNotification = (r: R): NotificationRecord => ({
  id: r.id,
  key: r.key,
  channel: r.channel,
  title: r.title,
  body: r.body,
  firedAt: r.fired_at,
  entityType: sn(r.entity_type),
  entityId: sn(r.entity_id),
  read: b(r.read),
});
