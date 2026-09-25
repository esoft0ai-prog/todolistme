import { convertMinor } from '../domain/money';
import type { ExchangeRate } from '../domain/types';
import { ValidationError, type Exec, type ServiceContext } from './context';
import { loadPreferences } from './preferences';

/**
 * Exchange rates are entered by the user (the app is offline, so there is no
 * rate feed). 1 unit of `currency` = `rate` units of the base currency.
 */

export async function listRates(db: Exec): Promise<ExchangeRate[]> {
  const rows = await db.all<{ currency: string; rate: number; updated_at: string }>('SELECT * FROM exchange_rates ORDER BY currency');
  return rows.map((r) => ({ currency: r.currency, rate: Number(r.rate), updatedAt: r.updated_at }));
}

export async function rateFor(db: Exec, currency: string, base: string): Promise<number> {
  if (currency === base) return 1;
  const row = await db.get<{ rate: number }>('SELECT rate FROM exchange_rates WHERE currency = ?', [currency]);
  return row ? Number(row.rate) : 1;
}

export async function setRate(ctx: ServiceContext, currency: string, rate: number): Promise<void> {
  if (!/^[A-Z]{3}$/.test(currency)) throw new ValidationError('Invalid currency code', 'currency');
  if (!(rate > 0) || !Number.isFinite(rate) || rate > 1e9) throw new ValidationError('Rate must be a positive number', 'rate');
  await ctx.db.run(
    'INSERT INTO exchange_rates (currency, rate, updated_at) VALUES (?,?,?) ON CONFLICT(currency) DO UPDATE SET rate = excluded.rate, updated_at = excluded.updated_at',
    [currency, rate, ctx.now().toISOString()],
  );
}

export async function deleteRate(ctx: ServiceContext, currency: string): Promise<void> {
  await ctx.db.run('DELETE FROM exchange_rates WHERE currency = ?', [currency]);
}

/** Converter bound to the current base currency and rate table. */
export async function makeConverter(db: Exec): Promise<{ base: string; toBase(minor: number, currency: string): number; rate(currency: string): number }> {
  const prefs = await loadPreferences(db);
  const rates = await listRates(db);
  const map = new Map(rates.map((r) => [r.currency, r.rate]));
  const base = prefs.baseCurrency;
  const rate = (c: string) => (c === base ? 1 : (map.get(c) ?? 1));
  return {
    base,
    rate,
    toBase: (minor, currency) => convertMinor(minor, currency, base, rate(currency)),
  };
}

/**
 * Recalculates the stored base-currency amounts of every transaction using the
 * current rates (used after the base currency or a rate is changed).
 */
export async function recalculateBaseAmounts(ctx: ServiceContext): Promise<number> {
  const conv = await makeConverter(ctx.db);
  const rows = await ctx.db.all<{ id: string; amount_minor: number; currency: string }>('SELECT id, amount_minor, currency FROM transactions');
  await ctx.db.transaction(async (tx) => {
    for (const r of rows) {
      await tx.run('UPDATE transactions SET base_amount_minor = ?, fx_rate = ? WHERE id = ?', [
        conv.toBase(Number(r.amount_minor), r.currency),
        conv.rate(r.currency),
        r.id,
      ]);
    }
  });
  return rows.length;
}
