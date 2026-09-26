import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config, isProd } from './config.js';

import { hkdfSync } from 'node:crypto';

/** Which secret family a value belongs to — each is sealed with its own key (ADL §5). */
export type KeyPurpose = 'general' | 'ai' | 'webhook' | 'integration' | 'telegram';
const PURPOSES: readonly KeyPurpose[] = ['general', 'ai', 'webhook', 'integration', 'telegram'];

function toKey(raw: string, name: string, strict: boolean): Buffer {
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  const b64 = Buffer.from(raw, 'base64');
  if (b64.length === 32) return b64;
  if (strict) throw new Error(`${name} must decode to 32 bytes`);
  return createHash('sha256').update(raw).digest(); // passphrase-style secret
}

let master: Buffer | null = null;
function masterKey(): Buffer {
  if (master) return master;
  if (config.encryptionKey) master = toKey(config.encryptionKey, 'ENCRYPTION_KEY', true);
  else {
    if (isProd) throw new Error('ENCRYPTION_KEY is required in production');
    master = createHash('sha256').update('camplo-dev-only-encryption-key').digest();
  }
  return master;
}

const keys = new Map<KeyPurpose, Buffer>();
function key(purpose: KeyPurpose): Buffer {
  const hit = keys.get(purpose);
  if (hit) return hit;
  let k: Buffer;
  const dedicated = purpose === 'general' ? '' : config.encryptionKeys[purpose];
  if (dedicated) k = toKey(dedicated, `${purpose} encryption secret`, false);
  else if (purpose === 'general') k = masterKey();
  else k = Buffer.from(hkdfSync('sha256', masterKey(), Buffer.alloc(0), `camplo:${purpose}`, 32));
  keys.set(purpose, k);
  return k;
}

/**
 * AES-256-GCM. Output: `<purpose>.` + base64(iv[12] | tag[16] | ciphertext). The purpose prefix selects the key
 * on decrypt, so rotating one family's secret never touches the others. Unprefixed values are legacy `general`.
 */
export function encrypt(plain: string, purpose: KeyPurpose = 'general'): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(purpose), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `${purpose}.${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')}`;
}

export function decrypt(blob: string): string {
  const dot = blob.indexOf('.');
  const tag = dot > 0 ? blob.slice(0, dot) : '';
  const purpose = (PURPOSES as readonly string[]).includes(tag) ? (tag as KeyPurpose) : 'general';
  const buf = Buffer.from(purpose === tag ? blob.slice(dot + 1) : blob, 'base64');
  const d = createDecipheriv('aes-256-gcm', key(purpose), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export function hmacHex(secret: string, payload: string | Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** Constant-time comparison of hex/base64 signatures. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Show only the last 4 characters of a secret, never the value. */
export function mask(secret: string | null | undefined): string | null {
  if (!secret) return null;
  return '•'.repeat(12) + secret.slice(-4);
}
