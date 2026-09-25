import type { CurrencyCode } from './types';

export interface CurrencyInfo {
  code: CurrencyCode;
  symbol: string;
  name: string;
  decimals: number;
}

/**
 * Currencies offered in the app. NGN is the default but nothing in the
 * application logic depends on it — any ISO code with a decimals value works.
 */
export const CURRENCIES: CurrencyInfo[] = [
  { code: 'NGN', symbol: '₦', name: 'Nigerian Naira', decimals: 2 },
  { code: 'USD', symbol: '$', name: 'US Dollar', decimals: 2 },
  { code: 'EUR', symbol: '€', name: 'Euro', decimals: 2 },
  { code: 'GBP', symbol: '£', name: 'British Pound', decimals: 2 },
  { code: 'GHS', symbol: 'GH₵', name: 'Ghanaian Cedi', decimals: 2 },
  { code: 'KES', symbol: 'KSh', name: 'Kenyan Shilling', decimals: 2 },
  { code: 'ZAR', symbol: 'R', name: 'South African Rand', decimals: 2 },
  { code: 'XOF', symbol: 'CFA', name: 'West African CFA Franc', decimals: 0 },
  { code: 'XAF', symbol: 'FCFA', name: 'Central African CFA Franc', decimals: 0 },
  { code: 'EGP', symbol: 'E£', name: 'Egyptian Pound', decimals: 2 },
  { code: 'UGX', symbol: 'USh', name: 'Ugandan Shilling', decimals: 0 },
  { code: 'TZS', symbol: 'TSh', name: 'Tanzanian Shilling', decimals: 2 },
  { code: 'RWF', symbol: 'FRw', name: 'Rwandan Franc', decimals: 0 },
  { code: 'CAD', symbol: 'CA$', name: 'Canadian Dollar', decimals: 2 },
  { code: 'AED', symbol: 'AED', name: 'UAE Dirham', decimals: 2 },
  { code: 'INR', symbol: '₹', name: 'Indian Rupee', decimals: 2 },
  { code: 'CNY', symbol: 'CN¥', name: 'Chinese Yuan', decimals: 2 },
  { code: 'JPY', symbol: '¥', name: 'Japanese Yen', decimals: 0 },
];

export const DEFAULT_CURRENCY: CurrencyCode = 'NGN';

const byCode = new Map(CURRENCIES.map((c) => [c.code, c]));

export function getCurrency(code: CurrencyCode): CurrencyInfo {
  return byCode.get(code) ?? { code, symbol: code, name: code, decimals: 2 };
}

export function isKnownCurrency(code: string): boolean {
  return byCode.has(code);
}
