import { create } from 'zustand';
import type { Preferences } from '../domain/types';
import type { ServiceContext } from '../services/context';
import { DEFAULT_PREFERENCES } from '../services/preferences';

export type BootStatus = 'booting' | 'ready' | 'error';

export interface AppState {
  status: BootStatus;
  error: string | null;
  errorKind: 'decrypt' | 'migration' | 'generic' | null;
  ctx: ServiceContext | null;
  prefs: Preferences;
  locked: boolean;
  /** Incremented after every data mutation; screens re-query when it changes. */
  dataVersion: number;
  unread: number;
  toast: { id: number; message: string; tone: 'good' | 'bad' | 'info' } | null;
  setBooted(ctx: ServiceContext, prefs: Preferences, locked: boolean): void;
  setError(message: string, kind: AppState['errorKind']): void;
  setPrefs(prefs: Preferences): void;
  setLocked(locked: boolean): void;
  bump(): void;
  setUnread(n: number): void;
  showToast(message: string, tone?: 'good' | 'bad' | 'info'): void;
  clearToast(): void;
}

let toastSeq = 0;

export const useAppStore = create<AppState>((set) => ({
  status: 'booting',
  error: null,
  errorKind: null,
  ctx: null,
  prefs: DEFAULT_PREFERENCES,
  locked: false,
  dataVersion: 0,
  unread: 0,
  toast: null,
  setBooted: (ctx, prefs, locked) => set({ status: 'ready', ctx, prefs, locked, error: null, errorKind: null }),
  setError: (message, kind) => set({ status: 'error', error: message, errorKind: kind }),
  setPrefs: (prefs) => set({ prefs }),
  setLocked: (locked) => set({ locked }),
  bump: () => set((s) => ({ dataVersion: s.dataVersion + 1 })),
  setUnread: (unread) => set({ unread }),
  showToast: (message, tone = 'good') => set({ toast: { id: ++toastSeq, message, tone } }),
  clearToast: () => set({ toast: null }),
}));

/** Non-null service context for use inside screens (only rendered after boot). */
export function useCtx(): ServiceContext {
  const ctx = useAppStore((s) => s.ctx);
  if (!ctx) throw new Error('App not initialised');
  return ctx;
}

export function usePrefs(): Preferences {
  return useAppStore((s) => s.prefs);
}
