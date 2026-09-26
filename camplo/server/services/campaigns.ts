import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import PDFDocument from 'pdfkit';
import type { DB } from '../db/client.js';
import {
  campaignChanges, campaignLogs, campaignMembers, campaignRetrospectives, campaigns, deployments, insights, leads, pageVisits, tenants, users,
} from '../db/schema.js';
import { fail, assertFeature, assertRole, type AuthedContext } from '../lib/orpc.js';
import { config } from '../lib/config.js';
import { DAY, formatDuration, hasFeature, orderInsights, PLAN_LIMITS, speedColor, type Plan } from '../domain/rules.js';
import { campaignCpl, campaignStats, health, type CampaignStats } from './metrics.js';
import { emit, fireOutbound, logCampaign, logWorkspace, remember } from './effects.js';
import { complete as llm } from '../ai/router.js';
import { storageFor } from '../lib/storage.js';

type Campaign = typeof campaigns.$inferSelect;

function serialize(c: Campaign, s: CampaignStats, members: string[], plan: Plan) {
  const h = health(s);
  return {
    id: c.id, name: c.name, description: c.description, status: c.status,
    health: hasFeature(plan, 'health_pulse') ? h.status : null, healthSignals: hasFeature(plan, 'health_pulse') ? h.signals : null,
    ownerId: c.ownerId, startDate: c.startDate, budget: c.budget == null ? null : Number(c.budget), currency: c.currency,
    dailySpend: c.dailySpend == null ? null : Number(c.dailySpend), cplThreshold: c.cplThreshold == null ? null : Number(c.cplThreshold),
    cpl: hasFeature(plan, 'budget') ? campaignCpl(c, s) : null, pinned: c.pinned, retrospectiveReady: c.retrospectiveReady,
    leadCount: s.leadCount, respondedCount: s.respondedCount, notRespondedCount: s.notRespondedCount, avgResponseMs: s.avgResponseMs,
    pageCount: s.pageCount, notesCount: s.notesCount, daysActive: Math.max(0, Math.floor((Date.now() - new Date(c.startDate).getTime()) / DAY)),
    members, createdAt: c.createdAt, updatedAt: c.updatedAt, completedAt: c.completedAt, shareLinkActive: c.shareLinkActive,
  };
}
export type CampaignDTO = ReturnType<typeof serialize>;

async function membersOf(db: DB, tenantId: string, ids: string[]) {
  const map = new Map<string, string[]>();
  if (!ids.length) return map;
  const rows = await db.select().from(campaignMembers).where(and(eq(campaignMembers.tenantId, tenantId), inArray(campaignMembers.campaignId, ids)));
  for (const r of rows) map.set(r.campaignId, [...(map.get(r.campaignId) ?? []), r.userId]);
  return map;
}

export async function listCampaigns(ctx: AuthedContext) {
  const rows = await ctx.db.select().from(campaigns).where(eq(campaigns.tenantId, ctx.tenantId)).orderBy(desc(campaigns.pinned), desc(campaigns.updatedAt));
  const ids = rows.map((r) => r.id);
  const [stats, mem] = await Promise.all([campaignStats(ctx.db, ctx.tenantId, ids), membersOf(ctx.db, ctx.tenantId, ids)]);
  return rows.map((c) => serialize(c, stats.get(c.id)!, mem.get(c.id) ?? [], ctx.plan));
}

export async function loadCampaign(ctx: AuthedContext, id: string): Promise<Campaign> {
  const [c] = await ctx.db.select().from(campaigns).where(and(eq(campaigns.tenantId, ctx.tenantId), eq(campaigns.id, id)));
  if (!c) throw fail.notFound('Campaign not found.');
  return c;
}

export async function getCampaign(ctx: AuthedContext, id: string) {
  const c = await loadCampaign(ctx, id);
  const [stats, mem] = await Promise.all([campaignStats(ctx.db, ctx.tenantId, [id]), membersOf(ctx.db, ctx.tenantId, [id])]);
  return serialize(c, stats.get(id)!, mem.get(id) ?? [], ctx.plan);
}

export async function createCampaign(ctx: AuthedContext, input: {
  name: string; description?: string | null; startDate?: string; budget?: number | null; currency?: string; cplThreshold?: number | null; dailySpend?: number | null;
}) {
  assertRole(ctx, 'owner', 'admin');
  const [{ n }] = await ctx.db.select({ n: sql<number>`count(*)` }).from(campaigns)
    .where(and(eq(campaigns.tenantId, ctx.tenantId), sql`${campaigns.status} <> 'complete'`));
  if (Number(n) >= PLAN_LIMITS[ctx.plan].campaigns) {
    throw fail.planLimit(`Your plan includes ${PLAN_LIMITS[ctx.plan].campaigns} active campaigns. Upgrade to add more.`, ctx.plan === 'starter' ? 'growth' : 'watchtower');
  }
  const [c] = await ctx.db.insert(campaigns).values({
    tenantId: ctx.tenantId, name: input.name.trim(), description: input.description ?? null, ownerId: ctx.user.id,
    startDate: input.startDate ?? new Date().toISOString().slice(0, 10), currency: input.currency ?? 'USD',
    budget: input.budget == null ? null : String(input.budget), cplThreshold: input.budget == null || input.cplThreshold == null ? null : String(input.cplThreshold),
    dailySpend: input.dailySpend == null ? null : String(input.dailySpend),
  }).returning();
  await ctx.db.insert(campaignMembers).values({ tenantId: ctx.tenantId, campaignId: c.id, userId: ctx.user.id });
  await logCampaign(ctx.db, ctx.tenantId, c.id, ctx.user.id, `Campaign created by ${ctx.user.name}`);
  await logWorkspace(ctx.db, ctx.tenantId, ctx.user.id, `Campaign "${c.name}" created`);
  remember(ctx.db, ctx.tenantId, { type: 'campaign_event', campaignId: c.id, content: `Campaign "${c.name}" created on ${c.startDate}.` });
  return getCampaign(ctx, c.id);
}

/** Snapshot used for campaign_changes.performance_before/after (Data Model §8). */
export async function perfSnapshot(db: DB, tenantId: string, campaignId: string) {
  const s = (await campaignStats(db, tenantId, [campaignId])).get(campaignId)!;
  const [c] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
  const since = new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10);
  const [v] = await db.select({ n: sql<number>`coalesce(sum(${pageVisits.visits}),0)` }).from(pageVisits)
    .innerJoin(deployments, eq(deployments.id, pageVisits.deploymentId))
    .where(and(eq(pageVisits.tenantId, tenantId), eq(deployments.campaignId, campaignId), gte(pageVisits.day, since)));
  const visits = Number(v?.n ?? 0);
  return {
    lead_count_7d: s.leads7d, avg_response_ms: s.avgResponseMs, acknowledgment_rate: s.leads7d ? s.responded7d / s.leads7d : null,
    cpl: c ? campaignCpl(c, s) : null, conversion_rate: visits ? s.leads7d / visits : null,
  };
}

export async function updateCampaign(ctx: AuthedContext, id: string, patch: {
  name?: string; description?: string | null; dailySpend?: number | null; budget?: number | null; cplThreshold?: number | null; startDate?: string;
  status?: 'paused' | 'active'; change?: { type: 'budget' | 'audience' | 'creative' | 'messaging' | 'page'; description: string };
}) {
  assertRole(ctx, 'owner', 'admin');
  const c = await loadCampaign(ctx, id);
  if (c.status === 'complete' && (patch.dailySpend !== undefined || patch.budget !== undefined)) throw fail.bad('Completed campaigns cannot be changed.');
  const set: Partial<typeof campaigns.$inferInsert> = { updatedAt: new Date() };
  const logs: string[] = [];
  if (patch.name !== undefined && patch.name.trim() !== c.name) { set.name = patch.name.trim(); logs.push(`Renamed to "${set.name}"`); }
  if (patch.description !== undefined) { set.description = patch.description; logs.push('Campaign brief updated'); }
  if (patch.startDate !== undefined) set.startDate = patch.startDate;
  if (patch.status !== undefined) {
    if (c.status === 'complete') throw fail.bad('Completed campaigns cannot be paused or resumed.');
    // Pausing takes the campaign out of Health Pulse tracking; resuming hands status back to the pulse sweep.
    if (patch.status === 'paused' && c.status !== 'paused') { set.status = 'paused'; logs.push('Campaign paused'); }
    if (patch.status === 'active' && c.status === 'paused') { set.status = 'active'; logs.push('Campaign resumed'); }
  }
  if (patch.dailySpend !== undefined) { set.dailySpend = patch.dailySpend == null ? null : String(patch.dailySpend); logs.push(`Daily spend set to ${patch.dailySpend ?? '—'}`); }
  if (patch.budget !== undefined) { set.budget = patch.budget == null ? null : String(patch.budget); logs.push(`Budget set to ${patch.budget ?? '—'}`); }
  if (patch.cplThreshold !== undefined) { set.cplThreshold = patch.cplThreshold == null ? null : String(patch.cplThreshold); logs.push(`CPL threshold set to ${patch.cplThreshold ?? '—'}`); }

  const budgetChanged = patch.dailySpend !== undefined || patch.budget !== undefined;
  if (budgetChanged || patch.change) {
    const before = await perfSnapshot(ctx.db, ctx.tenantId, id);
    const type = patch.change?.type ?? 'budget';
    const description = patch.change?.description ?? logs.filter((l) => /spend|Budget/.test(l)).join('; ');
    const [ch] = await ctx.db.insert(campaignChanges).values({ tenantId: ctx.tenantId, campaignId: id, changeType: type, changeDescription: description, changedBy: ctx.user.id, performanceBefore: before }).returning();
    remember(ctx.db, ctx.tenantId, { type: 'experiment', campaignId: id, entityId: ch.id, content: `${type} change on "${c.name}": ${description}. Before: ${JSON.stringify(before)}` });
    if (patch.change) logs.push(`Logged ${type} change: ${patch.change.description}`);
  }
  await ctx.db.update(campaigns).set(set).where(and(eq(campaigns.tenantId, ctx.tenantId), eq(campaigns.id, id)));
  for (const l of logs) await logCampaign(ctx.db, ctx.tenantId, id, ctx.user.id, `${l} by ${ctx.user.name}`);
  emit(ctx.tenantId, `campaign:${id}:health`, {});
  return getCampaign(ctx, id);
}

export async function deleteCampaign(ctx: AuthedContext, id: string) {
  assertRole(ctx, 'owner');
  const c = await loadCampaign(ctx, id);
  // Leads are retained permanently; they keep campaign_id=null via FK set null.
  await ctx.db.delete(campaigns).where(and(eq(campaigns.tenantId, ctx.tenantId), eq(campaigns.id, id)));
  await logWorkspace(ctx.db, ctx.tenantId, ctx.user.id, `Campaign "${c.name}" deleted`);
  return { ok: true };
}

export async function setPinned(ctx: AuthedContext, id: string, pinned: boolean) {
  await loadCampaign(ctx, id);
  if (pinned) {
    const [{ n }] = await ctx.db.select({ n: sql<number>`count(*)` }).from(campaigns).where(and(eq(campaigns.tenantId, ctx.tenantId), eq(campaigns.pinned, true)));
    if (Number(n) >= 3) throw fail.conflict('You can pin up to 3 campaigns. Unpin one to pin this one.', 'pin_limit_reached');
  }
  await ctx.db.update(campaigns).set({ pinned }).where(and(eq(campaigns.tenantId, ctx.tenantId), eq(campaigns.id, id)));
  return { ok: true, pinned };
}

export async function campaignHealth(ctx: AuthedContext, id: string) {
  await loadCampaign(ctx, id);
  assertFeature(ctx, 'health_pulse');
  return health((await campaignStats(ctx.db, ctx.tenantId, [id])).get(id)!);
}

export async function campaignSpeedToLead(ctx: AuthedContext, id: string) {
  await loadCampaign(ctx, id);
  const s = (await campaignStats(ctx.db, ctx.tenantId, [id])).get(id)!;
  return { avgResponseMs: s.avgResponseMs, formatted: formatDuration(s.avgResponseMs), color: speedColor(s.avgResponseMs) };
}

export async function campaignCplInfo(ctx: AuthedContext, id: string) {
  const c = await loadCampaign(ctx, id);
  assertFeature(ctx, 'budget');
  const s = (await campaignStats(ctx.db, ctx.tenantId, [id])).get(id)!;
  const value = campaignCpl(c, s);
  const threshold = c.cplThreshold == null ? null : Number(c.cplThreshold);
  return { cpl: value, threshold, overThreshold: value != null && threshold != null && value > threshold, leadCount: s.leadCount };
}

export async function campaignLogsList(ctx: AuthedContext, id: string, from?: string, to?: string, cursor?: string, limit = 50) {
  await loadCampaign(ctx, id);
  assertFeature(ctx, 'campaign_logs');
  const fromD = from ? new Date(from) : new Date(Date.now() - 7 * DAY);
  const toD = to ? new Date(new Date(to).getTime() + (to.length <= 10 ? DAY - 1 : 0)) : new Date();
  const conds = [eq(campaignLogs.tenantId, ctx.tenantId), eq(campaignLogs.campaignId, id), gte(campaignLogs.createdAt, fromD), lte(campaignLogs.createdAt, toD)];
  if (cursor) conds.push(sql`${campaignLogs.createdAt} < ${new Date(cursor)}`);
  const rows = await ctx.db.select({ log: campaignLogs, actorName: users.name }).from(campaignLogs).leftJoin(users, eq(users.id, campaignLogs.actorId))
    .where(and(...conds)).orderBy(desc(campaignLogs.createdAt)).limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    logs: page.map((r) => ({ id: r.log.id, actorId: r.log.actorId, actorName: r.actorName ?? 'Camplo', description: r.log.description, createdAt: r.log.createdAt })),
    has_more: rows.length > limit, next_cursor: rows.length > limit ? page[page.length - 1].log.createdAt.toISOString() : null,
  };
}

// ------------------------------------------------------------ completion + retrospective

export async function completeCampaign(ctx: AuthedContext, id: string) {
  assertRole(ctx, 'owner', 'admin');
  const c = await loadCampaign(ctx, id);
  if (c.status === 'complete') throw fail.conflict('This campaign is already complete.');
  await ctx.db.update(campaigns).set({ status: 'complete', completedAt: new Date(), pinned: false, updatedAt: new Date() }).where(eq(campaigns.id, id));
  await ctx.db.insert(campaignRetrospectives).values({ tenantId: ctx.tenantId, campaignId: id }).onConflictDoNothing();
  await logCampaign(ctx.db, ctx.tenantId, id, ctx.user.id, `Campaign marked complete by ${ctx.user.name}`);
  remember(ctx.db, ctx.tenantId, { type: 'campaign_event', campaignId: id, content: `Campaign "${c.name}" marked complete.` });
  fireOutbound(ctx.db, ctx.tenantId, 'campaign.completed', { campaign_id: id, name: c.name });
  // Retrospective is generated asynchronously (retrospective-generation job); poll /retrospective/status.
  const { enqueue } = await import('../jobs/scheduler.js');
  await enqueue('retrospective-generation', { tenantId: ctx.tenantId, campaignId: id });
  return { ok: true };
}

export async function generateRetrospective(db: DB, tenantId: string, campaignId: string) {
  const [c] = await db.select().from(campaigns).where(and(eq(campaigns.tenantId, tenantId), eq(campaigns.id, campaignId)));
  const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
  if (!c || !t) return;
  const s = (await campaignStats(db, tenantId, [campaignId])).get(campaignId)!;
  const pages = await db.select({ id: deployments.id, name: deployments.name }).from(deployments).where(and(eq(deployments.tenantId, tenantId), eq(deployments.campaignId, campaignId)));
  let best: { id: string; rate: number } | null = null, worst: { id: string; rate: number } | null = null;
  for (const p of pages) {
    const [v] = await db.select({ n: sql<number>`coalesce(sum(${pageVisits.visits}),0)` }).from(pageVisits).where(eq(pageVisits.deploymentId, p.id));
    const [l] = await db.select({ n: sql<number>`count(*)` }).from(leads).where(eq(leads.deploymentId, p.id));
    const visits = Number(v?.n ?? 0);
    if (!visits) continue;
    const rate = Number(l.n) / visits;
    if (!best || rate > best.rate) best = { id: p.id, rate };
    if (!worst || rate < worst.rate) worst = { id: p.id, rate };
  }
  const ackRate = s.leadCount ? s.respondedCount / s.leadCount : null;
  const cplValue = campaignCpl(c, s);
  const facts = [
    `Campaign "${c.name}" ran ${c.startDate} to ${(c.completedAt ?? new Date()).toISOString().slice(0, 10)}.`,
    `${s.leadCount} leads; ${s.respondedCount} responded (${ackRate == null ? 'n/a' : Math.round(ackRate * 100) + '%'}).`,
    `Average speed-to-lead ${formatDuration(s.avgResponseMs)} against a 5-minute target.`,
    cplValue != null ? `Cost per lead ${cplValue} ${c.currency}.` : 'No budget tracked.',
  ];
  let observation: string;
  const res = await llm(db, {
    tenantId, plan: t.plan, workload: 'strategic', taskType: 'retrospective', maxTokens: 1200, timeoutMs: 5 * 60_000,
    system: 'You are Camplo, a campaign decision engine. Write one paragraph (4-6 sentences) observing what this finished campaign\'s data suggests for the next campaign. Be specific, cite numbers, never invent data, no bullet points.',
    messages: [{ role: 'user', content: facts.join('\n') }],
  });
  if (res.completion?.text) observation = res.completion.text;
  else {
    const speed = s.avgResponseMs == null ? 'Response speed could not be measured.' : s.avgResponseMs < 5 * 60_000
      ? `The team averaged ${formatDuration(s.avgResponseMs)} to respond — inside the five-minute window where contact rates are highest.`
      : `The team averaged ${formatDuration(s.avgResponseMs)} to respond, outside the five-minute window; staffing the busiest arrival hours is the clearest lever for the next campaign.`;
    observation = `${facts[1]} ${speed} ${ackRate != null && ackRate < 0.9 ? 'Roughly one in ten leads was never acknowledged — treat that as lost revenue to recover next time.' : 'Acknowledgment discipline held throughout.'} Judge the next campaign on cost per qualified opportunity, not cost per lead.`;
  }
  await db.update(campaignRetrospectives).set({
    generated: true, generatedAt: new Date(), totalLeads: s.leadCount, respondedCount: s.respondedCount, avgResponseTimeMs: s.avgResponseMs,
    acknowledgmentRate: ackRate == null ? null : ackRate.toFixed(4), cpl: cplValue == null ? null : String(cplValue),
    bestPageId: best?.id ?? null, worstPageId: worst && worst.id !== best?.id ? worst.id : null, aiObservation: observation,
  }).where(eq(campaignRetrospectives.campaignId, campaignId));
  await db.update(campaigns).set({ retrospectiveReady: true }).where(eq(campaigns.id, campaignId));
  const [r] = await db.select().from(campaignRetrospectives).where(eq(campaignRetrospectives.campaignId, campaignId));
  try { await storeRetroPdf(db, t, c, r); } catch (e) { console.error('[retro] pdf', (e as Error).message); }
  emit(tenantId, 'workspace:insights', { campaignId });
}

async function loadRetro(ctx: AuthedContext, id: string) {
  const c = await loadCampaign(ctx, id);
  assertFeature(ctx, 'retrospective');
  if (c.status !== 'complete') throw fail.notFound('Retrospective not yet available.');
  const [r] = await ctx.db.select().from(campaignRetrospectives).where(and(eq(campaignRetrospectives.tenantId, ctx.tenantId), eq(campaignRetrospectives.campaignId, id)));
  return { c, r };
}

export async function retrospectiveStatus(ctx: AuthedContext, id: string) {
  const { r } = await loadRetro(ctx, id);
  return { generated: !!r?.generated };
}

export async function retrospective(ctx: AuthedContext, id: string) {
  const { c, r } = await loadRetro(ctx, id);
  if (!r?.generated) return { generated: false as const };
  return retroView(ctx.db, c, r);
}

type Retro = typeof campaignRetrospectives.$inferSelect;
type RetroView = Awaited<ReturnType<typeof retroView>>;

async function retroView(db: DB, c: typeof campaigns.$inferSelect, r: Retro) {
  const pageName = async (pid: string | null) => {
    if (!pid) return null;
    const [p] = await db.select({ name: deployments.name }).from(deployments).where(eq(deployments.id, pid));
    if (!p) return null;
    const [v] = await db.select({ n: sql<number>`coalesce(sum(${pageVisits.visits}),0)` }).from(pageVisits).where(eq(pageVisits.deploymentId, pid));
    const [l] = await db.select({ n: sql<number>`count(*)` }).from(leads).where(eq(leads.deploymentId, pid));
    return { name: p.name, conversionRate: Number(v.n) ? Number(l.n) / Number(v.n) : null };
  };
  return {
    generated: true as const, campaignName: c.name, startDate: c.startDate, endDate: (c.completedAt ?? new Date()).toISOString().slice(0, 10),
    daysActive: Math.max(1, Math.round(((c.completedAt ?? new Date()).getTime() - new Date(c.startDate).getTime()) / DAY)),
    totalLeads: r.totalLeads, respondedCount: r.respondedCount, avgResponseTimeMs: r.avgResponseTimeMs,
    acknowledgmentRate: r.acknowledgmentRate == null ? null : Number(r.acknowledgmentRate), cpl: r.cpl == null ? null : Number(r.cpl), currency: c.currency,
    bestPage: await pageName(r.bestPageId), worstPage: await pageName(r.worstPageId), aiObservation: r.aiObservation, generatedAt: r.generatedAt,
  };
}

/** Dark-themed, client-ready PDF (Design Spec §17.8). */
const pdfName = (campaignName: string) => `${campaignName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-retrospective.pdf`;

/** D-NEW-14: served from object storage (pdf_url); rendered and stored on first request if generation couldn't. */
export async function retrospectivePdf(ctx: AuthedContext, id: string): Promise<{ filename: string; data: Buffer }> {
  const { c, r } = await loadRetro(ctx, id);
  if (!r?.generated) throw fail.notFound('Retrospective is still generating.');
  const st = await storageFor(ctx.db);
  const stored = r.pdfUrl ? await st.get(r.pdfUrl) : null;
  if (stored) return { filename: pdfName(c.name), data: stored.data };
  const data = await storeRetroPdf(ctx.db, ctx.tenant, c, r);
  return { filename: pdfName(c.name), data };
}

async function storeRetroPdf(db: DB, t: typeof tenants.$inferSelect, c: typeof campaigns.$inferSelect, r: Retro): Promise<Buffer> {
  const data = await renderRetroPdf(db, t, await retroView(db, c, r));
  const key = `retros/${t.id}/${c.id}.pdf`;
  await (await storageFor(db)).put(key, data, 'application/pdf');
  await db.update(campaignRetrospectives).set({ pdfUrl: key }).where(eq(campaignRetrospectives.id, r.id));
  return data;
}

/** Dark, client-ready PDF with the operator's logo at the top (D-NEW-21). */
async function renderRetroPdf(db: DB, t: typeof tenants.$inferSelect, r: RetroView): Promise<Buffer> {
  const logo = t.logoUrl?.startsWith('/api/files/') ? await (await storageFor(db)).get(t.logoUrl.slice('/api/files/'.length)) : null;
  const doc = new PDFDocument({ size: 'A4', margin: 56 });
  const chunks: Buffer[] = [];
  doc.on('data', (b: Buffer) => chunks.push(b));
  const done = new Promise<void>((res) => doc.on('end', () => res()));
  doc.rect(0, 0, doc.page.width, doc.page.height).fill('#0B0B0F');
  if (logo) {
    try { doc.image(logo.data, 56, 48, { fit: [140, 44] }); doc.y = 100; } catch { /* unreadable image: fall back to the name */ }
  }
  doc.fillColor('#E8E8F0').font('Helvetica-Bold').fontSize(22).text(t.businessName, 56, logo ? doc.y : 56);
  doc.moveDown(0.4).fillColor('#8888A8').font('Helvetica').fontSize(11).text('Campaign Retrospective');
  doc.moveDown(1.2).fillColor('#E8E8F0').font('Helvetica-Bold').fontSize(18).text(r.campaignName);
  doc.fillColor('#8888A8').font('Helvetica').fontSize(11).text(`${r.startDate} – ${r.endDate} · ${r.daysActive} days active`);
  const tiles: Array<[string, string]> = [
    ['Total leads', String(r.totalLeads ?? 0)], ['Avg speed-to-lead', formatDuration(r.avgResponseTimeMs)],
    ['Acknowledgment rate', r.acknowledgmentRate == null ? '—' : `${Math.round(r.acknowledgmentRate * 100)}%`],
  ];
  if (r.cpl != null) tiles.push(['Cost per lead', `${r.cpl.toLocaleString()} ${r.currency}`]);
  let y = doc.y + 24;
  tiles.forEach(([k, v], i) => {
    const x = 56 + i * 124;
    doc.roundedRect(x, y, 116, 70, 8).fill('#111118');
    doc.fillColor('#55557A').fontSize(8).text(k.toUpperCase(), x + 12, y + 12, { width: 96 });
    doc.fillColor('#E8E8F0').font('Helvetica-Bold').fontSize(16).text(v, x + 12, y + 32, { width: 96 });
    doc.font('Helvetica');
  });
  y += 96;
  doc.fillColor('#8888A8').fontSize(10);
  if (r.bestPage) doc.text(`Best page: ${r.bestPage.name}${r.bestPage.conversionRate != null ? ` · ${(r.bestPage.conversionRate * 100).toFixed(1)}% conversion` : ''}`, 56, y);
  if (r.worstPage) doc.text(`Weakest page: ${r.worstPage.name}${r.worstPage.conversionRate != null ? ` · ${(r.worstPage.conversionRate * 100).toFixed(1)}% conversion` : ''}`);
  doc.moveDown(1.5).fillColor('#55557A').fontSize(8).text('AI OBSERVATION');
  doc.moveDown(0.5).fillColor('#E8E8F0').font('Helvetica-Oblique').fontSize(12).text(r.aiObservation ?? '', { lineGap: 4 });
  doc.fillColor('#55557A').font('Helvetica').fontSize(8).text('Powered by Camplo', 56, doc.page.height - 72, { align: 'center', width: doc.page.width - 112 });
  doc.end();
  await done;
  return Buffer.concat(chunks);
}

// ------------------------------------------------------------ share links + public view

export async function getShareLink(ctx: AuthedContext, id: string) {
  const c = await loadCampaign(ctx, id);
  assertFeature(ctx, 'client_view');
  if (!c.shareToken || !c.shareLinkActive) throw fail.notFound('No share link yet.');
  return { shareUrl: `${config.appUrl}/#/share/${c.shareToken}` };
}

export async function createShareLink(ctx: AuthedContext, id: string) {
  assertRole(ctx, 'owner', 'admin');
  await loadCampaign(ctx, id);
  assertFeature(ctx, 'client_view');
  const token = randomUUID();
  await ctx.db.update(campaigns).set({ shareToken: token, shareLinkActive: true }).where(and(eq(campaigns.tenantId, ctx.tenantId), eq(campaigns.id, id)));
  await logCampaign(ctx.db, ctx.tenantId, id, ctx.user.id, `Client share link generated by ${ctx.user.name}`);
  return { shareUrl: `${config.appUrl}/#/share/${token}` };
}

export async function revokeShareLink(ctx: AuthedContext, id: string) {
  assertRole(ctx, 'owner', 'admin');
  await loadCampaign(ctx, id);
  await ctx.db.update(campaigns).set({ shareToken: null, shareLinkActive: false }).where(and(eq(campaigns.tenantId, ctx.tenantId), eq(campaigns.id, id)));
  await logCampaign(ctx.db, ctx.tenantId, id, ctx.user.id, `Client share link revoked by ${ctx.user.name}`);
  return { ok: true };
}

/** Public read-only view. Excludes team names, notes, config, billing and other campaigns. */
export async function publicCampaign(db: DB, token: string) {
  if (!/^[0-9a-f-]{36}$/i.test(token)) throw fail.notFound('This report link is no longer active.');
  const [c] = await db.select().from(campaigns).where(and(eq(campaigns.shareToken, token), eq(campaigns.shareLinkActive, true)));
  if (!c) throw fail.notFound('This report link is no longer active.');
  const s = (await campaignStats(db, c.tenantId, [c.id])).get(c.id)!;
  const ins = await db.select().from(insights).where(and(eq(insights.tenantId, c.tenantId), eq(insights.campaignId, c.id), sql`${insights.dismissedAt} is null`, sql`${insights.type} <> 'insufficient_evidence'`))
    .orderBy(desc(insights.generatedAt)).limit(20);
  // Clients never see who on the team did what: strip member names from observation text.
  const names = (await db.select({ name: users.name }).from(users).where(eq(users.tenantId, c.tenantId)))
    .flatMap((u) => [u.name, u.name.split(/\s+/)[0]]).filter((n) => n.length > 1).sort((a, b) => b.length - a.length);
  const redact = (text: string) => names.reduce((t, n) => t.replace(new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:'s)?\\b`, 'g'), 'The team'), text);
  return {
    campaign_name: c.name, status: c.status, lead_count: s.leadCount, responded_count: s.respondedCount, not_responded_count: s.notRespondedCount,
    speed_to_lead_ms: s.avgResponseMs, health_pulse: health(s).status,
    insights: orderInsights(ins).slice(0, 5).map((i) => ({ observation: redact(i.observation), generated_at: i.generatedAt })),
    powered_by: 'Camplo',
  };
}

export async function memoryTimeline(ctx: AuthedContext, campaignId: string) {
  await loadCampaign(ctx, campaignId);
  const rows = await ctx.db.select({ ch: campaignChanges, by: users.name }).from(campaignChanges).leftJoin(users, eq(users.id, campaignChanges.changedBy))
    .where(and(eq(campaignChanges.tenantId, ctx.tenantId), eq(campaignChanges.campaignId, campaignId))).orderBy(asc(campaignChanges.changedAt));
  return rows.map((r) => ({ id: r.ch.id, type: r.ch.changeType, description: r.ch.changeDescription, by: r.by, at: r.ch.changedAt, before: r.ch.performanceBefore, after: r.ch.performanceAfter }));
}
