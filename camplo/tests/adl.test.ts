/**
 * ADL v1.0 delta behaviour: P-4 pagination, D-NEW-9 plan_limit contract, P-2 magic-link login, D-NEW-16 Telegram
 * webhook auth, D-NEW-13 cross-tool SLA, D-NEW-2 campaign status from Health Pulse, per-domain encryption keys.
 */
process.env.NODE_ENV = 'test';
process.env.AUTO_ACTIVATE = 'true';
process.env.APP_URL = 'http://localhost:4173';

import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import { getDatabase, type DB } from '../server/db/client.js';
import * as s from '../server/db/schema.js';
import { decrypt, encrypt } from '../server/lib/crypto.js';
import { outbox } from '../server/lib/mailer.js';
import { paginate } from '../server/lib/paginate.js';
import { DEMO_EMAIL, DEMO_PASSWORD } from '../server/db/seed.js';
import { campaignStatusSweep } from '../server/jobs/scheduler.js';
import { checkCrossToolSla } from '../server/services/crosstool.js';
import { ackCallbackData, webhookSecretFor } from '../server/services/telegram.js';

let app: Express;
let db: DB;
let owner: request.Agent;
let tenantId: string;

beforeAll(async () => {
  db = (await getDatabase()).db;
  app = createApp();
  owner = request.agent(app);
  expect((await owner.post('/api/auth/login').send({ email: DEMO_EMAIL, password: DEMO_PASSWORD })).status).toBe(200);
  const [t] = await db.select().from(s.tenants).where(eq(s.tenants.ownerEmail, DEMO_EMAIL));
  tenantId = t.id;
});

describe('P-4 cursor pagination', () => {
  it('every list endpoint returns { data, next_cursor, has_more }', async () => {
    for (const path of ['/api/campaigns', '/api/leads', '/api/pages', '/api/team/members', '/api/team-notes', '/api/insights',
      '/api/recommendations', '/api/notifications', '/api/sla/overdue', '/api/integrations', '/api/webhooks/inbound', '/api/chat/history']) {
      const r = await owner.get(path);
      expect(r.status, path).toBe(200);
      expect(Array.isArray(r.body.data), path).toBe(true);
      expect(typeof r.body.has_more, path).toBe('boolean');
      expect('next_cursor' in r.body, path).toBe(true);
    }
  });
  it('pages through leads without overlap and caps limit at 100', async () => {
    const p1 = (await owner.get('/api/leads?limit=5')).body;
    expect(p1.data).toHaveLength(5);
    expect(p1.has_more).toBe(true);
    const p2 = (await owner.get(`/api/leads?limit=5&cursor=${encodeURIComponent(p1.next_cursor)}`)).body;
    expect(p2.data).toHaveLength(5);
    const ids = new Set(p1.data.map((l: { id: string }) => l.id));
    expect(p2.data.some((l: { id: string }) => ids.has(l.id))).toBe(false);
    expect((await owner.get('/api/leads?limit=500')).status).toBe(400);
  });
  it('pages envelope carries workspace_avg_conversion_rate (D-NEW-24)', async () => {
    const r = (await owner.get('/api/pages')).body;
    expect('workspace_avg_conversion_rate' in r).toBe(true);
  });
  it('in-memory pages are keyed, not offset, and chat pages from the newest end', () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ id: `i${i}` }));
    const a = paginate(items, { limit: 3 });
    expect(a.data.map((x) => x.id)).toEqual(['i0', 'i1', 'i2']);
    const shifted = [{ id: 'new' }, ...items]; // a row arrives before the next request
    const b = paginate(shifted, { limit: 3, cursor: a.next_cursor! });
    expect(b.data.map((x) => x.id)).toEqual(['i3', 'i4', 'i5']);
    const c = paginate(items, { limit: 3 }, { fromEnd: true });
    expect(c.data.map((x) => x.id)).toEqual(['i4', 'i5', 'i6']);
    expect(paginate(items, { limit: 3, cursor: c.next_cursor! }, { fromEnd: true }).data.map((x) => x.id)).toEqual(['i1', 'i2', 'i3']);
  });
});

describe('D-NEW-9 plan gating contract', () => {
  it('returns 403 { reason: "plan_limit", required_plan } at the top level', async () => {
    const email = `starter-${Date.now()}@example.com`;
    expect((await request(app).post('/api/auth/signup').send({ name: 'Ada', email, password: 'longenough1', workspaceName: 'Starter Co', plan: 'starter' })).status).toBe(200);
    const a = request.agent(app);
    expect((await a.post('/api/auth/login').send({ email, password: 'longenough1' })).status).toBe(200);
    const r = await a.post('/api/chat/message').send({ content: 'hi' });
    expect(r.status).toBe(403);
    expect(r.body.reason).toBe('plan_limit');
    expect(r.body.required_plan).toBe('growth');
    const plan = (await a.get('/api/workspace/plan')).body;
    expect(plan.aiUsage.deepPercent).toBe(0);
  });
});

describe('P-2 magic-link login', () => {
  it('signs in once, then the link is dead', async () => {
    outbox.length = 0;
    expect((await request(app).post('/api/auth/magic-link').send({ email: DEMO_EMAIL })).body.ok).toBe(true);
    const mail = outbox.find((m) => m.subject.includes('sign-in link'));
    const token = mail!.text.match(/verify\?token=([A-Za-z0-9_-]+)/)![1];
    const a = request.agent(app);
    const first = await a.get(`/api/auth/verify?token=${token}`);
    expect(first.status).toBe(200);
    expect(first.body.next).toBe('/dashboard');
    expect((await a.get('/api/auth/me')).status).toBe(200);
    expect((await request(app).get(`/api/auth/verify?token=${token}`)).status).toBe(401);
  });
  it('never reveals whether an email exists', async () => {
    expect((await request(app).post('/api/auth/magic-link').send({ email: 'nobody@nowhere.example' })).body.ok).toBe(true);
  });
});

describe('ADL §4 routes', () => {
  it('serves /deployments as an alias of /pages and the new endpoints', async () => {
    const pages = (await owner.get('/api/pages')).body.data;
    const deps = (await owner.get('/api/deployments')).body.data;
    expect(deps.map((d: { id: string }) => d.id)).toEqual(pages.map((p: { id: string }) => p.id));
    const [c] = (await owner.get('/api/campaigns')).body.data;
    const sum = (await owner.get(`/api/campaigns/${c.id}/lifecycle/summary`)).body;
    expect(sum.total_leads).toBeGreaterThan(0);
    const settings = (await owner.get('/api/settings')).body;
    expect(settings.sla.sla_threshold_minutes).toBeGreaterThan(0);
    const [rec] = (await owner.get('/api/recommendations')).body.data;
    expect((await owner.get(`/api/recommendations/${rec.recommendation_id}`)).body.apply_action).toBeTruthy();
  });
  it('GET /api/acknowledge/:token opens the acknowledge screen without consuming the token', async () => {
    const r = await request(app).get('/api/acknowledge/abcdefghijklmnop');
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/#/acknowledge?token=abcdefghijklmnop');
  });
});

describe('D-26 Caddy on-demand TLS', () => {
  it('approves live page subdomains and verified custom domains only', async () => {
    const [d] = await db.select().from(s.deployments).where(and(eq(s.deployments.tenantId, tenantId), eq(s.deployments.status, 'ready'))).limit(1);
    expect((await request(app).get(`/api/caddy/ask?domain=${d.subdomain}.camplo.app`)).status).toBe(200);
    expect((await request(app).get('/api/caddy/ask?domain=nope.camplo.app')).status).toBe(404);
    expect((await request(app).get('/api/caddy/ask?domain=attacker.example')).status).toBe(404);
    await db.insert(s.domains).values({ tenantId, deploymentId: d.id, domainName: 'offers.example.org', verificationToken: 't', status: 'verified' });
    expect((await request(app).get('/api/caddy/ask?domain=offers.example.org')).status).toBe(200);
  });
});

describe('D-NEW-16 Telegram webhook', () => {
  it('rejects updates without the secret_token header and fits callback data in 64 bytes', async () => {
    expect((await request(app).post('/api/telegram/webhook').send({})).status).toBe(401);
    expect((await request(app).post(`/api/telegram/${tenantId}`).set('x-telegram-bot-api-secret-token', 'wrong').send({})).status).toBe(401);
    expect((await request(app).post(`/api/telegram/${tenantId}`).set('x-telegram-bot-api-secret-token', webhookSecretFor(tenantId)).send({})).status).toBe(200);
    const data = ackCallbackData('4a3f1e2d-1111-4222-8333-944455556666', '5b3f1e2d-1111-4222-8333-944455556666', tenantId);
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
  });
});

describe('D-NEW-13 cross-tool SLA', () => {
  it('breaches an acknowledged lead with no CRM progress, then resolves when the event arrives', async () => {
    const [twenty] = await db.select().from(s.integrations).where(and(eq(s.integrations.tenantId, tenantId), eq(s.integrations.provider, 'twenty_crm')));
    await db.update(s.integrations).set({ createdAt: new Date(Date.now() - 90 * 86_400_000) }).where(eq(s.integrations.id, twenty.id));
    const [camp] = await db.select().from(s.campaigns).where(eq(s.campaigns.tenantId, tenantId)).limit(1);
    const [u] = await db.select().from(s.users).where(eq(s.users.email, DEMO_EMAIL));
    const received = new Date(Date.now() - 3 * 86_400_000);
    const [l] = await db.insert(s.leads).values({
      tenantId, campaignId: camp.id, fullName: 'Cross Tool Test', sourceSystem: 'tally', receivedAt: received,
      status: 'responded', respondedAt: new Date(received.getTime() + 60_000), respondedBy: u.id, assigneeId: u.id, assignmentPath: 'A', claimedAt: received,
    }).returning();
    await checkCrossToolSla(db, tenantId);
    const [b] = await db.select().from(s.crossToolSlaBreaches).where(eq(s.crossToolSlaBreaches.leadId, l.id));
    expect(b.breachType).toBe('not_contacted');
    expect(b.resolved).toBe(false);
    await db.insert(s.leadLifecycleEvents).values({ tenantId, leadId: l.id, event: 'Moved to Contacted', source: 'twenty_crm', eventTimestamp: new Date() });
    await checkCrossToolSla(db, tenantId);
    const [after] = await db.select().from(s.crossToolSlaBreaches).where(eq(s.crossToolSlaBreaches.id, b.id));
    expect(after.resolved).toBe(true);
  });
});

describe('D-NEW-1/2 campaign status follows the Health Pulse', () => {
  it('syncs running campaigns to active | watch | critical and leaves paused/complete alone', async () => {
    await campaignStatusSweep(db, tenantId);
    const rows = await db.select().from(s.campaigns).where(eq(s.campaigns.tenantId, tenantId));
    expect(rows.some((c) => c.status === 'critical')).toBe(true); // Black Friday: webhook offline + slow acks
    expect(rows.find((c) => c.name === 'Summer Launch 2026')!.status).toBe('complete');
    const running = rows.find((c) => c.status !== 'complete')!;
    expect((await owner.patch(`/api/campaigns/${running.id}`).send({ status: 'paused' })).body.status).toBe('paused');
    await campaignStatusSweep(db, tenantId);
    expect((await db.select().from(s.campaigns).where(eq(s.campaigns.id, running.id)))[0].status).toBe('paused');
  });
});

describe('ADL §5 per-domain encryption keys', () => {
  it('tags ciphertext with its key family and still reads legacy values', () => {
    const v = encrypt('sk-test', 'ai');
    expect(v.startsWith('ai.')).toBe(true);
    expect(decrypt(v)).toBe('sk-test');
    expect(decrypt(encrypt('x', 'webhook'))).toBe('x');
    const legacy = encrypt('old').replace(/^general\./, '');
    expect(decrypt(legacy)).toBe('old');
  });
});
