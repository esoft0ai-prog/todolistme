/**
 * The controlled tool set available to the Main Agent and Workers
 * (Agent Architecture Part 2, "Controlled tool set"). Every tool is read-only
 * and receives its tenant/campaign scope from the caller's contract — never
 * from the model — so a model cannot widen its own access.
 */
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { campaigns, deployments, integrations, leadLifecycleEvents, leads, notes, tenants, users, webhookSources } from '../db/schema.js';
import { campaignCpl, campaignStats, health } from '../services/metrics.js';
import { DAY, formatDuration, webhookState } from '../domain/rules.js';
import { recall } from './memory.js';

export interface ToolScope { db: DB; tenantId: string; campaignId: string | null }
export type ToolFn = (scope: ToolScope, args: Record<string, unknown>) => Promise<unknown>;

/** Campaign boundary: a scoped contract always wins over a model-supplied id. */
function campaignFor(scope: ToolScope, args: Record<string, unknown>): string | null {
  if (scope.campaignId) return scope.campaignId;
  return typeof args.campaignId === 'string' ? args.campaignId : null;
}

async function campaignRows(scope: ToolScope, id: string | null) {
  return scope.db.select().from(campaigns).where(and(eq(campaigns.tenantId, scope.tenantId), id ? eq(campaigns.id, id) : undefined));
}

export const TOOLS: Record<string, { description: string; fn: ToolFn }> = {
  get_campaign_metrics: {
    description: 'Lead volume, acknowledgment, speed-to-lead, CPL and Health Pulse for one campaign (campaignId) or all campaigns.',
    fn: async (s, a) => {
      const rows = await campaignRows(s, campaignFor(s, a));
      const stats = await campaignStats(s.db, s.tenantId, rows.map((r) => r.id));
      return rows.map((c) => {
        const st = stats.get(c.id)!;
        return {
          id: c.id, name: c.name, status: c.status, leads_total: st.leadCount, leads_7d: st.leads7d, avg_weekly_prior_4w: Math.round(st.avgWeekly * 10) / 10,
          responded: st.respondedCount, ack_rate_7d: st.leads7d ? Math.round((st.responded7d / st.leads7d) * 100) / 100 : null,
          avg_speed_to_lead: formatDuration(st.avgResponseMs), cpl: campaignCpl(c, st), cpl_threshold: c.cplThreshold == null ? null : Number(c.cplThreshold),
          daily_spend: c.dailySpend == null ? null : Number(c.dailySpend), currency: c.currency, health: health(st).status, health_signals: health(st).signals,
          days_active: Math.floor((Date.now() - new Date(c.startDate).getTime()) / DAY),
        };
      });
    },
  },
  get_lead_data: {
    description: 'Unresponded and overdue leads (with wait times and assignees) for a campaign or the workspace.',
    fn: async (s, a) => {
      const cid = campaignFor(s, a);
      const [t] = await s.db.select().from(tenants).where(eq(tenants.id, s.tenantId));
      const rows = await s.db.select({ l: leads, assignee: users.name, campaign: campaigns.name }).from(leads).leftJoin(users, eq(users.id, leads.assigneeId)).leftJoin(campaigns, eq(campaigns.id, leads.campaignId))
        .where(and(eq(leads.tenantId, s.tenantId), eq(leads.status, 'not_responded'), cid ? eq(leads.campaignId, cid) : undefined)).orderBy(leads.receivedAt).limit(25);
      return {
        threshold_minutes: t.slaThresholdMinutes,
        unresponded: rows.map((r) => ({
          lead_id: r.l.id, name: r.l.fullName, campaign: r.campaign, waiting: formatDuration(Date.now() - r.l.receivedAt.getTime()),
          overdue: Date.now() - r.l.receivedAt.getTime() > t.slaThresholdMinutes * 60_000, assignee: r.assignee ?? 'Unassigned', vip: r.l.vip,
        })),
      };
    },
  },
  get_funnel_data: {
    description: 'Funnel from lead → responded → CRM lifecycle milestones for a campaign (last 30 days).',
    fn: async (s, a) => {
      const cid = campaignFor(s, a);
      const since = new Date(Date.now() - 30 * DAY);
      const scope = and(eq(leads.tenantId, s.tenantId), gte(leads.receivedAt, since), cid ? eq(leads.campaignId, cid) : undefined);
      const [f] = await s.db.select({ n: sql<number>`count(*)`, r: sql<number>`count(*) filter (where ${leads.status}='responded')`, ext: sql<number>`count(*) filter (where ${leads.hasExternalLifecycleEvents})` }).from(leads).where(scope);
      const ev = await s.db.select({ event: leadLifecycleEvents.event, n: sql<number>`count(distinct ${leadLifecycleEvents.leadId})` }).from(leadLifecycleEvents)
        .innerJoin(leads, eq(leads.id, leadLifecycleEvents.leadId)).where(and(scope, sql`${leadLifecycleEvents.source} <> 'camplo'`)).groupBy(leadLifecycleEvents.event);
      return { leads: Number(f.n), responded: Number(f.r), with_crm_events: Number(f.ext), crm_stages: ev.map((e) => ({ stage: e.event, leads: Number(e.n) })) };
    },
  },
  get_campaign_history: {
    description: 'Campaign memory: prior changes, experiments and recommendation outcomes (what was already tried).',
    fn: async (s, a) => recall(s.db, s.tenantId, String(a.query ?? 'What changed on this campaign and what happened?'), campaignFor(s, a)),
  },
  get_webhook_health: {
    description: 'Webhook health of every page (operational / stale / offline / never connected).',
    fn: async (s, a) => {
      const cid = campaignFor(s, a);
      const rows = await s.db.select({ name: deployments.name, last: webhookSources.lastReceivedAt, thr: webhookSources.staleThresholdMinutes, state: deployments.servingState })
        .from(deployments).leftJoin(webhookSources, eq(webhookSources.deploymentId, deployments.id))
        .where(and(eq(deployments.tenantId, s.tenantId), eq(deployments.status, 'ready'), cid ? eq(deployments.campaignId, cid) : undefined));
      return rows.map((r) => ({ page: r.name, serving: r.state, webhook: webhookState(r.last ?? null, r.thr ?? 480), last_received: r.last }));
    },
  },
  get_team_patterns: {
    description: 'Per-member response times and SLA breaches over the last 7 days (pattern data, no ranking).',
    fn: async (s) => {
      const since = new Date(Date.now() - 7 * DAY);
      const rows = await s.db.select({
        name: users.name, n: sql<number>`count(*)`,
        avg: sql<number | null>`avg(extract(epoch from (${leads.respondedAt} - ${leads.receivedAt}))*1000)`,
        weekend: sql<number>`count(*) filter (where extract(isodow from ${leads.receivedAt}) >= 6)`,
      }).from(leads).innerJoin(users, eq(users.id, leads.respondedBy)).where(and(eq(leads.tenantId, s.tenantId), gte(leads.receivedAt, since))).groupBy(users.name);
      return rows.map((r) => ({ member: r.name, responded: Number(r.n), avg_response: formatDuration(r.avg == null ? null : Number(r.avg)), weekend_leads: Number(r.weekend) }));
    },
  },
  get_conversation_signals: {
    description: 'Recent campaign and lead notes written by the team (summarise patterns; never quote individuals).',
    fn: async (s, a) => {
      const cid = campaignFor(s, a);
      const leadIds = cid ? (await s.db.select({ id: leads.id }).from(leads).where(and(eq(leads.tenantId, s.tenantId), eq(leads.campaignId, cid))).limit(500)).map((r) => r.id) : [];
      const rows = await s.db.select({ c: notes.content, at: notes.createdAt }).from(notes)
        .where(and(eq(notes.tenantId, s.tenantId), cid ? inArray(notes.entityId, [cid, ...leadIds]) : undefined)).orderBy(desc(notes.createdAt)).limit(30);
      return rows.map((r) => ({ note: r.c.slice(0, 400), at: r.at }));
    },
  },
  get_data_sources: {
    description: 'Which of the six data sources are connected. Use this to state which sources an analysis is based on.',
    fn: async (s) => {
      const rows = await s.db.select({ p: integrations.provider }).from(integrations).where(and(eq(integrations.tenantId, s.tenantId), eq(integrations.status, 'connected')));
      const ps = rows.map((r) => r.p);
      return {
        camplo_native: true, analytics_umami: ps.includes('umami'),
        email_platform: ps.some((p) => ['activecampaign', 'mailchimp', 'brevo', 'notifuse'].includes(p)),
        crm: ps.some((p) => ['twenty_crm', 'gohighlevel', 'hubspot', 'salesforce'].includes(p)),
        slack: ps.includes('slack'), ad_platforms: ps.some((p) => ['meta_ads', 'google_ads'].includes(p)),
      };
    },
  },
};

export const TOOL_NAMES = Object.keys(TOOLS);

export interface CampaignMetric {
  id: string; name: string; status: string; leads_total: number; leads_7d: number; avg_weekly_prior_4w: number; responded: number;
  ack_rate_7d: number | null; avg_speed_to_lead: string; cpl: number | null; cpl_threshold: number | null; daily_spend: number | null;
  currency: string; health: string; health_signals: { lead_volume: string; acknowledgment: string; webhook: string }; days_active: number;
}
export interface LeadData { threshold_minutes: number; unresponded: Array<{ lead_id: string; name: string; campaign: string | null; waiting: string; overdue: boolean; assignee: string; vip: boolean }> }
export interface WebhookRow { page: string; serving: string; webhook: string; last_received: Date | null }

/** Compact workspace snapshot for the Main Agent's context (campaigns + overdue + sources). */
export async function workspaceSnapshot(db: DB, tenantId: string) {
  const s: ToolScope = { db, tenantId, campaignId: null };
  const [camps, lead, sources, hooks] = await Promise.all([
    TOOLS.get_campaign_metrics.fn(s, {}), TOOLS.get_lead_data.fn(s, {}), TOOLS.get_data_sources.fn(s, {}), TOOLS.get_webhook_health.fn(s, {}),
  ]);
  const members = await db.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.tenantId, tenantId), isNull(users.removedAt)));
  return {
    campaigns: camps as CampaignMetric[], leads: lead as LeadData, data_sources: sources as Record<string, boolean>,
    webhooks: hooks as WebhookRow[], team: members.map((m) => m.name),
  };
}
