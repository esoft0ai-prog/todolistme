import { getCurrency } from './currency';
import type { CurrencyCode } from './types';

/** Largest amount accepted anywhere in the app (in major units). Keeps math far from float precision limits. */
export const MAX_MAJOR_AMOUNT = 999_999_999_999; // just under 1 trillion

export function pow10(decimals: number): number {
  return Math.pow(10, decimals);
}

export function toMinor(major: number, currency: CurrencyCode): number {
  const d = getCurrency(currency).decimals;
  return Math.round(major * pow10(d));
}

export function toMajor(minor: number, currency: CurrencyCode): number {
  const d = getCurrency(currency).decimals;
  return minor / pow10(d);
}

export type ParseResult = { ok: true; minor: number } | { ok: false; error: string };

/**
 * Parses user input like "25000", "25,000.50", "₦25,000", "25k", "1.5m", "2bn" into minor units.
 * Negative values are rejected unless `allowNegative` is set.
 */
export function parseAmount(
  input: string,
  currency: CurrencyCode,
  opts: { allowZero?: boolean; allowNegative?: boolean } = {},
): ParseResult {
  if (input == null) return { ok: false, error: 'Enter an amount' };
  let s = String(input).trim().toLowerCase();
  if (!s) return { ok: false, error: 'Enter an amount' };
  let negative = false;
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1).trim();
  }
  // Strip currency symbols/codes and spaces.
  const info = getCurrency(currency);
  s = s.split(info.symbol.toLowerCase()).join('');
  s = s.replace(new RegExp(`^${info.code.toLowerCase()}`), '');
  s = s.replace(/[₦$€£¥₹\s]/g, '').replace(/,/g, '');
  let multiplier = 1;
  const suffix = s.match(/(k|m|bn|b)$/);
  if (suffix) {
    multiplier = suffix[1] === 'k' ? 1e3 : suffix[1] === 'm' ? 1e6 : 1e9;
    s = s.slice(0, -suffix[1].length);
  }
  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return { ok: false, error: 'Amount must be a valid number' };
  const value = parseFloat(s) * multiplier;
  if (!Number.isFinite(value)) return { ok: false, error: 'Amount must be a valid number' };
  if (value > MAX_MAJOR_AMOUNT) return { ok: false, error: 'Amount is too large' };
  if (negative && !opts.allowNegative) return { ok: false, error: 'Amount cannot be negative' };
  const decimalsGiven = s.includes('.') && multiplier === 1 ? s.split('.')[1].length : 0;
  if (decimalsGiven > info.decimals) {
    return {
      ok: false,
      error: info.decimals === 0 ? `${info.code} has no decimal places` : `Use at most ${info.decimals} decimal places`,
    };
  }
  const minor = Math.round(value * pow10(info.decimals)) * (negative ? -1 : 1);
  if (minor === 0 && !opts.allowZero) return { ok: false, error: 'Amount must be greater than zero' };
  return { ok: true, minor };
}

function groupThousands(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export interface FormatOptions {
  /** Show +/− sign explicitly. */
  signed?: boolean;
  /** Compact: 1.2K, 3.4M, 1.1B. */
  compact?: boolean;
  /** Hide the minor part when it's zero (e.g. ₦25,000 instead of ₦25,000.00). */
  trimZeroMinor?: boolean;
  /** Omit symbol. */
  noSymbol?: boolean;
}

/** Deterministic money formatter (does not depend on device Intl support). */
export function formatMoney(minor: number, currency: CurrencyCode, opts: FormatOptions = {}): string {
  const info = getCurrency(currency);
  const safe = Number.isFinite(minor) ? minor : 0;
  const neg = safe < 0;
  const abs = Math.abs(safe);
  const major = abs / pow10(info.decimals);
  let body: string;
  if (opts.compact && major >= 1000) {
    const units: [number, string][] = [
      [1e12, 'T'],
      [1e9, 'B'],
      [1e6, 'M'],
      [1e3, 'K'],
    ];
    const [div, label] = units.find(([d]) => major >= d)!;
    const v = major / div;
    const str = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
    body = `${str.replace(/\.?0+$/, '')}${label}`;
  } else {
    const fixed = major.toFixed(info.decimals);
    let [intPart, frac] = fixed.split('.');
    intPart = groupThousands(intPart);
    if (frac && (opts.trimZeroMinor ?? true) && /^0+$/.test(frac)) frac = '';
    body = frac ? `${intPart}.${frac}` : intPart;
  }
  const symbol = opts.noSymbol ? '' : info.symbol;
  const sep = symbol.length > 1 && /[A-Za-z]$/.test(symbol) ? ' ' : '';
  const sign = neg ? '−' : opts.signed && safe > 0 ? '+' : '';
  return `${sign}${symbol}${sep}${body}`;
}

/** Formats minor units for an editable input field (no symbol, no grouping). */
export function minorToInput(minor: number, currency: CurrencyCode): string {
  const info = getCurrency(currency);
  const major = minor / pow10(info.decimals);
  const s = major.toFixed(info.decimals);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** Convert an amount in `currency` into base currency minor units using a rate (1 unit currency = rate base). */
export function convertMinor(
  minor: number,
  from: CurrencyCode,
  to: CurrencyCode,
  rate: number,
): number {
  if (from === to) return minor;
  const fromD = getCurrency(from).decimals;
  const toD = getCurrency(to).decimals;
  const major = minor / pow10(fromD);
  return Math.round(major * rate * pow10(toD));
}

export function sumMinor(values: number[]): number {
  let t = 0;
  for (const v of values) t += v;
  return t;
}

/** Safe percentage (0..∞) with zero-denominator handling. */
export function ratio(part: number, whole: number): number {
  if (!whole) return 0;
  return part / whole;
}

export function formatPercent(r: number, digits = 0): string {
  if (!Number.isFinite(r)) return '—';
  return `${(r * 100).toFixed(digits)}%`;
}
