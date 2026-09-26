import { and, asc, desc, eq, gte, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import {
  campaigns, deployments, inboundWebhooks, insights, integrations, leadAssignmentHistory, leadExternalMappings, leadLifecycleEvents, leads,
  oneTimeTokens, tenants, users, webhookSources,
} from '../db/schema.js';
import { fail, assertRole, type AuthedContext } from '../lib/orpc.js';
import { config } from '../lib/config.js';
import { decrypt, hmacHex, randomToken, safeEqual, sha256 } from '../lib/crypto.js';
import {
  assignmentPathFor, canRespond, customerWaitingMs, formatDuration, hasFeature, isOverdue, MIN, responseTimeMs, thresholdMinutesFor,
  type Plan, type Role,
} from '../domain/rules.js';
import { emit, fireOutbound, logCampaign, notify, remember } from './effects.js';

type Lead = typeof leads.$inferSelect;
type Tenant = typeof tenants.$inferSelect;

export const displayId = (id: string) => `CP${id.replace(/-/g, '').slice(0, 6).toUpperCase()}`;

function serialize(l: Lead, t: Tenant, extra: { campaignName?: string | null; pageName?: string | null; assigneeName?: string | null; respondedByName?: string | null }, viewer?: { id: string; role: Role }) {
  const now = new Date();
  const thr = thresholdMinutesFor(l, t);
  const utm = hasFeature(t.plan as Plan, 'utm')
    ? { source: l.utmSource, medium: l.utmMedium, campaign: l.utmCampaign, content: l.utmContent, term: l.utmTerm }
    : null;
  return {
    id: l.id, displayId: displayId(l.id), name: l.fullName, email: l.email, phone: l.phone,
    campaignId: l.campaignId, campaignName: extra.campaignName ?? null, deploymentId: l.deploymentId, pageName: extra.pageName ?? null,
    deploymentDeleted: l.deploymentDeleted, sourceSystem: l.sourceSystem, sourceIdentifier: l.sourceIdentifier, vip: l.vip,
    utm: utm && Object.values(utm).some(Boolean) ? utm : null, utmLocked: !hasFeature(t.plan as Plan, 'utm'),
    receivedAt: l.receivedAt, status: l.status, assignmentPath: l.assignmentPath, assigneeId: l.assigneeId, assigneeName: extra.assigneeName ?? null,
    assignedAt: l.assignedAt, claimedAt: l.claimedAt, reassignedAt: l.reassignedAt, respondedAt: l.respondedAt, respondedBy: l.respondedBy,
    respondedByName: extra.respondedByName ?? null, hasExternalLifecycleEvents: l.hasExternalLifecycleEvents,
    thresholdMinutes: thr, isOverdue: isOverdue(l, thr, now),
    customerWaitingMs: customerWaitingMs(l, now), responseTimeMs: responseTimeMs(l, now),
    canRespond: viewer ? canRespond(l, viewer.id, viewer.role) : false,
  };
}
export type LeadDTO = ReturnType<typeof serialize>;

const assignee = sql<string | null>`(select name from users u where u.id = ${leads.assigneeId})`;
const respondedByName = sql<string | null>`(select name from users u where u.id = ${leads.respondedBy})`;

async function selectLeads(db: DB, where: SQL | undefined, order: SQL[], limit: number) {
  return db.select({ lead: leads, campaignName: campaigns.name, pageName: deployments.name, assigneeName: assignee, respondedByName })
    .from(leads).leftJoin(campaigns, eq(campaigns.id, leads.campaignId)).leftJoin(deployments, eq(deployments.id, leads.deploymentId))
    .where(where).orderBy(...order).limit(limit);
}

export interface LeadFilters {
  status?: 'all' | 'responded' | 'not_responded' | 'overdue' | 'unassigned';
  campaignId?: string; deploymentId?: string; assigneeId?: string; q?: string; cursor?: string; limit?: number;
}

/** Members see unassigned leads (Path A) and their own; owner/admin see everything. */
function visibility(ctx: AuthedContext): SQL | undefined {
  if (ctx.role !== 'member') return undefined;
  return or(isNull(leads.assigneeId), eq(leads.assigneeId, ctx.user.id));
}

export async function listLeads(ctx: AuthedContext, f: LeadFilters) {
  const limit = Math.min(f.limit ?? 50, 200);
  const base: (SQL | undefined)[] = [eq(leads.tenantId, ctx.tenantId), visibility(ctx)];
  if (f.campaignId) base.push(eq(leads.campaignId, f.campaignId));
  if (f.deploymentId) base.push(eq(leads.deploymentId, f.deploymentId));
  if (f.assigneeId === 'me') base.push(eq(leads.assigneeId, ctx.user.id));
  else if (f.assigneeId === 'none') base.push(isNull(leads.assigneeId));
  else if (f.assigneeId) base.push(eq(leads.assigneeId, f.assigneeId));
  if (f.q) base.push(or(ilike(leads.fullName, `%${f.q}%`), ilike(leads.email, `%${f.q}%`)));
  const conds = [...base];
  const thr = ctx.tenant.slaThresholdMinutes;
  const vipThr = ctx.tenant.vipLeadEnabled ? ctx.tenant.vipSlaThresholdMinutes : thr;
  const overdueSql = sql`${leads.status} = 'not_responded' and ${leads.receivedAt} < now() - (case when ${leads.vip} then ${vipThr}::int else ${thr}::int end) * interval '1 minute'`;
  if (f.status === 'responded') conds.push(eq(leads.status, 'responded'));
  if (f.status === 'not_responded') conds.push(eq(leads.status, 'not_responded'));
  if (f.status === 'unassigned') conds.push(and(eq(leads.status, 'not_responded'), isNull(leads.assigneeId)));
  if (f.status === 'overdue') conds.push(overdueSql);
  if (f.cursor) conds.push(sql`${leads.receivedAt} < ${new Date(f.cursor)}`);

  const rows = await selectLeads(ctx.db, and(...conds), [desc(leads.receivedAt)], limit + 1);
  const page = rows.slice(0, limit);
  const [sum] = await ctx.db.select({
    total: sql<number>`count(*)`,
    responded: sql<number>`count(*) filter (where ${leads.status} = 'responded')`,
    overdue: sql<number>`count(*) filter (where ${overdueSql})`,
    avg: sql<number | null>`avg(extract(epoch from (${leads.respondedAt} - ${leads.receivedAt}))) filter (where ${leads.respondedAt} is not null)`,
  }).from(leads).where(and(...base));
  const viewer = { id: ctx.user.id, role: ctx.role };
  return {
    leads: page.map((r) => serialize(r.lead, ctx.tenant, r, viewer)),
    total: Number(sum.total), responded: Number(sum.responded), not_responded: Number(sum.total) - Number(sum.responded), overdue: Number(sum.overdue),
    avg_response_time_seconds: sum.avg == null ? null : Math.round(Number(sum.avg)),
    has_more: rows.length > limit, next_cursor: rows.length > limit ? page[page.length - 1].lead.receivedAt.toISOString() : null,
  };
}

export async function loadLead(ctx: AuthedContext, id: string): Promise<Lead> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw fail.notFound('Lead not found.');
  const [l] = await ctx.db.select().from(leads).where(and(eq(leads.tenantId, ctx.tenantId), eq(leads.id, id), visibility(ctx)));
  if (!l) throw fail.notFound('Lead not found.');
  return l;
}

export async function getLead(ctx: AuthedContext, id: string) {
  await loadLead(ctx, id);
  const [r] = await selectLeads(ctx.db, and(eq(leads.tenantId, ctx.tenantId), eq(leads.id, id)), [desc(leads.receivedAt)], 1);
  return serialize(r.lead, ctx.tenant, r, { id: ctx.user.id, role: ctx.role });
}

async function addLifecycle(db: DB, tenantId: string, leadId: string, event: string, source: string, at = new Date(), isMilestone = false) {
  await db.insert(leadLifecycleEvents).values({ tenantId, leadId, event, source, eventTimestamp: at, isMilestone });
}

/**
 * Respond = claim + acknowledge in one action (Design Spec §5.2).
 * Irreversible: both timers freeze at responded_at.
 */
export async function respond(ctx: AuthedContext, id: string) {
  const l = await loadLead(ctx, id);
  if (l.status === 'responded') throw fail.conflict('This lead has already been responded to.', 'already_responded');
  if (!canRespond(l, ctx.user.id, ctx.role)) throw fail.forbidden('This lead is assigned to someone else.');
  const now = new Date();
  const claim = !l.assigneeId;
  const [updated] = await ctx.db.update(leads).set({
    status: 'responded', respondedAt: now, respondedBy: ctx.user.id,
    ...(claim ? { assigneeId: ctx.user.id, assignmentPath: 'A' as const, claimedAt: now } : {}),
  }).where(and(eq(leads.id, id), eq(leads.tenantId, ctx.tenantId), eq(leads.status, 'not_responded'))).returning();
  if (!updated) throw fail.conflict('This lead has already been responded to.', 'already_responded');
  if (claim) {
    await ctx.db.insert(leadAssignmentHistory).values({ tenantId: ctx.tenantId, leadId: id, toAssigneeId: ctx.user.id, path: 'A', actionedBy: ctx.user.id, actionedAt: now });
  }
  await afterRespond(ctx.db, ctx.tenant, updated, ctx.user);
  return getLead(ctx, id);
}

/** Shared by dashboard respond, magic-link acknowledge and Telegram acknowledge. */
export async function afterRespond(db: DB, tenant: Tenant, l: Lead, user: { id: string; name: string }) {
  const tenantId = tenant.id;
  const waited = customerWaitingMs(l);
  const { cancelJob } = await import('../jobs/scheduler.js');
  await cancelJob('sla-timers', l.slaJobId); // D-13: the SLA job is cancelled by sla_job_id on respond
  await addLifecycle(db, tenantId, l.id, `Responded — ${user.name}`, 'camplo', l.respondedAt!);
  if (l.campaignId) await logCampaign(db, tenantId, l.campaignId, user.id, `Responded to ${l.fullName} in ${formatDuration(waited)}`);
  remember(db, tenantId, {
    type: 'lead_responded', campaignId: l.campaignId, entityId: l.id,
    content: `${user.name} responded to lead ${l.fullName} ${formatDuration(waited)} after arrival (path ${l.assignmentPath ?? 'A'}).`,
  });
  // Level 1 win signal — deterministic trigger, Growth plan and above.
  if (waited < 5 * MIN && hasFeature(tenant.plan as Plan, 'win_signals')) {
    const [c] = l.campaignId ? await db.select({ name: campaigns.name }).from(campaigns).where(eq(campaigns.id, l.campaignId)) : [];
    await db.insert(insights).values({
      tenantId, campaignId: l.campaignId, type: 'win', severity: 'green', category: 'SLA', campaignTag: c?.name ?? null,
      observation: `${user.name.split(' ')[0]} responded to ${l.fullName} in ${formatDuration(waited)} — inside the 5-minute conversion window.`,
      evidence: `Leads answered inside five minutes are far more likely to be contacted and qualified. ${l.vip ? 'This was a VIP page lead.' : ''}`.trim(),
      dedupeKey: `win:${l.id}`,
    });
    emit(tenantId, 'workspace:insights', { campaignId: l.campaignId });
  }
  fireOutbound(db, tenantId, 'lead.responded', { lead_id: l.id, name: l.fullName, responded_by: user.name, responded_at: l.respondedAt, waited_ms: waited });
  emit(tenantId, `lead:${l.id}:status`, { status: 'responded', respondedAt: l.respondedAt });
  emit(tenantId, 'workspace:leads', { type: 'updated', leadId: l.id });
  emit(tenantId, 'workspace:overdue-count', {});
  emit(tenantId, 'workspace:sla', {});
  if (l.campaignId) emit(tenantId, `campaign:${l.campaignId}:health`, {});
}

/** Path B (owner/admin assigns unowned lead) or Path C (owner reassigns). Timer 1 never resets. */
export async function assign(ctx: AuthedContext, id: string, assigneeId: string) {
  assertRole(ctx, 'owner', 'admin');
  const l = await loadLead(ctx, id);
  if (l.status === 'responded') throw fail.conflict('Responded leads cannot be reassigned.');
  const [target] = await ctx.db.select().from(users).where(and(eq(users.tenantId, ctx.tenantId), eq(users.id, assigneeId), isNull(users.removedAt)));
  if (!target) throw fail.bad('That team member does not exist.');
  if (l.assigneeId === assigneeId) return getLead(ctx, id);
  const path = assignmentPathFor(l.assigneeId);
  if (path === 'C' && ctx.role !== 'owner') throw fail.forbidden('Only the owner can reassign a claimed lead.');
  const now = new Date();
  await ctx.db.update(leads).set(path === 'B'
    ? { assigneeId, assignmentPath: 'B', assignedAt: now }
    : { assigneeId, assignmentPath: 'C', reassignedAt: now, reassignedBy: ctx.user.id },
  ).where(and(eq(leads.id, id), eq(leads.tenantId, ctx.tenantId)));
  await ctx.db.insert(leadAssignmentHistory).values({ tenantId: ctx.tenantId, leadId: id, fromAssigneeId: l.assigneeId, toAssigneeId: assigneeId, path, actionedBy: ctx.user.id, actionedAt: now });
  await addLifecycle(ctx.db, ctx.tenantId, id, path === 'B' ? `Assigned to ${target.name}` : `Reassigned to ${target.name}`, 'camplo', now);
  if (l.campaignId) await logCampaign(ctx.db, ctx.tenantId, l.campaignId, ctx.user.id, `${path === 'B' ? 'Assigned' : 'Reassigned'} ${l.fullName} to ${target.name}`);
  await notify(ctx.db, ctx.tenantId, { userId: assigneeId, kind: 'assignment', description: `${ctx.user.name} assigned ${l.fullName} to you`, link: `/leads/${id}` });
  fireOutbound(ctx.db, ctx.tenantId, 'lead.assigned', { lead_id: id, assignee: target.name, path });
  emit(ctx.tenantId, `lead:${id}:status`, { assigneeId, path });
  emit(ctx.tenantId, 'workspace:leads', { type: 'updated', leadId: id });
  return getLead(ctx, id);
}

export async function lifecycle(ctx: AuthedContext, id: string) {
  await loadLead(ctx, id);
  const rows = await ctx.db.select().from(leadLifecycleEvents).where(and(eq(leadLifecycleEvents.tenantId, ctx.tenantId), eq(leadLifecycleEvents.leadId, id)))
    .orderBy(asc(leadLifecycleEvents.eventTimestamp));
  return rows.map((e) => ({ id: e.id, at: e.eventTimestamp, event: e.event, source: e.source, isMilestone: e.isMilestone }));
}

export async function audit(ctx: AuthedContext, id: string) {
  const l = await loadLead(ctx, id);
  const hist = await ctx.db.select({ h: leadAssignmentHistory, to: users.name }).from(leadAssignmentHistory).innerJoin(users, eq(users.id, leadAssignmentHistory.toAssigneeId))
    .where(and(eq(leadAssignmentHistory.tenantId, ctx.tenantId), eq(leadAssignmentHistory.leadId, id))).orderBy(asc(leadAssignmentHistory.actionedAt));
  const names = new Map((await ctx.db.select({ id: users.id, name: users.name }).from(users).where(eq(users.tenantId, ctx.tenantId))).map((u) => [u.id, u.name]));
  const out: Array<{ at: Date; actorId: string | null; actorName: string; description: string }> = [
    { at: l.receivedAt, actorId: null, actorName: 'Camplo', description: 'Lead received' },
  ];
  if (!hist.length || hist[0].h.path === 'A') out.push({ at: l.receivedAt, actorId: null, actorName: 'Camplo', description: 'Available to all team members' });
  for (const { h, to } of hist) {
    if (h.path === 'A') continue; // claim is folded into the Responded entry
    const by = names.get(h.actionedBy) ?? 'Unknown';
    out.push({ at: h.actionedAt, actorId: h.actionedBy, actorName: by, description: h.path === 'B'
      ? `Assigned to ${to} — by ${by}`
      : `Reassigned from ${names.get(h.fromAssigneeId ?? '') ?? 'Unassigned'} to ${to} by ${by}` });
  }
  if (l.respondedAt && l.respondedBy) {
    const who = names.get(l.respondedBy) ?? 'Unknown';
    out.push({ at: l.respondedAt, actorId: l.respondedBy, actorName: who, description: `Responded — ${who}${l.assignmentPath === 'A' ? ' (claimed and acknowledged)' : ' (acknowledged)'}` });
  }
  return { status: l.status, events: out };
}

// ------------------------------------------------------------------ ingestion

const pick = (o: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) {
    const v = o[k] ?? o[k.toLowerCase()];
    if (v != null && String(v).trim() !== '') return String(v).trim().slice(0, 255);
  }
  return null;
};

/** Normalise the many shapes lead sources send (Tally, Typeform, GHL, Systeme.io, custom). */
export function normalizePayload(body: unknown): Record<string, string | null> {
  let o: Record<string, unknown> = typeof body === 'object' && body ? { ...(body as Record<string, unknown>) } : {};
  const data = (o.data ?? o.contact ?? o.payload) as Record<string, unknown> | undefined;
  if (data && typeof data === 'object') o = { ...data, ...o };
  // Tally: data.fields[] = { label, value }
  const fields = (o.fields ?? (data as Record<string, unknown> | undefined)?.fields) as Array<{ label?: string; key?: string; value?: unknown }> | undefined;
  if (Array.isArray(fields)) for (const f of fields) if (f.label) o[f.label.toLowerCase().replace(/\s+/g, '_')] = Array.isArray(f.value) ? f.value.join(', ') : f.value;
  const first = pick(o, 'first_name', 'firstName', 'firstname');
  const last = pick(o, 'last_name', 'lastName', 'lastname');
  return {
    fullName: pick(o, 'full_name', 'fullName', 'name', 'your_name') ?? ([first, last].filter(Boolean).join(' ') || null),
    email: pick(o, 'email', 'email_address', 'your_email'),
    phone: pick(o, 'phone', 'phone_number', 'phoneNumber', 'mobile'),
    sourceIdentifier: pick(o, 'source_identifier', 'submission_id', 'submissionId', 'responseId', 'contact_id', 'id', 'eventId'),
    utmSource: pick(o, 'utm_source'), utmMedium: pick(o, 'utm_medium'), utmCampaign: pick(o, 'utm_campaign'),
    utmContent: pick(o, 'utm_content'), utmTerm: pick(o, 'utm_term'),
    sourceSystem: pick(o, 'source_system', 'source'),
  };
}

export function verifySignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const provided = header.replace(/^sha256=/, '').trim();
  return safeEqual(provided, hmacHex(secret, rawBody));
}

async function createLead(db: DB, tenant: Tenant, input: {
  deploymentId: string | null; campaignId: string | null; sourceSystem: string; vip: boolean; data: Record<string, string | null>;
}) {
  const plan = tenant.plan as Plan;
  const d = input.data;
  const [lead] = await db.insert(leads).values({
    tenantId: tenant.id, deploymentId: input.deploymentId, campaignId: input.campaignId,
    fullName: d.fullName ?? d.email ?? 'Unnamed lead', email: d.email, phone: d.phone,
    sourceSystem: d.sourceSystem ?? input.sourceSystem, sourceIdentifier: d.sourceIdentifier, vip: input.vip && tenant.vipLeadEnabled,
    ...(hasFeature(plan, 'utm') ? { utmSource: d.utmSource, utmMedium: d.utmMedium, utmCampaign: d.utmCampaign, utmContent: d.utmContent, utmTerm: d.utmTerm } : {}),
  }).returning();
  await addLifecycle(db, tenant.id, lead.id, 'Lead received', 'camplo', lead.receivedAt);
  if (lead.campaignId) await logCampaign(db, tenant.id, lead.campaignId, null, `New lead received — ${lead.fullName}`);
  remember(db, tenant.id, {
    type: 'lead_arrived', campaignId: lead.campaignId, entityId: lead.id,
    content: `Lead ${lead.fullName} arrived from ${lead.sourceSystem}${lead.utmSource ? ` (utm_source=${lead.utmSource}, utm_campaign=${lead.utmCampaign ?? ''})` : ''}${lead.vip ? ' [VIP]' : ''}.`,
  });
  fireOutbound(db, tenant.id, 'lead.received', { lead_id: lead.id, name: lead.fullName, email: lead.email, campaign_id: lead.campaignId });
  emit(tenant.id, 'workspace:leads', { type: 'created', leadId: lead.id });
  emit(tenant.id, 'workspace:overdue-count', {});
  if (lead.campaignId) emit(tenant.id, `campaign:${lead.campaignId}:health`, {});
  // ADL §6 / P-7: SLA timer (delayed job, cancelled on respond) + Telegram notification.
  const { enqueue, scheduleSlaTimer } = await import('../jobs/scheduler.js');
  await scheduleSlaTimer(db, tenant, lead);
  await enqueue('telegram-notifications', { tenantId: tenant.id, leadId: lead.id });
  // Lead-batch event trigger for the AI refresh (20+ leads in 30 minutes).
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(leads).where(and(eq(leads.tenantId, tenant.id), gte(leads.receivedAt, new Date(Date.now() - 30 * MIN))));
  if (Number(n) === 20) await enqueue('ai-intelligence', { tenantId: tenant.id, reason: 'lead_batch' });
  return lead;
}

/** GET /campaigns/:id/lifecycle/summary — how the campaign's leads progressed across Camplo and connected tools. */
export async function lifecycleSummary(ctx: AuthedContext, campaignId: string) {
  const { loadCampaign } = await import('./campaigns.js');
  await loadCampaign(ctx, campaignId);
  const scope = and(eq(leadLifecycleEvents.tenantId, ctx.tenantId), eq(leads.campaignId, campaignId));
  const [tot] = await ctx.db.select({
    total: sql<number>`count(*)`, external: sql<number>`count(*) filter (where ${leads.hasExternalLifecycleEvents})`,
    responded: sql<number>`count(*) filter (where ${leads.status} = 'responded')`,
  }).from(leads).where(and(eq(leads.tenantId, ctx.tenantId), eq(leads.campaignId, campaignId)));
  const bySource = await ctx.db.select({ source: leadLifecycleEvents.source, events: sql<number>`count(*)`, leads: sql<number>`count(distinct ${leadLifecycleEvents.leadId})` })
    .from(leadLifecycleEvents).innerJoin(leads, eq(leads.id, leadLifecycleEvents.leadId)).where(scope).groupBy(leadLifecycleEvents.source);
  const stages = await ctx.db.select({ event: leadLifecycleEvents.event, source: leadLifecycleEvents.source, milestone: sql<boolean>`bool_or(${leadLifecycleEvents.isMilestone})`, leads: sql<number>`count(distinct ${leadLifecycleEvents.leadId})` })
    .from(leadLifecycleEvents).innerJoin(leads, eq(leads.id, leadLifecycleEvents.leadId))
    .where(and(scope, sql`${leadLifecycleEvents.source} <> 'camplo'`)).groupBy(leadLifecycleEvents.event, leadLifecycleEvents.source)
    .orderBy(desc(sql`count(distinct ${leadLifecycleEvents.leadId})`)).limit(12);
  const [last] = await ctx.db.select({ at: sql<Date | null>`max(${leadLifecycleEvents.eventTimestamp})` }).from(leadLifecycleEvents).innerJoin(leads, eq(leads.id, leadLifecycleEvents.leadId))
    .where(and(scope, sql`${leadLifecycleEvents.source} <> 'camplo'`));
  const total = Number(tot.total), external = Number(tot.external);
  return {
    campaign_id: campaignId, total_leads: total, responded: Number(tot.responded),
    leads_with_external_events: external, external_coverage_rate: total ? external / total : null,
    by_source: bySource.map((s) => ({ source: s.source, events: Number(s.events), leads: Number(s.leads) })),
    stages: stages.map((s) => ({ event: s.event, source: s.source, is_milestone: !!s.milestone, leads: Number(s.leads) })),
    milestones: stages.filter((s) => s.milestone).map((s) => ({ event: s.event, source: s.source, leads: Number(s.leads) })),
    last_external_event_at: last?.at ?? null,
  };
}

/** POST /api/v1/ingest/:tenantId/:deploymentId — per-deployment HMAC-signed webhook. */
export async function ingestDeployment(db: DB, tenantId: string, deploymentId: string, rawBody: Buffer, signature: string | undefined, body: unknown) {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId) || !/^[0-9a-f-]{36}$/i.test(deploymentId)) return { status: 404 as const };
  const [row] = await db.select({ d: deployments, t: tenants }).from(deployments).innerJoin(tenants, eq(tenants.id, deployments.tenantId))
    .where(and(eq(deployments.id, deploymentId), eq(deployments.tenantId, tenantId)));
  if (!row || row.d.status === 'deleted') return { status: 404 as const };
  if (row.t.status === 'suspended' && row.t.suspendedAt && Date.now() - row.t.suspendedAt.getTime() > 7 * 24 * 3600_000) return { status: 410 as const };
  if (!verifySignature(decrypt(row.d.webhookSecretEncrypted), rawBody, signature)) return { status: 401 as const };
  const data = normalizePayload(body);
  const [src] = await db.select().from(webhookSources).where(and(eq(webhookSources.tenantId, tenantId), eq(webhookSources.deploymentId, deploymentId)));
  const sourceSystem = data.sourceSystem ?? src?.sourceSystem ?? 'webhook';
  await db.insert(webhookSources).values({
    tenantId, deploymentId, campaignId: row.d.campaignId, label: row.d.name, sourceSystem, lastReceivedAt: new Date(), status: 'operational',
  }).onConflictDoUpdate({ target: [webhookSources.tenantId, webhookSources.deploymentId], set: { lastReceivedAt: new Date(), status: 'operational', campaignId: row.d.campaignId } });
  emit(tenantId, `page:${deploymentId}:webhook`, { status: 'operational', lastReceivedAt: new Date() });
  const lead = await createLead(db, row.t, { deploymentId, campaignId: row.d.campaignId, sourceSystem, vip: row.d.vip, data });
  return { status: 201 as const, leadId: lead.id };
}

/** POST /api/v1/hooks/:inboundId — named inbound endpoints (§17.6), HMAC-signed with the endpoint secret. */
export async function ingestNamed(db: DB, inboundId: string, rawBody: Buffer, signature: string | undefined, body: unknown) {
  if (!/^[0-9a-f-]{36}$/i.test(inboundId)) return { status: 404 as const };
  const [row] = await db.select({ w: inboundWebhooks, t: tenants }).from(inboundWebhooks).innerJoin(tenants, eq(tenants.id, inboundWebhooks.tenantId))
    .where(eq(inboundWebhooks.id, inboundId));
  if (!row || row.w.status !== 'active') return { status: 404 as const };
  if (!verifySignature(decrypt(row.w.secretEncrypted), rawBody, signature)) return { status: 401 as const };
  await db.update(inboundWebhooks).set({ lastReceivedAt: new Date() }).where(eq(inboundWebhooks.id, inboundId));
  const lead = await createLead(db, row.t, { deploymentId: null, campaignId: row.w.campaignId, sourceSystem: row.w.sourceLabel, vip: false, data: normalizePayload(body) });
  return { status: 201 as const, leadId: lead.id };
}

/**
 * POST /api/v1/lifecycle/:integrationId/:token — external lifecycle events (CRM etc).
 * Maps external contact → Camplo lead via lead_external_mappings, falling back to email.
 */
export async function ingestLifecycle(db: DB, integrationId: string, token: string, body: Record<string, unknown>) {
  if (!/^[0-9a-f-]{36}$/i.test(integrationId)) return { status: 404 as const };
  const [integ] = await db.select().from(integrations).where(eq(integrations.id, integrationId));
  if (!integ || !integ.webhookUrl || !integ.webhookUrl.endsWith(`/${token}`)) return { status: 404 as const };
  const externalId = pick(body, 'contact_id', 'person_id', 'external_contact_id', 'id');
  const email = pick(body, 'email');
  const event = pick(body, 'event', 'stage', 'type', 'status');
  if (!event) return { status: 422 as const };
  let leadId: string | null = null;
  if (externalId) {
    const [m] = await db.select().from(leadExternalMappings).where(and(eq(leadExternalMappings.integrationId, integ.id), eq(leadExternalMappings.externalContactId, externalId)));
    leadId = m?.leadId ?? null;
  }
  if (!leadId && email) {
    const [l] = await db.select({ id: leads.id }).from(leads).where(and(eq(leads.tenantId, integ.tenantId), sql`lower(${leads.email}) = ${email.toLowerCase()}`)).orderBy(desc(leads.receivedAt)).limit(1);
    leadId = l?.id ?? null;
    if (leadId && externalId) await db.insert(leadExternalMappings).values({ tenantId: integ.tenantId, leadId, integrationId: integ.id, externalContactId: externalId });
  }
  if (!leadId) return { status: 202 as const };
  const milestone = /won|closed|booked|appointment/i.test(event);
  const at = pick(body, 'occurred_at', 'timestamp') ? new Date(pick(body, 'occurred_at', 'timestamp')!) : new Date();
  const source = integ.provider;
  await db.insert(leadLifecycleEvents).values({ tenantId: integ.tenantId, leadId, event, source, isMilestone: milestone, eventTimestamp: Number.isNaN(at.getTime()) ? new Date() : at });
  const [lead] = await db.update(leads).set({ hasExternalLifecycleEvents: true }).where(eq(leads.id, leadId)).returning();
  remember(db, integ.tenantId, { type: 'lifecycle_event', campaignId: lead.campaignId, entityId: leadId, content: `${source}: lead ${lead.fullName} → ${event}` });
  emit(integ.tenantId, 'workspace:leads', { type: 'updated', leadId });
  return { status: 201 as const };
}

// ------------------------------------------------------------------ magic link acknowledgment

export async function createAckToken(db: DB, tenantId: string, leadId: string, userId: string) {
  const token = randomToken();
  await db.insert(oneTimeTokens).values({
    tenantId, purpose: 'acknowledge', tokenHash: sha256(token), leadId, userId,
    expiresAt: new Date(Date.now() + config.acknowledgmentLinkExpirySeconds * 1000),
  });
  return `${config.appUrl}/api/acknowledge/${token}`; // ADL §4 public link → acknowledge screen
}

async function loadAck(db: DB, token: string) {
  const [t] = await db.select().from(oneTimeTokens).where(and(eq(oneTimeTokens.tokenHash, sha256(token)), eq(oneTimeTokens.purpose, 'acknowledge')));
  if (!t || !t.leadId || !t.userId) return { state: 'invalid' as const };
  const [l] = await db.select().from(leads).where(eq(leads.id, t.leadId));
  if (!l) return { state: 'invalid' as const };
  if (t.usedAt || l.status === 'responded') return { state: 'already' as const, lead: l, token: t };
  if (t.expiresAt < new Date()) return { state: 'expired' as const, lead: l, token: t };
  return { state: 'ok' as const, lead: l, token: t };
}

export async function ackPreview(db: DB, token: string) {
  const r = await loadAck(db, token);
  if (r.state === 'invalid') return { state: r.state };
  const [c] = r.lead.campaignId ? await db.select({ name: campaigns.name }).from(campaigns).where(eq(campaigns.id, r.lead.campaignId)) : [];
  return { state: r.state, lead: { name: r.lead.fullName }, campaign: { name: c?.name ?? null }, timer: { elapsed: customerWaitingMs(r.lead) } };
}

export async function acknowledge(db: DB, token: string) {
  const r = await loadAck(db, token);
  if (r.state !== 'ok') return { state: r.state };
  const [u] = await db.select().from(users).where(eq(users.id, r.token.userId!));
  const [t] = await db.select().from(tenants).where(eq(tenants.id, r.lead.tenantId));
  const now = new Date();
  const claim = !r.lead.assigneeId;
  const [updated] = await db.update(leads).set({
    status: 'responded', respondedAt: now, respondedBy: u.id,
    ...(claim ? { assigneeId: u.id, assignmentPath: 'A' as const, claimedAt: now } : {}),
  }).where(and(eq(leads.id, r.lead.id), eq(leads.status, 'not_responded'))).returning();
  await db.update(oneTimeTokens).set({ usedAt: now }).where(eq(oneTimeTokens.id, r.token.id));
  if (!updated) return { state: 'already' as const };
  if (claim) await db.insert(leadAssignmentHistory).values({ tenantId: t.id, leadId: r.lead.id, toAssigneeId: u.id, path: 'A', actionedBy: u.id, actionedAt: now });
  await afterRespond(db, t, updated, u);
  return { state: 'done' as const, lead: { name: updated.fullName }, elapsedMs: customerWaitingMs(updated) };
}

/** Counts used by the nav strip, mobile header and O7 badge. */
export async function overdueCount(db: DB, tenant: Tenant) {
  const thr = tenant.slaThresholdMinutes, vip = tenant.vipLeadEnabled ? tenant.vipSlaThresholdMinutes : thr;
  const [r] = await db.select({ n: sql<number>`count(*)` }).from(leads).where(and(eq(leads.tenantId, tenant.id), eq(leads.status, 'not_responded'),
    sql`${leads.receivedAt} < now() - (case when ${leads.vip} then ${vip}::int else ${thr}::int end) * interval '1 minute'`));
  return Number(r.n);
}

export async function leadsByIds(ctx: AuthedContext, ids: string[]) {
  if (!ids.length) return [];
  const rows = await selectLeads(ctx.db, and(eq(leads.tenantId, ctx.tenantId), inArray(leads.id, ids)), [desc(leads.receivedAt)], ids.length);
  return rows.map((r) => serialize(r.lead, ctx.tenant, r, { id: ctx.user.id, role: ctx.role }));
}
