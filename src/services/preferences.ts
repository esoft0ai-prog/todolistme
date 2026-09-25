import { DEFAULT_CURRENCY } from '../domain/currency';
import type { NotificationChannel, Preferences } from '../domain/types';
import type { Exec, ServiceContext } from './context';

export const DEFAULT_PREFERENCES: Preferences = {
  baseCurrency: DEFAULT_CURRENCY,
  locale: 'en-NG',
  themeMode: 'dark',
  monthlyIncomeMinor: 0,
  mainGoal: '',
  onboardingComplete: false,
  notificationsEnabled: true,
  notificationChannels: { debts: true, bills: true, budgets: true, savings: true, reminders: true, general: true },
  reminderTime: '09:00',
  defaultDebtReminderOffsets: [7, 3, 1, 0],
  appLockEnabled: false,
  biometricEnabled: false,
  autoLockSeconds: 60,
  hideInRecents: true,
  weekStartsOn: 1,
  largeText: false,
  demoDataLoaded: false,
  duplicateWindowMinutes: 10,
};

const KEYS = Object.keys(DEFAULT_PREFERENCES) as (keyof Preferences)[];

function coerce<K extends keyof Preferences>(key: K, raw: unknown): Preferences[K] {
  const def = DEFAULT_PREFERENCES[key];
  if (raw === undefined || raw === null) return def;
  if (typeof def === 'boolean') return (typeof raw === 'boolean' ? raw : def) as Preferences[K];
  if (typeof def === 'number') return (typeof raw === 'number' && Number.isFinite(raw) ? raw : def) as Preferences[K];
  if (typeof def === 'string') return (typeof raw === 'string' ? raw : def) as Preferences[K];
  if (Array.isArray(def)) {
    return (Array.isArray(raw) ? raw.filter((x) => typeof x === 'number' && x >= 0 && x <= 365).slice(0, 8) : def) as Preferences[K];
  }
  if (key === 'notificationChannels' && typeof raw === 'object') {
    const merged = { ...(def as Record<NotificationChannel, boolean>) };
    for (const k of Object.keys(merged) as NotificationChannel[]) {
      const v = (raw as Record<string, unknown>)[k];
      if (typeof v === 'boolean') merged[k] = v;
    }
    return merged as Preferences[K];
  }
  return def;
}

export async function loadPreferences(db: Exec): Promise<Preferences> {
  const rows = await db.all<{ key: string; value: string }>('SELECT key, value FROM preferences');
  const prefs = { ...DEFAULT_PREFERENCES };
  for (const r of rows) {
    if (!KEYS.includes(r.key as keyof Preferences)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.value);
    } catch {
      continue;
    }
    (prefs as Record<string, unknown>)[r.key] = coerce(r.key as keyof Preferences, parsed);
  }
  if (prefs.weekStartsOn !== 0 && prefs.weekStartsOn !== 1) prefs.weekStartsOn = 1;
  if (!/^[A-Z]{3}$/.test(prefs.baseCurrency)) prefs.baseCurrency = DEFAULT_CURRENCY;
  return prefs;
}

export async function savePreferences(ctx: ServiceContext, patch: Partial<Preferences>, exec?: Exec): Promise<Preferences> {
  const db = exec ?? ctx.db;
  const now = ctx.now().toISOString();
  for (const [key, value] of Object.entries(patch)) {
    if (!KEYS.includes(key as keyof Preferences)) continue;
    const v = coerce(key as keyof Preferences, value);
    await db.run(
      'INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [key, JSON.stringify(v), now],
    );
  }
  return loadPreferences(db);
}
