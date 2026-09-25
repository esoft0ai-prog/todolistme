import { Platform } from 'react-native';
import { deleteExpoDatabase, openExpoDatabase } from '../db/expoDriver';
import { migrate, MigrationError } from '../db/migrate';
import { installForegroundHandler } from '../platform/notifications';
import { securityService, setScreenPrivacy } from '../platform/security';
import { pruneAudit } from '../services/audit';
import { seedDefaultCategories } from '../services/categories';
import { createContext } from '../services/context';
import { loadPreferences } from '../services/preferences';
import { materializeDue } from '../services/recurring';
import { runNotificationSync } from '../state/actions';
import { useAppStore } from '../state/appStore';

let booting = false;

/**
 * App start-up. Everything here is local: open the encrypted database with the
 * Keystore-held key, run migrations, seed defaults, decide whether to show the
 * lock screen, then catch up recurring transactions and re-plan reminders.
 */
export async function bootstrap(): Promise<void> {
  if (booting) return;
  booting = true;
  const store = useAppStore.getState();
  try {
    installForegroundHandler();
    const key = Platform.OS === 'web' ? null : (await securityService.getOrCreateDatabaseKey()).key;
    let db;
    try {
      db = await openExpoDatabase(key);
    } catch (e) {
      store.setError(
        'Finora could not unlock its encrypted database on this phone. If you have a backup you can reset the app and restore it.',
        'decrypt',
      );
      return;
    }
    try {
      await migrate(db);
    } catch (e) {
      store.setError(e instanceof Error ? e.message : String(e), e instanceof MigrationError ? 'migration' : 'generic');
      return;
    }
    const ctx = createContext(db);
    await seedDefaultCategories(ctx);
    const prefs = await loadPreferences(db);
    const locked = prefs.appLockEnabled && (await securityService.hasPin());
    await setScreenPrivacy(prefs.hideInRecents);
    store.setBooted(ctx, prefs, locked);

    // Non-blocking catch-up work.
    void (async () => {
      try {
        const r = await materializeDue(ctx);
        if (r.created > 0) store.bump();
      } catch {
        /* ignore */
      }
      await runNotificationSync();
      await pruneAudit(ctx).catch(() => undefined);
    })();
  } catch (e) {
    store.setError(e instanceof Error ? e.message : String(e), 'generic');
  } finally {
    booting = false;
  }
}

/** Last-resort recovery: wipes the local database and its key, then starts fresh. */
export async function resetAllData(): Promise<void> {
  const store = useAppStore.getState();
  try {
    await store.ctx?.db.close();
  } catch {
    /* ignore */
  }
  await deleteExpoDatabase().catch(() => undefined);
  await securityService.deleteDatabaseKey();
  await securityService.clearPin();
  useAppStore.setState({ status: 'booting', ctx: null, error: null, errorKind: null, locked: false });
  await bootstrap();
}

/** Called when the app returns to the foreground on a new day etc. */
export async function onResume(): Promise<void> {
  const { ctx, bump } = useAppStore.getState();
  if (!ctx) return;
  try {
    const r = await materializeDue(ctx);
    if (r.created > 0) bump();
  } catch {
    /* ignore */
  }
  await runNotificationSync();
}
