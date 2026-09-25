import { mapAccount } from '../db/mappers';
import type { Account, AccountType, AccountWithBalance } from '../domain/types';
import { sanitizeText, validateAccount } from '../domain/validation';
import { newId } from '../utils/id';
import { audit } from './audit';
import { throwIfErrors, ValidationError, type Exec, type ServiceContext } from './context';

/**
 * Account balances are always derived from the opening balance plus the
 * transaction ledger, so they can never drift out of sync.
 *
 * Effects on `account_id`:     income, loan_received, savings_withdrawal → +amount
 *                              expense, debt_repayment, savings_deposit, transfer → −amount
 * Effects on `to_account_id`:  transfer, savings_deposit → +to_amount (or amount)
 *                              savings_withdrawal → −to_amount (money leaves the goal's linked account)
 */
export const BALANCE_SQL = `
SELECT a.*,
  a.opening_balance_minor
  + COALESCE((SELECT SUM(CASE WHEN t.type IN ('income','loan_received','savings_withdrawal') THEN t.amount_minor ELSE -t.amount_minor END)
              FROM transactions t WHERE t.account_id = a.id), 0)
  + COALESCE((SELECT SUM(CASE WHEN t.type = 'savings_withdrawal' THEN -COALESCE(t.to_amount_minor, t.amount_minor) ELSE COALESCE(t.to_amount_minor, t.amount_minor) END)
              FROM transactions t WHERE t.to_account_id = a.id), 0) AS balance_minor
FROM accounts a`;

export async function listAccounts(db: Exec, opts: { includeArchived?: boolean } = {}): Promise<AccountWithBalance[]> {
  const rows = await db.all<Record<string, unknown>>(
    `${BALANCE_SQL} ${opts.includeArchived ? '' : 'WHERE a.archived = 0'} ORDER BY a.archived, a.created_at`,
  );
  return rows.map((r) => ({ ...mapAccount(r), balanceMinor: Number(r.balance_minor ?? 0) }));
}

export async function getAccount(db: Exec, id: string): Promise<AccountWithBalance | null> {
  const r = await db.get<Record<string, unknown>>(`${BALANCE_SQL} WHERE a.id = ?`, [id]);
  return r ? { ...mapAccount(r), balanceMinor: Number(r.balance_minor ?? 0) } : null;
}

export interface AccountInput {
  name: string;
  type: AccountType;
  currency: string;
  openingBalanceMinor: number;
  color?: string | null;
  icon?: string | null;
  isDemo?: boolean;
}

export async function createAccount(ctx: ServiceContext, input: AccountInput, exec?: Exec): Promise<Account> {
  const name = sanitizeText(input.name, 80);
  throwIfErrors(validateAccount({ ...input, name }));
  const now = ctx.now().toISOString();
  const id = newId();
  const run = async (tx: Exec) => {
    await tx.run(
      'INSERT INTO accounts (id, name, type, currency, opening_balance_minor, color, icon, archived, is_demo, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,?,?,?)',
      [id, name, input.type, input.currency, input.openingBalanceMinor, input.color ?? null, input.icon ?? null, input.isDemo ? 1 : 0, now, now],
    );
    await audit(ctx, tx, 'account', id, 'create', `Created account "${name}"`);
  };
  if (exec) await run(exec);
  else await ctx.db.transaction(run);
  return (await getAccount(exec ?? ctx.db, id))!;
}

export async function updateAccount(ctx: ServiceContext, id: string, input: Partial<AccountInput> & { archived?: boolean }): Promise<void> {
  const current = await getAccount(ctx.db, id);
  if (!current) throw new ValidationError('Account not found');
  const next = { ...current, ...input, name: sanitizeText(input.name ?? current.name, 80) };
  throwIfErrors(validateAccount(next));
  const txCount = await ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM transactions WHERE account_id = ? OR to_account_id = ?', [id, id]);
  if (next.currency !== current.currency && Number(txCount?.n) > 0) {
    throw new ValidationError('Currency cannot be changed after transactions were recorded', 'currency');
  }
  await ctx.db.transaction(async (tx) => {
    await tx.run(
      'UPDATE accounts SET name=?, type=?, currency=?, opening_balance_minor=?, color=?, icon=?, archived=?, updated_at=? WHERE id=?',
      [next.name, next.type, next.currency, next.openingBalanceMinor, next.color ?? null, next.icon ?? null, next.archived ? 1 : 0, ctx.now().toISOString(), id],
    );
    await audit(ctx, tx, 'account', id, 'update', `Updated account "${next.name}"`);
  });
}

/**
 * Deletes an account only when nothing references it; otherwise the caller
 * should archive it so history is preserved.
 */
export async function deleteAccount(ctx: ServiceContext, id: string): Promise<void> {
  const used = await ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM transactions WHERE account_id = ? OR to_account_id = ?', [id, id]);
  if (Number(used?.n) > 0) {
    throw new ValidationError('This account has transactions. Archive it instead to keep your history.');
  }
  await ctx.db.transaction(async (tx) => {
    await tx.run('DELETE FROM accounts WHERE id = ?', [id]);
    await audit(ctx, tx, 'account', id, 'delete', 'Deleted account');
  });
}

export function isSpendable(type: AccountType): boolean {
  return type !== 'savings';
}
