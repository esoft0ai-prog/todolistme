import { mapNotification } from '../db/mappers';
import { Mutex } from '../db/driver';
import { formatMoney } from '../domain/money';
import { diffSchedule, hashContent, planNotifications, type PlannedNotification, type ScheduledEntry } from '../domain/reminderPlanner';
import type { NotificationChannel, NotificationRecord } from '../domain/types';
import { newId } from '../utils/id';
import { budgetViews } from './budgets';
import type { ServiceContext } from './context';
import { listDebts } from './debts';
import { listGoals } from './goals';
import { loadPreferences } from './preferences';
import { listRecurring } from './recurring';
import { listCustomReminders, listDebtReminders, listEvents } from './reminders';

export type PermissionState = 'granted' | 'denied' | 'undetermined' | 'unsupported';

/** Platform adapter (expo-notifications on device, fake in tests). */
export interface NotificationGateway {
  getPermission(): Promise<PermissionState>;
  requestPermission(): Promise<PermissionState>;
  ensureChannels(): Promise<void>;
  schedule(n: PlannedNotification): Promise<string>;
  cancel(osId: string): Promise<void>;
  /** OS identifiers of notifications currently scheduled by this app. */
  listScheduledIds(): Promise<string[]>;
  presentNow(n: { title: string; body: string; channel: NotificationChannel; data?: Record<string, string> }): Promise<void>;
}

export interface SyncResult {
  permission: PermissionState;
  enabled: boolean;
  scheduled: number;
  cancelled: number;
  unchanged: number;
  total: number;
  movedToHistory: number;
  error?: string;
}

const syncLock = new Mutex();

/** Moves notifications whose time has passed from the schedule registry into history. */
async function archiveFired(ctx: ServiceContext): Promise<number> {
  const nowISO = ctx.now().toISOString();
  const fired = await ctx.db.all<{ key: string; channel: string; title: string; body: string; fire_at: string; entity_type: string | null; entity_id: string | null }>(
    'SELECT * FROM scheduled_notifications WHERE fire_at <= ?',
    [nowISO],
  );
  if (!fired.length) return 0;
  await ctx.db.transaction(async (tx) => {
    for (const f of fired) {
      await tx.run(
        'INSERT OR IGNORE INTO notifications (id, key, channel, title, body, fired_at, entity_type, entity_id, read) VALUES (?,?,?,?,?,?,?,?,0)',
        [newId(), f.key, f.channel, f.title, f.body, f.fire_at, f.entity_type, f.entity_id],
      );
      await tx.run('DELETE FROM scheduled_notifications WHERE key = ?', [f.key]);
    }
  });
  return fired.length;
}

export async function buildPlan(ctx: ServiceContext): Promise<PlannedNotification[]> {
  const prefs = await loadPreferences(ctx.db);
  const today = ctx.today();
  const debts = await listDebts(ctx.db, today);
  const goals = await listGoals(ctx);
  const accounts = await ctx.db.all<{ id: string; currency: string }>('SELECT id, currency FROM accounts');
  return planNotifications({
    now: ctx.now(),
    today,
    prefs,
    debts: debts.map((d) => ({ debt: d.debt, summary: d.summary })),
    debtReminders: await listDebtReminders(ctx.db),
    customReminders: await listCustomReminders(ctx.db),
    bills: await listRecurring(ctx.db, { activeOnly: true }),
    goals: goals.map((g) => ({ goal: g.goal, progress: g.progress })),
    events: await listEvents(ctx.db),
    currencyOf: (id) => accounts.find((a) => a.id === id)?.currency ?? prefs.baseCurrency,
  });
}

/**
 * Reconciles OS-scheduled notifications with the current plan. Safe to call
 * any time (app start, resume, after edits, after restore): it only cancels
 * what changed and schedules what is missing.
 */
export async function syncNotifications(ctx: ServiceContext, gateway: NotificationGateway): Promise<SyncResult> {
  return syncLock.run(async () => {
    const result: SyncResult = { permission: 'undetermined', enabled: false, scheduled: 0, cancelled: 0, unchanged: 0, total: 0, movedToHistory: 0 };
    try {
      result.movedToHistory = await archiveFired(ctx);
      const prefs = await loadPreferences(ctx.db);
      result.permission = await gateway.getPermission();
      result.enabled = prefs.notificationsEnabled && result.permission === 'granted';

      let registry = await ctx.db.all<{ key: string; hash: string; os_id: string }>('SELECT key, hash, os_id FROM scheduled_notifications');
      // Drop registry entries the OS no longer knows about (e.g. cleared by the system) so they get rescheduled.
      const osIds = new Set(await gateway.listScheduledIds());
      const stale = registry.filter((r) => !osIds.has(r.os_id));
      if (stale.length) {
        for (const s of stale) await ctx.db.run('DELETE FROM scheduled_notifications WHERE key = ?', [s.key]);
        registry = registry.filter((r) => osIds.has(r.os_id));
      }

      if (!result.enabled) {
        for (const r of registry) {
          await gateway.cancel(r.os_id);
          result.cancelled++;
        }
        await ctx.db.run('DELETE FROM scheduled_notifications');
        return result;
      }

      await gateway.ensureChannels();
      const plan = await buildPlan(ctx);
      const scheduled: ScheduledEntry[] = registry.map((r) => ({ key: r.key, hash: r.hash, osId: r.os_id }));
      const diff = diffSchedule(plan, scheduled);
      for (const c of diff.toCancel) {
        await gateway.cancel(c.osId);
        await ctx.db.run('DELETE FROM scheduled_notifications WHERE key = ? AND os_id = ?', [c.key, c.osId]);
        result.cancelled++;
      }
      for (const n of diff.toSchedule) {
        const osId = await gateway.schedule(n);
        await ctx.db.run(
          `INSERT INTO scheduled_notifications (key, os_id, hash, fire_at, channel, title, body, entity_type, entity_id) VALUES (?,?,?,?,?,?,?,?,?)
           ON CONFLICT(key) DO UPDATE SET os_id = excluded.os_id, hash = excluded.hash, fire_at = excluded.fire_at, channel = excluded.channel,
             title = excluded.title, body = excluded.body, entity_type = excluded.entity_type, entity_id = excluded.entity_id`,
          [n.key, osId, hashContent(n), n.fireAt.toISOString(), n.channel, n.title, n.body, n.entityType, n.entityId],
        );
        result.scheduled++;
      }
      result.unchanged = diff.unchanged;
      result.total = plan.length;
    } catch (e) {
      result.error = e instanceof Error ? e.message : String(e);
    }
    return result;
  });
}

/**
 * Immediate budget warnings, evaluated after spending is recorded. Each
 * (budget, period, level) fires at most once thanks to the unique history key.
 */
export async function checkBudgetAlerts(ctx: ServiceContext, gateway: NotificationGateway): Promise<number> {
  const prefs = await loadPreferences(ctx.db);
  if (!prefs.notificationsEnabled || !prefs.notificationChannels.budgets) return 0;
  const permission = await gateway.getPermission();
  let fired = 0;
  for (const v of await budgetViews(ctx)) {
    const s = v.status;
    if (s.state !== 'warning' && s.state !== 'at_risk' && s.state !== 'exceeded') continue;
    const key = `budget:${v.budget.id}:${s.range.start}:${s.state}`;
    const exists = await ctx.db.get('SELECT 1 FROM notifications WHERE key = ?', [key]);
    if (exists) continue;
    const title = s.state === 'exceeded' ? `${v.budget.name} budget exceeded` : s.state === 'at_risk' ? `${v.budget.name} budget at risk` : `${v.budget.name} budget ${Math.round(s.percentUsed * 100)}% used`;
    const body =
      s.state === 'exceeded'
        ? `You have spent ${formatMoney(s.spentMinor, prefs.baseCurrency)} of ${formatMoney(s.limitMinor, prefs.baseCurrency)}.`
        : s.state === 'at_risk'
          ? s.message.replace('this budget', `your ${v.budget.name} budget`)
          : `${formatMoney(Math.max(0, s.remainingMinor), prefs.baseCurrency)} left for the next ${s.daysRemaining} day(s).`;
    await ctx.db.run('INSERT OR IGNORE INTO notifications (id, key, channel, title, body, fired_at, entity_type, entity_id, read) VALUES (?,?,?,?,?,?,?,?,0)', [
      newId(),
      key,
      'budgets',
      title,
      body,
      ctx.now().toISOString(),
      'budget',
      v.budget.id,
    ]);
    if (permission === 'granted') {
      try {
        await gateway.presentNow({ title, body, channel: 'budgets', data: { entityType: 'budget', entityId: v.budget.id } });
      } catch {
        // History still records the alert even if the OS refused to show it.
      }
    }
    fired++;
  }
  return fired;
}

export async function listNotificationHistory(ctx: ServiceContext, limit = 200): Promise<NotificationRecord[]> {
  return (await ctx.db.all('SELECT * FROM notifications ORDER BY fired_at DESC LIMIT ?', [limit])).map(mapNotification);
}

export async function markAllRead(ctx: ServiceContext): Promise<void> {
  await ctx.db.run('UPDATE notifications SET read = 1 WHERE read = 0');
}

export async function unreadCount(ctx: ServiceContext): Promise<number> {
  const r = await ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM notifications WHERE read = 0 AND fired_at <= ?', [ctx.now().toISOString()]);
  return Number(r?.n ?? 0);
}

export async function clearHistory(ctx: ServiceContext): Promise<void> {
  await ctx.db.run('DELETE FROM notifications');
}

export async function listScheduled(ctx: ServiceContext, limit = 100) {
  return ctx.db.all<{ key: string; title: string; body: string; fire_at: string; channel: string }>(
    'SELECT key, title, body, fire_at, channel FROM scheduled_notifications ORDER BY fire_at LIMIT ?',
    [limit],
  );
}
