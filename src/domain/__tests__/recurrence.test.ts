import { describeRule, monthlyEquivalent, nextOccurrence, occurrencesBetween } from '../recurrence';
import type { RecurrenceRule } from '../types';

const rule = (r: Partial<RecurrenceRule>): RecurrenceRule => ({
  frequency: 'monthly',
  interval: 1,
  unit: 'month',
  startDate: '2026-01-31',
  endDate: null,
  ...r,
});

describe('recurrence engine', () => {
  it('keeps month-end anchors without drifting', () => {
    expect(occurrencesBetween(rule({}), '2026-01-01', '2026-05-31')).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
    ]);
  });

  it('handles daily, weekly, biweekly, quarterly and yearly rules', () => {
    expect(occurrencesBetween(rule({ frequency: 'daily', startDate: '2026-01-01' }), '2026-01-01', '2026-01-04')).toHaveLength(4);
    expect(occurrencesBetween(rule({ frequency: 'weekly', startDate: '2026-01-05' }), '2026-01-01', '2026-01-31')).toEqual([
      '2026-01-05',
      '2026-01-12',
      '2026-01-19',
      '2026-01-26',
    ]);
    expect(occurrencesBetween(rule({ frequency: 'biweekly', startDate: '2026-01-05' }), '2026-01-01', '2026-02-28')).toEqual([
      '2026-01-05',
      '2026-01-19',
      '2026-02-02',
      '2026-02-16',
    ]);
    expect(occurrencesBetween(rule({ frequency: 'quarterly', startDate: '2025-11-30' }), '2026-01-01', '2026-12-31')).toEqual([
      '2026-02-28',
      '2026-05-30',
      '2026-08-30',
      '2026-11-30',
    ]);
    expect(occurrencesBetween(rule({ frequency: 'yearly', startDate: '2024-02-29' }), '2024-01-01', '2028-12-31')).toEqual([
      '2024-02-29',
      '2025-02-28',
      '2026-02-28',
      '2027-02-28',
      '2028-02-29',
    ]);
  });

  it('supports custom intervals', () => {
    expect(occurrencesBetween(rule({ frequency: 'custom', interval: 10, unit: 'day', startDate: '2026-01-01' }), '2026-01-01', '2026-01-31')).toEqual([
      '2026-01-01',
      '2026-01-11',
      '2026-01-21',
      '2026-01-31',
    ]);
    expect(describeRule({ frequency: 'custom', interval: 3, unit: 'week' })).toBe('Every 3 weeks');
  });

  it('respects end dates and window starts far after the start date', () => {
    const r = rule({ frequency: 'monthly', startDate: '2020-01-15', endDate: '2026-03-15' });
    expect(occurrencesBetween(r, '2026-01-01', '2026-12-31')).toEqual(['2026-01-15', '2026-02-15', '2026-03-15']);
    expect(nextOccurrence(r, '2026-03-15')).toBeNull();
    expect(nextOccurrence(r, '2026-02-15')).toBe('2026-03-15');
    expect(nextOccurrence(r, '2026-02-15', true)).toBe('2026-02-15');
  });

  it('converts to monthly equivalents', () => {
    expect(monthlyEquivalent(1200, 'yearly')).toBeCloseTo(100);
    expect(monthlyEquivalent(100, 'weekly')).toBeCloseTo(434.8, 0);
    expect(monthlyEquivalent(300, 'quarterly')).toBeCloseTo(100);
    expect(monthlyEquivalent(100, 'one_time')).toBe(0);
  });
});
