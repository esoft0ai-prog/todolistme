import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import { config, isProd } from './config.js';

const secret = () => {
  if (isProd && config.jwtSecret.startsWith('dev-only')) throw new Error('JWT_SECRET is required in production');
  return new TextEncoder().encode(config.jwtSecret);
};

export interface AccessClaims { sub: string; tid: string; role: string }

export async function signAccessToken(c: AccessClaims): Promise<string> {
  return new SignJWT({ tid: c.tid, role: c.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(c.sub)
    .setIssuedAt()
    .setExpirationTime(`${config.accessTokenTtlSeconds}s`)
    .sign(secret());
}

export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ['HS256'] });
    if (!payload.sub || typeof payload.tid !== 'string') return null;
    return { sub: payload.sub, tid: payload.tid, role: String(payload.role ?? '') };
  } catch {
    return null;
  }
}

export const hashPassword = (p: string) => bcrypt.hash(p, 10);
export const checkPassword = (p: string, hash: string | null) => (hash ? bcrypt.compare(p, hash) : Promise.resolve(false));

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name: string, value: string, maxAgeSeconds: number): string {
  const secure = config.appUrl.startsWith('https') ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}
