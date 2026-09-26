/** Level 0 aggregates computed from the operational database (never stored). */
import { and, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { campaigns, deployments, leads, notes, pageVisits, webhookSources } from '../db/schema.js';
import {
  ackRateSignal, cpl, DAY, healthPulse, leadVolumeSignal, webhookSignal, webhookState, type Health, type Signal,
} from '../domain/rules.js';

export interface CampaignStats {
  leadCount: number; respondedCount: number; notRespondedCount: number; avgResponseMs: number | null;
  pageCount: number; notesCount: number; leads7d: number; responded7d: number; avgWeekly: number;
  hookStatuses: Array<'operational' | 'stale' | 'offline'>;
}

const num = (v: unknown) => (v == null ? 0 : Number(v));

export async function campaignStats(db: DB, tenantId: string, campaignIds?: string[]): Promise<Map<string, CampaignStats>> {
  const out = new Map<string, CampaignStats>();
  const ids = campaignIds ?? (await db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.tenantId, tenantId))).map((r) => r.id);
  if (!ids.length) return out;
  for (const id of ids) out.set(id, { leadCount: 0, respondedCount: 0, notRespondedCount: 0, avgResponseMs: null, pageCount: 0, notesCount: 0, leads7d: 0, responded7d: 0, avgWeekly: 0, hookStatuses: [] });
  const now = Date.now();
  const d7 = new Date(now - 7 * DAY), d35 = new Date(now - 35 * DAY);

  const leadRows = await db.select({
    cid: leads.campaignId,
    total: sql<number>`count(*)`,
    responded: sql<number>`count(*) filter (where ${leads.status} = 'responded')`,
    avgMs: sql<number | null>`avg(extract(epoch from (${leads.respondedAt} - ${leads.receivedAt})) * 1000) filter (where ${leads.respondedAt} is not null)`,
    l7: sql<number>`count(*) filter (where ${leads.receivedAt} >= ${d7})`,
    r7: sql<number>`count(*) filter (where ${leads.receivedAt} >= ${d7} and ${leads.status} = 'responded')`,
    prior4w: sql<number>`count(*) filter (where ${leads.receivedAt} >= ${d35} and ${leads.receivedAt} < ${d7})`,
  }).from(leads).where(and(eq(leads.tenantId, tenantId), inArray(leads.campaignId, ids))).groupBy(leads.campaignId);
  for (const r of leadRows) {
    const s = out.get(r.cid!); if (!s) continue;
    s.leadCount = num(r.total); s.respondedCount = num(r.responded); s.notRespondedCount = s.leadCount - s.respondedCount;
    s.avgResponseMs = r.avgMs == null ? null : Math.round(Number(r.avgMs));
    s.leads7d = num(r.l7); s.responded7d = num(r.r7); s.avgWeekly = num(r.prior4w) / 4;
  }
  const pageRows = await db.select({ cid: deployments.campaignId, n: sql<number>`count(*)` }).from(deployments)
    .where(and(eq(deployments.tenantId, tenantId), inArray(deployments.campaignId, ids), eq(deployments.status, 'ready'))).groupBy(deployments.campaignId);
  for (const r of pageRows) { const s = out.get(r.cid!); if (s) s.pageCount = num(r.n); }
  const noteRows = await db.select({ cid: notes.entityId, n: sql<number>`count(*)` }).from(notes)
    .where(and(eq(notes.tenantId, tenantId), eq(notes.noteType, 'campaign'), inArray(notes.entityId, ids))).groupBy(notes.entityId);
  for (const r of noteRows) { const s = out.get(r.cid); if (s) s.notesCount = num(r.n); }
  const hooks = await db.select({ cid: webhookSources.campaignId, last: webhookSources.lastReceivedAt, thr: webhookSources.staleThresholdMinutes })
    .from(webhookSources).innerJoin(deployments, eq(deployments.id, webhookSources.deploymentId))
    .where(and(eq(webhookSources.tenantId, tenantId), inArray(webhookSources.campaignId, ids), eq(deployments.servingState, 'active'), eq(deployments.status, 'ready')));
  for (const h of hooks) {
    const st = webhookState(h.last, h.thr);
    if (st !== 'never_connected') out.get(h.cid!)?.hookStatuses.push(st);
  }
  return out;
}

export interface HealthResult { status: Health; signals: { lead_volume: Signal; acknowledgment: Signal; webhook: Signal } }
export function health(s: CampaignStats): HealthResult {
  const signals = {
    lead_volume: leadVolumeSignal(s.leads7d, s.avgWeekly),
    acknowledgment: ackRateSignal(s.responded7d, s.leads7d),
    webhook: webhookSignal(s.hookStatuses),
  };
  return { status: healthPulse(Object.values(signals)), signals };
}

export const campaignCpl = (c: typeof campaigns.$inferSelect, s: CampaignStats) =>
  cpl(c.dailySpend == null ? null : Number(c.dailySpend), s.leadCount);

/** Workspace Speed-to-Lead (avg received→responded) over a window. */
export async function avgResponseMs(db: DB, tenantId: string, since: Date, until = new Date(), extra?: ReturnType<typeof eq>) {
  const [r] = await db.select({
    avg: sql<number | null>`avg(extract(epoch from (${leads.respondedAt} - ${leads.receivedAt})) * 1000)`,
    n: sql<number>`count(*)`,
  }).from(leads).where(and(eq(leads.tenantId, tenantId), isNotNull(leads.respondedAt), gte(leads.respondedAt, since), lt(leads.respondedAt, until), extra));
  return { avgMs: r?.avg == null ? null : Math.round(Number(r.avg)), count: num(r?.n) };
}

/** Workspace average page conversion (leads / visits, last 7 days). */
export async function workspaceConversion(db: DB, tenantId: string): Promise<number | null> {
  const since = new Date(Date.now() - 7 * DAY);
  const [v] = await db.select({ n: sql<number>`coalesce(sum(${pageVisits.visits}),0)` }).from(pageVisits)
    .where(and(eq(pageVisits.tenantId, tenantId), gte(pageVisits.day, since.toISOString().slice(0, 10))));
  const [l] = await db.select({ n: sql<number>`count(*)` }).from(leads).where(and(eq(leads.tenantId, tenantId), gte(leads.receivedAt, since)));
  return num(v?.n) > 0 ? num(l?.n) / num(v!.n) : null;
}
