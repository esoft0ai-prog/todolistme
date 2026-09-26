/**
 * oRPC procedure builders. Every authenticated procedure resolves the user and
 * tenant fresh from the database (role changes and suspensions apply
 * immediately) and exposes `ctx.tenantId`, which every query must filter on.
 */
import { os, ORPCError } from '@orpc/server';
import { and, eq, isNull } from 'drizzle-orm';
import type { IncomingHttpHeaders } from 'node:http';
import type { DB } from '../db/client.js';
import { tenants, users } from '../db/schema.js';
import { parseCookies, verifyAccessToken } from './auth.js';
import { type Feature, FEATURE_PLAN, hasFeature, type Plan, type Role } from '../domain/rules.js';

export interface BaseContext {
  db: DB;
  headers: IncomingHttpHeaders;
  ip: string;
  /** Cookies to set on the HTTP response (auth endpoints). */
  setCookies: string[];
}

export type Tenant = typeof tenants.$inferSelect;
export type User = typeof users.$inferSelect;
export interface AuthedContext extends BaseContext { user: User; tenant: Tenant; tenantId: string; role: Role; plan: Plan }

export const pub = os.$context<BaseContext>();

export const fail = {
  unauthorized: (message = 'Session expired. Please log in again.') => new ORPCError('UNAUTHORIZED', { message }),
  forbidden: (message = "You don't have access to this.", reason?: string, extra: Record<string, unknown> = {}) =>
    new ORPCError('FORBIDDEN', { message, data: { reason, ...extra } }),
  /** ADL D-NEW-9: a feature or limit above the workspace's plan → 403 { reason: 'plan_limit', required_plan }. */
  planLimit: (message: string, requiredPlan: Plan) => new ORPCError('FORBIDDEN', { message, data: { reason: 'plan_limit', required_plan: requiredPlan } }),
  notFound: (message = 'Not found.') => new ORPCError('NOT_FOUND', { message }),
  conflict: (message: string, reason?: string) => new ORPCError('CONFLICT', { message, data: { reason } }),
  bad: (message: string) => new ORPCError('BAD_REQUEST', { message }),
  unprocessable: (message: string) => new ORPCError('UNPROCESSABLE_CONTENT', { message }),
  tooLarge: (message = 'Storage quota exceeded. Delete unused deployments to free space.') => new ORPCError('PAYLOAD_TOO_LARGE', { message }),
  rateLimited: (message: string) => new ORPCError('TOO_MANY_REQUESTS', { message }),
};

export function bearer(headers: IncomingHttpHeaders): string | null {
  const h = headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7);
  return parseCookies(headers.cookie).camplo_at ?? null;
}

const lastTouch = new Map<string, number>();

/** Resolve and validate the caller. Shared by oRPC procedures and raw Express endpoints. */
export async function resolveAuth(db: DB, headers: IncomingHttpHeaders): Promise<{ user: User; tenant: Tenant }> {
  const token = bearer(headers);
  const claims = token ? await verifyAccessToken(token) : null;
  if (!claims) throw fail.unauthorized();
  const [row] = await db.select({ user: users, tenant: tenants }).from(users)
    .innerJoin(tenants, eq(tenants.id, users.tenantId))
    .where(and(eq(users.id, claims.sub), eq(users.tenantId, claims.tid), isNull(users.removedAt)));
  if (!row) throw fail.unauthorized();
  const { user, tenant } = row;
  if (tenant.status === 'suspended') {
    throw fail.forbidden(`Your account has been suspended. Contact support.`, 'account_suspended');
  }
  if (tenant.status !== 'active') throw fail.forbidden('Your account is awaiting activation.', 'pending_activation');
  // Throttled last_active_at update (at most every 5 minutes per user).
  const now = Date.now();
  if ((lastTouch.get(user.id) ?? 0) < now - 5 * 60_000) {
    lastTouch.set(user.id, now);
    await db.update(users).set({ lastActiveAt: new Date() }).where(eq(users.id, user.id));
  }
  return { user, tenant };
}

export const authed = pub.use(async ({ context, next }) => {
  const { user, tenant } = await resolveAuth(context.db, context.headers);
  return next({ context: { user, tenant, tenantId: tenant.id, role: user.role as Role, plan: tenant.plan as Plan } });
});

export function toAuthedContext(base: BaseContext, a: { user: User; tenant: Tenant }): AuthedContext {
  return { ...base, user: a.user, tenant: a.tenant, tenantId: a.tenant.id, role: a.user.role as Role, plan: a.tenant.plan as Plan };
}

export const requireRole = (...roles: Role[]) => authed.use(async ({ context, next }) => {
  if (!roles.includes(context.role)) throw fail.forbidden();
  return next();
});

export function assertRole(ctx: AuthedContext, ...roles: Role[]) {
  if (!roles.includes(ctx.role)) throw fail.forbidden();
}

export function assertFeature(ctx: AuthedContext, f: Feature) {
  if (!hasFeature(ctx.plan, f)) {
    const need = FEATURE_PLAN[f];
    throw fail.planLimit(`Available on ${need[0].toUpperCase()}${need.slice(1)} — upgrade to unlock.`, need);
  }
}

export const withFeature = (f: Feature) => authed.use(async ({ context, next }) => {
  assertFeature(context, f);
  return next();
});
