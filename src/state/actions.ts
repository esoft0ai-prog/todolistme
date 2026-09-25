import type { Preferences } from '../domain/types';
import { expoNotificationGateway } from '../platform/notifications';
import { setScreenPrivacy } from '../platform/security';
import { ValidationError, type ServiceContext } from '../services/context';
import { checkBudgetAlerts, syncNotifications, unreadCount, type SyncResult } from '../services/notifications';
import { savePreferences } from '../services/preferences';
import { DuplicateTransactionError } from '../services/transactions';
import { useAppStore } from './appStore';

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let lastSync: SyncResult | null = null;

export function getLastSync(): SyncResult | null {
  return lastSync;
}

/** Re-plans local notifications shortly after changes (debounced). */
export function scheduleNotificationSync(delayMs = 700): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    void runNotificationSync();
  }, delayMs);
}

export async function runNotificationSync(): Promise<SyncResult | null> {
  const ctx = useAppStore.getState().ctx;
  if (!ctx) return null;
  try {
    lastSync = await syncNotifications(ctx, expoNotificationGateway);
    useAppStore.getState().setUnread(await unreadCount(ctx));
  } catch {
    // Never let notification problems break the app.
  }
  return lastSync;
}

/**
 * Runs a data mutation, then refreshes screens, re-plans reminders and checks
 * budget alerts. Errors are converted into user-friendly toasts and re-thrown
 * as `false` return values so forms can stay open.
 */
export async function mutate<T>(
  fn: (ctx: ServiceContext) => Promise<T>,
  opts: { success?: string; budgetCheck?: boolean; silent?: boolean } = {},
): Promise<{ ok: true; value: T } | { ok: false; error: string; field?: string; duplicateOf?: string }> {
  const store = useAppStore.getState();
  const ctx = store.ctx;
  if (!ctx) return { ok: false, error: 'App is still starting' };
  try {
    const value = await fn(ctx);
    store.bump();
    scheduleNotificationSync();
    if (opts.budgetCheck) void checkBudgetAlerts(ctx, expoNotificationGateway).then(async () => store.setUnread(await unreadCount(ctx))).catch(() => undefined);
    if (opts.success) store.showToast(opts.success, 'good');
    return { ok: true, value };
  } catch (e) {
    if (e instanceof DuplicateTransactionError) return { ok: false, error: e.message, duplicateOf: e.duplicateOf };
    const message = e instanceof ValidationError ? e.message : friendlyError(e);
    if (!opts.silent) store.showToast(message, 'bad');
    return { ok: false, error: message, field: e instanceof ValidationError ? e.field : undefined };
  }
}

export function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/FOREIGN KEY/i.test(msg)) return 'This item is linked to other records and cannot be changed that way.';
  if (/UNIQUE/i.test(msg)) return 'This record already exists.';
  if (/CHECK constraint/i.test(msg)) return 'Some values are not valid. Please review the form.';
  if (/database is locked|SQLITE_BUSY/i.test(msg)) return 'The database is busy. Please try again.';
  return msg.length < 160 ? msg : 'Something went wrong. Please try again.';
}

export async function updatePrefs(patch: Partial<Preferences>): Promise<Preferences | null> {
  const store = useAppStore.getState();
  if (!store.ctx) return null;
  const prefs = await savePreferences(store.ctx, patch);
  store.setPrefs(prefs);
  store.bump();
  if ('hideInRecents' in patch || 'appLockEnabled' in patch) await setScreenPrivacy(prefs.hideInRecents);
  if (
    'notificationsEnabled' in patch ||
    'notificationChannels' in patch ||
    'reminderTime' in patch ||
    'defaultDebtReminderOffsets' in patch ||
    'baseCurrency' in patch
  ) {
    scheduleNotificationSync(200);
  }
  return prefs;
}
