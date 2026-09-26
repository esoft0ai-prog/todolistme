/**
 * Page hosting (Module 1): ZIP upload → static files in object storage, served
 * at `{subdomain}.{PAGES_BASE_DOMAIN}` (or /sites/{subdomain}/ on the app host,
 * or a verified custom domain). Static files only — nothing on a hosted page
 * ever executes server-side.
 */
import { planLimits, platform } from '../lib/platform.js';
import { enqueue, scheduleEarlyWarningClose, usesQueues } from '../jobs/scheduler.js';
import AdmZip from 'adm-zip';
import { resolveCname } from 'node:dns/promises';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { campaigns, deployments, domains, leads, pageVisits, tenants, webhookSources } from '../db/schema.js';
import { fail, assertRole, type AuthedContext } from '../lib/orpc.js';
import { config } from '../lib/config.js';
import { decrypt, encrypt, hmacHex, randomToken } from '../lib/crypto.js';
import { contentTypeFor, storageFor } from '../lib/storage.js';
import { DAY, earlyWarningActive, hasRollbackAvailable, PLAN_LIMITS, webhookState } from '../domain/rules.js';
import { emit, fireOutbound, logCampaign, logWorkspace } from './effects.js';
import { workspaceConversion } from './metrics.js';
import { loadCampaign } from './campaigns.js';

type Deployment = typeof deployments.$inferSelect;

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'page';
const shortId = () => randomUUID().replace(/-/g, '').slice(0, 6);

export const webhookUrlFor = (d: Pick<Deployment, 'tenantId' | 'id'>) => `${config.appUrl}/api/v1/ingest/${d.tenantId}/${d.id}`;
export const pageUrlFor = (d: Pick<Deployment, 'subdomain'>) => `${config.appUrl}/sites/${d.subdomain}/`;

async function analytics(db: DB, tenantId: string, ids: string[]) {
  const since = new Date(Date.now() - 7 * DAY);
  const map = new Map<string, { visits7d: number; leads7d: number }>();
  if (!ids.length) return map;
  for (const id of ids) map.set(id, { visits7d: 0, leads7d: 0 });
  const v = await db.select({ id: pageVisits.deploymentId, n: sql<number>`sum(${pageVisits.visits})` }).from(pageVisits)
    .where(and(eq(pageVisits.tenantId, tenantId), inArray(pageVisits.deploymentId, ids), gte(pageVisits.day, since.toISOString().slice(0, 10)))).groupBy(pageVisits.deploymentId);
  for (const r of v) map.get(r.id)!.visits7d = Number(r.n);
  const l = await db.select({ id: leads.deploymentId, n: sql<number>`count(*)` }).from(leads)
    .where(and(eq(leads.tenantId, tenantId), inArray(leads.deploymentId, ids), gte(leads.receivedAt, since))).groupBy(leads.deploymentId);
  for (const r of l) map.get(r.id!)!.leads7d = Number(r.n);
  return map;
}

function serialize(d: Deployment, extra: { campaignName: string | null; hook: typeof webhookSources.$inferSelect | null; a?: { visits7d: number; leads7d: number }; avgConv: number | null; domain?: typeof domains.$inferSelect | null }, canManage: boolean) {
  const state = extra.hook ? webhookState(extra.hook.lastReceivedAt, extra.hook.staleThresholdMinutes) : 'never_connected';
  const a = extra.a ?? { visits7d: 0, leads7d: 0 };
  const conv = a.visits7d ? a.leads7d / a.visits7d : null;
  return {
    id: d.id, name: d.name, campaignId: d.campaignId, campaignName: extra.campaignName, subdomain: d.subdomain,
    url: pageUrlFor(d), host: `${d.subdomain}.${config.pagesBaseDomain}`, status: d.status, servingState: d.servingState, vip: d.vip,
    entryFile: d.entryFile, storageSizeBytes: d.storageSizeBytes, deployedAt: d.deployedAt, createdAt: d.createdAt, failureReason: d.failureReason,
    webhook: { state, lastReceivedAt: extra.hook?.lastReceivedAt ?? null, url: webhookUrlFor(d), ...(canManage ? { secret: decrypt(d.webhookSecretEncrypted) } : {}) },
    analytics: { ...a, conversionRate: conv, aboveAverage: conv != null && extra.avgConv != null ? conv > extra.avgConv : null },
    hasRollbackAvailable: hasRollbackAvailable(d.previousStoragePath, d.previousDeployedAt, new Date(), config.rollbackRetentionDays), previousDeployedAt: d.previousDeployedAt,
    earlyWarningActive: earlyWarningActive(d.deployedAt, new Date(), config.earlyWarningHours), earlyWarningTriggered: d.earlyWarningTriggered,
    domain: extra.domain ? { id: extra.domain.id, name: extra.domain.domainName, status: extra.domain.status } : null,
  };
}
export type PageDTO = ReturnType<typeof serialize>;

export async function listPages(ctx: AuthedContext, campaignId?: string) {
  if (campaignId) await loadCampaign(ctx, campaignId);
  const conds = [eq(deployments.tenantId, ctx.tenantId), sql`${deployments.status} <> 'deleted'`];
  if (campaignId) conds.push(eq(deployments.campaignId, campaignId));
  const rows = await ctx.db.select({ d: deployments, cname: campaigns.name, hook: webhookSources }).from(deployments)
    .leftJoin(campaigns, eq(campaigns.id, deployments.campaignId)).leftJoin(webhookSources, eq(webhookSources.deploymentId, deployments.id))
    .where(and(...conds)).orderBy(desc(deployments.createdAt));
  const ids = rows.map((r) => r.d.id);
  const [a, avg, doms] = await Promise.all([
    analytics(ctx.db, ctx.tenantId, ids), workspaceConversion(ctx.db, ctx.tenantId),
    ids.length ? ctx.db.select().from(domains).where(inArray(domains.deploymentId, ids)) : Promise.resolve([]),
  ]);
  const canManage = ctx.role !== 'member';
  return {
    pages: rows.map((r) => serialize(r.d, { campaignName: r.cname, hook: r.hook, a: a.get(r.d.id), avgConv: avg, domain: doms.find((x) => x.deploymentId === r.d.id) }, canManage)),
    avgConversionRate: avg,
  };
}

async function loadPage(ctx: AuthedContext, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw fail.notFound('Page not found.');
  const [d] = await ctx.db.select().from(deployments).where(and(eq(deployments.tenantId, ctx.tenantId), eq(deployments.id, id), sql`${deployments.status} <> 'deleted'`));
  if (!d) throw fail.notFound('Page not found.');
  return d;
}

export async function getPage(ctx: AuthedContext, id: string) {
  const d = await loadPage(ctx, id);
  const [row] = await ctx.db.select({ cname: campaigns.name, hook: webhookSources }).from(deployments)
    .leftJoin(campaigns, eq(campaigns.id, deployments.campaignId)).leftJoin(webhookSources, eq(webhookSources.deploymentId, deployments.id)).where(eq(deployments.id, id));
  const [a, avg, [dom]] = await Promise.all([analytics(ctx.db, ctx.tenantId, [id]), workspaceConversion(ctx.db, ctx.tenantId), ctx.db.select().from(domains).where(eq(domains.deploymentId, id))]);
  const [lc] = await ctx.db.select({
    n: sql<number>`count(*)`, un: sql<number>`count(*) filter (where ${leads.status} = 'not_responded')`,
    avg: sql<number | null>`avg(extract(epoch from (${leads.respondedAt} - ${leads.receivedAt}))) filter (where ${leads.respondedAt} is not null)`,
  }).from(leads).where(and(eq(leads.tenantId, ctx.tenantId), eq(leads.deploymentId, id)));
  return {
    ...serialize(d, { campaignName: row?.cname ?? null, hook: row?.hook ?? null, a: a.get(id), avgConv: avg, domain: dom }, ctx.role !== 'member'),
    leadSummary: { lead_count: Number(lc.n), unacknowledged_lead_count: Number(lc.un), avg_response_time_seconds: lc.avg == null ? null : Math.round(Number(lc.avg)) },
  };
}

export async function pageAnalytics(ctx: AuthedContext, id: string) {
  await loadPage(ctx, id);
  const days: Array<{ date: string; visits: number; leads: number }> = [];
  for (let i = 6; i >= 0; i--) days.push({ date: new Date(Date.now() - i * DAY).toISOString().slice(0, 10), visits: 0, leads: 0 });
  const rows = await ctx.db.select().from(pageVisits).where(and(eq(pageVisits.deploymentId, id), gte(pageVisits.day, days[0].date)));
  for (const r of rows) { const d = days.find((x) => x.date === r.day); if (d) d.visits = r.visits; }
  const lrows = await ctx.db.select({ day: sql<string>`to_char(${leads.receivedAt} at time zone 'UTC', 'YYYY-MM-DD')`, n: sql<number>`count(*)` })
    .from(leads).where(and(eq(leads.deploymentId, id), gte(leads.receivedAt, new Date(days[0].date)))).groupBy(sql`1`);
  for (const r of lrows) { const d = days.find((x) => x.date === r.day); if (d) d.leads = Number(r.n); }
  return { daily: days };
}

// ------------------------------------------------------------------ upload + processing

interface Extracted { files: Array<{ path: string; data: Buffer }>; servingRoot: string; entryFile: string; size: number }

/** Validate + extract a ZIP. Throws 422-style messages from the Build Spec. */
export function extractZip(buf: Buffer, entryFile?: string): Extracted | { needsInput: string[] } {
  let zip: AdmZip;
  try { zip = new AdmZip(buf); } catch { throw fail.unprocessable('Invalid ZIP file. Please check and try again.'); }
  const entries = zip.getEntries().filter((e) => !e.isDirectory && !/(^|\/)(__MACOSX|\.DS_Store)/.test(e.entryName));
  if (!entries.length) throw fail.unprocessable('Invalid ZIP file. Please check and try again.');
  for (const e of entries) if (e.entryName.includes('..') || e.entryName.startsWith('/')) throw fail.unprocessable('Invalid ZIP file. Please check and try again.');
  const htmls = entries.map((e) => e.entryName).filter((n) => /\.html?$/i.test(n));
  let entry = entryFile ?? htmls.filter((n) => /(^|\/)index\.html?$/i.test(n)).sort((a, b) => a.split('/').length - b.split('/').length)[0];
  if (!entry) {
    const shallow = htmls.filter((n) => n.split('/').length === Math.min(...htmls.map((h) => h.split('/').length)));
    if (shallow.length > 1) return { needsInput: shallow };
    if (!shallow.length) throw fail.unprocessable('No index.html found in ZIP. Ensure your build output is included.');
    entry = shallow[0];
  }
  if (!htmls.includes(entry)) throw fail.unprocessable('No index.html found in ZIP. Ensure your build output is included.');
  const servingRoot = entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/') + 1) : '';
  const files = entries.filter((e) => e.entryName.startsWith(servingRoot)).map((e) => ({ path: e.entryName.slice(servingRoot.length), data: e.getData() }));
  return { files, servingRoot, entryFile: entry.slice(servingRoot.length), size: files.reduce((s, f) => s + f.data.length, 0) };
}

async function storeVersion(db: DB, tenantId: string, d: Pick<Deployment, 'id'>, x: Extracted) {
  const prefix = `sites/${tenantId}/${d.id}/${Date.now().toString(36)}/`;
  const st = await storageFor(db);
  for (const f of x.files) await st.put(prefix + f.path, f.data, contentTypeFor(f.path));
  return prefix;
}

async function ensureQuota(ctx: AuthedContext, bytes: number) {
  const [t] = await ctx.db.select().from(tenants).where(eq(tenants.id, ctx.tenantId));
  if (t.storageUsedBytes + bytes > t.storageQuotaBytes) throw fail.tooLarge();
}

export async function uploadPage(ctx: AuthedContext, input: { file: File; name?: string; campaignId?: string | null; slug?: string; entryFile?: string }) {
  assertRole(ctx, 'owner', 'admin');
  if (!/\.zip$/i.test(input.file.name)) throw fail.unprocessable('Only .zip files can be uploaded.');
  if (input.file.size > config.maxZipSizeMb * 1024 * 1024) throw fail.tooLarge(`File exceeds ${config.maxZipSizeMb}MB limit`);
  const [{ n }] = await ctx.db.select({ n: sql<number>`count(*)` }).from(deployments).where(and(eq(deployments.tenantId, ctx.tenantId), sql`${deployments.status} <> 'deleted'`));
  const lim = await planLimits(ctx.plan, ctx.db);
  if (Number(n) >= lim.deployments) {
    const pf = await platform(ctx.db);
    throw fail.planLimit(`Your plan includes ${lim.deployments} deployments. Additional deployments are ${pf.pricing.currency === 'USD' ? '$' : pf.pricing.currency + ' '}${pf.pricing.addOns.extraDeploymentMonthly}/month each.`, 'growth');
  }
  if (input.campaignId) await loadCampaign(ctx, input.campaignId);
  const x = extractZip(Buffer.from(await input.file.arrayBuffer()), input.entryFile);
  if ('needsInput' in x) return { status: 'needs_input' as const, entry_points: x.needsInput };
  await ensureQuota(ctx, x.size);
  const name = input.name?.trim() || input.file.name.replace(/\.zip$/i, '');
  const [d] = await ctx.db.insert(deployments).values({
    tenantId: ctx.tenantId, campaignId: input.campaignId ?? null, name, subdomain: `${slugify(input.slug || name)}-${shortId()}`,
    storagePath: 'pending', entryFile: x.entryFile, servingRoot: x.servingRoot, status: 'processing', webhookSecretEncrypted: encrypt(randomToken(24), 'webhook'),
  }).returning();
  await logWorkspace(ctx.db, ctx.tenantId, ctx.user.id, `Deployment uploaded: ${name}`);
  if (d.campaignId) await logCampaign(ctx.db, ctx.tenantId, d.campaignId, ctx.user.id, `Page ${name} uploaded by ${ctx.user.name}`);
  // D-19: with a queue, the stored ZIP is processed by the `deployment-processing` worker and the client polls
  // /pages/upload/:id/status. Without one (serverless), processing runs before responding.
  if (usesQueues()) {
    await (await storageFor(ctx.db)).put(uploadKey(ctx.tenantId, d.id), Buffer.from(await input.file.arrayBuffer()), 'application/zip');
    await enqueue('deployment-processing', { tenantId: ctx.tenantId, deploymentId: d.id, entryFile: x.entryFile });
    return { uploadId: d.id, id: d.id, status: 'processing' as const };
  }
  const r = await finishDeployment(ctx.db, ctx.tenantId, d, x);
  if (r.status === 'failed') throw fail.unprocessable('Deployment failed. Try again.');
  return { uploadId: d.id, id: d.id, status: 'ready' as const };
}

const uploadKey = (tenantId: string, id: string) => `uploads/${tenantId}/${id}.zip`;

/** Queue consumer `deployment-processing`: extract the stored ZIP, publish the files, mark READY or FAILED. */
export async function processDeployment(db: DB, tenantId: string, deploymentId: string, entryFile?: string) {
  const [d] = await db.select().from(deployments).where(and(eq(deployments.tenantId, tenantId), eq(deployments.id, deploymentId)));
  if (!d || d.status !== 'processing') return { status: d?.status ?? 'missing' };
  const st = await storageFor(db);
  const zip = await st.get(uploadKey(tenantId, deploymentId));
  if (!zip) {
    await db.update(deployments).set({ status: 'failed', failureReason: 'Upload not found' }).where(eq(deployments.id, d.id));
    return { status: 'failed' as const };
  }
  let x: Extracted | { needsInput: string[] };
  try { x = extractZip(zip.data, entryFile); } catch { x = { needsInput: [] }; }
  const r = 'needsInput' in x
    ? (await db.update(deployments).set({ status: 'failed', failureReason: 'Could not determine the entry file' }).where(eq(deployments.id, d.id)), { status: 'failed' as const })
    : await finishDeployment(db, tenantId, d, x);
  await st.removePrefix(uploadKey(tenantId, deploymentId));
  return r;
}

async function finishDeployment(db: DB, tenantId: string, d: Deployment, x: Extracted) {
  try {
    const prefix = await storeVersion(db, tenantId, d, x);
    const deployedAt = new Date();
    await db.update(deployments).set({ storagePath: prefix, status: 'ready', storageSizeBytes: x.size, deployedAt, earlyWarningActive: true, updatedAt: new Date() }).where(eq(deployments.id, d.id));
    await db.update(tenants).set({ storageUsedBytes: sql`${tenants.storageUsedBytes} + ${x.size}` }).where(eq(tenants.id, tenantId));
    await db.insert(webhookSources).values({ tenantId, deploymentId: d.id, campaignId: d.campaignId, label: d.name, sourceSystem: 'webhook' }).onConflictDoNothing();
    await scheduleEarlyWarningClose(tenantId, d.id, deployedAt);
  } catch (e) {
    await db.update(deployments).set({ status: 'failed', failureReason: (e as Error).message }).where(eq(deployments.id, d.id));
    return { status: 'failed' as const };
  }
  if (d.campaignId) await logCampaign(db, tenantId, d.campaignId, null, `Page ${d.name} is live`);
  emit(tenantId, 'workspace:leads', { type: 'deployment_ready', deploymentId: d.id });
  fireOutbound(db, tenantId, 'deployment.ready', { deployment_id: d.id, name: d.name, url: pageUrlFor(d) });
  return { status: 'ready' as const };
}

export async function uploadStatus(ctx: AuthedContext, id: string) {
  const d = await loadPage(ctx, id);
  return { status: d.status, id: d.id, url: pageUrlFor(d), failureReason: d.failureReason };
}

export async function redeploy(ctx: AuthedContext, id: string, file: File) {
  assertRole(ctx, 'owner', 'admin');
  const d = await loadPage(ctx, id);
  const x = extractZip(Buffer.from(await file.arrayBuffer()));
  if ('needsInput' in x) return { status: 'needs_input' as const, entry_points: x.needsInput };
  await ensureQuota(ctx, x.size);
  const prefix = await storeVersion(ctx.db, ctx.tenantId, d, x);
  // Keep exactly one previous version for 30-day rollback; delete the one before it.
  if (d.previousStoragePath) await (await storageFor(ctx.db)).removePrefix(d.previousStoragePath);
  await ctx.db.update(deployments).set({
    previousStoragePath: d.storagePath, previousDeployedAt: d.deployedAt, storagePath: prefix, entryFile: x.entryFile, servingRoot: x.servingRoot,
    storageSizeBytes: x.size, deployedAt: new Date(), earlyWarningActive: true, earlyWarningTriggered: false, updatedAt: new Date(),
  }).where(eq(deployments.id, id));
  await scheduleEarlyWarningClose(ctx.tenantId, id, new Date());
  if (d.campaignId) await logCampaign(ctx.db, ctx.tenantId, d.campaignId, ctx.user.id, `Page ${d.name} redeployed by ${ctx.user.name}`);
  return { status: 'ready' as const, id };
}

export async function rollback(ctx: AuthedContext, id: string) {
  assertRole(ctx, 'owner', 'admin');
  const d = await loadPage(ctx, id);
  if (!hasRollbackAvailable(d.previousStoragePath, d.previousDeployedAt, new Date(), config.rollbackRetentionDays)) throw fail.bad('No previous version is available.');
  await ctx.db.update(deployments).set({
    storagePath: d.previousStoragePath!, previousStoragePath: d.storagePath, deployedAt: d.previousDeployedAt, previousDeployedAt: new Date(), updatedAt: new Date(),
  }).where(eq(deployments.id, id));
  if (d.campaignId) await logCampaign(ctx.db, ctx.tenantId, d.campaignId, ctx.user.id, `Page ${d.name} rolled back by ${ctx.user.name}`);
  return { ok: true };
}

export async function patchPage(ctx: AuthedContext, id: string, patch: { name?: string; campaignId?: string | null; slug?: string; vip?: boolean }) {
  assertRole(ctx, 'owner', 'admin');
  const d = await loadPage(ctx, id);
  const set: Partial<typeof deployments.$inferInsert> = { updatedAt: new Date() };
  if (patch.name) set.name = patch.name.trim();
  if (patch.vip !== undefined) set.vip = patch.vip;
  if (patch.slug) {
    const sub = `${slugify(patch.slug)}-${d.subdomain.split('-').pop()}`;
    const [clash] = await ctx.db.select({ id: deployments.id }).from(deployments).where(eq(deployments.subdomain, sub));
    if (clash && clash.id !== id) throw fail.conflict('That address is already taken.');
    set.subdomain = sub;
  }
  if (patch.campaignId !== undefined) {
    if (patch.campaignId) await loadCampaign(ctx, patch.campaignId);
    set.campaignId = patch.campaignId;
    await ctx.db.update(webhookSources).set({ campaignId: patch.campaignId }).where(eq(webhookSources.deploymentId, id));
  }
  await ctx.db.update(deployments).set(set).where(eq(deployments.id, id));
  return getPage(ctx, id);
}

export async function setServingState(ctx: AuthedContext, id: string, state: 'active' | 'paused' | 'archived') {
  assertRole(ctx, 'owner', 'admin');
  const d = await loadPage(ctx, id);
  await ctx.db.update(deployments).set({ servingState: state, updatedAt: new Date() }).where(eq(deployments.id, id));
  if (d.campaignId) await logCampaign(ctx.db, ctx.tenantId, d.campaignId, ctx.user.id, `Page ${d.name} ${state === 'active' ? 'unpaused' : state} by ${ctx.user.name}`);
  return { ok: true, servingState: state };
}

/** Leads are retained permanently; they are flagged deployment_deleted. */
export async function deletePage(ctx: AuthedContext, id: string) {
  assertRole(ctx, 'owner');
  const d = await loadPage(ctx, id);
  await ctx.db.update(leads).set({ deploymentDeleted: true }).where(and(eq(leads.tenantId, ctx.tenantId), eq(leads.deploymentId, id)));
  await ctx.db.update(deployments).set({ status: 'deleted', updatedAt: new Date() }).where(eq(deployments.id, id));
  const st = await storageFor(ctx.db);
  await st.removePrefix(`sites/${ctx.tenantId}/${id}/`);
  await ctx.db.update(tenants).set({ storageUsedBytes: sql`greatest(0, ${tenants.storageUsedBytes} - ${d.storageSizeBytes})` }).where(eq(tenants.id, ctx.tenantId));
  await logWorkspace(ctx.db, ctx.tenantId, ctx.user.id, `Deployment deleted: ${d.name}`);
  return { ok: true };
}

export async function webhookHealth(ctx: AuthedContext, id: string) {
  await loadPage(ctx, id);
  const [h] = await ctx.db.select().from(webhookSources).where(eq(webhookSources.deploymentId, id));
  return { state: h ? webhookState(h.lastReceivedAt, h.staleThresholdMinutes) : 'never_connected', lastReceivedAt: h?.lastReceivedAt ?? null };
}

/** Self-test: signs a sample payload with the page secret and checks it verifies. Creates no lead. */
export async function testWebhook(ctx: AuthedContext, id: string) {
  const d = await loadPage(ctx, id);
  const started = Date.now();
  const body = JSON.stringify({ test: true, full_name: 'Camplo test' });
  const sig = hmacHex(decrypt(d.webhookSecretEncrypted), body);
  const { verifySignature } = await import('./leads.js');
  const ok = verifySignature(decrypt(d.webhookSecretEncrypted), Buffer.from(body), `sha256=${sig}`);
  return { ok, latencyMs: Date.now() - started, url: webhookUrlFor(d) };
}

// ------------------------------------------------------------------ domains

export async function listDomains(ctx: AuthedContext) {
  const rows = await ctx.db.select({ dom: domains, page: deployments.name, sub: deployments.subdomain }).from(domains).innerJoin(deployments, eq(deployments.id, domains.deploymentId))
    .where(eq(domains.tenantId, ctx.tenantId));
  return rows.map((r) => ({ id: r.dom.id, domainName: r.dom.domainName, status: r.dom.status, deploymentId: r.dom.deploymentId, pageName: r.page, cnameTarget: `${r.sub}.${config.pagesBaseDomain}` }));
}

export async function addDomain(ctx: AuthedContext, deploymentId: string, domainName: string) {
  assertRole(ctx, 'owner', 'admin');
  const d = await loadPage(ctx, deploymentId);
  const name = domainName.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(name)) throw fail.bad('Enter a valid domain like offers.yourbrand.com');
  const [taken] = await ctx.db.select().from(domains).where(eq(domains.domainName, name));
  if (taken && taken.tenantId !== ctx.tenantId) throw fail.conflict('This domain is already connected to another account.');
  if (taken) throw fail.conflict('This domain is already connected.');
  const [row] = await ctx.db.insert(domains).values({ tenantId: ctx.tenantId, deploymentId, domainName: name, verificationToken: randomToken(12) }).returning();
  return { id: row.id, domainName: name, status: row.status, record: { name, type: 'CNAME', value: `${d.subdomain}.${config.pagesBaseDomain}` } };
}

export async function verifyDomain(ctx: AuthedContext, id: string) {
  const [row] = await ctx.db.select({ dom: domains, sub: deployments.subdomain }).from(domains).innerJoin(deployments, eq(deployments.id, domains.deploymentId))
    .where(and(eq(domains.tenantId, ctx.tenantId), eq(domains.id, id)));
  if (!row) throw fail.notFound('Domain not found.');
  const target = `${row.sub}.${config.pagesBaseDomain}`;
  let ok = false;
  try { ok = (await resolveCname(row.dom.domainName)).some((c) => c.replace(/\.$/, '').toLowerCase() === target); } catch { ok = false; }
  if (ok) await ctx.db.update(domains).set({ status: 'verified' }).where(eq(domains.id, id));
  return { verified: ok, message: ok ? 'Verified' : 'Not confirmed yet. Wait a few minutes and try again.' };
}

export async function removeDomain(ctx: AuthedContext, id: string) {
  assertRole(ctx, 'owner', 'admin');
  await ctx.db.delete(domains).where(and(eq(domains.tenantId, ctx.tenantId), eq(domains.id, id)));
  return { ok: true };
}

// ------------------------------------------------------------------ serving

/** Resolve a hosted page by subdomain or verified custom domain. */
export async function resolveSite(db: DB, key: { subdomain?: string; host?: string }) {
  if (key.host) {
    const [r] = await db.select({ d: deployments, t: tenants }).from(domains).innerJoin(deployments, eq(deployments.id, domains.deploymentId)).innerJoin(tenants, eq(tenants.id, deployments.tenantId))
      .where(and(eq(domains.domainName, key.host.toLowerCase()), eq(domains.status, 'verified')));
    if (r) return r;
    const base = `.${config.pagesBaseDomain}`;
    if (!key.host.endsWith(base)) return null;
    key = { subdomain: key.host.slice(0, -base.length) };
  }
  if (!key.subdomain) return null;
  const [r] = await db.select({ d: deployments, t: tenants }).from(deployments).innerJoin(tenants, eq(tenants.id, deployments.tenantId)).where(eq(deployments.subdomain, key.subdomain));
  return r ?? null;
}

export async function serveSiteFile(db: DB, site: { d: Deployment; t: typeof tenants.$inferSelect }, path: string) {
  const { d, t } = site;
  if (d.status !== 'ready' || d.servingState !== 'active') return null;
  if (t.status === 'suspended' && t.suspendedAt && Date.now() - t.suspendedAt.getTime() > 7 * DAY) return null;
  const clean = path.replace(/^\/+/, '').split('?')[0];
  if (clean.includes('..')) return null;
  const st = await storageFor(db);
  const candidates = clean === '' || clean.endsWith('/') ? [`${clean}${d.entryFile}`] : [clean, `${clean}/index.html`, `${clean}.html`];
  for (const c of candidates) {
    const f = await st.get(d.storagePath + c);
    if (f) {
      if (/\.html?$/i.test(c)) await recordVisit(db, d);
      return f;
    }
  }
  return null;
}

async function recordVisit(db: DB, d: Deployment) {
  const day = new Date().toISOString().slice(0, 10);
  await db.insert(pageVisits).values({ tenantId: d.tenantId, deploymentId: d.id, day, visits: 1 })
    .onConflictDoUpdate({ target: [pageVisits.deploymentId, pageVisits.day], set: { visits: sql`${pageVisits.visits} + 1` } });
}

