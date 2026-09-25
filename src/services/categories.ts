import { mapCategory } from '../db/mappers';
import type { Category, CategoryKind } from '../domain/types';
import { sanitizeText, validateCategory } from '../domain/validation';
import { newId } from '../utils/id';
import { audit } from './audit';
import { throwIfErrors, ValidationError, type Exec, type ServiceContext } from './context';

/** Default categories. Deterministic ids make backups from different phones merge cleanly. */
export const DEFAULT_CATEGORIES: { id: string; name: string; kind: CategoryKind; icon: string; color: string }[] = [
  { id: 'sys-inc-salary', name: 'Salary', kind: 'income', icon: 'briefcase', color: '#22D3A6' },
  { id: 'sys-inc-business', name: 'Business', kind: 'income', icon: 'storefront', color: '#34D399' },
  { id: 'sys-inc-freelance', name: 'Freelance', kind: 'income', icon: 'laptop', color: '#2DD4BF' },
  { id: 'sys-inc-investment', name: 'Investment', kind: 'income', icon: 'trending-up', color: '#60A5FA' },
  { id: 'sys-inc-gift', name: 'Gift', kind: 'income', icon: 'gift', color: '#F472B6' },
  { id: 'sys-inc-other', name: 'Other', kind: 'income', icon: 'add-circle', color: '#A3E635' },
  { id: 'sys-exp-food', name: 'Food', kind: 'expense', icon: 'fast-food', color: '#F97316' },
  { id: 'sys-exp-transport', name: 'Transport', kind: 'expense', icon: 'car', color: '#38BDF8' },
  { id: 'sys-exp-rent', name: 'Rent', kind: 'expense', icon: 'home', color: '#A78BFA' },
  { id: 'sys-exp-electricity', name: 'Electricity', kind: 'expense', icon: 'flash', color: '#FACC15' },
  { id: 'sys-exp-internet', name: 'Internet', kind: 'expense', icon: 'wifi', color: '#22D3EE' },
  { id: 'sys-exp-education', name: 'Education', kind: 'expense', icon: 'school', color: '#818CF8' },
  { id: 'sys-exp-health', name: 'Health', kind: 'expense', icon: 'medkit', color: '#FB7185' },
  { id: 'sys-exp-family', name: 'Family', kind: 'expense', icon: 'people', color: '#F472B6' },
  { id: 'sys-exp-entertainment', name: 'Entertainment', kind: 'expense', icon: 'film', color: '#C084FC' },
  { id: 'sys-exp-shopping', name: 'Shopping', kind: 'expense', icon: 'bag-handle', color: '#FB923C' },
  { id: 'sys-exp-debt', name: 'Debt repayment', kind: 'expense', icon: 'card', color: '#EF4444' },
  { id: 'sys-exp-business', name: 'Business', kind: 'expense', icon: 'briefcase', color: '#10B981' },
  { id: 'sys-exp-other', name: 'Other', kind: 'expense', icon: 'ellipsis-horizontal-circle', color: '#94A3B8' },
];

export async function seedDefaultCategories(ctx: ServiceContext, exec?: Exec): Promise<void> {
  const db = exec ?? ctx.db;
  const now = ctx.now().toISOString();
  for (const c of DEFAULT_CATEGORIES) {
    await db.run(
      'INSERT OR IGNORE INTO categories (id, name, kind, icon, color, is_system, archived, is_demo, created_at, updated_at) VALUES (?,?,?,?,?,1,0,0,?,?)',
      [c.id, c.name, c.kind, c.icon, c.color, now, now],
    );
  }
}

export async function listCategories(db: Exec, opts: { kind?: CategoryKind; includeArchived?: boolean } = {}): Promise<Category[]> {
  const where: string[] = [];
  const params: string[] = [];
  if (opts.kind) {
    where.push('kind = ?');
    params.push(opts.kind);
  }
  if (!opts.includeArchived) where.push('archived = 0');
  const rows = await db.all(`SELECT * FROM categories ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY kind, is_system DESC, name COLLATE NOCASE`, params);
  return rows.map(mapCategory);
}

export async function createCategory(
  ctx: ServiceContext,
  input: { name: string; kind: CategoryKind; icon?: string; color?: string; isDemo?: boolean },
  exec?: Exec,
): Promise<Category> {
  const db = exec ?? ctx.db;
  const name = sanitizeText(input.name, 40);
  const existing = await listCategories(db, { kind: input.kind });
  throwIfErrors(validateCategory({ name, kind: input.kind }, existing));
  const now = ctx.now().toISOString();
  const id = newId();
  await db.run(
    'INSERT INTO categories (id, name, kind, icon, color, is_system, archived, is_demo, created_at, updated_at) VALUES (?,?,?,?,?,0,0,?,?,?)',
    [id, name, input.kind, input.icon ?? 'pricetag', input.color ?? '#7C8CFF', input.isDemo ? 1 : 0, now, now],
  );
  await audit(ctx, db, 'category', id, 'create', `Created category "${name}"`);
  return mapCategory((await db.get('SELECT * FROM categories WHERE id = ?', [id]))!);
}

export async function updateCategory(ctx: ServiceContext, id: string, input: { name?: string; icon?: string; color?: string; archived?: boolean }): Promise<void> {
  const row = await ctx.db.get('SELECT * FROM categories WHERE id = ?', [id]);
  if (!row) throw new ValidationError('Category not found');
  const cur = mapCategory(row);
  const name = sanitizeText(input.name ?? cur.name, 40);
  const existing = await listCategories(ctx.db, { kind: cur.kind });
  throwIfErrors(validateCategory({ id, name, kind: cur.kind }, existing));
  await ctx.db.run('UPDATE categories SET name=?, icon=?, color=?, archived=?, updated_at=? WHERE id=?', [
    name,
    input.icon ?? cur.icon,
    input.color ?? cur.color,
    (input.archived ?? cur.archived) ? 1 : 0,
    ctx.now().toISOString(),
    id,
  ]);
  await audit(ctx, ctx.db, 'category', id, 'update', `Updated category "${name}"`);
}

/**
 * Deletes a category. Transactions keep their amounts but lose the category
 * (ON DELETE SET NULL), unless `reassignTo` is provided.
 */
export async function deleteCategory(ctx: ServiceContext, id: string, reassignTo?: string | null): Promise<void> {
  const row = await ctx.db.get<{ kind: string; name: string }>('SELECT kind, name FROM categories WHERE id = ?', [id]);
  if (!row) return;
  if (reassignTo) {
    const target = await ctx.db.get<{ kind: string }>('SELECT kind FROM categories WHERE id = ?', [reassignTo]);
    if (!target || target.kind !== row.kind) throw new ValidationError('Choose a category of the same type to move transactions to');
  }
  await ctx.db.transaction(async (tx) => {
    if (reassignTo) {
      await tx.run('UPDATE transactions SET category_id = ?, updated_at = ? WHERE category_id = ?', [reassignTo, ctx.now().toISOString(), id]);
      await tx.run('UPDATE recurring_transactions SET category_id = ? WHERE category_id = ?', [reassignTo, id]);
      await tx.run('INSERT OR IGNORE INTO budget_categories (budget_id, category_id) SELECT budget_id, ? FROM budget_categories WHERE category_id = ?', [reassignTo, id]);
    }
    await tx.run('DELETE FROM categories WHERE id = ?', [id]);
    await audit(ctx, tx, 'category', id, 'delete', `Deleted category "${row.name}"`);
  });
}

export async function categoryUsage(db: Exec, id: string): Promise<number> {
  const r = await db.get<{ n: number }>('SELECT count(*) AS n FROM transactions WHERE category_id = ?', [id]);
  return Number(r?.n ?? 0);
}
