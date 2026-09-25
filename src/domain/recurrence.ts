import { addDays, addMonths, diffDays } from './dates';
import type { ISODate, PaymentFrequency, RecurrenceRule, RecurrenceFrequency, CustomUnit } from './types';

/**
 * Recurrence engine. Every occurrence is computed from the start date and an index
 * (start + n × step) rather than by chaining, so month-end anchors never drift
 * (e.g. monthly on the 31st → 31 Jan, 28 Feb, 31 Mar, 30 Apr …).
 */

interface Step {
  unit: CustomUnit;
  count: number;
}

export function stepFor(frequency: RecurrenceFrequency, interval = 1, unit: CustomUnit = 'month'): Step {
  switch (frequency) {
    case 'daily':
      return { unit: 'day', count: 1 };
    case 'weekly':
      return { unit: 'week', count: 1 };
    case 'biweekly':
      return { unit: 'week', count: 2 };
    case 'monthly':
      return { unit: 'month', count: 1 };
    case 'quarterly':
      return { unit: 'month', count: 3 };
    case 'yearly':
      return { unit: 'year', count: 1 };
    case 'custom':
      return { unit, count: Math.max(1, Math.floor(interval || 1)) };
  }
}

export function paymentFrequencyStep(freq: PaymentFrequency): Step | null {
  if (freq === 'one_time') return null;
  return stepFor(freq);
}

/** The n-th occurrence (0-based) of a step series starting at `start`. */
export function nthOccurrence(start: ISODate, step: Step, n: number): ISODate {
  switch (step.unit) {
    case 'day':
      return addDays(start, n * step.count);
    case 'week':
      return addDays(start, n * step.count * 7);
    case 'month':
      return addMonths(start, n * step.count, Number(start.slice(8, 10)));
    case 'year':
      return addMonths(start, n * step.count * 12, Number(start.slice(8, 10)));
  }
}

/** Approximate step length in days (for estimating the index near a date). */
function approxDays(step: Step): number {
  switch (step.unit) {
    case 'day':
      return step.count;
    case 'week':
      return step.count * 7;
    case 'month':
      return step.count * 30.436875;
    case 'year':
      return step.count * 365.2425;
  }
}

/** First index whose occurrence is >= date. */
function firstIndexOnOrAfter(start: ISODate, step: Step, date: ISODate): number {
  if (date <= start) return 0;
  let n = Math.max(0, Math.floor(diffDays(start, date) / approxDays(step)) - 1);
  let guard = 0;
  while (nthOccurrence(start, step, n) < date && guard++ < 1000) n++;
  while (n > 0 && nthOccurrence(start, step, n - 1) >= date && guard++ < 2000) n--;
  return n;
}

/** All occurrences of a rule within [from, to] (inclusive), capped by `limit`. */
export function occurrencesBetween(rule: RecurrenceRule, from: ISODate, to: ISODate, limit = 500): ISODate[] {
  const step = stepFor(rule.frequency, rule.interval, rule.unit);
  const out: ISODate[] = [];
  const lower = from > rule.startDate ? from : rule.startDate;
  const upper = rule.endDate && rule.endDate < to ? rule.endDate : to;
  if (lower > upper) return out;
  let n = firstIndexOnOrAfter(rule.startDate, step, lower);
  while (out.length < limit) {
    const d = nthOccurrence(rule.startDate, step, n);
    if (d > upper) break;
    out.push(d);
    n++;
  }
  return out;
}

/** Next occurrence strictly after `after` (or on/after when inclusive). */
export function nextOccurrence(rule: RecurrenceRule, after: ISODate, inclusive = false): ISODate | null {
  const step = stepFor(rule.frequency, rule.interval, rule.unit);
  const target = inclusive ? after : addDays(after, 1);
  const n = firstIndexOnOrAfter(rule.startDate, step, target);
  const d = nthOccurrence(rule.startDate, step, n);
  if (rule.endDate && d > rule.endDate) return null;
  return d;
}

/** Converts an amount per occurrence into an average monthly amount. */
export function monthlyEquivalent(amount: number, frequency: RecurrenceFrequency | PaymentFrequency, interval = 1, unit: CustomUnit = 'month'): number {
  if (frequency === 'one_time') return 0;
  const step = stepFor(frequency as RecurrenceFrequency, interval, unit);
  const perYear =
    step.unit === 'day'
      ? 365.2425 / step.count
      : step.unit === 'week'
        ? 52.1775 / step.count
        : step.unit === 'month'
          ? 12 / step.count
          : 1 / step.count;
  return (amount * perYear) / 12;
}

export function describeRule(rule: Pick<RecurrenceRule, 'frequency' | 'interval' | 'unit'>): string {
  switch (rule.frequency) {
    case 'daily':
      return 'Every day';
    case 'weekly':
      return 'Every week';
    case 'biweekly':
      return 'Every 2 weeks';
    case 'monthly':
      return 'Every month';
    case 'quarterly':
      return 'Every 3 months';
    case 'yearly':
      return 'Every year';
    case 'custom': {
      const n = Math.max(1, rule.interval || 1);
      return n === 1 ? `Every ${rule.unit}` : `Every ${n} ${rule.unit}s`;
    }
  }
}
