import { mapGoal } from '../db/mappers';
import { goalProgress, validateGoal, type GoalContribution, type GoalProgress } from '../domain/savings';
import type { SavingsGoal } from '../domain/types';
import { sanitizeText } from '../domain/validation';
import { newId } from '../utils/id';
import { audit } from './audit';
import { throwIfErrors, ValidationError, type Exec, type ServiceContext } from './context';
import { goalContributions, syncGoalStatus } from './ledgerState';
import { loadPreferences } from './preferences';
import { createTransaction } from './transactions';

export type GoalInput = Omit<SavingsGoal, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'isDemo'> & { isDemo?: boolean };

export interface GoalView {
  goal: SavingsGoal;
  contributions: GoalContribution[];
  progress: GoalProgress;
}

export async function listGoals(ctx: ServiceContext, opts: { includeArchived?: boolean } = {}): Promise<GoalView[]> {
  const prefs = await loadPreferences(ctx.db);
  const rows = await ctx.db.all(`SELECT * FROM savings_goals ${opts.includeArchived ? '' : "WHERE status <> 'archived'"} ORDER BY status, deadline IS NULL, deadline, created_at`);
  const out: GoalView[] = [];
  for (const r of rows) {
    const goal = mapGoal(r);
    const contributions = await goalContributions(ctx.db, goal, prefs.baseCurrency);
    out.push({ goal, contributions, progress: goalProgress(goal, contributions, ctx.today()) });
  }
  return out;
}

export async function getGoalView(ctx: ServiceContext, id: string): Promise<GoalView | null> {
  return (await listGoals(ctx, { includeArchived: true })).find((g) => g.goal.id === id) ?? null;
}

function normalise(input: GoalInput): GoalInput {
  return { ...input, name: sanitizeText(input.name, 80), notes: input.notes ? sanitizeText(input.notes, 1000) || null : null, deadline: input.deadline || null };
}

export async function createGoal(ctx: ServiceContext, raw: GoalInput, exec?: Exec): Promise<string> {
  const input = normalise(raw);
  throwIfErrors(validateGoal(input, ctx.today()));
  const id = newId();
  const run = async (tx: Exec) => {
    const now = ctx.now().toISOString();
    await tx.run(
      `INSERT INTO savings_goals (id, name, target_minor, currency, initial_minor, start_date, deadline, linked_account_id, icon, color, reminder_frequency, status, notes, is_demo, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?)`,
      [id, input.name, input.targetMinor, input.currency, input.initialMinor, input.startDate, input.deadline, input.linkedAccountId, input.icon, input.color, input.reminderFrequency, input.notes, input.isDemo ? 1 : 0, now, now],
    );
    const prefs = await loadPreferences(tx);
    await syncGoalStatus(tx, id, prefs.baseCurrency, ctx.today(), now);
    await audit(ctx, tx, 'goal', id, 'create', `Created goal "${input.name}"`);
  };
  if (exec) await run(exec);
  else await ctx.db.transaction(run);
  return id;
}

export async function updateGoal(ctx: ServiceContext, id: string, raw: GoalInput & { archived?: boolean }): Promise<void> {
  const input = normalise(raw);
  throwIfErrors(validateGoal({ ...input, id }, ctx.today()));
  await ctx.db.transaction(async (tx) => {
    const cur = await tx.get<{ status: string; linked_account_id: string | null }>('SELECT status, linked_account_id FROM savings_goals WHERE id = ?', [id]);
    if (!cur) throw new ValidationError('Goal not found');
    const hasTx = await tx.get<{ n: number }>('SELECT count(*) AS n FROM transactions WHERE goal_id = ?', [id]);
    if (Number(hasTx?.n) > 0 && (cur.linked_account_id ?? null) !== (input.linkedAccountId ?? null)) {
      throw new ValidationError('The linked account cannot be changed after deposits were made', 'linkedAccountId');
    }
    const now = ctx.now().toISOString();
    const status = raw.archived ? 'archived' : cur.status === 'archived' ? 'active' : cur.status;
    await tx.run(
      'UPDATE savings_goals SET name=?, target_minor=?, currency=?, initial_minor=?, start_date=?, deadline=?, linked_account_id=?, icon=?, color=?, reminder_frequency=?, notes=?, status=?, updated_at=? WHERE id=?',
      [input.name, input.targetMinor, input.currency, input.initialMinor, input.startDate, input.deadline, input.linkedAccountId, input.icon, input.color, input.reminderFrequency, input.notes, status, now, id],
    );
    const prefs = await loadPreferences(tx);
    await syncGoalStatus(tx, id, prefs.baseCurrency, ctx.today(), now);
    await audit(ctx, tx, 'goal', id, 'update', `Updated goal "${input.name}"`);
  });
}

export async function deleteGoal(ctx: ServiceContext, id: string): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const n = await tx.get<{ n: number }>('SELECT count(*) AS n FROM transactions WHERE goal_id = ?', [id]);
    if (Number(n?.n) > 0) {
      throw new ValidationError('This goal has deposits. Withdraw the money or archive the goal instead.');
    }
    await tx.run('DELETE FROM savings_goals WHERE id = ?', [id]);
    await audit(ctx, tx, 'goal', id, 'delete', 'Deleted savings goal');
  });
}

export async function contribute(
  ctx: ServiceContext,
  goalId: string,
  kind: 'deposit' | 'withdraw',
  input: { amountMinor: number; accountId: string; date: string; notes?: string | null; isDemo?: boolean },
  exec?: Exec,
): Promise<void> {
  const goal = await (exec ?? ctx.db).get('SELECT * FROM savings_goals WHERE id = ?', [goalId]);
  if (!goal) throw new ValidationError('Goal not found');
  const g = mapGoal(goal);
  await createTransaction(
    ctx,
    {
      type: kind === 'deposit' ? 'savings_deposit' : 'savings_withdrawal',
      amountMinor: input.amountMinor,
      date: input.date,
      time: null,
      accountId: input.accountId,
      toAccountId: null,
      toAmountMinor: null,
      categoryId: null,
      debtId: null,
      goalId,
      recurringId: null,
      description: `${kind === 'deposit' ? 'Saved towards' : 'Withdrew from'} ${g.name}`,
      paymentMethod: null,
      notes: input.notes ?? null,
      reference: null,
      tags: [],
      isDemo: input.isDemo ?? g.isDemo,
    },
    { exec, allowDuplicate: true },
  );
}
