/**
 * Background jobs (ADL §6). With DRAGONFLY_URL / REDIS_URL every job goes through its own named BullMQ queue and
 * is processed by `server/worker.ts`; delayed jobs (SLA timers, 72h early-warning close, 7-day suspension grace)
 * are real BullMQ delayed jobs and can be cancelled by id (leads.sla_job_id).
 *
 * Without Redis (serverless demo, tests) jobs run inline after the request, delayed jobs are skipped, and the
 * idempotent sweeps below — driven by `maybeSweep()` on API traffic (at most once a minute) and by /api/cron —
 * cover every time-based rule, so behaviour is the same, only coarser in timing.
 */
import { and, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { campaigns, deployments, leads, tenants, webhookSources } from '../db/schema.js';
import { config } from '../lib/config.js';
import { emails, sendMail } from '../lib/mailer.js';
import { storageFor } from '../lib/storage.js';
import { DAY, formatDuration, HOUR, webhookState } from '../domain/rules.js';
import { emit } from '../rt/hub.js';

export const QUEUES = [
  'deployment-processing', 'sla-timers', 'daily-summaries', 'ai-intelligence', 'telegram-notifications', 'early-warning',
  'retrospective-generation', 'campaign-memory-measurement', 'cross-tool-sla-check', 'rollback-cleanup', 'suspension-grace',
] as const;
export type JobName = (typeof QUEUES)[number];

/** Per-queue time limits (ADL §6): Level 4 intelligence 30s, retrospectives 5 minutes. */
const TIMEOUT_MS: Partial<Record<JobName, number>> = {
  'ai-intelligence': 30_000, 'retrospective-generation': 5 * 60_000, 'deployment-processing': 5 * 60_000,
};

interface BullQueue {
  add(name: string, data: unknown, opts?: { delay?: number; jobId?: string; removeOnComplete?: boolean | number; removeOnFail?: number }): Promise<{ id?: string }>;
  remove(jobId: string): Promise<number>;
  getJobCounts(): Promise<Record<string, number>>;
}
const queues = new Map<JobName, BullQueue>();
let redis: unknown = null;
async function queueFor(name: JobName): Promise<BullQueue | null> {
  if (!config.redisUrl) return null;
  const hit = queues.get(name);
  if (hit) return hit;
  const { Queue } = await import('bullmq');
  if (!redis) { const { Redis } = await import('ioredis'); redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null }); }
  const q = new Queue(name, { connection: redis as never }) as unknown as BullQueue;
  queues.set(name, q);
  return q;
}

let dbRef: DB | null = null;
export function bindDatabase(db: DB) { dbRef = db; }
export const usesQueues = () => !!config.redisUrl;

/**
 * Enqueue a job. Returns the BullMQ job id (queued mode) or null (inline mode). Delayed jobs are only scheduled in
 * queued mode — inline mode relies on the sweeps for anything time-based.
 */
export async function enqueue(name: JobName, data: Record<string, unknown>, opts: { delayMs?: number; jobId?: string } = {}): Promise<string | null> {
  const q = await queueFor(name);
  if (q) {
    const job = await q.add(name, data, { delay: opts.delayMs, jobId: opts.jobId, removeOnComplete: 1000, removeOnFail: 1000 });
    return job.id ?? opts.jobId ?? null;
  }
  if (opts.delayMs) return null;
  const db = dbRef;
  if (!db) return null;
  setImmediate(() => { void runJob(db, name, data).catch((e) => console.error(`[job] ${name} failed`, e)); });
  return null;
}

/** Cancel a delayed job (e.g. the SLA timer once a lead is responded). No-op in inline mode. */
export async function cancelJob(name: JobName, jobId: string | null | undefined) {
  if (!jobId) return;
  const q = await queueFor(name);
  if (q) await q.remove(jobId).catch(() => 0);
}

function withTimeout<T>(p: Promise<T>, ms: number | undefined, name: string): Promise<T> {
  if (!ms) return p;
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<T>((_, rej) => { timer = setTimeout(() => rej(new Error(`${name} timed out after ${ms}ms`)), ms); });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

export async function runJob(db: DB, name: JobName, data: Record<string, unknown>): Promise<unknown> {
  return withTimeout(dispatch(db, name, data), TIMEOUT_MS[name], name);
}

async function dispatch(db: DB, name: JobName, data: Record<string, unknown>): Promise<unknown> {
  const tenantId = data.tenantId ? String(data.tenantId) : undefined;
  switch (name) {
    case 'deployment-processing': {
      const { processDeployment } = await import('../services/pages.js');
      return processDeployment(db, String(tenantId), String(data.deploymentId), data.entryFile ? String(data.entryFile) : undefined);
    }
    case 'sla-timers':
      return data.leadId ? slaTimerFired(db, String(data.leadId)) : slaSweep(db);
    case 'daily-summaries':
      return tenantId ? sendDigest(db, tenantId) : digestSweep(db);
    case 'ai-intelligence': {
      const { refreshWorkspace } = await import('../ai/engine.js');
      return refreshWorkspace(db, String(tenantId), { force: true, reason: String(data.reason ?? 'event') });
    }
    case 'telegram-notifications': {
      const { notifyNewLead } = await import('../services/telegram.js');
      return notifyNewLead(db, String(tenantId), String(data.leadId));
    }
    case 'early-warning':
      return earlyWarningSweep(db, data.deploymentId ? String(data.deploymentId) : undefined);
    case 'retrospective-generation': {
      const { generateRetrospective } = await import('../services/campaigns.js');
      return generateRetrospective(db, String(tenantId), String(data.campaignId));
    }
    case 'campaign-memory-measurement': {
      const { measureMemory } = await import('../ai/engine.js');
      return measureMemory(db, tenantId);
    }
    case 'cross-tool-sla-check': {
      const { checkCrossToolSla } = await import('../services/crosstool.js');
      return checkCrossToolSla(db, tenantId);
    }
    case 'rollback-cleanup':
      return rollbackCleanup(db);
    case 'suspension-grace':
      return suspensionSweep(db, tenantId);
  }
}

export async function queueDepth(): Promise<number> {
  let n = 0;
  for (const name of QUEUES) {
    const q = await queueFor(name);
    if (!q) return 0;
    const c = await q.getJobCounts();
    n += (c.waiting ?? 0) + (c.delayed ?? 0) + (c.active ?? 0);
  }
  return n;
}

// ------------------------------------------------------------------ SLA timers (D-13)

function thresholdMinutes(t: typeof tenants.$inferSelect, vip: boolean) {
  return vip && t.vipLeadEnabled ? t.vipSlaThresholdMinutes : t.slaThresholdMinutes;
}

/** Called at ingestion: a delayed job at received_at + threshold. The job id is stored for cancellation on respond. */
export async function scheduleSlaTimer(db: DB, t: typeof tenants.$inferSelect, l: typeof leads.$inferSelect) {
  const due = l.receivedAt.getTime() + thresholdMinutes(t, l.vip) * 60_000;
  const jobId = await enqueue('sla-timers', { tenantId: t.id, leadId: l.id }, { delayMs: Math.max(1, due - Date.now()), jobId: `sla-${l.id}` });
  if (jobId) await db.update(leads).set({ slaJobId: jobId }).where(eq(leads.id, l.id));
}

/** The delayed SLA job fired: alert only if the lead is still NOT_RESPONDED and hasn't been alerted. */
async function slaTimerFired(db: DB, leadId: string) {
  const [l] = await db.select().from(leads).where(and(eq(leads.id, leadId), eq(leads.status, 'not_responded'), isNull(leads.slaAlertSentAt)));
  if (!l) return { alerted: false };
  const [t] = await db.select().from(tenants).where(and(eq(tenants.id, l.tenantId), eq(tenants.status, 'active')));
  if (!t?.urgentAlertsEnabled) return { alerted: false };
  const { sendSlaAlert } = await import('../services/sla.js');
  await sendSlaAlert(db, t, l);
  await enqueue('ai-intelligence', { tenantId: t.id, reason: 'sla_breach' });
  return { alerted: true };
}

/** Safety net for the delayed jobs (and the only mechanism in inline mode) — idempotent via sla_alert_sent_at. */
async function slaSweep(db: DB) {
  const { sendSlaAlert } = await import('../services/sla.js');
  const active = await db.select().from(tenants).where(eq(tenants.status, 'active'));
  for (const t of active) {
    if (!t.urgentAlertsEnabled) continue;
    const vip = t.vipLeadEnabled ? t.vipSlaThresholdMinutes : t.slaThresholdMinutes;
    const due = await db.select().from(leads).where(and(eq(leads.tenantId, t.id), eq(leads.status, 'not_responded'), isNull(leads.slaAlertSentAt),
      sql`${leads.receivedAt} < now() - (case when ${leads.vip} then ${vip}::int else ${t.slaThresholdMinutes}::int end) * interval '1 minute'`)).limit(50);
    for (const l of due) await sendSlaAlert(db, t, l);
    if (due.length) await enqueue('ai-intelligence', { tenantId: t.id, reason: 'sla_breach' });
  }
}

// ------------------------------------------------------------------ webhook health (P-7 stale detection)

async function webhookSweep(db: DB) {
  const rows = await db.select().from(webhookSources).where(isNotNull(webhookSources.lastReceivedAt));
  for (const h of rows) {
    const s = webhookState(h.lastReceivedAt, h.staleThresholdMinutes);
    if (s !== 'never_connected' && s !== h.status) {
      await db.update(webhookSources).set({ status: s }).where(eq(webhookSources.id, h.id));
      emit(h.tenantId, `page:${h.deploymentId}:webhook`, { status: s });
      if (s === 'offline') await enqueue('ai-intelligence', { tenantId: h.tenantId, reason: 'webhook_silence' });
    }
  }
}

// ------------------------------------------------------------------ daily summaries

const digestSent = new Set<string>();
/** Cron producer: one `daily-summaries` job per workspace whose summary time has passed today (UTC). */
async function digestSweep(db: DB) {
  const now = new Date();
  const hhmm = now.toISOString().slice(11, 16);
  const day = now.toISOString().slice(0, 10);
  const due = await db.select().from(tenants).where(and(eq(tenants.status, 'active'), eq(tenants.dailySummaryEnabled, true)));
  for (const t of due) {
    const key = `${t.id}:${day}`;
    if (digestSent.has(key) || t.dailySummaryTime.slice(0, 5) > hhmm) continue;
    digestSent.add(key);
    if (usesQueues()) await enqueue('daily-summaries', { tenantId: t.id }, { jobId: `digest-${key}` });
    else await sendDigest(db, t.id);
  }
}

/** Email the unacknowledged-lead summary (only when something is unacknowledged). */
async function sendDigest(db: DB, tenantId: string) {
  const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
  if (!t) return;
  const open = await db.select({ name: leads.fullName, at: leads.receivedAt, dep: deployments.name }).from(leads).leftJoin(deployments, eq(deployments.id, leads.deploymentId))
    .where(and(eq(leads.tenantId, t.id), eq(leads.status, 'not_responded'))).orderBy(leads.receivedAt).limit(50);
  if (!open.length) return;
  const [avg] = await db.select({ ms: sql<number | null>`avg(extract(epoch from (${leads.respondedAt} - ${leads.receivedAt}))*1000)` }).from(leads)
    .where(and(eq(leads.tenantId, t.id), sql`${leads.respondedAt} >= now() - interval '1 day'`));
  await sendMail(emails.dailySummary(t.notificationEmail, open.map((l) => `• ${l.name} — ${l.dep ?? 'webhook'} — waiting ${formatDuration(Date.now() - l.at.getTime())}`), formatDuration(avg.ms == null ? null : Number(avg.ms))));
}

// ------------------------------------------------------------------ 72h early warning (D-NEW-18)

/** Closes monitoring windows that have run their course. The hourly conversion check runs in the Level 1 engine. */
async function earlyWarningSweep(db: DB, deploymentId?: string) {
  const cutoff = new Date(Date.now() - config.earlyWarningHours * HOUR);
  const where = and(eq(deployments.earlyWarningActive, true), lt(deployments.deployedAt, cutoff), deploymentId ? eq(deployments.id, deploymentId) : undefined);
  const closed = await db.update(deployments).set({ earlyWarningActive: false, updatedAt: new Date() }).where(where).returning({ id: deployments.id, tenantId: deployments.tenantId });
  for (const d of closed) emit(d.tenantId, `page:${d.id}:webhook`, { earlyWarningActive: false });
  return { closed: closed.length };
}

/** After a deployment goes READY: close its window at deployed_at + 72h. */
export async function scheduleEarlyWarningClose(tenantId: string, deploymentId: string, deployedAt: Date) {
  const delay = deployedAt.getTime() + config.earlyWarningHours * HOUR - Date.now();
  await enqueue('early-warning', { tenantId, deploymentId }, { delayMs: Math.max(1, delay), jobId: `ew-${deploymentId}-${deployedAt.getTime()}` });
}

// ------------------------------------------------------------------ rollback cleanup + suspension grace

async function rollbackCleanup(db: DB) {
  const old = await db.select().from(deployments).where(and(isNotNull(deployments.previousStoragePath), lt(deployments.previousDeployedAt, new Date(Date.now() - config.rollbackRetentionDays * DAY))));
  const st = await storageFor(db);
  for (const d of old) {
    await st.removePrefix(d.previousStoragePath!);
    await db.update(deployments).set({ previousStoragePath: null, previousDeployedAt: null }).where(eq(deployments.id, d.id));
  }
  return { cleaned: old.length };
}

/** failure_reason marker for pages taken offline by suspension (restored on reactivation). */
export const SUSPENDED_OFFLINE = 'suspended';

/** P-3: pages stay live 7 days after suspension, then stop being served (files are retained). */
async function suspensionSweep(db: DB, tenantId?: string) {
  const expired = await db.select({ id: tenants.id }).from(tenants)
    .where(and(eq(tenants.status, 'suspended'), lt(tenants.suspendedAt, new Date(Date.now() - 7 * DAY)), tenantId ? eq(tenants.id, tenantId) : undefined));
  if (!expired.length) return { offline: 0 };
  await db.update(deployments).set({ status: 'deleted', failureReason: SUSPENDED_OFFLINE }).where(and(inArray(deployments.tenantId, expired.map((t) => t.id)), eq(deployments.status, 'ready')));
  return { offline: expired.length };
}

/** Called when a tenant is suspended: the delayed job at suspended_at + 7 days (the sweep is the safety net). */
export async function scheduleSuspensionGrace(tenantId: string) {
  await enqueue('suspension-grace', { tenantId }, { delayMs: 7 * DAY + 60_000, jobId: `suspend-${tenantId}-${Date.now()}` });
}

// ------------------------------------------------------------------ campaign status ← Health Pulse (D-NEW-1/2)

/** Keep campaigns.status in step with the rule-based Health Pulse for running campaigns; push RT on change. */
export async function campaignStatusSweep(db: DB, tenantId?: string) {
  const { campaignStats, health } = await import('../services/metrics.js');
  const where = and(inArray(campaigns.status, ['active', 'watch', 'critical']), tenantId ? eq(campaigns.tenantId, tenantId) : undefined);
  const rows = await db.select({ c: campaigns }).from(campaigns).innerJoin(tenants, eq(tenants.id, campaigns.tenantId)).where(and(where, eq(tenants.status, 'active')));
  const byTenant = new Map<string, Array<typeof campaigns.$inferSelect>>();
  for (const { c } of rows) byTenant.set(c.tenantId, [...(byTenant.get(c.tenantId) ?? []), c]);
  let changed = 0;
  for (const [tid, list] of byTenant) {
    const stats = await campaignStats(db, tid, list.map((c) => c.id));
    for (const c of list) {
      const h = health(stats.get(c.id)!);
      const status = h.status === 'healthy' ? 'active' : h.status;
      if (status === c.status) continue;
      changed++;
      await db.update(campaigns).set({ status, updatedAt: new Date() }).where(eq(campaigns.id, c.id));
      emit(tid, `campaign:${c.id}:health`, { status, pulse: h.status, signals: h.signals });
      if (status === 'critical') await enqueue('ai-intelligence', { tenantId: tid, reason: 'health_pulse_change' });
    }
  }
  return { changed };
}

// ------------------------------------------------------------------ cron driver

async function aiSweep(db: DB) {
  const { refreshWorkspace, measureMemory } = await import('../ai/engine.js');
  const active = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, 'active'));
  for (const t of active) await refreshWorkspace(db, t.id); // respects each workspace's refresh interval
  await measureMemory(db);
}

let lastCrossTool = 0;
let running = false;
export async function runSweeps(db: DB) {
  if (running) return;
  running = true;
  const step = async (label: string, fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { console.error(`[sweep] ${label} failed`, e); } };
  try {
    await step('sla', () => slaSweep(db));
    await step('webhooks', () => webhookSweep(db));
    await step('team-notes', async () => { const { expireTeamNotes } = await import('../services/notes.js'); await expireTeamNotes(db); });
    await step('digest', () => digestSweep(db));
    await step('early-warning', () => earlyWarningSweep(db));
    await step('rollback', () => rollbackCleanup(db));
    await step('suspension', () => suspensionSweep(db));
    await step('campaign-status', () => campaignStatusSweep(db));
    if (Date.now() - lastCrossTool >= 30 * 60_000) { // cross-tool-sla-check: every 30 minutes
      lastCrossTool = Date.now();
      await step('cross-tool', async () => { const { checkCrossToolSla } = await import('../services/crosstool.js'); await checkCrossToolSla(db); });
    }
    await step('ai', () => aiSweep(db));
  } finally {
    running = false;
  }
}

let lastSweep = 0;
/** Piggy-back scheduler for environments without a worker process. */
export function maybeSweep(db: DB) {
  if (config.redisUrl || config.env === 'test') return;
  if (Date.now() - lastSweep < 60_000) return;
  lastSweep = Date.now();
  void runSweeps(db);
}
