import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { platform } from '../lib/platform.js';
import { createCheckout } from '../lib/polar.js';
import type { DB } from '../db/client.js';
import { aiProviderConfigs, oneTimeTokens, sessions, tenants, users } from '../db/schema.js';
import { checkPassword, cookie, hashPassword, parseCookies, signAccessToken } from '../lib/auth.js';
import { config } from '../lib/config.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { emails, sendMail } from '../lib/mailer.js';
import { fail, type BaseContext } from '../lib/orpc.js';
import { ensureBank } from '../ai/memory.js';
import { logWorkspace } from './effects.js';

const REFRESH_MAX_AGE = 30 * 24 * 3600;

async function issueSession(ctx: BaseContext, user: typeof users.$inferSelect) {
  const refresh = randomToken();
  await ctx.db.insert(sessions).values({ tenantId: user.tenantId, userId: user.id, refreshTokenHash: sha256(refresh) });
  const access = await signAccessToken({ sub: user.id, tid: user.tenantId, role: user.role });
  ctx.setCookies.push(cookie('camplo_at', access, config.accessTokenTtlSeconds), cookie('camplo_rt', refresh, REFRESH_MAX_AGE));
  return access;
}

/** Where the client should go after authenticating (Build Spec Screen 22). */
export function nextRoute(t: typeof tenants.$inferSelect): string {
  if (t.status === 'pending_activation' || t.status === 'flagged') return '/pending';
  if (t.status === 'suspended') return '/login';
  return t.setupComplete ? '/dashboard' : '/setup';
}

// Simple in-memory login throttle: 10 attempts / 15 min per email+ip.
const attempts = new Map<string, { n: number; until: number }>();

export async function login(ctx: BaseContext, email: string, password: string) {
  const key = `${email.toLowerCase()}|${ctx.ip}`;
  const a = attempts.get(key);
  if (a && a.n >= 10 && a.until > Date.now()) {
    throw fail.rateLimited(`Too many attempts. Try again in ${Math.ceil((a.until - Date.now()) / 60000)} minutes.`);
  }
  const rows = await ctx.db.select({ user: users, tenant: tenants }).from(users)
    .innerJoin(tenants, eq(tenants.id, users.tenantId))
    .where(and(sql`lower(${users.email}) = ${email.toLowerCase()}`, isNull(users.removedAt)));
  let match: (typeof rows)[number] | undefined;
  for (const r of rows) if (await checkPassword(password, r.user.passwordHash)) { match = r; break; }
  if (!match) {
    attempts.set(key, { n: (a && a.until > Date.now() ? a.n : 0) + 1, until: Date.now() + 15 * 60_000 });
    throw fail.unauthorized('Incorrect email or password.');
  }
  attempts.delete(key);
  if (match.tenant.status === 'suspended') {
    throw fail.forbidden(`Your account has been suspended. Contact support at ${(await platform(ctx.db)).branding.supportEmail}.`, 'account_suspended');
  }
  const accessToken = await issueSession(ctx, match.user);
  return { accessToken, next: nextRoute(match.tenant), user: publicUser(match.user), tenant: publicTenant(match.tenant) };
}

// ------------------------------------------------------------------ magic-link login (ADL P-2: 15 minutes, single use)
const magicSent = new Map<string, { n: number; until: number }>();

/** Always answers ok (no account enumeration). Sends one link per workspace the email belongs to. */
export async function requestMagicLink(db: DB, email: string) {
  const key = email.toLowerCase();
  const m = magicSent.get(key);
  if (m && m.until > Date.now() && m.n >= 5) return { ok: true };
  magicSent.set(key, { n: (m && m.until > Date.now() ? m.n : 0) + 1, until: Date.now() + 15 * 60_000 });
  const rows = await db.select({ user: users, tenant: tenants }).from(users).innerJoin(tenants, eq(tenants.id, users.tenantId))
    .where(and(sql`lower(${users.email}) = ${key}`, isNull(users.removedAt), isNull(users.invitationToken)));
  for (const { user } of rows) {
    const token = randomToken();
    await db.insert(oneTimeTokens).values({
      tenantId: user.tenantId, purpose: 'magic_login', tokenHash: sha256(token), userId: user.id,
      expiresAt: new Date(Date.now() + config.magicLinkExpirySeconds * 1000),
    });
    await sendMail(emails.magicLink(user.email, `${config.appUrl}/#/verify?token=${token}`));
  }
  return { ok: true };
}

/** Exchange a magic-link token for a session. `used_at` is checked and set atomically — a link works exactly once. */
export async function verifyMagicLink(ctx: BaseContext, token: string) {
  const [t] = await ctx.db.update(oneTimeTokens).set({ usedAt: new Date() })
    .where(and(eq(oneTimeTokens.tokenHash, sha256(token)), eq(oneTimeTokens.purpose, 'magic_login'), isNull(oneTimeTokens.usedAt), gt(oneTimeTokens.expiresAt, new Date())))
    .returning();
  if (!t?.userId) throw fail.unauthorized('This sign-in link has expired or was already used. Request a new one.');
  const [row] = await ctx.db.select({ user: users, tenant: tenants }).from(users).innerJoin(tenants, eq(tenants.id, users.tenantId))
    .where(and(eq(users.id, t.userId), isNull(users.removedAt)));
  if (!row) throw fail.unauthorized('This sign-in link has expired or was already used. Request a new one.');
  if (row.tenant.status === 'suspended') throw fail.forbidden(`Your account has been suspended. Contact support at ${(await platform(ctx.db)).branding.supportEmail}.`, 'account_suspended');
  const accessToken = await issueSession(ctx, row.user);
  return { accessToken, next: nextRoute(row.tenant), user: publicUser(row.user), tenant: publicTenant(row.tenant) };
}

export async function refresh(ctx: BaseContext) {
  const token = parseCookies(ctx.headers.cookie).camplo_rt;
  if (!token) throw fail.unauthorized();
  const cutoff = new Date(Date.now() - config.sessionInactivityDays * 86400_000);
  const [row] = await ctx.db.select({ s: sessions, u: users }).from(sessions).innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.refreshTokenHash, sha256(token)), isNull(sessions.revokedAt), gt(sessions.lastUsedAt, cutoff), isNull(users.removedAt)));
  if (!row) throw fail.unauthorized('Your session has expired. Please sign in again.');
  // Rotate the refresh token on every use.
  await ctx.db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, row.s.id));
  const accessToken = await issueSession(ctx, row.u);
  return { accessToken };
}

export async function logout(ctx: BaseContext) {
  const token = parseCookies(ctx.headers.cookie).camplo_rt;
  if (token) await ctx.db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.refreshTokenHash, sha256(token)));
  ctx.setCookies.push(cookie('camplo_at', '', 0), cookie('camplo_rt', '', 0));
  return { ok: true };
}

export async function signup(ctx: BaseContext, input: { name: string; email: string; password: string; workspaceName: string; plan: 'starter' | 'growth' | 'watchtower' }) {
  const email = input.email.toLowerCase();
  const [exists] = await ctx.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.ownerEmail, email));
  if (exists) throw fail.conflict('An account with this email already exists.', 'duplicate_email');
  const autoActivate = (await platform(ctx.db)).signup.autoActivate;
  const tenant = await ctx.db.transaction(async (tx) => {
    const [t] = await tx.insert(tenants).values({
      businessName: input.workspaceName, ownerName: input.name, ownerEmail: email, notificationEmail: email, plan: input.plan,
      status: autoActivate ? 'active' : 'pending_activation', activatedAt: autoActivate ? new Date() : null, storageQuotaBytes: config.defaultStorageQuotaBytes,
    }).returning();
    await tx.insert(users).values({ tenantId: t.id, email, name: input.name, role: 'owner', passwordHash: await hashPassword(input.password), joinedAt: new Date() });
    await tx.insert(aiProviderConfigs).values({ tenantId: t.id });
    return t;
  });
  await logWorkspace(ctx.db, tenant.id, null, `Workspace created by ${input.name}`);
  if (autoActivate) await ensureBank(tenant.id, tenant.businessName);
  // Payment happens on Polar checkout; the Polar webhook records the order. No auto-login after signup.
  let checkoutUrl: string | null = null;
  try { checkoutUrl = await createCheckout({ plan: input.plan, email, tenantId: tenant.id }); } catch (e) { console.error('[polar]', (e as Error).message); }
  return { next: autoActivate ? '/login' : '/pending', checkoutUrl };
}

/** Never confirms or denies whether the account exists. */
export async function forgotPassword(db: DB, email: string) {
  const rows = await db.select().from(users).where(and(sql`lower(${users.email}) = ${email.toLowerCase()}`, isNull(users.removedAt)));
  for (const u of rows) {
    const token = randomToken();
    await db.insert(oneTimeTokens).values({
      tenantId: u.tenantId, purpose: 'password_reset', tokenHash: sha256(token), userId: u.id,
      expiresAt: new Date(Date.now() + config.passwordResetExpirySeconds * 1000),
    });
    await sendMail(emails.resetPassword(u.email, `${config.appUrl}/#/reset-password?token=${token}`));
  }
  return { ok: true };
}

export async function resetPassword(db: DB, token: string, newPassword: string) {
  if (newPassword.length < 8) throw fail.bad('Password must be at least 8 characters.');
  const [t] = await db.select().from(oneTimeTokens).where(and(eq(oneTimeTokens.tokenHash, sha256(token)), eq(oneTimeTokens.purpose, 'password_reset')));
  if (!t || t.usedAt || t.expiresAt < new Date() || !t.userId) throw fail.bad('This reset link has expired or is invalid. Request a new one.');
  await db.transaction(async (tx) => {
    await tx.update(oneTimeTokens).set({ usedAt: new Date() }).where(eq(oneTimeTokens.id, t.id));
    await tx.update(users).set({ passwordHash: await hashPassword(newPassword) }).where(eq(users.id, t.userId!));
    await tx.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.userId, t.userId!));
  });
  return { ok: true };
}

/** Accept a team invitation (magic link) and set a password. */
export async function acceptInvitation(ctx: BaseContext, token: string, password: string, name?: string) {
  if (password.length < 8) throw fail.bad('Password must be at least 8 characters.');
  const [u] = await ctx.db.select().from(users).where(eq(users.invitationToken, sha256(token)));
  if (!u || !u.invitationExpiresAt || u.invitationExpiresAt < new Date()) throw fail.bad('This invitation has expired. Ask for a new one.');
  const [updated] = await ctx.db.update(users).set({
    passwordHash: await hashPassword(password), invitationToken: null, invitationExpiresAt: null, joinedAt: new Date(), ...(name ? { name } : {}),
  }).where(eq(users.id, u.id)).returning();
  const [t] = await ctx.db.select().from(tenants).where(eq(tenants.id, u.tenantId));
  await logWorkspace(ctx.db, u.tenantId, u.id, `${updated.name} joined the workspace`);
  await issueSession(ctx, updated);
  return { next: nextRoute(t) };
}

export function publicUser(u: typeof users.$inferSelect) {
  return {
    id: u.id, name: u.name, email: u.email, role: u.role, theme: u.theme, avatarUrl: u.avatarUrl,
    initials: initials(u.name), lastActiveAt: u.lastActiveAt, joinedAt: u.joinedAt,
  };
}

export function publicTenant(t: typeof tenants.$inferSelect) {
  return {
    id: t.id, name: t.businessName, status: t.status, plan: t.plan, setupComplete: t.setupComplete, logoUrl: t.logoUrl,
    hasMarketingStack: t.hasMarketingStack, stackCheckCompleted: t.stackCheckCompleted, teamSize: t.teamSize,
    slaThresholdMinutes: t.slaThresholdMinutes, vipSlaThresholdMinutes: t.vipSlaThresholdMinutes, vipLeadEnabled: t.vipLeadEnabled,
    storageUsedBytes: t.storageUsedBytes, storageQuotaBytes: t.storageQuotaBytes,
  };
}

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';
