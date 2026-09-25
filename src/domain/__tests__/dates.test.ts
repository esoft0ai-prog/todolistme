import {
  addDays,
  addMonths,
  diffDays,
  eachMonth,
  endOfMonth,
  formatDate,
  isValidISODate,
  periodRange,
  previousRange,
  relativeDays,
  startOfWeek,
} from '../dates';

describe('date utilities', () => {
  it('validates ISO dates including leap years', () => {
    expect(isValidISODate('2024-02-29')).toBe(true);
    expect(isValidISODate('2025-02-29')).toBe(false);
    expect(isValidISODate('2025-13-01')).toBe(false);
    expect(isValidISODate('2025-1-1')).toBe(false);
    expect(isValidISODate('hello')).toBe(false);
    expect(isValidISODate(null)).toBe(false);
  });

  it('adds days across month and year boundaries', () => {
    expect(addDays('2025-12-31', 1)).toBe('2026-01-01');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
  });

  it('clamps month arithmetic to month end', () => {
    expect(addMonths('2025-01-31', 1)).toBe('2025-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2025-01-31', 2)).toBe('2025-03-31');
    expect(addMonths('2025-03-15', -3)).toBe('2024-12-15');
    expect(addMonths('2025-02-28', 1, 31)).toBe('2025-03-31');
  });

  it('computes day differences', () => {
    expect(diffDays('2025-01-01', '2025-12-31')).toBe(364);
    expect(diffDays('2025-03-10', '2025-03-01')).toBe(-9);
  });

  it('computes week starts for Monday and Sunday weeks', () => {
    // 2025-06-18 is a Wednesday
    expect(startOfWeek('2025-06-18', 1)).toBe('2025-06-16');
    expect(startOfWeek('2025-06-18', 0)).toBe('2025-06-15');
    expect(startOfWeek('2025-06-16', 1)).toBe('2025-06-16');
  });

  it('resolves dashboard period presets', () => {
    const ref = '2026-03-15';
    expect(periodRange('today', ref)).toEqual({ start: ref, end: ref });
    expect(periodRange('this_month', ref)).toEqual({ start: '2026-03-01', end: '2026-03-31' });
    expect(periodRange('last_month', ref)).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(periodRange('last_3_months', ref)).toEqual({ start: '2026-01-01', end: '2026-03-31' });
    expect(periodRange('last_6_months', ref)).toEqual({ start: '2025-10-01', end: '2026-03-31' });
    expect(periodRange('this_year', ref)).toEqual({ start: '2026-01-01', end: '2026-12-31' });
    expect(periodRange('custom', ref, 1, { start: '2026-01-05', end: '2026-01-10' })).toEqual({ start: '2026-01-05', end: '2026-01-10' });
    // Invalid custom range falls back to this month.
    expect(periodRange('custom', ref, 1, { start: '2026-02-10', end: '2026-01-10' })).toEqual({ start: '2026-03-01', end: '2026-03-31' });
  });

  it('computes previous comparable ranges', () => {
    expect(previousRange({ start: '2026-03-01', end: '2026-03-31' })).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(previousRange({ start: '2026-03-10', end: '2026-03-16' })).toEqual({ start: '2026-03-03', end: '2026-03-09' });
  });

  it('lists months and formats', () => {
    expect(eachMonth('2025-11-20', '2026-02-01')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(endOfMonth('2024-02-10')).toBe('2024-02-29');
    expect(formatDate('2026-12-20')).toBe('20 Dec 2026');
    expect(formatDate('2026-12-20', 'long')).toBe('Sun, 20 December 2026');
    expect(relativeDays('2026-01-02', '2026-01-01')).toBe('tomorrow');
    expect(relativeDays('2025-12-29', '2026-01-01')).toBe('3 days ago');
  });
});
