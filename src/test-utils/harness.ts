import { migrate } from '../db/migrate';
import type { PlannedNotification } from '../domain/reminderPlanner';
import type { NotificationChannel } from '../domain/types';
import { seedDefaultCategories } from '../services/categories';
import { createContext, type ServiceContext } from '../services/context';
import type { NotificationGateway, PermissionState } from '../services/notifications';
import { savePreferences } from '../services/preferences';
import type { SecureStoreGateway } from '../services/security';
import { openNodeDatabase } from './nodeDriver';

export interface TestClock {
  set(date: string, time?: string): void;
  today(): string;
  now(): Date;
}

export function makeClock(date = '2026-03-15', time = '12:00'): TestClock {
  let current = new Date(`${date}T${time}:00`);
  return {
    set(d: string, t = '12:00') {
      current = new Date(`${d}T${t}:00`);
    },
    today() {
      const d = current;
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },
    now() {
      return new Date(current.getTime());
    },
  };
}

export async function setupTestContext(opts: { date?: string; onboarding?: boolean } = {}): Promise<{ ctx: ServiceContext; clock: TestClock }> {
  const db = openNodeDatabase();
  await migrate(db);
  const clock = makeClock(opts.date);
  const ctx = createContext(db, clock);
  await seedDefaultCategories(ctx);
  await savePreferences(ctx, { onboardingComplete: opts.onboarding ?? true, duplicateWindowMinutes: 10 });
  return { ctx, clock };
}

/** In-memory stand-in for expo-notifications that behaves like the OS scheduler. */
export class FakeNotificationGateway implements NotificationGateway {
  permission: PermissionState = 'granted';
  scheduled = new Map<string, PlannedNotification>();
  presented: { title: string; body: string; channel: NotificationChannel }[] = [];
  channelsEnsured = 0;
  private seq = 0;

  async getPermission() {
    return this.permission;
  }
  async requestPermission() {
    return this.permission;
  }
  async ensureChannels() {
    this.channelsEnsured++;
  }
  async schedule(n: PlannedNotification) {
    const id = `os-${++this.seq}`;
    this.scheduled.set(id, n);
    return id;
  }
  async cancel(id: string) {
    this.scheduled.delete(id);
  }
  async listScheduledIds() {
    return [...this.scheduled.keys()];
  }
  async presentNow(n: { title: string; body: string; channel: NotificationChannel }) {
    this.presented.push(n);
  }
  /** Simulates the OS delivering (and dropping) everything due before `now`. */
  deliverDue(now: Date) {
    for (const [id, n] of this.scheduled) if (n.fireAt.getTime() <= now.getTime()) this.scheduled.delete(id);
  }
  keys() {
    return [...this.scheduled.values()].map((n) => n.key).sort();
  }
}

export class MemorySecureStore implements SecureStoreGateway {
  data = new Map<string, string>();
  async getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  async setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  async deleteItem(k: string) {
    this.data.delete(k);
  }
}

export const naira = (n: number) => Math.round(n * 100);
