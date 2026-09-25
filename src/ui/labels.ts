import type {
  AccountType,
  DebtType,
  InterestType,
  PaymentFrequency,
  PaymentMethod,
  RecurrenceFrequency,
  TransactionType,
} from '../domain/types';
import type { Palette } from './theme';

export const TX_TYPE_LABEL: Record<TransactionType, string> = {
  income: 'Income',
  expense: 'Expense',
  transfer: 'Transfer',
  debt_repayment: 'Debt repayment',
  loan_received: 'Loan received',
  savings_deposit: 'Savings deposit',
  savings_withdrawal: 'Savings withdrawal',
};

export const TX_TYPE_ICON: Record<TransactionType, string> = {
  income: 'arrow-down-circle',
  expense: 'arrow-up-circle',
  transfer: 'swap-horizontal',
  debt_repayment: 'card',
  loan_received: 'cash',
  savings_deposit: 'wallet',
  savings_withdrawal: 'exit',
};

/** Sign of a transaction's effect on the user's spendable money. */
export function txSign(type: TransactionType): 1 | -1 | 0 {
  if (type === 'income' || type === 'loan_received' || type === 'savings_withdrawal') return 1;
  if (type === 'transfer') return 0;
  return -1;
}

export function txColor(c: Palette, type: TransactionType): string {
  switch (type) {
    case 'income':
      return c.success;
    case 'expense':
      return c.danger;
    case 'transfer':
      return c.info;
    case 'debt_repayment':
      return c.warning;
    case 'loan_received':
      return c.primary;
    default:
      return c.accent;
  }
}

export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  cash: 'Cash',
  bank: 'Bank account',
  mobile_wallet: 'Mobile wallet',
  savings: 'Savings',
  business: 'Business account',
  other: 'Other',
};

export const ACCOUNT_TYPE_ICON: Record<AccountType, string> = {
  cash: 'cash',
  bank: 'business',
  mobile_wallet: 'phone-portrait',
  savings: 'shield-checkmark',
  business: 'briefcase',
  other: 'wallet',
};

export const DEBT_TYPE_LABEL: Record<DebtType, string> = {
  personal_loan: 'Personal loan',
  bank_loan: 'Bank loan',
  loan_app: 'Loan app',
  family: 'Family',
  friend: 'Friend',
  business: 'Business debt',
  credit_purchase: 'Credit purchase',
  other: 'Other',
};

export const DEBT_TYPE_ICON: Record<DebtType, string> = {
  personal_loan: 'person',
  bank_loan: 'business',
  loan_app: 'phone-portrait',
  family: 'home',
  friend: 'people',
  business: 'briefcase',
  credit_purchase: 'cart',
  other: 'document-text',
};

export const INTEREST_LABEL: Record<InterestType, { label: string; help: string }> = {
  none: { label: 'No interest', help: 'You repay exactly what you borrowed.' },
  fixed_amount: { label: 'Fixed interest amount', help: 'A fixed extra amount on top of the principal (e.g. ₦10,000).' },
  flat_percentage: { label: 'Flat percentage', help: 'A one-off % of the principal for the whole loan — common with loan apps (e.g. 15%).' },
  simple_annual: { label: 'Simple interest (per year)', help: 'Annual rate × principal × time. Interest does not compound.' },
  reducing_balance: { label: 'Reducing balance (amortised)', help: 'Bank-style loan: fixed instalments, interest charged on the remaining balance.' },
  custom_schedule: { label: 'Custom repayment schedule', help: 'Enter each instalment date and amount yourself.' },
};

export const PAYMENT_FREQ_LABEL: Record<PaymentFrequency, string> = {
  one_time: 'One-time (lump sum)',
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
};

export const RECURRENCE_LABEL: Record<RecurrenceFrequency, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
  custom: 'Custom',
};

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: 'Cash',
  bank_transfer: 'Bank transfer',
  card: 'Card',
  ussd: 'USSD',
  pos: 'POS',
  mobile_money: 'Mobile money',
  cheque: 'Cheque',
  other: 'Other',
};

export const CATEGORY_ICONS = [
  'fast-food', 'restaurant', 'cafe', 'car', 'bus', 'bicycle', 'airplane', 'home', 'flash', 'water', 'wifi', 'call', 'school', 'book',
  'medkit', 'fitness', 'people', 'heart', 'film', 'musical-notes', 'game-controller', 'bag-handle', 'shirt', 'cart', 'gift', 'briefcase',
  'storefront', 'laptop', 'trending-up', 'cash', 'card', 'wallet', 'construct', 'paw', 'football', 'globe', 'pricetag', 'sparkles',
  'ellipsis-horizontal-circle',
];

export const COLOR_SWATCHES = ['#7C8CFF', '#22D3A6', '#FFB547', '#FF5C7A', '#38BDF8', '#C084FC', '#F472B6', '#A3E635', '#FB923C', '#94A3B8', '#2DD4BF', '#FACC15'];
