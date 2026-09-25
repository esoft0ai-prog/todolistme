import { convertMinor, formatMoney, minorToInput, parseAmount, toMinor } from '../money';

describe('parseAmount', () => {
  it('parses plain and grouped numbers into kobo', () => {
    expect(parseAmount('25000', 'NGN')).toEqual({ ok: true, minor: 2_500_000 });
    expect(parseAmount('25,000.50', 'NGN')).toEqual({ ok: true, minor: 2_500_050 });
    expect(parseAmount('₦ 1,200', 'NGN')).toEqual({ ok: true, minor: 120_000 });
  });

  it('supports k/m/bn shorthand', () => {
    expect(parseAmount('25k', 'NGN')).toEqual({ ok: true, minor: 2_500_000 });
    expect(parseAmount('1.5m', 'NGN')).toEqual({ ok: true, minor: 150_000_000 });
    expect(parseAmount('2bn', 'NGN')).toEqual({ ok: true, minor: 200_000_000_000 });
  });

  it('rejects invalid input', () => {
    expect(parseAmount('', 'NGN').ok).toBe(false);
    expect(parseAmount('abc', 'NGN').ok).toBe(false);
    expect(parseAmount('12.3.4', 'NGN').ok).toBe(false);
    expect(parseAmount('0', 'NGN').ok).toBe(false);
    expect(parseAmount('-50', 'NGN')).toEqual({ ok: false, error: 'Amount cannot be negative' });
    expect(parseAmount('1.234', 'NGN').ok).toBe(false);
    expect(parseAmount('10.5', 'JPY').ok).toBe(false);
    expect(parseAmount('9999999999999', 'NGN')).toEqual({ ok: false, error: 'Amount is too large' });
  });

  it('allows zero or negatives only when asked', () => {
    expect(parseAmount('0', 'NGN', { allowZero: true })).toEqual({ ok: true, minor: 0 });
    expect(parseAmount('-50', 'NGN', { allowNegative: true })).toEqual({ ok: true, minor: -5000 });
  });
});

describe('formatMoney', () => {
  it('formats with symbol and grouping', () => {
    expect(formatMoney(2_500_000, 'NGN')).toBe('₦25,000');
    expect(formatMoney(2_500_050, 'NGN')).toBe('₦25,000.50');
    expect(formatMoney(-150_000, 'NGN')).toBe('−₦1,500');
    expect(formatMoney(150_000, 'NGN', { signed: true })).toBe('+₦1,500');
    expect(formatMoney(12345, 'USD', { trimZeroMinor: false })).toBe('$123.45');
    expect(formatMoney(5000, 'KES')).toBe('KSh 50');
  });

  it('formats compact values', () => {
    expect(formatMoney(150_000_000, 'NGN', { compact: true })).toBe('₦1.5M');
    expect(formatMoney(2_500_000, 'NGN', { compact: true })).toBe('₦25K');
    expect(formatMoney(50_000, 'NGN', { compact: true })).toBe('₦500');
    // Regression: integer parts must keep their trailing zeros.
    expect(formatMoney(15_000_000, 'NGN', { compact: true })).toBe('₦150K');
    expect(formatMoney(10_000_000, 'NGN', { compact: true })).toBe('₦100K');
    expect(formatMoney(200_000_000, 'NGN', { compact: true })).toBe('₦2M');
    expect(formatMoney(120_000_000_000, 'NGN', { compact: true })).toBe('₦1.2B');
  });

  it('never throws on bad numbers', () => {
    expect(formatMoney(NaN, 'NGN')).toBe('₦0');
  });
});

describe('conversions', () => {
  it('round-trips minor/major', () => {
    expect(toMinor(10.1, 'NGN')).toBe(1010);
    expect(minorToInput(1010, 'NGN')).toBe('10.1');
    expect(minorToInput(250000, 'NGN')).toBe('2500');
  });

  it('converts between currencies with different decimals', () => {
    expect(convertMinor(10_000, 'USD', 'NGN', 1500)).toBe(15_000_000); // $100 → ₦150,000
    expect(convertMinor(1000, 'XOF', 'NGN', 2.5)).toBe(250_000); // 1000 CFA → ₦2,500
    expect(convertMinor(777, 'NGN', 'NGN', 99)).toBe(777);
  });
});
