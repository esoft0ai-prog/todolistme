import { mapTransaction } from '../db/mappers';
import type { DateRange } from '../domain/dates';
import { convertMinor } from '../domain/money';
import type { Transaction, TransactionInput, TransactionType } from '../domain/types';
import { findProbableDuplicate, sanitizeText, validateTransaction } from '../domain/validation';
import { newId } from '../utils/id';
import { audit } from './audit';
import { inList, throwIfErrors, ValidationError, type Exec, type ServiceContext } from './context';
import { loadDebtState, loadGoalState, syncDebtStatus, syncGoalStatus } from './ledgerState';
import { loadPreferences } from './preferences';
import { rateFor } from './rates';

export class DuplicateTransactionError extends Error {
  constructor(public duplicateOf: string) {
    super('This looks like a transaction you just added.');
    this.name = 'DuplicateTransactionError';
  }
}

export interface TransactionFilter {
  range?: DateRange;
  types?: TransactionType[];
  accountId?: string;
  categoryIds?: string[];
  debtId?: string;
  goalId?: string;
  tag?: string;
  search?: string;
  minAmountMinor?: number;
  maxAmountMinor?: number;
  limit?: number;
  offset?: number;
  order?: 'date_desc' | 'date_asc' | 'amount_desc';
}

const TX_SELECT = `
SELECT t.*,
  (SELECT group_concat(g.name, char(31)) FROM transaction_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.transaction_id = t.id) AS tag_names
FROM transactions t`;

/** LIKE-escape user search input (parameterised; % and _ are treated literally). */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

export function buildFilterSQL(f: TransactionFilter): { where: string; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (f.range) {
    where.push('t.date BETWEEN ? AND ?');
    params.push(f.range.start, f.range.end);
  }
  if (f.types?.length) {
    where.push(`t.type IN (${inList(f.types)})`);
    params.push(...f.types);
  }
  if (f.accountId) {
    where.push('(t.account_id = ? OR t.to_account_id = ?)');
    params.push(f.accountId, f.accountId);
  }
  if (f.categoryIds?.length) {
    where.push(`t.category_id IN (${inList(f.categoryIds)})`);
    params.push(...f.categoryIds);
  }
  if (f.debtId) {
    where.push('t.debt_id = ?');
    params.push(f.debtId);
  }
  if (f.goalId) {
    where.push('t.goal_id = ?');
    params.push(f.goalId);
  }
  if (f.tag) {
    where.push('EXISTS (SELECT 1 FROM transaction_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.transaction_id = t.id AND g.name = ? COLLATE NOCASE)');
    params.push(f.tag);
  }
  if (f.minAmountMinor != null) {
    where.push('t.base_amount_minor >= ?');
    params.push(f.minAmountMinor);
  }
  if (f.maxAmountMinor != null) {
    where.push('t.base_amount_minor <= ?');
    params.push(f.maxAmountMinor);
  }
  if (f.search?.trim()) {
    const p = likePattern(f.search.trim().slice(0, 100));
    where.push(`(t.description LIKE ? ESCAPE '\\' OR t.notes LIKE ? ESCAPE '\\' OR t.reference LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM categories c WHERE c.id = t.category_id AND c.name LIKE ? ESCAPE '\\')
      OR EXISTS (SELECT 1 FROM accounts a WHERE a.id IN (t.account_id, t.to_account_id) AND a.name LIKE ? ESCAPE '\\')
      OR EXISTS (SELECT 1 FROM transaction_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.transaction_id = t.id AND g.name LIKE ? ESCAPE '\\'))`);
    params.push(p, p, p, p, p, p);
  }
  return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

export async function listTransactions(db: Exec, f: TransactionFilter = {}): Promise<Transaction[]> {
  const { where, params } = buildFilterSQL(f);
  const order =
    f.order === 'date_asc' ? 't.date ASC, t.time ASC, t.created_at ASC' : f.order === 'amount_desc' ? 't.base_amount_minor DESC' : 't.date DESC, t.time DESC, t.created_at DESC';
  const limit = Math.min(Math.max(1, f.limit ?? 200), 5000);
  const offset = Math.max(0, f.offset ?? 0);
  const rows = await db.all(`${TX_SELECT} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return rows.map((r) => mapTransaction(r));
}

export async function countTransactions(db: Exec, f: TransactionFilter = {}): Promise<number> {
  const { where, params } = buildFilterSQL(f);
  const r = await db.get<{ n: number }>(`SELECT count(*) AS n FROM transactions t ${where}`, params);
  return Number(r?.n ?? 0);
}

export async function getTransaction(db: Exec, id: string): Promise<Transaction | null> {
  const r = await db.get(`${TX_SELECT} WHERE t.id = ?`, [id]);
  return r ? mapTransaction(r) : null;
}

async function upsertTags(ctx: ServiceContext, tx: Exec, names: string[], isDemo: boolean): Promise<string[]> {
  const ids: string[] = [];
  const now = ctx.now().toISOString();
  for (const raw of names) {
    const name = sanitizeText(raw, 40);
    if (!name) continue;
    const existing = await tx.get<{ id: string }>('SELECT id FROM tags WHERE name = ? COLLATE NOCASE', [name]);
    if (existing) ids.push(existing.id);
    else {
      const id = newId();
      await tx.run('INSERT INTO tags (id, name, is_demo, created_at, updated_at) VALUES (?,?,?,?,?)', [id, name, isDemo ? 1 : 0, now, now]);
      ids.push(id);
    }
  }
  return [...new Set(ids)];
}

async function setTransactionTags(ctx: ServiceContext, tx: Exec, transactionId: string, tags: string[], isDemo: boolean) {
  await tx.run('DELETE FROM transaction_tags WHERE transaction_id = ?', [transactionId]);
  for (const tagId of await upsertTags(ctx, tx, tags, isDemo)) {
    await tx.run('INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?,?)', [transactionId, tagId]);
  }
  // Remove orphan tags.
  await tx.run('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM transaction_tags)');
}

interface Prepared {
  input: TransactionInput;
  currency: string;
  baseAmount: number;
  fxRate: number;
  toAmount: number | null;
  base: string;
}

/** Validates and normalises a transaction against the current database state. */
async function prepare(ctx: ServiceContext, db: Exec, raw: TransactionInput, editingId?: string): Promise<Prepared> {
  const input: TransactionInput = {
    ...raw,
    description: sanitizeText(raw.description, 500),
    notes: raw.notes ? sanitizeText(raw.notes, 2000) || null : null,
    reference: raw.reference ? sanitizeText(raw.reference, 200) || null : null,
    tags: (raw.tags ?? []).map((t) => sanitizeText(t, 40)).filter(Boolean),
    time: raw.time || null,
  };
  // Clear links that do not apply to the type.
  if (input.type !== 'transfer' && input.type !== 'savings_deposit' && input.type !== 'savings_withdrawal') {
    input.toAccountId = null;
    input.toAmountMinor = null;
  }
  if (input.type !== 'debt_repayment' && input.type !== 'loan_received') input.debtId = null;
  if (input.type !== 'savings_deposit' && input.type !== 'savings_withdrawal') input.goalId = null;
  if (input.type !== 'income' && input.type !== 'expense' && input.type !== 'debt_repayment') input.categoryId = null;

  throwIfErrors(validateTransaction(input));
  const prefs = await loadPreferences(db);
  const base = prefs.baseCurrency;

  const account = await db.get<{ currency: string; archived: number }>('SELECT currency, archived FROM accounts WHERE id = ?', [input.accountId]);
  if (!account) throw new ValidationError('Choose an account', 'accountId');
  const currency = account.currency;

  if (input.categoryId) {
    const cat = await db.get<{ kind: string }>('SELECT kind FROM categories WHERE id = ?', [input.categoryId]);
    if (!cat) throw new ValidationError('Category not found', 'categoryId');
    if ((input.type === 'income' && cat.kind !== 'income') || (input.type === 'expense' && cat.kind !== 'expense')) {
      throw new ValidationError('Category does not match the transaction type', 'categoryId');
    }
  }

  let toAmount: number | null = null;
  if (input.type === 'transfer') {
    const to = await db.get<{ currency: string }>('SELECT currency FROM accounts WHERE id = ?', [input.toAccountId!]);
    if (!to) throw new ValidationError('Destination account not found', 'toAccountId');
    if (to.currency === currency) toAmount = null;
    else {
      toAmount =
        input.toAmountMinor ??
        convertMinor(
          convertMinor(input.amountMinor, currency, base, await rateFor(db, currency, base)),
          base,
          to.currency,
          1 / (await rateFor(db, to.currency, base)),
        );
    }
  }

  if (input.type === 'debt_repayment' || (input.type === 'loan_received' && input.debtId)) {
    const st = await loadDebtState(db, input.debtId!, ctx.today(), { excludeTransactionId: editingId });
    if (!st) throw new ValidationError('Debt not found', 'debtId');
    if (input.type === 'debt_repayment') {
      if (st.debt.currency !== currency) {
        throw new ValidationError(`Pay this ${st.debt.currency} debt from a ${st.debt.currency} account`, 'accountId');
      }
      if (input.amountMinor > st.summary.outstandingMinor) {
        throw new ValidationError('Repayment is larger than the outstanding balance', 'amountMinor');
      }
    }
  }

  if (input.type === 'savings_deposit' || input.type === 'savings_withdrawal') {
    const st = await loadGoalState(db, input.goalId!, base, ctx.today(), editingId);
    if (!st) throw new ValidationError('Savings goal not found', 'goalId');
    if (st.goal.linkedAccountId && st.goal.linkedAccountId === input.accountId) {
      throw new ValidationError(
        input.type === 'savings_deposit' ? "Choose an account other than the goal's savings account" : "Choose where the money should go (not the goal's savings account)",
        'accountId',
      );
    }
    input.toAccountId = st.goal.linkedAccountId;
    if (input.type === 'savings_withdrawal' && input.amountMinor > st.progress.savedMinor && st.goal.currency === currency) {
      throw new ValidationError('You cannot withdraw more than has been saved', 'amountMinor');
    }
    if (input.toAccountId) {
      const linked = await db.get<{ currency: string }>('SELECT currency FROM accounts WHERE id = ?', [input.toAccountId]);
      if (linked && linked.currency !== currency) {
        toAmount = convertMinor(convertMinor(input.amountMinor, currency, base, await rateFor(db, currency, base)), base, linked.currency, 1 / (await rateFor(db, linked.currency, base)));
      }
    }
  }

  const fxRate = await rateFor(db, currency, base);
  return { input, currency, baseAmount: convertMinor(input.amountMinor, currency, base, fxRate), fxRate, toAmount, base };
}

async function writeDebtPayment(ctx: ServiceContext, tx: Exec, t: { id: string; type: TransactionType; debtId: string | null; amountMinor: number; date: string; isDemo: boolean }) {
  const now = ctx.now().toISOString();
  const existing = await tx.get<{ id: string; debt_id: string }>('SELECT id, debt_id FROM debt_payments WHERE transaction_id = ?', [t.id]);
  if (t.type === 'debt_repayment' && t.debtId) {
    if (existing) {
      await tx.run('UPDATE debt_payments SET debt_id=?, amount_minor=?, date=?, updated_at=? WHERE id=?', [t.debtId, t.amountMinor, t.date, now, existing.id]);
    } else {
      await tx.run(
        "INSERT INTO debt_payments (id, debt_id, kind, amount_minor, date, transaction_id, notes, is_demo, created_at, updated_at) VALUES (?,?,'payment',?,?,?,NULL,?,?,?)",
        [newId(), t.debtId, t.amountMinor, t.date, t.id, t.isDemo ? 1 : 0, now, now],
      );
    }
  } else if (existing) {
    await tx.run('DELETE FROM debt_payments WHERE id = ?', [existing.id]);
  }
  const affected = new Set([existing?.debt_id, t.type === 'debt_repayment' ? t.debtId : null].filter(Boolean) as string[]);
  for (const d of affected) await syncDebtStatus(tx, d, ctx.today(), now);
}

export interface SaveOptions {
  allowDuplicate?: boolean;
  /** Run inside an existing transaction. */
  exec?: Exec;
}

export async function createTransaction(ctx: ServiceContext, raw: TransactionInput, opts: SaveOptions = {}): Promise<Transaction> {
  const id = newId();
  const run = async (tx: Exec) => {
    const p = await prepare(ctx, tx, raw);
    const now = ctx.now();
    if (!opts.allowDuplicate && !raw.recurringId) {
      const prefs = await loadPreferences(tx);
      const cutoff = new Date(now.getTime() - prefs.duplicateWindowMinutes * 60_000).toISOString();
      const recent = await tx.all('SELECT * FROM transactions WHERE created_at >= ? AND date = ? AND amount_minor = ?', [cutoff, p.input.date, p.input.amountMinor]);
      const dup = findProbableDuplicate(p.input, recent.map((r) => mapTransaction(r)), prefs.duplicateWindowMinutes, now);
      if (dup) throw new DuplicateTransactionError(dup);
    }
    const nowISO = now.toISOString();
    const i = p.input;
    const isDemo = !!raw.isDemo;
    await tx.run(
      `INSERT INTO transactions (id, type, amount_minor, currency, base_amount_minor, fx_rate, date, time, account_id, to_account_id, to_amount_minor,
        category_id, debt_id, goal_id, recurring_id, description, payment_method, notes, reference, is_demo, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, i.type, i.amountMinor, p.currency, p.baseAmount, p.fxRate, i.date, i.time, i.accountId, i.toAccountId, p.toAmount,
        i.categoryId, i.debtId, i.goalId, i.recurringId ?? null, i.description, i.paymentMethod, i.notes, i.reference, isDemo ? 1 : 0, nowISO, nowISO,
      ],
    );
    if (i.tags.length) await setTransactionTags(ctx, tx, id, i.tags, isDemo);
    await writeDebtPayment(ctx, tx, { id, type: i.type, debtId: i.debtId, amountMinor: i.amountMinor, date: i.date, isDemo });
    if (i.goalId) await syncGoalStatus(tx, i.goalId, p.base, ctx.today(), nowISO);
    await audit(ctx, tx, 'transaction', id, 'create', `${i.type} ${i.amountMinor} ${p.currency} on ${i.date}`);
  };
  if (opts.exec) await run(opts.exec);
  else await ctx.db.transaction(run);
  return (await getTransaction(opts.exec ?? ctx.db, id))!;
}

export async function updateTransaction(ctx: ServiceContext, id: string, raw: TransactionInput): Promise<Transaction> {
  await ctx.db.transaction(async (tx) => {
    const before = await getTransaction(tx, id);
    if (!before) throw new ValidationError('Transaction not found');
    const p = await prepare(ctx, tx, { ...raw, recurringId: before.recurringId }, id);
    const i = p.input;
    const nowISO = ctx.now().toISOString();
    await tx.run(
      `UPDATE transactions SET type=?, amount_minor=?, currency=?, base_amount_minor=?, fx_rate=?, date=?, time=?, account_id=?, to_account_id=?, to_amount_minor=?,
        category_id=?, debt_id=?, goal_id=?, description=?, payment_method=?, notes=?, reference=?, updated_at=? WHERE id=?`,
      [
        i.type, i.amountMinor, p.currency, p.baseAmount, p.fxRate, i.date, i.time, i.accountId, i.toAccountId, p.toAmount,
        i.categoryId, i.debtId, i.goalId, i.description, i.paymentMethod, i.notes, i.reference, nowISO, id,
      ],
    );
    await setTransactionTags(ctx, tx, id, i.tags, before.isDemo);
    await writeDebtPayment(ctx, tx, { id, type: i.type, debtId: i.debtId, amountMinor: i.amountMinor, date: i.date, isDemo: before.isDemo });
    for (const g of new Set([before.goalId, i.goalId].filter(Boolean) as string[])) await syncGoalStatus(tx, g, p.base, ctx.today(), nowISO);
    if (before.debtId && before.debtId !== i.debtId) await syncDebtStatus(tx, before.debtId, ctx.today(), nowISO);
    await audit(ctx, tx, 'transaction', id, 'update', `Edited ${i.type} ${i.amountMinor} ${p.currency} on ${i.date}`);
  });
  return (await getTransaction(ctx.db, id))!;
}

export async function deleteTransaction(ctx: ServiceContext, id: string): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const t = await getTransaction(tx, id);
    if (!t) return;
    const prefs = await loadPreferences(tx);
    const nowISO = ctx.now().toISOString();
    await tx.run('DELETE FROM debt_payments WHERE transaction_id = ?', [id]);
    await tx.run('DELETE FROM transactions WHERE id = ?', [id]);
    await tx.run('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM transaction_tags)');
    if (t.debtId) await syncDebtStatus(tx, t.debtId, ctx.today(), nowISO);
    if (t.goalId) await syncGoalStatus(tx, t.goalId, prefs.baseCurrency, ctx.today(), nowISO);
    await audit(ctx, tx, 'transaction', id, 'delete', `Deleted ${t.type} ${t.amountMinor} ${t.currency} on ${t.date}`);
  });
}

export async function listTags(db: Exec): Promise<{ id: string; name: string; count: number }[]> {
  const rows = await db.all<{ id: string; name: string; n: number }>(
    'SELECT g.id, g.name, count(tt.transaction_id) AS n FROM tags g LEFT JOIN transaction_tags tt ON tt.tag_id = g.id GROUP BY g.id ORDER BY n DESC, g.name',
  );
  return rows.map((r) => ({ id: r.id, name: r.name, count: Number(r.n) }));
}
