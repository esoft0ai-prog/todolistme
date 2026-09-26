/**
 * Background jobs. With REDIS_URL (Dragonfly/Redis) jobs go through BullMQ and
 * are processed by `server/worker.ts`. Without it (serverless demo, tests)
 * jobs run inline and the periodic sweeps are driven by `maybeSweep()` —
 * called on API traffic at most once a minute — and by the /api/cron endpoint.
 *
 * Queues (PRD §8): deployment-processing · sla-timers · daily-summaries ·
 * ai-intelligence · telegram-notifications · early-warning ·
 * retrospective-generation · campaign-memory-measurement · cross-tool-sla-check ·
 * rollback-cleanup. Sweeps implement the time-based ones idempotently.
 */
import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { deployments, leads, tenants, webhookSources } from '../db/schema.js';
import { config } from '../lib/config.js';
import { emails, sendMail } from '../lib/mailer.js';
import { storageFor } from '../lib/storage.js';
import { DAY, formatDuration, webhookState } from '../domain/rules.js';
import { emit } from '../rt/hub.js';

export type JobName = 'retrospective-generation' | 'ai-intelligence' | 'sla-timers' | 'campaign-memory-measurement';

let queue: { add(name: string, data: unknown): Promise<unknown>; getJobCounts(): Promise<Record<string, number>> } | null = null;
async function bull() {
  if (!config.redisUrl) return null;
  if (!queue) {
    const { Queue } = await import('bullmq');
    const { Redis } = await import('ioredis');
    queue = new Queue('camplo', { connection: new Redis(config.redisUrl, { maxRetriesPerRequest: null }) }) as never;
  }
  return queue;
}

let dbRef: DB | null = null;
export function bindDatabase(db: DB) { dbRef = db; }

export async function enqueue(name: JobName, data: Record<string, unknown>) {
  const q = await bull();
  if (q) { await q.add(name, data); return; }
  const db = dbRef;
  if (!db) return;
  // Inline: run after the current request finishes.
  setImmediate(() => { void runJob(db, name, data).catch((e) => console.error(`[job] ${name} failed`, e)); });
}

export async function runJob(db: DB, name: JobName, data: Record<string, unknown>) {
  switch (name) {
    case 'retrospective-generation': {
      const { generateRetrospective } = await import('../services/campaigns.js');
      return generateRetrospective(db, String(data.tenantId), String(data.campaignId));
    }
    case 'ai-intelligence': {
      const { refreshWorkspace } = await import('../ai/engine.js');
      return refreshWorkspace(db, String(data.tenantId), { force: true, reason: String(data.reason ?? 'event') });
    }
    case 'campaign-memory-measurement': {
      const { measureMemory } = await import('../ai/engine.js');
      return measureMemory(db, data.tenantId ? String(data.tenantId) : undefined);
    }
    case 'sla-timers':
      return slaSweep(db);
  }
}

export async function queueDepth(): Promise<number> {
  const q = await bull();
  if (!q) return 0;
  const c = await q.getJobCounts();
  return (c.waiting ?? 0) + (c.delayed ?? 0) + (c.active ?? 0);
}

// ------------------------------------------------------------------ sweeps

/** SLA breach alerts — idempotent via leads.sla_alert_sent_at. */
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

/** Webhook stale/offline detection (every 30 min in production; cheap to run more often). */
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

const digestSent = new Set<string>();
/** Daily summary email at the workspace's daily_summary_time (UTC). Only if something is unacknowledged. */
async function digestSweep(db: DB) {
  const now = new Date();
  const hhmm = now.toISOString().slice(11, 16);
  const day = now.toISOString().slice(0, 10);
  const due = await db.select().from(tenants).where(and(eq(tenants.status, 'active'), eq(tenants.dailySummaryEnabled, true)));
  for (const t of due) {
    const key = `${t.id}:${day}`;
    if (digestSent.has(key) || t.dailySummaryTime.slice(0, 5) > hhmm) continue;
    digestSent.add(key);
    const open = await db.select({ name: leads.fullName, at: leads.receivedAt, dep: deployments.name }).from(leads).leftJoin(deployments, eq(deployments.id, leads.deploymentId))
      .where(and(eq(leads.tenantId, t.id), eq(leads.status, 'not_responded'))).orderBy(leads.receivedAt).limit(50);
    if (!open.length) continue;
    const [avg] = await db.select({ ms: sql<number | null>`avg(extract(epoch from (${leads.respondedAt} - ${leads.receivedAt}))*1000)` }).from(leads)
      .where(and(eq(leads.tenantId, t.id), sql`${leads.respondedAt} >= now() - interval '1 day'`));
    await sendMail(emails.dailySummary(t.notificationEmail, open.map((l) => `• ${l.name} — ${l.dep ?? 'webhook'} — waiting ${formatDuration(Date.now() - l.at.getTime())}`), formatDuration(avg.ms == null ? null : Number(avg.ms))));
  }
}

/** Remove prior deployment versions older than 30 days. */
async function rollbackCleanup(db: DB) {
  const old = await db.select().from(deployments).where(and(isNotNull(deployments.previousStoragePath), lt(deployments.previousDeployedAt, new Date(Date.now() - 30 * DAY))));
  const st = await storageFor(db);
  for (const d of old) {
    await st.removePrefix(d.previousStoragePath!);
    await db.update(deployments).set({ previousStoragePath: null, previousDeployedAt: null }).where(eq(deployments.id, d.id));
  }
}

/** Pages stay live 7 days after suspension, then stop being served. */
async function suspensionSweep(db: DB) {
  const expired = await db.select({ id: tenants.id }).from(tenants).where(and(eq(tenants.status, 'suspended'), lt(tenants.suspendedAt, new Date(Date.now() - 7 * DAY))));
  for (const t of expired) await db.update(deployments).set({ status: 'deleted' }).where(and(eq(deployments.tenantId, t.id), eq(deployments.status, 'ready')));
}

async function aiSweep(db: DB) {
  const { refreshWorkspace, measureMemory } = await import('../ai/engine.js');
  const active = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, 'active'));
  for (const t of active) await refreshWorkspace(db, t.id); // respects each workspace's refresh interval
  await measureMemory(db);
}

let running = false;
export async function runSweeps(db: DB) {
  if (running) return;
  running = true;
  try {
    await slaSweep(db);
    await webhookSweep(db);
    const { expireTeamNotes } = await import('../services/notes.js');
    await expireTeamNotes(db);
    await digestSweep(db);
    await rollbackCleanup(db);
    await suspensionSweep(db);
    await aiSweep(db);
  } catch (e) {
    console.error('[sweep] failed', e);
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

