import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { sendLeadMessage } from './telegram.js';
import type { DB } from '../db/client.js';
import {
  campaigns, crossToolSlaBreaches, crossToolSlaRules, deployments, insights, integrations, leads, tenants, users,
} from '../db/schema.js';
import { fail, assertFeature, assertRole, type AuthedContext } from '../lib/orpc.js';
import { config } from '../lib/config.js';
import { emails, sendMail } from '../lib/mailer.js';
import { DAY, formatDuration, speedColor } from '../domain/rules.js';
import { avgResponseMs } from './metrics.js';
import { createAckToken, displayId, overdueCount } from './leads.js';
import { emit, fireOutbound, notify, remember } from './effects.js';

const overdueWhere = (t: typeof tenants.$inferSelect) => {
  const thr = t.slaThresholdMinutes, vip = t.vipLeadEnabled ? t.vipSlaThresholdMinutes : thr;
  return and(eq(leads.tenantId, t.id), eq(leads.status, 'not_responded'),
    sql`${leads.receivedAt} < now() - (case when ${leads.vip} then ${vip}::int else ${thr}::int end) * interval '1 minute'`);
};

/** GET /sla/live — Speed-to-Lead (nav), comparisons and Morning Brief digest fields. */
export async function live(ctx: AuthedContext) {
  const now = Date.now();
  const startToday = new Date(); startToday.setUTCHours(0, 0, 0, 0);
  const startYesterday = new Date(startToday.getTime() - DAY);
  const [d7, today, d30, yesterday] = await Promise.all([
    avgResponseMs(ctx.db, ctx.tenantId, new Date(now - 7 * DAY)), avgResponseMs(ctx.db, ctx.tenantId, startToday),
    avgResponseMs(ctx.db, ctx.tenantId, new Date(now - 30 * DAY)), avgResponseMs(ctx.db, ctx.tenantId, startYesterday, startToday),
  ]);
  const mineY = await avgResponseMs(ctx.db, ctx.tenantId, startYesterday, startToday, eq(leads.respondedBy, ctx.user.id));
  const mine30 = await avgResponseMs(ctx.db, ctx.tenantId, new Date(now - 30 * DAY), new Date(), eq(leads.respondedBy, ctx.user.id));
  const thr = ctx.tenant.slaThresholdMinutes;
  const [y] = await ctx.db.select({
    received: sql<number>`count(*)`, responded: sql<number>`count(*) filter (where ${leads.status} = 'responded')`,
    breaches: sql<number>`count(*) filter (where coalesce(${leads.respondedAt}, now()) - ${leads.receivedAt} > ${thr}::int * interval '1 minute')`,
  }).from(leads).where(and(eq(leads.tenantId, ctx.tenantId), gte(leads.receivedAt, startYesterday), lt(leads.receivedAt, startToday)));
  const [worst] = await ctx.db.select({ id: leads.id, name: leads.fullName, receivedAt: leads.receivedAt, campaignId: leads.campaignId })
    .from(leads).where(overdueWhere(ctx.tenant)).orderBy(asc(leads.receivedAt)).limit(1);
  const [flags] = await ctx.db.select({ n: sql<number>`count(*)` }).from(insights).where(and(eq(insights.tenantId, ctx.tenantId), eq(insights.type, 'priority_flag'), isNull(insights.dismissedAt)));
  const [flagged] = await ctx.db.select({ n: sql<number>`count(distinct ${insights.campaignId})` }).from(insights)
    .where(and(eq(insights.tenantId, ctx.tenantId), inArray(insights.severity, ['red', 'amber']), gte(insights.generatedAt, startYesterday), lt(insights.generatedAt, startToday)));
  const avg = d7.avgMs ?? d30.avgMs;
  return {
    avgResponseTime: avg, formatted: formatDuration(avg), color: speedColor(avg),
    today: today.avgMs, thirtyDayAvg: d30.avgMs,
    overdueCount: await overdueCount(ctx.db, ctx.tenant),
    brief: {
      yesterday: { received: Number(y.received), responded: Number(y.responded), slaBreaches: Number(y.breaches), campaignsFlagged: Number(flagged.n) },
      mostOverdue: worst ? { id: worst.id, name: worst.name, receivedAt: worst.receivedAt, campaignId: worst.campaignId } : null,
      priorityFlags: Number(flags.n),
      mySpeedYesterday: mineY.avgMs, mySpeed30d: mine30.avgMs, workspaceYesterday: yesterday.avgMs,
    },
  };
}

export async function overdue(ctx: AuthedContext, campaignId?: string) {
  const rows = await ctx.db.select({ l: leads, campaignName: campaigns.name, pageName: deployments.name, assigneeName: users.name })
    .from(leads).leftJoin(campaigns, eq(campaigns.id, leads.campaignId)).leftJoin(deployments, eq(deployments.id, leads.deploymentId)).leftJoin(users, eq(users.id, leads.assigneeId))
    .where(and(overdueWhere(ctx.tenant), campaignId ? eq(leads.campaignId, campaignId) : undefined)).orderBy(asc(leads.receivedAt)).limit(100);
  return {
    count: rows.length,
    leads: rows.map((r) => ({
      id: r.l.id, displayId: displayId(r.l.id), name: r.l.fullName, campaignId: r.l.campaignId, campaignName: r.campaignName, pageName: r.pageName,
      receivedAt: r.l.receivedAt, assigneeId: r.l.assigneeId, assigneeName: r.assigneeName, vip: r.l.vip,
    })),
  };
}

/** 7-day trend bars, or one day's detail (O16) when `date` is given. */
export async function trend(ctx: AuthedContext, opts: { date?: string; campaignId?: string } = {}) {
  const scope = opts.campaignId ? eq(leads.campaignId, opts.campaignId) : undefined;
  const thr = ctx.tenant.slaThresholdMinutes;
  if (opts.date) {
    const start = new Date(`${opts.date}T00:00:00Z`), end = new Date(start.getTime() + DAY);
    const [d] = await ctx.db.select({
      received: sql<number>`count(*)`, responded: sql<number>`count(*) filter (where ${leads.status} = 'responded')`,
      overdue: sql<number>`count(*) filter (where coalesce(${leads.respondedAt}, now()) - ${leads.receivedAt} > ${thr}::int * interval '1 minute')`,
      avg: sql<number | null>`avg(extract(epoch from (${leads.respondedAt} - ${leads.receivedAt}))*1000) filter (where ${leads.respondedAt} is not null)`,
      min: sql<number | null>`min(extract(epoch from (${leads.respondedAt} - ${leads.receivedAt}))*1000)`,
      max: sql<number | null>`max(extract(epoch from (${leads.respondedAt} - ${leads.receivedAt}))*1000)`,
    }).from(leads).where(and(eq(leads.tenantId, ctx.tenantId), gte(leads.receivedAt, start), lt(leads.receivedAt, end), scope));
    const team = await ctx.db.select({ id: users.id, name: users.name, avg: sql<number>`avg(extract(epoch from (${leads.respondedAt} - ${leads.receivedAt}))*1000)` })
      .from(leads).innerJoin(users, eq(users.id, leads.respondedBy))
      .where(and(eq(leads.tenantId, ctx.tenantId), gte(leads.receivedAt, start), lt(leads.receivedAt, end), scope)).groupBy(users.id, users.name).orderBy(sql`3 asc`).limit(3);
    const avg = d.avg == null ? null : Math.round(Number(d.avg));
    return {
      date: opts.date, avgMs: avg, color: speedColor(avg), received: Number(d.received), responded: Number(d.responded), overdue: Number(d.overdue),
      fastestMs: d.min == null ? null : Math.round(Number(d.min)), slowestMs: d.max == null ? null : Math.round(Number(d.max)),
      slowestOverThreshold: d.max != null && Number(d.max) > thr * 60_000,
      team: team.map((t) => ({ id: t.id, name: t.name, avgMs: Math.round(Number(t.avg)) })),
    };
  }
  const since = new Date(Date.now() - 6 * DAY); since.setUTCHours(0, 0, 0, 0);
  const rows = await ctx.db.select({
    day: sql<string>`to_char(${leads.receivedAt} at time zone 'UTC', 'YYYY-MM-DD')`,
    avg: sql<number | null>`avg(extract(epoch from (${leads.respondedAt} - ${leads.receivedAt}))*1000) filter (where ${leads.respondedAt} is not null)`,
    n: sql<number>`count(*)`,
  }).from(leads).where(and(eq(leads.tenantId, ctx.tenantId), gte(leads.receivedAt, since), scope)).groupBy(sql`1`);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = new Date(since.getTime() + i * DAY).toISOString().slice(0, 10);
    const r = rows.find((x) => x.day === date);
    const avg = r?.avg == null ? null : Math.round(Number(r.avg));
    days.push({ date, label: new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }), avgMs: avg, color: speedColor(avg), leads: Number(r?.n ?? 0) });
  }
  return { days };
}

export async function team(ctx: AuthedContext, campaignId?: string) {
  const members = await ctx.db.select().from(users).where(and(eq(users.tenantId, ctx.tenantId), isNull(users.removedAt), sql`${users.joinedAt} is not null`));
  const thr = ctx.tenant.slaThresholdMinutes;
  const week = new Date(Date.now() - 7 * DAY), month = new Date(Date.now() - 30 * DAY);
  const scope = campaignId ? eq(leads.campaignId, campaignId) : undefined;
  const out = [];
  for (const m of members) {
    const mine = and(eq(leads.respondedBy, m.id), scope);
    const [w, mo] = await Promise.all([avgResponseMs(ctx.db, ctx.tenantId, week, new Date(), mine as never), avgResponseMs(ctx.db, ctx.tenantId, month, new Date(), mine as never)]);
    const [a] = await ctx.db.select({
      assigned: sql<number>`count(*)`, responded: sql<number>`count(*) filter (where ${leads.status} = 'responded')`,
      breaches: sql<number>`count(*) filter (where coalesce(${leads.respondedAt}, now()) - ${leads.receivedAt} > ${thr}::int * interval '1 minute')`,
    }).from(leads).where(and(eq(leads.tenantId, ctx.tenantId), eq(leads.assigneeId, m.id), gte(leads.receivedAt, week), scope));
    out.push({
      id: m.id, name: m.name, avgThisWeekMs: w.avgMs, avg30dMs: mo.avgMs, improving: w.avgMs != null && mo.avgMs != null ? w.avgMs <= mo.avgMs : null,
      acknowledgmentRate: Number(a.assigned) ? Number(a.responded) / Number(a.assigned) : null, breachesThisWeek: Number(a.breaches),
    });
  }
  // Alphabetical — data only, never a ranking (Screen 16 "Must NOT").
  return out.sort((x, y) => x.name.localeCompare(y.name));
}

export async function campaignSla(ctx: AuthedContext, campaignId: string) {
  const s = await avgResponseMs(ctx.db, ctx.tenantId, new Date(0), new Date(), eq(leads.campaignId, campaignId));
  const [c] = await ctx.db.select({ n: sql<number>`count(*)`, r: sql<number>`count(*) filter (where ${leads.status}='responded')` }).from(leads)
    .where(and(eq(leads.tenantId, ctx.tenantId), eq(leads.campaignId, campaignId)));
  return { avgResponseMs: s.avgMs, color: speedColor(s.avgMs), leadCount: Number(c.n), respondedCount: Number(c.r), thresholdMinutes: ctx.tenant.slaThresholdMinutes };
}

/** POST /sla/notify/:leadId — email + Telegram with an acknowledgment magic link. */
export async function notifyNow(ctx: AuthedContext, leadId: string) {
  const [l] = await ctx.db.select().from(leads).where(and(eq(leads.tenantId, ctx.tenantId), eq(leads.id, leadId)));
  if (!l) throw fail.notFound('Lead not found.');
  if (l.status === 'responded') throw fail.conflict('This lead has already been responded to.');
  const result = await sendSlaAlert(ctx.db, ctx.tenant, l, true);
  if (!result.sent) throw fail.bad('Last notification failed. Try again.');
  return { ok: true, channels: result.channels };
}

/**
 * Deliver an SLA breach alert to the assignee (or every active member when
 * unassigned). Telegram first when connected; email always as the fallback.
 */
export async function sendSlaAlert(db: DB, tenant: typeof tenants.$inferSelect, l: typeof leads.$inferSelect, manual = false) {
  const recipients = l.assigneeId
    ? await db.select().from(users).where(and(eq(users.id, l.assigneeId), isNull(users.removedAt)))
    : await db.select().from(users).where(and(eq(users.tenantId, tenant.id), isNull(users.removedAt), sql`${users.joinedAt} is not null`, eq(users.notifyEnabled, true)));
  const [dep] = l.deploymentId ? await db.select({ name: deployments.name }).from(deployments).where(eq(deployments.id, l.deploymentId)) : [];
  const minutes = Math.round((Date.now() - l.receivedAt.getTime()) / 60_000);
  const channels = new Set<string>();
  for (const u of recipients) {
    const link = await createAckToken(db, tenant.id, l.id, u.id);
    let delivered = false;
    if (u.telegramChatId && u.notifyChannel !== 'email' && await sendLeadMessage(db, tenant.id, u, l.id, `⏱ ${l.fullName} has waited ${minutes} min (${dep?.name ?? 'webhook'}).`)) {
      delivered = true; channels.add('telegram');
    }
    if (!delivered || u.notifyChannel === 'both') {
      await sendMail(emails.slaAlert(u.email, l.fullName, dep?.name ?? 'webhook', minutes, link));
      channels.add('email');
    }
  }
  if (!manual) {
    await db.update(leads).set({ slaAlertSentAt: new Date() }).where(eq(leads.id, l.id));
    await notify(db, tenant.id, { userId: l.assigneeId, kind: 'sla_breach', description: `SLA breached — ${l.fullName} (${minutes} min)`, link: `/leads/${l.id}` });
    remember(db, tenant.id, { type: 'sla_breach', campaignId: l.campaignId, entityId: l.id, content: `SLA breached: ${l.fullName} waited ${minutes} minutes against a ${tenant.slaThresholdMinutes}-minute threshold.` });
    fireOutbound(db, tenant.id, 'sla.breached', { lead_id: l.id, name: l.fullName, waited_minutes: minutes });
    emit(tenant.id, 'workspace:overdue-count', {});
  }
  return { sent: recipients.length > 0, channels: [...channels] };
}

// ------------------------------------------------------------------ configuration

export async function getConfig(ctx: AuthedContext) {
  const pages = await ctx.db.select({ id: deployments.id, name: deployments.name, vip: deployments.vip }).from(deployments)
    .where(and(eq(deployments.tenantId, ctx.tenantId), eq(deployments.status, 'ready')));
  const members = await ctx.db.select({ id: users.id, name: users.name, notifyEnabled: users.notifyEnabled, notifyChannel: users.notifyChannel }).from(users)
    .where(and(eq(users.tenantId, ctx.tenantId), isNull(users.removedAt), sql`${users.joinedAt} is not null`));
  return {
    sla_threshold_minutes: ctx.tenant.slaThresholdMinutes, vip_lead_enabled: ctx.tenant.vipLeadEnabled,
    vip_sla_threshold_minutes: ctx.tenant.vipSlaThresholdMinutes, daily_summary_time: ctx.tenant.dailySummaryTime.slice(0, 5),
    vipPages: pages, notificationRules: members,
  };
}

export async function patchConfig(ctx: AuthedContext, p: {
  sla_threshold_minutes?: number; vip_lead_enabled?: boolean; vip_sla_threshold_minutes?: number; daily_summary_time?: string; vipPages?: string[];
  notificationRules?: Array<{ id: string; notifyEnabled: boolean; notifyChannel: 'email' | 'telegram' | 'both' }>;
}) {
  assertRole(ctx, 'owner', 'admin');
  const set: Partial<typeof tenants.$inferInsert> = {};
  if (p.sla_threshold_minutes !== undefined) { if (p.sla_threshold_minutes <= 0) throw fail.bad('Please enter a value greater than 0.'); set.slaThresholdMinutes = Math.round(p.sla_threshold_minutes); }
  if (p.vip_sla_threshold_minutes !== undefined) { if (p.vip_sla_threshold_minutes <= 0) throw fail.bad('Please enter a value greater than 0.'); set.vipSlaThresholdMinutes = Math.round(p.vip_sla_threshold_minutes); }
  if (p.vip_lead_enabled !== undefined) set.vipLeadEnabled = p.vip_lead_enabled;
  if (p.daily_summary_time) { if (!/^\d{2}:\d{2}$/.test(p.daily_summary_time)) throw fail.bad('Use HH:MM (UTC).'); set.dailySummaryTime = `${p.daily_summary_time}:00`; }
  if (Object.keys(set).length) await ctx.db.update(tenants).set(set).where(eq(tenants.id, ctx.tenantId));
  if (p.vipPages) {
    await ctx.db.update(deployments).set({ vip: false }).where(eq(deployments.tenantId, ctx.tenantId));
    if (p.vipPages.length) await ctx.db.update(deployments).set({ vip: true }).where(and(eq(deployments.tenantId, ctx.tenantId), inArray(deployments.id, p.vipPages)));
  }
  for (const r of p.notificationRules ?? []) {
    await ctx.db.update(users).set({ notifyEnabled: r.notifyEnabled, notifyChannel: r.notifyChannel }).where(and(eq(users.tenantId, ctx.tenantId), eq(users.id, r.id)));
  }
  emit(ctx.tenantId, 'workspace:sla', {});
  const warnings = (set.vipSlaThresholdMinutes ?? ctx.tenant.vipSlaThresholdMinutes) >= (set.slaThresholdMinutes ?? ctx.tenant.slaThresholdMinutes)
    ? ['VIP threshold is usually lower than the standard threshold'] : [];
  return { ok: true, warnings };
}

/** Default cross-tool rules per integration category (Design Spec §12). */
const DEFAULT_RULES: Record<string, Array<{ ruleType: string; thresholdValue: number; thresholdUnit: 'hours' | 'days' | 'percent' | 'currency'; enabled: boolean }>> = {
  crm: [
    { ruleType: 'not_contacted', thresholdValue: 24, thresholdUnit: 'hours', enabled: true },
    { ruleType: 'not_proposal', thresholdValue: 72, thresholdUnit: 'hours', enabled: false },
    { ruleType: 'no_activity', thresholdValue: 7, thresholdUnit: 'days', enabled: false },
  ],
  email: [
    { ruleType: 'not_enrolled', thresholdValue: 2, thresholdUnit: 'hours', enabled: true },
    { ruleType: 'open_rate_drop', thresholdValue: 15, thresholdUnit: 'percent', enabled: false },
    { ruleType: 'no_click', thresholdValue: 48, thresholdUnit: 'hours', enabled: false },
  ],
  ads: [
    { ruleType: 'spend_without_leads', thresholdValue: 72, thresholdUnit: 'hours', enabled: true },
    { ruleType: 'cpl_exceeded', thresholdValue: 0, thresholdUnit: 'currency', enabled: false },
    { ruleType: 'spend_increase', thresholdValue: 20, thresholdUnit: 'percent', enabled: false },
  ],
  slack: [{ ruleType: 'discussed_not_acted', thresholdValue: 4, thresholdUnit: 'hours', enabled: false }],
};
export const categoryOf = (p: string) =>
  ['gohighlevel', 'twenty_crm', 'hubspot', 'salesforce'].includes(p) ? 'crm'
    : ['activecampaign', 'mailchimp', 'brevo', 'notifuse'].includes(p) ? 'email'
      : ['meta_ads', 'google_ads'].includes(p) ? 'ads' : p === 'slack' ? 'slack' : null;

export async function crossToolConfig(ctx: AuthedContext) {
  assertFeature(ctx, 'cross_tool_sla');
  const ints = await ctx.db.select().from(integrations).where(and(eq(integrations.tenantId, ctx.tenantId), eq(integrations.status, 'connected')));
  const out = [];
  for (const i of ints) {
    const cat = categoryOf(i.provider);
    if (!cat) continue;
    let rules = await ctx.db.select().from(crossToolSlaRules).where(and(eq(crossToolSlaRules.tenantId, ctx.tenantId), eq(crossToolSlaRules.integrationId, i.id)));
    if (!rules.length) {
      rules = await ctx.db.insert(crossToolSlaRules).values(DEFAULT_RULES[cat].map((r) => ({ ...r, tenantId: ctx.tenantId, integrationId: i.id }))).returning();
    }
    out.push({ integrationId: i.id, provider: i.provider, category: cat, method: i.connectionMethod, rules: rules.map((r) => ({ id: r.id, ruleType: r.ruleType, thresholdValue: r.thresholdValue, thresholdUnit: r.thresholdUnit, enabled: r.enabled, notificationChannels: r.notificationChannels })) });
  }
  return out;
}

export async function patchCrossTool(ctx: AuthedContext, integrationId: string, rules: Array<{ id: string; thresholdValue: number; enabled: boolean; notificationChannels: Array<'ai_panel' | 'email' | 'telegram'> }>) {
  assertRole(ctx, 'owner', 'admin');
  assertFeature(ctx, 'cross_tool_sla');
  for (const r of rules) {
    if (r.thresholdValue < 0) throw fail.bad('Thresholds cannot be negative.');
    await ctx.db.update(crossToolSlaRules).set({ thresholdValue: r.thresholdValue, enabled: r.enabled, notificationChannels: r.notificationChannels, updatedAt: new Date() })
      .where(and(eq(crossToolSlaRules.tenantId, ctx.tenantId), eq(crossToolSlaRules.integrationId, integrationId), eq(crossToolSlaRules.id, r.id)));
  }
  return { ok: true };
}

export async function crossToolBreaches(ctx: AuthedContext) {
  assertFeature(ctx, 'cross_tool_sla');
  const [anyConnected] = await ctx.db.select({ n: sql<number>`count(*)` }).from(integrations).where(and(eq(integrations.tenantId, ctx.tenantId), eq(integrations.status, 'connected')));
  const rows = await ctx.db.select({ b: crossToolSlaBreaches, lead: leads.fullName, leadId: leads.id, assignee: users.name, provider: integrations.provider })
    .from(crossToolSlaBreaches).innerJoin(leads, eq(leads.id, crossToolSlaBreaches.leadId)).innerJoin(integrations, eq(integrations.id, crossToolSlaBreaches.integrationId))
    .leftJoin(users, eq(users.id, leads.assigneeId))
    .where(and(eq(crossToolSlaBreaches.tenantId, ctx.tenantId), eq(crossToolSlaBreaches.resolved, false))).orderBy(desc(crossToolSlaBreaches.detectedAt)).limit(100);
  return {
    connected: Number(anyConnected.n) > 0,
    breaches: rows.map((r) => ({ id: r.b.id, type: categoryOf(r.provider), provider: r.provider, breachType: r.b.breachType, leadId: r.leadId, leadName: r.lead, assigneeName: r.assignee, hoursExceeded: r.b.hoursExceeded, detectedAt: r.b.detectedAt })),
  };
}
