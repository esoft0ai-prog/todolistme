import { classifyIntent, extractAmount, extractPeriod, extractTargetDate, normalize, parseQuery } from '../assistant/parser';

const categories = [
  { id: 'food', name: 'Food', kind: 'expense' },
  { id: 'transport', name: 'Transport', kind: 'expense' },
  { id: 'electricity', name: 'Electricity', kind: 'expense' },
  { id: 'salary', name: 'Salary', kind: 'income' },
];
const goals = [{ id: 'g1', name: 'New Laptop' }];
const ctx = { today: '2026-03-15', currency: 'NGN', categories, goals };

describe('intent detection', () => {
  const cases: [string, string][] = [
    ['Can I afford a ₦100,000 phone?', 'affordability'],
    ['How much did I spend on food this month?', 'category_spend'],
    ['How much do I owe?', 'debt_total'],
    ['When is my next debt payment?', 'next_debt_payment'],
    ['How much should I save each month for my goal?', 'goal_saving'],
    ['What category consumes most of my money?', 'top_category'],
    ['How much did I earn this month?', 'income_total'],
    ['How much did I spend last month?', 'spend_total'],
    ['How much debt did I clear this year?', 'debt_cleared'],
    ['Show me my biggest expenses', 'biggest_expenses'],
    ["What's my balance", 'balance'],
    ['How is my financial health score?', 'health'],
    ['Am I on track with my budgets?', 'budget_status'],
    ['What was my cash flow last month', 'cash_flow'],
    ['How much did I pay for nepa light in march', 'category_spend'],
    ['hello', 'greeting'],
    ['what can you do', 'help'],
    ['tell me a joke', 'unknown'],
  ];
  it.each(cases)('%s → %s', (q, intent) => {
    expect(parseQuery(q, ctx).intent).toBe(intent);
  });

  it('reports confidence', () => {
    expect(classifyIntent(normalize('can i afford it')).confidence).toBeGreaterThan(0.8);
  });
});

describe('entity extraction', () => {
  it('extracts amounts in Nigerian formats', () => {
    expect(extractAmount('can i afford a ₦100,000 phone', 'NGN')).toBe(10_000_000);
    expect(extractAmount('can i afford n250k shoes', 'NGN')).toBe(25_000_000);
    expect(extractAmount('buy a car for 4.5m naira', 'NGN')).toBe(450_000_000);
    expect(extractAmount('save 2 million by december 2026', 'NGN')).toBe(200_000_000);
    expect(extractAmount('in 6 months', 'NGN')).toBeNull();
    expect(extractAmount('no amount here', 'NGN')).toBeNull();
  });

  it('extracts periods', () => {
    expect(extractPeriod('last month', '2026-03-15')).toMatchObject({ start: '2026-02-01', end: '2026-02-28' });
    expect(extractPeriod('this year', '2026-03-15')).toMatchObject({ start: '2026-01-01', end: '2026-12-31' });
    expect(extractPeriod('in the last 3 months', '2026-03-15')).toMatchObject({ start: '2026-01-01', end: '2026-03-31' });
    expect(extractPeriod('spent in december', '2026-03-15')).toMatchObject({ start: '2025-12-01', end: '2025-12-31' });
    expect(extractPeriod('in february 2026', '2026-03-15')).toMatchObject({ start: '2026-02-01', end: '2026-02-28' });
    expect(extractPeriod('last week', '2026-03-18', 1)).toMatchObject({ start: '2026-03-09', end: '2026-03-15' });
    expect(extractPeriod('how much', '2026-03-15')).toBeNull();
    expect(extractPeriod('may i know my balance', '2026-03-15')).toBeNull();
  });

  it('extracts target dates', () => {
    expect(extractTargetDate('save 500k by december', '2026-03-15')).toBe('2026-12-31');
    expect(extractTargetDate('by december 20, 2026', '2026-03-15')).toBe('2026-12-20');
    expect(extractTargetDate('save 500k by january', '2026-03-15')).toBe('2027-01-31');
    expect(extractTargetDate('in 6 months', '2026-03-15')).toBe('2026-09-15');
    expect(extractTargetDate('by 2026-10-01', '2026-03-15')).toBe('2026-10-01');
  });

  it('matches categories through Nigerian synonyms and goals by name', () => {
    expect(parseQuery('how much did i spend on nepa bill', ctx).categoryIds).toEqual(['electricity']);
    expect(parseQuery('how much on okada and danfo', ctx).categoryIds).toEqual(['transport']);
    expect(parseQuery('how much did i spend on food and fuel', ctx).categoryIds.sort()).toEqual(['food', 'transport']);
    expect(parseQuery('how much should i save for the laptop goal', ctx).goalId).toBe('g1');
  });
});
