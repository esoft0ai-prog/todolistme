/**
 * Error monitoring. Every unexpected server error, failed background job, failed outbound webhook and browser
 * error is grouped by fingerprint into `error_events` (Super Admin → Errors). When SENTRY_DSN is set, each
 * event is also forwarded to Sentry (or any Sentry-compatible service such as GlitchTip) via its envelope API.
 *
 * Capturing never throws and never blocks a response. Request bodies, cookies and headers are not recorded.
 */
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { config } from './config.js';

export type ErrorSource = 'server' | 'job' | 'webhook' | 'client' | 'admin_client';
export interface Capture {
  source: ErrorSource; level?: 'error' | 'warning'; route?: string | null; tenantId?: string | null; userId?: string | null;
  context?: Record<string, unknown>;
}

const UUIDISH = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Same error, different ids/numbers → same group. */
export function fingerprint(source: string, message: string, route?: string | null): string {
  const norm = (s: string) => s.replace(UUIDISH, ':id').replace(/\b\d+\b/g, 'N').slice(0, 300);
  return createHash('sha256').update(`${source}|${norm(message)}|${norm(route ?? '')}`).digest('hex').slice(0, 64);
}

function describe(err: unknown): { message: string; stack: string | null; type: string } {
  if (err instanceof Error) return { message: err.message || err.name, stack: err.stack ?? null, type: err.name };
  return { message: typeof err === 'string' ? err : JSON.stringify(err)?.slice(0, 500) ?? 'Unknown error', stack: null, type: 'Error' };
}

export async function captureError(err: unknown, c: Capture): Promise<void> {
  try {
    const d = describe(err);
    const level = c.level ?? 'error';
    const route = c.route?.split('?')[0].slice(0, 500) ?? null;
    if (process.env.NODE_ENV !== 'test') console.error(`[${c.source}]${route ? ` ${route}` : ''}`, d.stack ?? d.message);
    const fp = fingerprint(c.source, d.message, route);
    const { getDatabase } = await import('../db/client.js');
    const { errorEvents } = await import('../db/schema.js');
    const { db } = await getDatabase();
    await db.insert(errorEvents).values({
      fingerprint: fp, source: c.source, level, message: d.message.slice(0, 4000), stack: d.stack?.slice(0, 8000) ?? null, route,
      tenantId: c.tenantId ?? null, userId: c.userId ?? null, context: c.context ?? null,
    }).onConflictDoUpdate({
      target: errorEvents.fingerprint,
      set: { count: sql`${errorEvents.count} + 1`, lastSeenAt: new Date(), resolvedAt: null, stack: d.stack?.slice(0, 8000) ?? null, tenantId: c.tenantId ?? null, userId: c.userId ?? null, context: c.context ?? null },
    });
    void toSentry(d, level, route, c).catch(() => undefined);
  } catch (e) {
    console.error('[monitor] capture failed', (e as Error).message);
  }
}

/** Parse a DSN like https://<key>@o123.ingest.sentry.io/456 into the envelope endpoint + auth header. */
export function sentryTarget(dsn: string): { url: string; auth: string } | null {
  try {
    const u = new URL(dsn);
    const project = u.pathname.replace(/^\/+|\/+$/g, '');
    if (!u.username || !project) return null;
    return { url: `${u.protocol}//${u.host}/api/${project}/envelope/`, auth: `Sentry sentry_version=7, sentry_key=${u.username}, sentry_client=camplo/1.0` };
  } catch { return null; }
}

async function toSentry(d: { message: string; stack: string | null; type: string }, level: string, route: string | null, c: Capture) {
  const dsn = config.sentryDsn;
  const t = dsn ? sentryTarget(dsn) : null;
  if (!t) return;
  const eventId = randomUUID().replace(/-/g, '');
  const event = {
    event_id: eventId, timestamp: Date.now() / 1000, platform: c.source.endsWith('client') ? 'javascript' : 'node', level,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'production', server_name: 'camplo',
    exception: { values: [{ type: d.type, value: d.message }] },
    tags: { source: c.source, ...(route ? { route } : {}), ...(c.tenantId ? { tenant: c.tenantId } : {}) },
    user: c.userId ? { id: c.userId } : undefined, extra: { stack: d.stack, ...(c.context ?? {}) },
  };
  const body = `${JSON.stringify({ event_id: eventId, dsn })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}`;
  await fetch(t.url, { method: 'POST', headers: { 'Content-Type': 'application/x-sentry-envelope', 'X-Sentry-Auth': t.auth }, body, signal: AbortSignal.timeout(5000) });
}

/** Very small per-key limiter for the public browser-error endpoint. */
const buckets = new Map<string, { n: number; reset: number }>();
export function allowClientReport(key: string, perMinute = 30): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.reset) { buckets.set(key, { n: 1, reset: now + 60_000 }); if (buckets.size > 5000) buckets.clear(); return true; }
  return ++b.n <= perMinute;
}
