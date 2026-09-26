/** Workspace, team management (TM1–TM4), notifications, workspace log and global search. */
import { and, desc, eq, gte, ilike, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { campaignMembers, campaigns, deployments, leads, notifications, tenants, users, workspaceLogs } from '../db/schema.js';
import { fail, assertRole, type AuthedContext } from '../lib/orpc.js';
import { config } from '../lib/config.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { emails, sendMail } from '../lib/mailer.js';
import { DAY, PLAN_LIMITS, PLAN_PRICE, type Plan } from '../domain/rules.js';
import { initials, publicTenant, publicUser } from './auth.js';
import { avgResponseMs, workspaceConversion } from './metrics.js';
import { logWorkspace } from './effects.js';
import { storageFor } from '../lib/storage.js';
import { displayId } from './leads.js';

export async function getWorkspace(ctx: AuthedContext) {
  const [unread] = await ctx.db.select({ n: sql<number>`count(*)` }).from(notifications)
    .where(and(eq(notifications.tenantId, ctx.tenantId), isNull(notifications.readAt), or(isNull(notifications.userId), eq(notifications.userId, ctx.user.id))));
  return {
    ...publicTenant(ctx.tenant), avgConversionRate: await workspaceConversion(ctx.db, ctx.tenantId),
    notifications: { unreadCount: Number(unread.n) }, limits: limitsFor(ctx.plan), price: PLAN_PRICE[ctx.plan],
    me: publicUser(ctx.user),
  };
}

const limitsFor = (p: Plan) => Object.fromEntries(Object.entries(PLAN_LIMITS[p]).map(([k, v]) => [k, Number.isFinite(v) ? v : null]));

export async function patchWorkspace(ctx: AuthedContext, patch: {
  name?: string; teamSize?: string; hasMarketingStack?: boolean; stackCheckCompleted?: boolean; setupComplete?: boolean; notificationEmail?: string;
}) {
  assertRole(ctx, 'owner');
  const set: Partial<typeof tenants.$inferInsert> = {};
  if (patch.name) set.businessName = patch.name.trim();
  if (patch.teamSize !== undefined) set.teamSize = patch.teamSize;
  if (patch.hasMarketingStack !== undefined) set.hasMarketingStack = patch.hasMarketingStack;
  if (patch.stackCheckCompleted !== undefined) set.stackCheckCompleted = patch.stackCheckCompleted;
  if (patch.setupComplete !== undefined) set.setupComplete = patch.setupComplete;
  if (patch.notificationEmail) set.notificationEmail = patch.notificationEmail;
  if (Object.keys(set).length) await ctx.db.update(tenants).set(set).where(eq(tenants.id, ctx.tenantId));
  const [t] = await ctx.db.select().from(tenants).where(eq(tenants.id, ctx.tenantId));
  return publicTenant(t);
}

export function planInfo(ctx: AuthedContext) {
  return { plan: ctx.plan, price: PLAN_PRICE[ctx.plan], limits: limitsFor(ctx.plan) };
}

/** O6 upgrade. With Polar configured this returns a checkout URL; the webhook applies the new plan. */
export async function upgrade(ctx: AuthedContext, targetPlan: Plan) {
  assertRole(ctx, 'owner');
  const url = process.env[`POLAR_CHECKOUT_URL_${targetPlan.toUpperCase()}`];
  if (url) return { checkoutUrl: `${url}?customer_email=${encodeURIComponent(ctx.tenant.ownerEmail)}&metadata[tenant_id]=${ctx.tenantId}`, applied: false };
  if (process.env.ALLOW_DIRECT_PLAN_CHANGE === 'true') {
    await ctx.db.update(tenants).set({ plan: targetPlan }).where(eq(tenants.id, ctx.tenantId));
    await logWorkspace(ctx.db, ctx.tenantId, ctx.user.id, `Plan changed to ${targetPlan}`);
    return { checkoutUrl: null, applied: true };
  }
  throw fail.bad('Billing is not configured for this environment.');
}

export async function uploadLogo(ctx: AuthedContext, file: File) {
  assertRole(ctx, 'owner');
  if (!/^image\/(png|jpe?g)$/.test(file.type)) throw fail.bad('Logo must be a PNG or JPG.');
  if (file.size > 2 * 1024 * 1024) throw fail.bad('Logo must be 2MB or smaller.');
  const path = `logos/${ctx.tenantId}/${Date.now()}.${file.type.endsWith('png') ? 'png' : 'jpg'}`;
  await (await storageFor(ctx.db)).put(path, Buffer.from(await file.arrayBuffer()), file.type);
  const logoUrl = `/api/files/${path}`;
  await ctx.db.update(tenants).set({ logoUrl }).where(eq(tenants.id, ctx.tenantId));
  return { logoUrl };
}

export async function removeLogo(ctx: AuthedContext) {
  assertRole(ctx, 'owner');
  await ctx.db.update(tenants).set({ logoUrl: null }).where(eq(tenants.id, ctx.tenantId));
  return { ok: true };
}

// ------------------------------------------------------------------ team

async function performance(ctx: AuthedContext, userId: string) {
  const now = Date.now();
  const week = new Date(now - 7 * DAY), month = new Date(now - 30 * DAY);
  const mine = eq(leads.respondedBy, userId);
  const [w, m] = await Promise.all([avgResponseMs(ctx.db, ctx.tenantId, week, new Date(), mine), avgResponseMs(ctx.db, ctx.tenantId, month, new Date(), mine)]);
  const thr = ctx.tenant.slaThresholdMinutes;
  const [agg] = await ctx.db.select({
    assigned: sql<number>`count(*)`,
    responded: sql<number>`count(*) filter (where ${leads.status} = 'responded')`,
    breaches: sql<number>`count(*) filter (where coalesce(${leads.respondedAt}, now()) - ${leads.receivedAt} > ${thr}::int * interval '1 minute')`,
    fastest: sql<number | null>`min(extract(epoch from (${leads.respondedAt} - ${leads.receivedAt})) * 1000) filter (where ${leads.respondedBy} = ${userId})`,
  }).from(leads).where(and(eq(leads.tenantId, ctx.tenantId), eq(leads.assigneeId, userId), gte(leads.receivedAt, week)));
  return {
    avgThisWeekMs: w.avgMs, avg30dMs: m.avgMs, respondedThisWeek: w.count,
    acknowledgmentRate: Number(agg.assigned) ? Number(agg.responded) / Number(agg.assigned) : null,
    breachesThisWeek: Number(agg.breaches), fastestThisWeekMs: agg.fastest == null ? null : Math.round(Number(agg.fastest)),
  };
}

export async function listMembers(ctx: AuthedContext) {
  const rows = await ctx.db.select().from(users).where(and(eq(users.tenantId, ctx.tenantId), isNull(users.removedAt), isNotNull(users.joinedAt))).orderBy(users.createdAt);
  const out = [];
  for (const u of rows) out.push({ ...publicUser(u), performance: await performance(ctx, u.id) });
  return out;
}

export async function getMember(ctx: AuthedContext, id: string) {
  if (ctx.role === 'member' && id !== ctx.user.id) throw fail.forbidden();
  const [u] = await ctx.db.select().from(users).where(and(eq(users.tenantId, ctx.tenantId), eq(users.id, id), isNull(users.removedAt)));
  if (!u) throw fail.notFound('Member not found.');
  const camps = await ctx.db.select({ id: campaigns.id, name: campaigns.name }).from(campaignMembers).innerJoin(campaigns, eq(campaigns.id, campaignMembers.campaignId))
    .where(and(eq(campaignMembers.tenantId, ctx.tenantId), eq(campaignMembers.userId, id)));
  const recent = await ctx.db.select({ d: workspaceLogs.description, at: workspaceLogs.createdAt }).from(workspaceLogs)
    .where(and(eq(workspaceLogs.tenantId, ctx.tenantId), eq(workspaceLogs.actorId, id))).orderBy(desc(workspaceLogs.createdAt)).limit(10);
  const responded = await ctx.db.select({ name: leads.fullName, at: leads.respondedAt }).from(leads)
    .where(and(eq(leads.tenantId, ctx.tenantId), eq(leads.respondedBy, id))).orderBy(desc(leads.respondedAt)).limit(10);
  const activity = [...recent.map((r) => ({ description: r.d, at: r.at })), ...responded.map((r) => ({ description: `Responded to ${r.name}`, at: r.at! }))]
    .sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 10);
  return { ...publicUser(u), performance: await performance(ctx, id), campaigns: camps, recentActivity: activity };
}

export async function changeRole(ctx: AuthedContext, id: string, role: 'admin' | 'member') {
  assertRole(ctx, 'owner');
  const [u] = await ctx.db.select().from(users).where(and(eq(users.tenantId, ctx.tenantId), eq(users.id, id), isNull(users.removedAt)));
  if (!u) throw fail.notFound('Member not found.');
  if (u.role === 'owner') throw fail.forbidden('The owner role cannot be changed.');
  await ctx.db.update(users).set({ role }).where(eq(users.id, id));
  await logWorkspace(ctx.db, ctx.tenantId, ctx.user.id, `${u.name}'s role changed to ${role}`);
  return { ok: true, role };
}

/** Soft-remove: audit trails keep pointing at the user record. */
export async function removeMember(ctx: AuthedContext, id: string) {
  assertRole(ctx, 'owner');
  const [u] = await ctx.db.select().from(users).where(and(eq(users.tenantId, ctx.tenantId), eq(users.id, id), isNull(users.removedAt)));
  if (!u) throw fail.notFound('Member not found.');
  if (u.role === 'owner') throw fail.forbidden('The owner cannot be removed.');
  await ctx.db.update(users).set({ removedAt: new Date(), passwordHash: null }).where(eq(users.id, id));
  // Unresponded leads they owned go back to the shared inbox.
  await ctx.db.update(leads).set({ assigneeId: null, assignmentPath: null }).where(and(eq(leads.tenantId, ctx.tenantId), eq(leads.assigneeId, id), eq(leads.status, 'not_responded')));
  await logWorkspace(ctx.db, ctx.tenantId, ctx.user.id, `${u.name} removed from the workspace`);
  return { ok: true };
}

export async function listInvitations(ctx: AuthedContext) {
  assertRole(ctx, 'owner', 'admin');
  const rows = await ctx.db.select().from(users).where(and(eq(users.tenantId, ctx.tenantId), isNull(users.joinedAt), isNull(users.removedAt)));
  return rows.map((u) => ({
    id: u.id, email: u.email, role: u.role, invitedAt: u.createdAt, expiresAt: u.invitationExpiresAt,
    status: u.invitationExpiresAt && u.invitationExpiresAt < new Date() ? 'expired' : 'pending',
  }));
}

async function sendInvite(ctx: AuthedContext, u: typeof users.$inferSelect) {
  const token = randomToken();
  await ctx.db.update(users).set({ invitationToken: sha256(token), invitationExpiresAt: new Date(Date.now() + config.invitationExpiryDays * DAY) }).where(eq(users.id, u.id));
  await sendMail(emails.invite(u.email, ctx.user.name, ctx.tenant.businessName, `${config.appUrl}/#/accept-invite?token=${token}`));
  return token;
}

export async function invite(ctx: AuthedContext, email: string, role: 'admin' | 'member') {
  assertRole(ctx, 'owner', 'admin');
  const e = email.trim().toLowerCase();
  const [existing] = await ctx.db.select().from(users).where(and(eq(users.tenantId, ctx.tenantId), sql`lower(${users.email}) = ${e}`));
  if (existing && !existing.removedAt) {
    throw fail.conflict(existing.joinedAt ? 'This person is already a member.' : 'An invitation has already been sent to this address.', existing.joinedAt ? 'already_member' : 'pending_invite');
  }
  const [{ n }] = await ctx.db.select({ n: sql<number>`count(*)` }).from(users).where(and(eq(users.tenantId, ctx.tenantId), isNull(users.removedAt)));
  if (Number(n) >= PLAN_LIMITS[ctx.plan].members) throw fail.forbidden(`Your plan includes ${PLAN_LIMITS[ctx.plan].members} team members. Upgrade to invite more.`, 'plan_limit', { plan: 'growth' });
  let u: typeof users.$inferSelect;
  if (existing) {
    [u] = await ctx.db.update(users).set({ removedAt: null, joinedAt: null, role, invitedBy: ctx.user.id, createdAt: new Date() }).where(eq(users.id, existing.id)).returning();
  } else {
    [u] = await ctx.db.insert(users).values({ tenantId: ctx.tenantId, email: e, name: e.split('@')[0], role, invitedBy: ctx.user.id }).returning();
  }
  const token = await sendInvite(ctx, u);
  await logWorkspace(ctx.db, ctx.tenantId, ctx.user.id, `Invited ${e} as ${role}`);
  return { id: u.id, email: u.email, ...(config.env === 'test' ? { token } : {}) };
}

export async function resendInvitation(ctx: AuthedContext, id: string) {
  assertRole(ctx, 'owner', 'admin');
  const [u] = await ctx.db.select().from(users).where(and(eq(users.tenantId, ctx.tenantId), eq(users.id, id), isNull(users.joinedAt), isNull(users.removedAt)));
  if (!u) throw fail.notFound('Invitation not found.');
  await sendInvite(ctx, u);
  return { ok: true, email: u.email };
}

export async function cancelInvitation(ctx: AuthedContext, id: string) {
  assertRole(ctx, 'owner', 'admin');
  await ctx.db.update(users).set({ removedAt: new Date(), invitationToken: null })
    .where(and(eq(users.tenantId, ctx.tenantId), eq(users.id, id), isNull(users.joinedAt)));
  return { ok: true };
}

export async function updateMe(ctx: AuthedContext, patch: { name?: string; theme?: 'dark' | 'light' }) {
  const set: Partial<typeof users.$inferInsert> = {};
  if (patch.name) set.name = patch.name.trim();
  if (patch.theme) set.theme = patch.theme;
  const [u] = await ctx.db.update(users).set(set).where(eq(users.id, ctx.user.id)).returning();
  return publicUser(u);
}

// ------------------------------------------------------------------ notifications, logs, search

export async function listNotifications(ctx: AuthedContext) {
  const rows = await ctx.db.select().from(notifications)
    .where(and(eq(notifications.tenantId, ctx.tenantId), or(isNull(notifications.userId), eq(notifications.userId, ctx.user.id))))
    .orderBy(desc(notifications.createdAt)).limit(50);
  return { notifications: rows.map((n) => ({ id: n.id, kind: n.kind, description: n.description, link: n.link, read: !!n.readAt, createdAt: n.createdAt })), unreadCount: rows.filter((n) => !n.readAt).length };
}

export async function markNotificationRead(ctx: AuthedContext, id: string | 'all') {
  const base = and(eq(notifications.tenantId, ctx.tenantId), or(isNull(notifications.userId), eq(notifications.userId, ctx.user.id)), isNull(notifications.readAt));
  await ctx.db.update(notifications).set({ readAt: new Date() }).where(id === 'all' ? base : and(base, eq(notifications.id, id)));
  return { ok: true };
}

export async function workspaceLog(ctx: AuthedContext, limit = 100) {
  assertRole(ctx, 'owner', 'admin');
  const rows = await ctx.db.select({ l: workspaceLogs, name: users.name }).from(workspaceLogs).leftJoin(users, eq(users.id, workspaceLogs.actorId))
    .where(eq(workspaceLogs.tenantId, ctx.tenantId)).orderBy(desc(workspaceLogs.createdAt)).limit(limit);
  return rows.map((r) => ({ id: r.l.id, actorName: r.name ?? 'Camplo', description: r.l.description, createdAt: r.l.createdAt }));
}

export async function search(ctx: AuthedContext, q: string) {
  const term = q.trim();
  if (term.length < 2) return { campaigns: [], leads: [], pages: [] };
  const like = `%${term.replace(/[%_]/g, '\\$&')}%`;
  const [cs, ls, ps] = await Promise.all([
    ctx.db.select({ id: campaigns.id, name: campaigns.name, status: campaigns.status }).from(campaigns).where(and(eq(campaigns.tenantId, ctx.tenantId), ilike(campaigns.name, like))).limit(5),
    ctx.db.select({ id: leads.id, name: leads.fullName, campaignId: leads.campaignId, campaignName: campaigns.name }).from(leads).leftJoin(campaigns, eq(campaigns.id, leads.campaignId))
      .where(and(eq(leads.tenantId, ctx.tenantId), or(ilike(leads.fullName, like), ilike(leads.email, like)), ctx.role === 'member' ? or(isNull(leads.assigneeId), eq(leads.assigneeId, ctx.user.id)) : undefined)).limit(5),
    ctx.db.select({ id: deployments.id, name: deployments.name, subdomain: deployments.subdomain }).from(deployments)
      .where(and(eq(deployments.tenantId, ctx.tenantId), sql`${deployments.status} <> 'deleted'`, or(ilike(deployments.name, like), ilike(deployments.subdomain, like)))).limit(5),
  ]);
  return {
    campaigns: cs,
    leads: ls.map((l) => ({ ...l, displayId: displayId(l.id) })),
    pages: ps.map((p) => ({ ...p, host: `${p.subdomain}.${config.pagesBaseDomain}` })),
  };
}

export async function teamAvatars(ctx: AuthedContext) {
  const rows = await ctx.db.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.tenantId, ctx.tenantId), isNull(users.removedAt), isNotNull(users.joinedAt)));
  return rows.map((r) => ({ ...r, initials: initials(r.name) }));
}

