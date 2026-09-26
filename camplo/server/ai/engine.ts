/**
 * Intelligence refresh cycle (AI Capability Map Part 11). Runs on schedule
 * (default every 30 min per workspace) or on event triggers.
 *
 *   Level 1 — deterministic alerts, wins and the Priority Flag (no LLM).
 *   Insufficient-evidence cards when a signal exists but the sample is small.
 *   Level 2 — tactical recommendation (Growth+), memory recalled first.
 *   Level 3 — diagnostic, multi-source via Workers (Watchtower, ≥2 sources).
 *   Level 4 — strategic, weekly, Reflect over memory (Watchtower).
 *   Memory — 7-day performance_after / outcome measurement.
 *
 * The engine only ever writes insights and recommendations. It never changes
 * leads, campaigns or any operator data.
 */
import { and, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.js';
import { config } from '../lib/config.js';
import {
  aiProviderConfigs, campaignChanges, campaignRecommendations, campaigns, deployments, insights, integrations, leads, pageVisits, tenants, webhookSources,
} from '../db/schema.js';
import {
  DAY, formatDuration, hasFeature, hasSufficientEvidence, HOUR, recommendationLevelAllowed, webhookState, type Plan,
} from '../domain/rules.js';
import { campaignCpl, campaignStats, health, workspaceConversion } from '../services/metrics.js';
import { perfSnapshot } from '../services/campaigns.js';
import { emit, notify, remember } from '../services/effects.js';
import { complete, parseJson, targetsFor } from './router.js';
import { recall, reflect } from './memory.js';
import { makeContract, runWorker } from './workers.js';

type Tenant = typeof tenants.$inferSelect;
type NewInsight = Omit<typeof insights.$inferInsert, 'tenantId'> & { dedupeKey: string };

async function upsertInsight(db: DB, tenantId: string, i: NewInsight): Promise<boolean> {
  const [dup] = await db.select({ id: insights.id }).from(insights)
    .where(and(eq(insights.tenantId, tenantId), eq(insights.dedupeKey, i.dedupeKey), gte(insights.generatedAt, new Date(Date.now() - DAY))));
  if (dup) return false;
  await db.insert(insights).values({ ...i, tenantId });
  return true;
}

const pct = (a: number, b: number) => Math.round(((a - b) / b) * 100);

/** Level 1 + insufficient evidence. Pure rules over live data. Returns number of new cards. */
export async function level1(db: DB, t: Tenant): Promise<number> {
  const plan = t.plan as Plan;
  const camps = await db.select().from(campaigns).where(and(eq(campaigns.tenantId, t.id), sql`${campaigns.status} <> 'complete'`));
  const stats = await campaignStats(db, t.id, camps.map((c) => c.id));
  const avgConv = await workspaceConversion(db, t.id);
  const hourKey = new Date().toISOString().slice(0, 13), dayKey = new Date().toISOString().slice(0, 10);
  let created = 0;
  const redByCampaign = new Map<string, string[]>();
  const addRed = (cid: string, s: string) => redByCampaign.set(cid, [...(redByCampaign.get(cid) ?? []), s]);

  for (const c of camps) {
    const s = stats.get(c.id)!;
    // SLA overdue (touchpoints 1–3)
    const thr = t.slaThresholdMinutes;
    const od = await db.select({ name: leads.fullName, at: leads.receivedAt, assignee: leads.assigneeId }).from(leads)
      .where(and(eq(leads.tenantId, t.id), eq(leads.campaignId, c.id), eq(leads.status, 'not_responded'), lt(leads.receivedAt, new Date(Date.now() - thr * 60_000))))
      .orderBy(leads.receivedAt);
    if (od.length) {
      addRed(c.id, `${od.length} overdue lead${od.length > 1 ? 's' : ''}`);
      if (await upsertInsight(db, t.id, {
        campaignId: c.id, campaignTag: c.name, type: 'alert', severity: 'red', category: 'SLA', dedupeKey: `sla:${c.id}:${hourKey}`,
        observation: `${od.length} lead${od.length > 1 ? 's are' : ' is'} overdue on ${c.name}.`,
        evidence: `${od[0].name} has waited ${formatDuration(Date.now() - od[0].at.getTime())} against a ${thr}-minute threshold. ${od.filter((l) => !l.assignee).length} are unclaimed. Open the Lead Dossier and respond or notify the assignee.`,
      })) created++;
    }
    // Webhook silence (touchpoint 9)
    const hooks = await db.select({ d: deployments, h: webhookSources }).from(deployments).innerJoin(webhookSources, eq(webhookSources.deploymentId, deployments.id))
      .where(and(eq(deployments.tenantId, t.id), eq(deployments.campaignId, c.id), eq(deployments.status, 'ready'), eq(deployments.servingState, 'active')));
    for (const { d, h } of hooks) {
      if (webhookState(h.lastReceivedAt, h.staleThresholdMinutes) === 'offline') {
        addRed(c.id, `${d.name} webhook offline`);
        if (await upsertInsight(db, t.id, {
          campaignId: c.id, campaignTag: c.name, type: 'alert', severity: 'red', category: 'SLA', dedupeKey: `hook:${d.id}:${dayKey}`,
          observation: `The webhook on ${d.name} has gone silent.`,
          evidence: `No submissions for ${formatDuration(Date.now() - h.lastReceivedAt!.getTime())}. If ads are still running, leads may be lost. Test the webhook from the Pages screen.`,
        })) {
          created++;
          if (t.notificationPrefs.webhookOffline) await notify(db, t.id, { kind: 'webhook_offline', description: `${d.name} webhook offline`, link: '/pages' });
        }
      }
      // 72-hour early warning (touchpoint 8)
      if (hasFeature(plan, 'early_warning') && d.deployedAt && Date.now() - d.deployedAt.getTime() < config.earlyWarningHours * HOUR && Date.now() - d.deployedAt.getTime() > 24 * HOUR && !d.earlyWarningTriggered) {
        const [v] = await db.select({ n: sql<number>`coalesce(sum(${pageVisits.visits}),0)` }).from(pageVisits).where(eq(pageVisits.deploymentId, d.id));
        const [l] = await db.select({ n: sql<number>`count(*)` }).from(leads).where(eq(leads.deploymentId, d.id));
        const visits = Number(v.n), n = Number(l.n);
        if (visits >= 50 && (avgConv == null ? n / visits < 0.01 : n / visits < avgConv * 0.5)) {
          await db.update(deployments).set({ earlyWarningTriggered: true, earlyWarningTriggeredAt: new Date() }).where(eq(deployments.id, d.id));
          if (await upsertInsight(db, t.id, {
            campaignId: c.id, campaignTag: c.name, type: 'alert', severity: 'amber', category: 'Performance', dedupeKey: `ew:${d.id}`,
            observation: `72h watch: ${d.name} has ${n} leads from ${visits} visits since launch.`,
            evidence: `That is ${((n / visits) * 100).toFixed(1)}% conversion${avgConv != null ? ` vs your ${(avgConv * 100).toFixed(1)}% average` : ''}. Check the form and webhook before spending more budget.`,
          })) created++;
        }
      }
    }
    // CPL threshold (touchpoint 10)
    const cplValue = campaignCpl(c, s);
    if (hasFeature(plan, 'budget') && cplValue != null && c.cplThreshold != null && cplValue > Number(c.cplThreshold)) {
      if (await upsertInsight(db, t.id, {
        campaignId: c.id, campaignTag: c.name, type: 'alert', severity: 'amber', category: 'Spend', dedupeKey: `cpl:${c.id}:${dayKey}`,
        observation: `CPL on ${c.name} is above your ${Number(c.cplThreshold).toLocaleString()} threshold.`,
        evidence: `Current CPL ${cplValue.toLocaleString()} ${c.currency} (+${pct(cplValue, Number(c.cplThreshold))}% over). Check webhook health and page conversion before increasing budget.`,
      })) {
        created++;
        if (t.notificationPrefs.budget) await notify(db, t.id, { kind: 'insight', description: `CPL above threshold on ${c.name}`, link: `/campaigns/${c.id}/insights` });
      }
    }
    // Acknowledgment rate (critical health signal)
    const h = health(s);
    if (h.signals.acknowledgment === 'red') addRed(c.id, 'acknowledgment rate below 70%');
    // Insufficient evidence vs. eligible
    const days = Math.floor((Date.now() - new Date(c.startDate).getTime()) / DAY);
    const signal = h.signals.lead_volume !== 'green' || h.signals.acknowledgment !== 'green';
    if (!hasSufficientEvidence(s.leadCount, days) && signal) {
      const [active] = await db.select({ id: insights.id }).from(insights)
        .where(and(eq(insights.tenantId, t.id), eq(insights.campaignId, c.id), eq(insights.type, 'insufficient_evidence'), isNull(insights.dismissedAt)));
      if (!active) {
        await db.insert(insights).values({
          tenantId: t.id, campaignId: c.id, campaignTag: c.name, type: 'insufficient_evidence', severity: 'blue', category: 'Performance', dedupeKey: `ie:${c.id}`,
          observation: `${h.signals.lead_volume !== 'green' ? 'Lead volume' : 'Acknowledgment rate'} on ${c.name} has softened — monitoring`,
          evidence: `The campaign has generated ${s.leadCount} leads so far. The sample is too small to confidently recommend a change.`,
          reassessCondition: '100 additional leads OR 7 days — whichever comes first', reassessAt: new Date(Date.now() + 7 * DAY),
        });
        created++;
      }
    } else {
      // Auto-resolve: evidence now sufficient (or signal gone) → retire the monitoring card.
      await db.update(insights).set({ dismissedAt: new Date() })
        .where(and(eq(insights.tenantId, t.id), eq(insights.campaignId, c.id), eq(insights.type, 'insufficient_evidence'), isNull(insights.dismissedAt)));
    }
  }

  // Win: page converting at 2× workspace average (Growth+)
  if (hasFeature(plan, 'win_signals') && avgConv) {
    const since = new Date(Date.now() - 7 * DAY);
    const pages = await db.select({ d: deployments, cname: campaigns.name }).from(deployments).leftJoin(campaigns, eq(campaigns.id, deployments.campaignId))
      .where(and(eq(deployments.tenantId, t.id), eq(deployments.status, 'ready')));
    for (const { d, cname } of pages) {
      const [v] = await db.select({ n: sql<number>`coalesce(sum(${pageVisits.visits}),0)` }).from(pageVisits).where(and(eq(pageVisits.deploymentId, d.id), gte(pageVisits.day, since.toISOString().slice(0, 10))));
      const [l] = await db.select({ n: sql<number>`count(*)` }).from(leads).where(and(eq(leads.deploymentId, d.id), gte(leads.receivedAt, since)));
      const visits = Number(v.n);
      if (visits >= 100 && Number(l.n) / visits > avgConv * 2) {
        if (await upsertInsight(db, t.id, {
          campaignId: d.campaignId, campaignTag: cname, type: 'win', severity: 'green', category: 'Performance', dedupeKey: `winconv:${d.id}:${dayKey.slice(0, 8)}`,
          observation: `${d.name} is converting at ${(Number(l.n) / visits / avgConv).toFixed(1)}× your account average.`,
          evidence: `${((Number(l.n) / visits) * 100).toFixed(1)}% conversion vs ${(avgConv * 100).toFixed(1)}% average across ${visits.toLocaleString()} visits in the last 7 days.`,
        })) created++;
      }
    }
  }

  // Priority Flag: multiple SLA flags on the same campaign at once = systemic.
  for (const [cid, reasons] of redByCampaign) {
    if (reasons.length < 2) continue;
    const c = camps.find((x) => x.id === cid)!;
    if (await upsertInsight(db, t.id, {
      campaignId: cid, campaignTag: c.name, type: 'priority_flag', severity: 'red', category: 'SLA', dedupeKey: `pf:${cid}:${dayKey}`,
      observation: `${c.name} is failing at ${reasons.length} handoffs at once — this is systemic, not one slow rep.`,
      evidence: `${reasons.join(', ')}. Fix the pipeline before adding budget.`,
    })) {
      created++;
      await notify(db, t.id, { kind: 'insight', description: `Priority Flag raised on ${c.name}`, link: `/campaigns/${cid}/insights` });
    }
  }
  if (created) emit(t.id, 'workspace:insights', {});
  return created;
}

// ------------------------------------------------------------------ Levels 2–4

const recSchema = z.object({
  action_text: z.string().min(5).max(500),
  why: z.string(),
  evidence: z.array(z.object({ metric: z.string(), change: z.string(), period: z.string() })).min(1),
  diagnosis: z.string().nullable().optional(),
  expected_outcome: z.string(),
  risk: z.string(),
  confidence: z.enum(['low', 'medium', 'high']),
  next_step: z.string(),
  why_now: z.string(),
  memory_references: z.array(z.string()).default([]),
  apply_action: z.object({ type: z.string(), platform: z.string(), adjustment: z.string().optional() }).nullable().optional(),
});

/** Versioned prompt template — the Level 2+ hierarchy from Capability Map Part 9. */
export const REC_PROMPT_VERSION = 'rec-v1';
function recPrompt(level: 2 | 3 | 4): string {
  const kind = level === 2 ? 'TACTICAL (what should change)' : level === 3 ? 'DIAGNOSTIC (why it is happening, root cause across sources)' : 'STRATEGIC (what to fundamentally change, cross-campaign)';
  return `You are Camplo's ${kind} recommendation engine (${REC_PROMPT_VERSION}).
Work through, in order: 1 business objective, 2 campaign objective, 3 funnel stage, 4 performance vs baseline, 5 segment comparison vs workspace,
6 anomalies (what changed, when), 7 campaign memory (what was tried and the measured outcome), 8 possible causes ranked by evidence,
9 evidence for each, 10 candidate actions, 11 expected impact, 12 risks, 13 output.
Hard rules: use only numbers present in the input; never repeat an approach memory shows failed; state data gaps honestly;
if evidence does not support a confident recommendation, set confidence to "low".
Return ONLY JSON: {"action_text","why","evidence":[{"metric","change","period"}],"diagnosis","expected_outcome","risk","confidence":"low|medium|high","next_step","why_now","memory_references":[ids],"apply_action":{"type","platform","adjustment"}|null}`;
}

async function hasAnyModel(db: DB, tenantId: string) { return (await targetsFor(db, tenantId, 'standard')).length > 0; }

async function recommend(db: DB, t: Tenant, level: 2 | 3 | 4, campaignId: string | null, payload: unknown, memoryIds: string[]) {
  const res = await complete(db, {
    tenantId: t.id, plan: t.plan as Plan, workload: level === 2 ? 'standard' : level === 3 ? 'deep' : 'strategic', taskType: 'recommendation', json: true, maxTokens: 2000,
    system: recPrompt(level), messages: [{ role: 'user', content: JSON.stringify(payload).slice(0, 50000) }],
  });
  if (!res.completion) return null;
  const parsed = recSchema.safeParse(parseJson(res.completion.text));
  if (!parsed.success) return null;
  const r = parsed.data;
  if ((level === 4 || level === 3) && r.confidence === 'low') return null; // higher bar for L3/L4
  const refs = r.memory_references.filter((m) => memoryIds.includes(m));
  const [row] = await db.insert(campaignRecommendations).values({
    tenantId: t.id, campaignId, level, actionText: r.action_text, why: r.why, evidence: r.evidence, diagnosis: r.diagnosis ?? null,
    expectedOutcome: r.expected_outcome, risk: r.risk, confidence: r.confidence, nextStep: r.next_step, whyNow: r.why_now, memoryReferences: refs,
    // Dormant in v1 — present so v2 Autopilot needs no data-model change.
    applyAction: r.apply_action ? { type: r.apply_action.type, platform: r.apply_action.platform, adjustment: r.apply_action.adjustment, status: 'pending_v2' } : null,
  }).returning();
  remember(db, t.id, { type: 'recommendation', campaignId, entityId: row.id, content: `Camplo recommended (L${level}, ${r.confidence}): ${r.action_text}. Why: ${r.why}` });
  return row;
}

export async function levels2to4(db: DB, t: Tenant): Promise<number> {
  const plan = t.plan as Plan;
  if (!recommendationLevelAllowed(plan, 2) || !(await hasAnyModel(db, t.id))) return 0;
  let made = 0;
  const camps = await db.select().from(campaigns).where(and(eq(campaigns.tenantId, t.id), sql`${campaigns.status} <> 'complete'`));
  const stats = await campaignStats(db, t.id, camps.map((c) => c.id));
  const sources = await db.select({ p: integrations.provider }).from(integrations).where(and(eq(integrations.tenantId, t.id), eq(integrations.status, 'connected')));
  for (const c of camps) {
    const s = stats.get(c.id)!;
    const days = Math.floor((Date.now() - new Date(c.startDate).getTime()) / DAY);
    if (!hasSufficientEvidence(s.leadCount, days)) continue;
    const [fresh] = await db.select({ id: campaignRecommendations.id }).from(campaignRecommendations)
      .where(and(eq(campaignRecommendations.campaignId, c.id), gte(campaignRecommendations.surfacedAt, new Date(Date.now() - 4 * HOUR))));
    if (fresh) continue;
    const h = health(s);
    const memories = await recall(db, t.id, `What changed recently on ${c.name} and what were the outcomes?`, c.id);
    const base = {
      campaign: { id: c.id, name: c.name, objective: 'qualified leads', description: c.description, days_active: days, currency: c.currency },
      performance: { leads_7d: s.leads7d, prior_weekly_avg: s.avgWeekly, ack_rate_7d: s.leads7d ? s.responded7d / s.leads7d : null, avg_speed_to_lead: formatDuration(s.avgResponseMs), cpl: campaignCpl(c, s), cpl_threshold: c.cplThreshold, health: h },
      memory: memories.slice(0, 10), data_sources: ['camplo_native', ...sources.map((x) => x.p)],
    };
    // Level 3 when anomalous, Watchtower, and ≥2 data sources are connected.
    if (h.status !== 'healthy' && recommendationLevelAllowed(plan, 3) && sources.length >= 1) {
      const workers = await Promise.all(['investigation', 'campaign_analysis'].map((cap) =>
        runWorker(db, plan, makeContract({ tenantId: t.id, capability: cap as 'investigation', objective: `Find the root cause of ${c.name}'s ${h.status} health`, campaignId: c.id, budget: 'high' }))));
      if (await recommend(db, t, 3, c.id, { ...base, investigation: workers.map((w) => w.output) }, memories.map((m) => m.id))) made++;
    } else if (h.status !== 'healthy' || (base.performance.cpl != null && c.cplThreshold != null && base.performance.cpl > Number(c.cplThreshold))) {
      if (await recommend(db, t, 2, c.id, base, memories.map((m) => m.id))) made++;
    }
  }
  // Level 4 weekly, cross-campaign.
  if (recommendationLevelAllowed(plan, 4) && camps.length >= 2) {
    const [recent] = await db.select({ id: campaignRecommendations.id }).from(campaignRecommendations)
      .where(and(eq(campaignRecommendations.tenantId, t.id), eq(campaignRecommendations.level, 4), gte(campaignRecommendations.surfacedAt, new Date(Date.now() - 7 * DAY))));
    if (!recent) {
      const model = await reflect(db, t.id, 'What patterns across all campaigns should change how this workspace operates?');
      const all = camps.map((c) => ({ name: c.name, ...stats.get(c.id), cpl: campaignCpl(c, stats.get(c.id)!) }));
      if (await recommend(db, t, 4, null, { campaigns: all, mental_model: model, window: '90 days' }, [])) made++;
    }
  }
  if (made) emit(t.id, 'workspace:insights', {});
  return made;
}

// ------------------------------------------------------------------ memory measurement

/** campaign-memory-measurement: capture performance 7 days after each change / actioned recommendation. */
export async function measureMemory(db: DB, tenantId?: string) {
  const cutoff = new Date(Date.now() - 7 * DAY);
  const changes = await db.select().from(campaignChanges)
    .where(and(isNull(campaignChanges.performanceAfter), lt(campaignChanges.changedAt, cutoff), tenantId ? eq(campaignChanges.tenantId, tenantId) : undefined)).limit(50);
  for (const ch of changes) {
    const after = await perfSnapshot(db, ch.tenantId, ch.campaignId);
    await db.update(campaignChanges).set({ performanceAfter: after }).where(eq(campaignChanges.id, ch.id));
    remember(db, ch.tenantId, { type: 'experiment', campaignId: ch.campaignId, entityId: ch.id, content: `Outcome 7 days after ${ch.changeType} change "${ch.changeDescription}": before ${JSON.stringify(ch.performanceBefore)}, after ${JSON.stringify(after)}.` });
  }
  const recs = await db.select().from(campaignRecommendations)
    .where(and(eq(campaignRecommendations.outcomeMeasured, false), sql`${campaignRecommendations.status} <> 'surfaced'`, lt(campaignRecommendations.actionedAt, cutoff), tenantId ? eq(campaignRecommendations.tenantId, tenantId) : undefined)).limit(50);
  for (const r of recs) {
    const after = r.campaignId ? await perfSnapshot(db, r.tenantId, r.campaignId) : null;
    await db.update(campaignRecommendations).set({ outcomeMeasured: true, measuredAt: new Date(), outcomeData: after }).where(eq(campaignRecommendations.id, r.id));
  }
}

// ------------------------------------------------------------------ orchestration

const lastRun = new Map<string, number>();

/** One refresh cycle for a workspace. `force` bypasses the schedule (event triggers / manual refresh). */
export async function refreshWorkspace(db: DB, tenantId: string, opts: { force?: boolean; reason?: string } = {}) {
  const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
  if (!t || t.status !== 'active') return { level1: 0, recommendations: 0 };
  const [cfg] = await db.select().from(aiProviderConfigs).where(eq(aiProviderConfigs.tenantId, tenantId));
  const interval = (cfg?.refreshIntervalMinutes ?? 30) * 60_000;
  if (!opts.force && Date.now() - (lastRun.get(tenantId) ?? cfg?.lastRefreshAt?.getTime() ?? 0) < interval) return { level1: 0, recommendations: 0, skipped: true };
  lastRun.set(tenantId, Date.now());
  const l1 = await level1(db, t);
  let recs = 0;
  try { recs = await levels2to4(db, t); } catch (e) { console.warn('[engine] L2-4 failed', (e as Error).message); }
  if (cfg) await db.update(aiProviderConfigs).set({ lastRefreshAt: new Date() }).where(eq(aiProviderConfigs.id, cfg.id));
  return { level1: l1, recommendations: recs };
}

