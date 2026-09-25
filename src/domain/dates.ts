import type { ISODate } from './types';

/**
 * Calendar-date utilities. Dates are plain `YYYY-MM-DD` strings; arithmetic is
 * done in UTC so daylight-saving shifts never move a date.
 */

const DAY_MS = 86_400_000;

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
export const MONTH_SHORT = MONTH_NAMES.map((m) => m.slice(0, 3));
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function isValidISODate(s: unknown): s is ISODate {
  if (typeof s !== 'string') return false;
  const m = ISO_RE.exec(s);
  if (!m) return false;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  if (y < 1900 || y > 2200 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

export function parts(date: ISODate): { y: number; m: number; d: number } {
  const m = ISO_RE.exec(date);
  if (!m) throw new Error(`Invalid date: ${date}`);
  return { y: +m[1], m: +m[2], d: +m[3] };
}

export function fromParts(y: number, m: number, d: number): ISODate {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function toUTC(date: ISODate): number {
  const { y, m, d } = parts(date);
  return Date.UTC(y, m - 1, d);
}

function fromUTC(ms: number): ISODate {
  const dt = new Date(ms);
  return fromParts(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** Local calendar date of a JS Date (device timezone). */
export function toISODate(d: Date = new Date()): ISODate {
  return fromParts(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

export function today(): ISODate {
  return toISODate(new Date());
}

export function nowTime(d: Date = new Date()): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function isValidTime(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  return !!m && +m[1] < 24 && +m[2] < 60;
}

/** Local Date object for a calendar date at a given HH:MM. */
export function toLocalDateTime(date: ISODate, time = '09:00'): Date {
  const { y, m, d } = parts(date);
  const [hh, mm] = (isValidTime(time) ? time : '09:00').split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

export function addDays(date: ISODate, days: number): ISODate {
  return fromUTC(toUTC(date) + days * DAY_MS);
}

/** Adds months, clamping the day to the target month length (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(date: ISODate, months: number, anchorDay?: number): ISODate {
  const { y, m, d } = parts(date);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const day = Math.min(anchorDay ?? d, daysInMonth(ny, nm));
  return fromParts(ny, nm, day);
}

export function addYears(date: ISODate, years: number, anchorDay?: number): ISODate {
  return addMonths(date, years * 12, anchorDay);
}

/** Whole days from a to b (b − a). */
export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((toUTC(b) - toUTC(a)) / DAY_MS);
}

export function compareDates(a: ISODate, b: ISODate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minDate(a: ISODate, b: ISODate): ISODate {
  return a <= b ? a : b;
}

export function maxDate(a: ISODate, b: ISODate): ISODate {
  return a >= b ? a : b;
}

export function weekday(date: ISODate): number {
  return new Date(toUTC(date)).getUTCDay();
}

export function startOfWeek(date: ISODate, weekStartsOn: 0 | 1 = 1): ISODate {
  const wd = weekday(date);
  const diff = (wd - weekStartsOn + 7) % 7;
  return addDays(date, -diff);
}

export function endOfWeek(date: ISODate, weekStartsOn: 0 | 1 = 1): ISODate {
  return addDays(startOfWeek(date, weekStartsOn), 6);
}

export function startOfMonth(date: ISODate): ISODate {
  const { y, m } = parts(date);
  return fromParts(y, m, 1);
}

export function endOfMonth(date: ISODate): ISODate {
  const { y, m } = parts(date);
  return fromParts(y, m, daysInMonth(y, m));
}

export function startOfYear(date: ISODate): ISODate {
  return `${parts(date).y}-01-01`;
}

export function endOfYear(date: ISODate): ISODate {
  return `${parts(date).y}-12-31`;
}

export function monthKey(date: ISODate): string {
  return date.slice(0, 7);
}

/** Inclusive number of days in [start, end]. */
export function daysInRange(start: ISODate, end: ISODate): number {
  return diffDays(start, end) + 1;
}

export function eachDay(start: ISODate, end: ISODate): ISODate[] {
  const out: ISODate[] = [];
  let d = start;
  let guard = 0;
  while (d <= end && guard++ < 3700) {
    out.push(d);
    d = addDays(d, 1);
  }
  return out;
}

export function eachMonth(start: ISODate, end: ISODate): string[] {
  const out: string[] = [];
  let d = startOfMonth(start);
  let guard = 0;
  while (d <= end && guard++ < 1200) {
    out.push(monthKey(d));
    d = addMonths(d, 1);
  }
  return out;
}

export function formatDate(date: ISODate, style: 'short' | 'medium' | 'long' = 'medium'): string {
  if (!isValidISODate(date)) return '—';
  const { y, m, d } = parts(date);
  if (style === 'short') return `${d} ${MONTH_SHORT[m - 1]}`;
  if (style === 'long') return `${WEEKDAY_SHORT[weekday(date)]}, ${d} ${MONTH_NAMES[m - 1]} ${y}`;
  return `${d} ${MONTH_SHORT[m - 1]} ${y}`;
}

export function formatMonthKey(key: string, short = false): string {
  const [y, m] = key.split('-').map(Number);
  return `${(short ? MONTH_SHORT : MONTH_NAMES)[m - 1]} ${short ? String(y).slice(2) : y}`;
}

/** "today", "tomorrow", "in 3 days", "3 days ago". */
export function relativeDays(date: ISODate, ref: ISODate = today()): string {
  const n = diffDays(ref, date);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  if (n > 0) return `in ${n} days`;
  return `${-n} days ago`;
}

// ------------------------------------------------------------------ Periods
export type PeriodPreset =
  | 'today'
  | 'this_week'
  | 'this_month'
  | 'last_month'
  | 'last_3_months'
  | 'last_6_months'
  | 'this_year'
  | 'custom';

export const PERIOD_PRESETS: { key: PeriodPreset; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'this_week', label: 'This week' },
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'last_3_months', label: 'Last 3 months' },
  { key: 'last_6_months', label: 'Last 6 months' },
  { key: 'this_year', label: 'This year' },
  { key: 'custom', label: 'Custom' },
];

export interface DateRange {
  start: ISODate;
  end: ISODate;
}

export function periodRange(
  preset: PeriodPreset,
  ref: ISODate = today(),
  weekStartsOn: 0 | 1 = 1,
  custom?: DateRange,
): DateRange {
  switch (preset) {
    case 'today':
      return { start: ref, end: ref };
    case 'this_week':
      return { start: startOfWeek(ref, weekStartsOn), end: endOfWeek(ref, weekStartsOn) };
    case 'this_month':
      return { start: startOfMonth(ref), end: endOfMonth(ref) };
    case 'last_month': {
      const s = addMonths(startOfMonth(ref), -1);
      return { start: s, end: endOfMonth(s) };
    }
    case 'last_3_months':
      return { start: addMonths(startOfMonth(ref), -2), end: endOfMonth(ref) };
    case 'last_6_months':
      return { start: addMonths(startOfMonth(ref), -5), end: endOfMonth(ref) };
    case 'this_year':
      return { start: startOfYear(ref), end: endOfYear(ref) };
    case 'custom':
      if (custom && isValidISODate(custom.start) && isValidISODate(custom.end) && custom.start <= custom.end) {
        return custom;
      }
      return { start: startOfMonth(ref), end: endOfMonth(ref) };
  }
}

/** Previous range of the same length (for "vs previous period" comparisons). */
export function previousRange(range: DateRange): DateRange {
  const len = daysInRange(range.start, range.end);
  // Whole-month ranges compare against the previous whole months.
  if (range.start === startOfMonth(range.start) && range.end === endOfMonth(range.end)) {
    const months = eachMonth(range.start, range.end).length;
    const start = addMonths(range.start, -months);
    return { start, end: addDays(range.start, -1) };
  }
  return { start: addDays(range.start, -len), end: addDays(range.start, -1) };
}

export function inRange(date: ISODate, range: DateRange): boolean {
  return date >= range.start && date <= range.end;
}
