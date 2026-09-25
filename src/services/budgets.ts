import { mapBudget } from '../db/mappers';
import { budgetPeriodRange, computeBudgetStatus, previousBudgetRange, validateBudget, type BudgetStatus } from '../domain/budget';
import type { DateRange } from '../domain/dates';
import type { Budget } from '../domain/types';
import { sanitizeText } from '../domain/validation';
import { newId } from '../utils/id';
import { audit } from './audit';
import { inList, throwIfErrors, ValidationError, type Exec, type ServiceContext } from './context';
import { loadPreferences } from './preferences';

export type BudgetInput = Omit<Budget, 'id' | 'createdAt' | 'updatedAt' | 'archived' | 'isDemo'> & { archived?: boolean; isDemo?: boolean };

export interface BudgetView {
  budget: Budget;
  status: BudgetStatus;
  categoryNames: string[];
}

const BUDGET_SELECT = `SELECT b.*, (SELECT group_concat(category_id) FROM budget_categories bc WHERE bc.budget_id = b.id) AS category_ids FROM budgets b`;

export async function listBudgets(db: Exec, opts: { includeArchived?: boolean } = {}): Promise<Budget[]> {
  const rows = await db.all(`${BUDGET_SELECT} ${opts.includeArchived ? '' : 'WHERE b.archived = 0'} ORDER BY b.created_at`);
  return rows.map((r) => mapBudget(r));
}

/** Spending counted against a budget: expenses (and categorised debt repayments) in base currency. */
export async function spentInRange(db: Exec, categoryIds: string[], range: DateRange): Promise<number> {
  const params: (string | number)[] = [range.start, range.end];
  let catClause = '';
  if (categoryIds.length) {
    catClause = `AND category_id IN (${inList(categoryIds)})`;
    params.push(...categoryIds);
  }
  const r = await db.get<{ s: number }>(
    `SELECT COALESCE(SUM(base_amount_minor), 0) AS s FROM transactions WHERE type IN ('expense', 'debt_repayment') AND date BETWEEN ? AND ? ${categoryIds.length ? catClause : "AND type = 'expense'"}`,
    params,
  );
  return Number(r?.s ?? 0);
}

export async function budgetViews(ctx: ServiceContext, opts: { includeArchived?: boolean } = {}): Promise<BudgetView[]> {
  const prefs = await loadPreferences(ctx.db);
  const budgets = await listBudgets(ctx.db, opts);
  const cats = await ctx.db.all<{ id: string; name: string }>('SELECT id, name FROM categories');
  const out: BudgetView[] = [];
  for (const b of budgets) {
    const range = budgetPeriodRange(b, ctx.today(), prefs.weekStartsOn);
    const spent = await spentInRange(ctx.db, b.categoryIds, range);
    out.push({
      budget: b,
      status: computeBudgetStatus(b.limitMinor, spent, range, ctx.today(), b.alertThreshold),
      categoryNames: b.categoryIds.map((id) => cats.find((c) => c.id === id)?.name ?? '').filter(Boolean),
    });
  }
  return out;
}

/** Current + previous periods for adherence scoring. */
export async function budgetHistory(ctx: ServiceContext, periods = 3): Promise<{ limitMinor: number; spentMinor: number; projectedMinor: number; isCurrent: boolean }[]> {
  const prefs = await loadPreferences(ctx.db);
  const out: { limitMinor: number; spentMinor: number; projectedMinor: number; isCurrent: boolean }[] = [];
  for (const b of await listBudgets(ctx.db)) {
    let range: DateRange | null = budgetPeriodRange(b, ctx.today(), prefs.weekStartsOn);
    for (let i = 0; i < periods && range; i++) {
      if (range.start < b.startDate && b.period !== 'custom') break;
      const spent = await spentInRange(ctx.db, b.categoryIds, range);
      const status = computeBudgetStatus(b.limitMinor, spent, range, ctx.today(), b.alertThreshold);
      if (status.state !== 'upcoming') out.push({ limitMinor: b.limitMinor, spentMinor: spent, projectedMinor: status.projectedSpendMinor, isCurrent: i === 0 && ctx.today() <= range.end });
      range = previousBudgetRange(b, range, prefs.weekStartsOn);
    }
  }
  return out;
}

function normalise(input: BudgetInput): BudgetInput {
  return { ...input, name: sanitizeText(input.name, 80), endDate: input.period === 'custom' ? input.endDate : null, categoryIds: [...new Set(input.categoryIds)] };
}

async function writeCategories(tx: Exec, budgetId: string, ids: string[]) {
  await tx.run('DELETE FROM budget_categories WHERE budget_id = ?', [budgetId]);
  for (const c of ids) {
    const cat = await tx.get<{ kind: string }>('SELECT kind FROM categories WHERE id = ?', [c]);
    if (!cat) throw new ValidationError('A selected category no longer exists', 'categoryIds');
    if (cat.kind !== 'expense') throw new ValidationError('Budgets can only include expense categories', 'categoryIds');
    await tx.run('INSERT INTO budget_categories (budget_id, category_id) VALUES (?,?)', [budgetId, c]);
  }
}

export async function createBudget(ctx: ServiceContext, raw: BudgetInput, exec?: Exec): Promise<string> {
  const input = normalise(raw);
  throwIfErrors(validateBudget(input));
  const id = newId();
  const run = async (tx: Exec) => {
    const now = ctx.now().toISOString();
    await tx.run(
      'INSERT INTO budgets (id, name, period, limit_minor, start_date, end_date, alert_threshold, archived, is_demo, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,?,?,?)',
      [id, input.name, input.period, input.limitMinor, input.startDate, input.endDate, input.alertThreshold, input.isDemo ? 1 : 0, now, now],
    );
    await writeCategories(tx, id, input.categoryIds);
    await audit(ctx, tx, 'budget', id, 'create', `Created budget "${input.name}"`);
  };
  if (exec) await run(exec);
  else await ctx.db.transaction(run);
  return id;
}

export async function updateBudget(ctx: ServiceContext, id: string, raw: BudgetInput): Promise<void> {
  const input = normalise(raw);
  throwIfErrors(validateBudget(input));
  await ctx.db.transaction(async (tx) => {
    const r = await tx.run(
      'UPDATE budgets SET name=?, period=?, limit_minor=?, start_date=?, end_date=?, alert_threshold=?, archived=?, updated_at=? WHERE id=?',
      [input.name, input.period, input.limitMinor, input.startDate, input.endDate, input.alertThreshold, input.archived ? 1 : 0, ctx.now().toISOString(), id],
    );
    if (!r.changes) throw new ValidationError('Budget not found');
    await writeCategories(tx, id, input.categoryIds);
    await audit(ctx, tx, 'budget', id, 'update', `Updated budget "${input.name}"`);
  });
}

export async function deleteBudget(ctx: ServiceContext, id: string): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    await tx.run('DELETE FROM budgets WHERE id = ?', [id]);
    await audit(ctx, tx, 'budget', id, 'delete', 'Deleted budget');
  });
}
