import { mapAccount, mapCategory, mapDebt, mapGoal, mapTransaction } from '../db/mappers';
import type { Account, Category, Debt, SavingsGoal, Transaction } from '../domain/types';
import type { Exec } from './context';
import { likePattern, listTransactions, type TransactionFilter } from './transactions';

export interface SearchResults {
  transactions: Transaction[];
  debts: Debt[];
  goals: SavingsGoal[];
  accounts: Account[];
  categories: Category[];
  reminders: { id: string; title: string; message: string; date: string | null }[];
  events: { id: string; title: string; date: string; notes: string | null }[];
  total: number;
}

/** Offline full-text-ish search across all entities (parameterised LIKE, escaped). */
export async function searchAll(db: Exec, query: string, filter: Omit<TransactionFilter, 'search'> = {}): Promise<SearchResults> {
  const q = query.trim().slice(0, 100);
  const empty: SearchResults = { transactions: [], debts: [], goals: [], accounts: [], categories: [], reminders: [], events: [], total: 0 };
  const hasFilter = Object.values(filter).some((v) => v != null && (!Array.isArray(v) || v.length > 0));
  if (!q && !hasFilter) return empty;
  const p = likePattern(q);
  const esc = "ESCAPE '\\'";
  const transactions = await listTransactions(db, { ...filter, search: q || undefined, limit: filter.limit ?? 100 });
  if (!q) return { ...empty, transactions, total: transactions.length };
  // An amount typed into search (e.g. "25000") also matches transactions of that amount.
  const numeric = /^\d+(\.\d{1,2})?$/.test(q.replace(/,/g, '')) ? Math.round(parseFloat(q.replace(/,/g, '')) * 100) : null;
  if (numeric) {
    const byAmount = (await db.all('SELECT * FROM transactions WHERE amount_minor = ? ORDER BY date DESC LIMIT 50', [numeric])).map((r) => mapTransaction(r));
    for (const t of byAmount) if (!transactions.find((x) => x.id === t.id)) transactions.push(t);
  }
  const debts = (await db.all(`SELECT * FROM debts WHERE lender_name LIKE ? ${esc} OR notes LIKE ? ${esc} LIMIT 50`, [p, p])).map(mapDebt);
  const goals = (await db.all(`SELECT * FROM savings_goals WHERE name LIKE ? ${esc} OR notes LIKE ? ${esc} LIMIT 50`, [p, p])).map(mapGoal);
  const accounts = (await db.all(`SELECT * FROM accounts WHERE name LIKE ? ${esc} LIMIT 50`, [p])).map(mapAccount);
  const categories = (await db.all(`SELECT * FROM categories WHERE name LIKE ? ${esc} LIMIT 50`, [p])).map(mapCategory);
  const reminders = await db.all<{ id: string; title: string; message: string; date: string | null }>(
    `SELECT id, title, message, date FROM reminders WHERE kind = 'custom' AND (title LIKE ? ${esc} OR message LIKE ? ${esc}) LIMIT 50`,
    [p, p],
  );
  const events = await db.all<{ id: string; title: string; date: string; notes: string | null }>(
    `SELECT id, title, date, notes FROM financial_events WHERE title LIKE ? ${esc} OR notes LIKE ? ${esc} LIMIT 50`,
    [p, p],
  );
  return {
    transactions,
    debts,
    goals,
    accounts,
    categories,
    reminders,
    events,
    total: transactions.length + debts.length + goals.length + accounts.length + categories.length + reminders.length + events.length,
  };
}
