/** Insights feed, recommendations and AI chat endpoints. */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { campaignChanges, campaignRecommendations, campaigns, chatMessages, insights, users } from '../db/schema.js';
import { fail, assertFeature, type AuthedContext } from '../lib/orpc.js';
import { config } from '../lib/config.js';
import { hasFeature, orderInsights, recommendationLevelAllowed } from '../domain/rules.js';
import { refreshWorkspace } from '../ai/engine.js';
import { askAgent, type Depth } from '../ai/agent.js';
import { advancedUsage } from '../ai/router.js';
import { overdueCount } from './leads.js';
import { remember } from './effects.js';
import { loadCampaign } from './campaigns.js';

type Insight = typeof insights.$inferSelect;
const serializeInsight = (i: Insight) => ({
  id: i.id, type: i.type, severity: i.severity, observation: i.observation, evidence: i.evidence, campaign_id: i.campaignId, campaign_tag: i.campaignTag,
  category: i.category, reassess_condition: i.reassessCondition, reassess_at: i.reassessAt, generated_at: i.generatedAt, dismissed_at: i.dismissedAt,
});

export async function listInsights(ctx: AuthedContext, campaignId?: string) {
  if (campaignId) await loadCampaign(ctx, campaignId);
  const rows = await ctx.db.select().from(insights)
    .where(and(eq(insights.tenantId, ctx.tenantId), isNull(insights.dismissedAt), campaignId ? eq(insights.campaignId, campaignId) : undefined))
    .orderBy(desc(insights.generatedAt)).limit(100);
  // Win cards are a Growth feature; alerts and Priority Flags are available on every plan.
  const visible = rows.filter((r) => r.type !== 'win' || hasFeature(ctx.plan, 'win_signals'));
  return orderInsights(visible).map(serializeInsight);
}

export async function getInsight(ctx: AuthedContext, id: string) {
  const [i] = await ctx.db.select().from(insights).where(and(eq(insights.tenantId, ctx.tenantId), eq(insights.id, id)));
  if (!i) throw fail.notFound('Insight not found.');
  return serializeInsight(i);
}

export async function dismissInsight(ctx: AuthedContext, id: string) {
  const [i] = await ctx.db.select().from(insights).where(and(eq(insights.tenantId, ctx.tenantId), eq(insights.id, id)));
  if (!i) throw fail.notFound('Insight not found.');
  if (i.type === 'insufficient_evidence') throw fail.bad('Monitoring cards resolve automatically.');
  await ctx.db.update(insights).set({ dismissedAt: new Date() }).where(eq(insights.id, id));
  return { ok: true };
}

/** Manual refresh — debounced to once per 15 minutes per workspace. */
const lastManual = new Map<string, number>();
export async function manualRefresh(ctx: AuthedContext) {
  const last = lastManual.get(ctx.tenantId) ?? 0;
  const wait = config.manualRefreshDebounceMinutes * 60_000 - (Date.now() - last);
  if (wait > 0) return { refreshed: false, retryInMinutes: Math.ceil(wait / 60_000) };
  lastManual.set(ctx.tenantId, Date.now());
  const r = await refreshWorkspace(ctx.db, ctx.tenantId, { force: true, reason: 'manual' });
  return { refreshed: true, ...r };
}

type Rec = typeof campaignRecommendations.$inferSelect;
async function serializeRecs(ctx: AuthedContext, rows: Rec[]) {
  const refIds = [...new Set(rows.flatMap((r) => r.memoryReferences))].filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  const changes = refIds.length ? await ctx.db.select().from(campaignChanges).where(and(eq(campaignChanges.tenantId, ctx.tenantId), inArray(campaignChanges.id, refIds))) : [];
  const priorRecs = refIds.length ? await ctx.db.select().from(campaignRecommendations).where(and(eq(campaignRecommendations.tenantId, ctx.tenantId), inArray(campaignRecommendations.id, refIds))) : [];
  const names = new Map((await ctx.db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns).where(eq(campaigns.tenantId, ctx.tenantId))).map((c) => [c.id, c.name]));
  return rows.map((r) => ({
    recommendation_id: r.id, campaign_id: r.campaignId, campaign_name: r.campaignId ? names.get(r.campaignId) ?? null : null, level: r.level,
    action_text: r.actionText, why: r.why, evidence: r.evidence, diagnosis: r.diagnosis, expected_outcome: r.expectedOutcome, risk: r.risk,
    confidence: r.confidence, next_step: r.nextStep, why_now: r.whyNow, memory_references: r.memoryReferences,
    memory_timeline: [
      ...changes.filter((c) => r.memoryReferences.includes(c.id)).map((c) => ({ id: c.id, at: c.changedAt, text: `${c.changeType} change: ${c.changeDescription}`, kind: 'experiment' })),
      ...priorRecs.filter((p) => r.memoryReferences.includes(p.id)).map((p) => ({ id: p.id, at: p.actionedAt ?? p.surfacedAt, text: `Camplo recommended "${p.actionText}"`, kind: p.status })),
    ],
    apply_action: r.applyAction, status: r.status, surfaced_at: r.surfacedAt, outcome_measured: r.outcomeMeasured,
  }));
}

export async function listRecommendations(ctx: AuthedContext, campaignId?: string) {
  if (campaignId) await loadCampaign(ctx, campaignId);
  const rows = await ctx.db.select().from(campaignRecommendations)
    .where(and(eq(campaignRecommendations.tenantId, ctx.tenantId), eq(campaignRecommendations.status, 'surfaced'), campaignId ? eq(campaignRecommendations.campaignId, campaignId) : undefined))
    .orderBy(asc(campaignRecommendations.level), desc(campaignRecommendations.surfacedAt));
  return serializeRecs(ctx, rows.filter((r) => recommendationLevelAllowed(ctx.plan, r.level)));
}

export async function getRecommendation(ctx: AuthedContext, id: string) {
  const [r] = await ctx.db.select().from(campaignRecommendations).where(and(eq(campaignRecommendations.tenantId, ctx.tenantId), eq(campaignRecommendations.id, id)));
  if (!r || !recommendationLevelAllowed(ctx.plan, r.level)) throw fail.notFound('Recommendation not found.');
  const [out] = await serializeRecs(ctx, [r]);
  return { ...out, status: r.status, surfaced_at: r.surfacedAt, actioned_at: r.actionedAt, outcome_measured: r.outcomeMeasured, outcome_data: r.outcomeData };
}

export async function dismissRecommendation(ctx: AuthedContext, id: string) {
  const [r] = await ctx.db.update(campaignRecommendations).set({ status: 'dismissed', actionedAt: new Date() })
    .where(and(eq(campaignRecommendations.tenantId, ctx.tenantId), eq(campaignRecommendations.id, id), eq(campaignRecommendations.status, 'surfaced'))).returning();
  if (!r) throw fail.notFound('Recommendation not found.');
  remember(ctx.db, ctx.tenantId, { type: 'recommendation', campaignId: r.campaignId, entityId: r.id, content: `Operator dismissed recommendation: ${r.actionText}` });
  return { ok: true };
}

/** v1 Copilot: execution is not connected yet. The endpoint exists so v2 is a flag flip. */
export async function applyRecommendation(_ctx: AuthedContext, _id: string): Promise<never> {
  throw fail.conflict('Applying recommendations arrives with Autopilot (v2). Camplo recommends; you execute.', 'coming_soon');
}

// ------------------------------------------------------------------ chat

export async function chatHistory(ctx: AuthedContext) {
  const rows = await ctx.db.select({ m: chatMessages, name: users.name }).from(chatMessages).leftJoin(users, eq(users.id, chatMessages.userId))
    .where(eq(chatMessages.tenantId, ctx.tenantId)).orderBy(asc(chatMessages.createdAt)).limit(500);
  const usage = await advancedUsage(ctx.db, ctx.tenantId, ctx.plan);
  return {
    messages: rows.map((r) => ({ id: r.m.id, role: r.m.role, content: r.m.content, author: r.name, workload: r.m.workloadLevel, createdAt: r.m.createdAt })),
    capacity: { advancedUsage: Math.min(1, usage), warning: usage >= 0.8 && usage < 1, limitReached: usage >= 1 },
    depthSelector: hasFeature(ctx.plan, 'depth_selector'),
  };
}

export async function chatMessage(ctx: AuthedContext, content: string, depth: Depth = 'Standard') {
  assertFeature(ctx, 'ai_chat');
  const text = content.trim();
  if (!text) throw fail.bad('Ask Camplo something.');
  if (!hasFeature(ctx.plan, 'depth_selector')) depth = 'Standard';
  const prior = await ctx.db.select().from(chatMessages).where(eq(chatMessages.tenantId, ctx.tenantId)).orderBy(desc(chatMessages.createdAt)).limit(10);
  await ctx.db.insert(chatMessages).values({ tenantId: ctx.tenantId, userId: ctx.user.id, role: 'user', content: text });
  const res = await askAgent({
    db: ctx.db, tenantId: ctx.tenantId, plan: ctx.plan, question: text, depth,
    history: prior.reverse().map((m) => ({ role: m.role, content: m.content })),
  });
  const [msg] = await ctx.db.insert(chatMessages).values({ tenantId: ctx.tenantId, role: 'assistant', content: res.answer, workloadLevel: res.workload }).returning();
  return { id: msg.id, role: 'assistant' as const, content: res.answer, workload: res.workload, investigated: res.investigated, workers: res.workers, createdAt: msg.createdAt };
}

export async function chatSuggestions(ctx: AuthedContext) {
  const od = await overdueCount(ctx.db, ctx.tenant);
  const [crit] = await ctx.db.select({ name: campaigns.name }).from(campaigns).where(and(eq(campaigns.tenantId, ctx.tenantId), sql`${campaigns.status} <> 'complete'`)).limit(1);
  return [
    'What needs my attention right now?',
    od ? 'Which lead is most overdue?' : 'How is my team performing on SLA?',
    crit ? `What should I change about ${crit.name} this week?` : 'What should I change about my campaigns this week?',
  ];
}

export async function clearChat(ctx: AuthedContext) {
  await ctx.db.delete(chatMessages).where(eq(chatMessages.tenantId, ctx.tenantId));
  return { ok: true };
}
