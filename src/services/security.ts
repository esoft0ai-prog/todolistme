import { fromHex, pbkdf2Sha256, timingSafeEqualHex, toHex, utf8 } from '../domain/crypto';

/**
 * Local app-lock security.
 *
 *  - The PIN is never stored. We store PBKDF2-HMAC-SHA256(pin, random 16-byte
 *    salt, 10k iterations) inside Android's Keystore-backed encrypted storage.
 *  - Failed attempts are persisted (so killing the app does not reset them) and
 *    trigger an escalating lockout: 5 failures → 30 s, then doubling up to 1 h.
 *  - The SQLCipher database key is 32 random bytes, also kept in the Keystore.
 */

export interface SecureStoreGateway {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

export interface RandomSource {
  bytes(n: number): Uint8Array;
}

export interface BiometricGateway {
  isAvailable(): Promise<boolean>;
  authenticate(reason: string): Promise<{ success: boolean; error?: string }>;
}

export const KEYS = {
  pinHash: 'finora.pin.hash.v1',
  failures: 'finora.pin.failures',
  lockedUntil: 'finora.pin.lockedUntil',
  dbKey: 'finora.db.key.v1',
} as const;

export const PIN_ITERATIONS = 10_000;
export const MAX_FREE_ATTEMPTS = 5;
const BASE_LOCK_MS = 30_000;
const MAX_LOCK_MS = 60 * 60_000;

export function validatePin(pin: string): string | null {
  if (!/^\d{4,6}$/.test(pin)) return 'PIN must be 4 to 6 digits';
  if (/^(\d)\1+$/.test(pin)) return 'PIN cannot be the same digit repeated';
  if ('0123456789'.includes(pin) || '9876543210'.includes(pin)) return 'PIN cannot be a simple sequence';
  return null;
}

function hashPin(pin: string, salt: Uint8Array, iterations: number): string {
  return toHex(pbkdf2Sha256(utf8(pin), salt, iterations, 32));
}

export class SecurityService {
  constructor(
    private store: SecureStoreGateway,
    private random: RandomSource,
    private clock: () => number = () => Date.now(),
  ) {}

  async hasPin(): Promise<boolean> {
    return !!(await this.store.getItem(KEYS.pinHash));
  }

  async setPin(pin: string): Promise<void> {
    const err = validatePin(pin);
    if (err) throw new Error(err);
    const salt = this.random.bytes(16);
    const record = `pbkdf2-sha256$${PIN_ITERATIONS}$${toHex(salt)}$${hashPin(pin, salt, PIN_ITERATIONS)}$${pin.length}`;
    await this.store.setItem(KEYS.pinHash, record);
    await this.resetFailures();
  }

  /** Length of the stored PIN (4–6), so the lock screen can submit automatically without burning attempts. */
  async pinLength(): Promise<number | null> {
    const record = await this.store.getItem(KEYS.pinHash);
    const len = Number(record?.split('$')[4]);
    return len >= 4 && len <= 6 ? len : null;
  }

  async clearPin(): Promise<void> {
    await this.store.deleteItem(KEYS.pinHash);
    await this.resetFailures();
  }

  async lockoutRemainingMs(): Promise<number> {
    const until = Number((await this.store.getItem(KEYS.lockedUntil)) ?? 0);
    return Math.max(0, until - this.clock());
  }

  private async resetFailures() {
    await this.store.deleteItem(KEYS.failures);
    await this.store.deleteItem(KEYS.lockedUntil);
  }

  /** Verifies a PIN, enforcing the persistent lockout policy. */
  async verifyPin(pin: string): Promise<{ ok: boolean; lockedMs: number; attemptsLeft: number | null; error?: string }> {
    const lockedMs = await this.lockoutRemainingMs();
    if (lockedMs > 0) return { ok: false, lockedMs, attemptsLeft: 0, error: 'Too many attempts' };
    const record = await this.store.getItem(KEYS.pinHash);
    if (!record) return { ok: false, lockedMs: 0, attemptsLeft: null, error: 'No PIN is set' };
    const [algo, iterStr, saltHex, hashHex] = record.split('$');
    if (algo !== 'pbkdf2-sha256' || !saltHex || !hashHex) return { ok: false, lockedMs: 0, attemptsLeft: null, error: 'PIN record is damaged' };
    const candidate = /^\d{4,6}$/.test(pin) ? hashPin(pin, fromHex(saltHex), Number(iterStr) || PIN_ITERATIONS) : '';
    if (candidate && timingSafeEqualHex(candidate, hashHex)) {
      await this.resetFailures();
      return { ok: true, lockedMs: 0, attemptsLeft: null };
    }
    const failures = Number((await this.store.getItem(KEYS.failures)) ?? 0) + 1;
    await this.store.setItem(KEYS.failures, String(failures));
    if (failures >= MAX_FREE_ATTEMPTS) {
      const lock = Math.min(MAX_LOCK_MS, BASE_LOCK_MS * Math.pow(2, failures - MAX_FREE_ATTEMPTS));
      await this.store.setItem(KEYS.lockedUntil, String(this.clock() + lock));
      return { ok: false, lockedMs: lock, attemptsLeft: 0, error: 'Too many attempts' };
    }
    return { ok: false, lockedMs: 0, attemptsLeft: MAX_FREE_ATTEMPTS - failures, error: 'Incorrect PIN' };
  }

  /** Returns the existing 256-bit database key or creates one. */
  async getOrCreateDatabaseKey(): Promise<{ key: string; created: boolean }> {
    const existing = await this.store.getItem(KEYS.dbKey);
    if (existing && /^[0-9a-f]{64}$/.test(existing)) return { key: existing, created: false };
    const key = toHex(this.random.bytes(32));
    await this.store.setItem(KEYS.dbKey, key);
    return { key, created: true };
  }

  async deleteDatabaseKey(): Promise<void> {
    await this.store.deleteItem(KEYS.dbKey);
  }
}

/** Decides whether the app must lock when returning from background. */
export function shouldLockOnResume(opts: { enabled: boolean; backgroundedAt: number | null; now: number; autoLockSeconds: number }): boolean {
  if (!opts.enabled) return false;
  if (opts.backgroundedAt == null) return false;
  return opts.now - opts.backgroundedAt >= Math.max(0, opts.autoLockSeconds) * 1000;
}
