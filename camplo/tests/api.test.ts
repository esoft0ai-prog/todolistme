/**
 * End-to-end API tests against the real Express app and an in-memory Postgres
 * (PGlite) seeded with the demo workspace.
 */
process.env.NODE_ENV = 'test';
process.env.AUTO_ACTIVATE = 'true';
process.env.APP_URL = 'http://localhost:4173';

import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import AdmZip from 'adm-zip';
import { and, eq } from 'drizzle-orm';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import { getDatabase, type DB } from '../server/db/client.js';
import * as s from '../server/db/schema.js';
import { decrypt, hmacHex } from '../server/lib/crypto.js';
import { DEMO_EMAIL, DEMO_PASSWORD } from '../server/db/seed.js';
import { runJob } from '../server/jobs/scheduler.js';
import { level1 } from '../server/ai/engine.js';
import { enforceContract, makeContract, WorkerPolicyError } from '../server/ai/workers.js';
import { createAckToken } from '../server/services/leads.js';

let app: Express;
let db: DB;
let owner: request.Agent;
let tenantId: string;

const login = async (email: string, password = DEMO_PASSWORD) => {
  const a = request.agent(app);
  const r = await a.post('/api/auth/login').send({ email, password });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return a;
};

const signed = (secret: string, body: object) => {
  const raw = JSON.stringify(body);
  return { raw, sig: `sha256=${hmacHex(secret, raw)}` };
};

beforeAll(async () => {
  db = (await getDatabase()).db;
  app = createApp();
  owner = await login(DEMO_EMAIL);
  const [t] = await db.select().from(s.tenants).where(eq(s.tenants.ownerEmail, DEMO_EMAIL));
  tenantId = t.id;
});

describe('auth', () => {
  it('rejects bad credentials without saying which field', async () => {
    const r = await request(app).post('/api/auth/login').send({ email: DEMO_EMAIL, password: 'nope-nope' });
    expect(r.status).toBe(401);
    expect(r.body.message).toBe('Incorrect email or password.');
  });
  it('requires a session for tenant data', async () => {
    expect((await request(app).get('/api/leads')).status).toBe(401);
  });
  it('refresh rotates the session', async () => {
    const r = await owner.post('/api/auth/refresh');
    expect(r.status).toBe(200);
    expect(r.body.accessToken).toBeTruthy();
  });
});

describe('lead ingestion + ownership paths', () => {
  let deploymentId = '';
  let secret = '';
  let leadId = '';

  beforeAll(async () => {
    const [d] = await db.select().from(s.deployments).where(and(eq(s.deployments.tenantId, tenantId), eq(s.deployments.name, 'bf-bundle-a')));
    deploymentId = d.id; secret = decrypt(d.webhookSecretEncrypted);
  });

  it('rejects unsigned or wrongly signed submissions', async () => {
    const r = await request(app).post(`/api/v1/ingest/${tenantId}/${deploymentId}`).set('content-type', 'application/json').set('x-camplo-signature', 'sha256=bad').send('{"name":"x"}');
    expect(r.status).toBe(401);
  });

  it('accepts an HMAC-signed Tally-style payload and creates an unassigned lead', async () => {
    const { raw, sig } = signed(secret, { data: { fields: [{ label: 'Full name', value: 'Test Lead' }, { label: 'Email', value: 'test.lead@example.com' }] }, utm_source: 'facebook' });
    const r = await request(app).post(`/api/v1/ingest/${tenantId}/${deploymentId}`).set('content-type', 'application/json').set('x-camplo-signature', sig).send(raw);
    expect(r.status).toBe(201);
    leadId = r.body.lead_id;
    const lead = (await owner.get(`/api/leads/${leadId}`)).body;
    expect(lead.name).toBe('Test Lead');
    expect(lead.email).toBe('test.lead@example.com');
    expect(lead.assigneeId).toBeNull();
    expect(lead.utm.source).toBe('facebook');
    expect(lead.canRespond).toBe(true);
  });

  it('Path A: Respond claims and acknowledges in one action; irreversible', async () => {
    const r = await owner.post(`/api/leads/${leadId}/respond`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('responded');
    expect(r.body.assignmentPath).toBe('A');
    expect(r.body.respondedAt).toBeTruthy();
    const again = await owner.post(`/api/leads/${leadId}/respond`);
    expect(again.status).toBe(409);
    const audit = (await owner.get(`/api/leads/${leadId}/audit`)).body;
    expect(audit.events.at(-1).description).toMatch(/claimed and acknowledged/);
  });

  it('Path B then C: owner assigns, then reassigns; members cannot respond to others’ leads', async () => {
    const { raw, sig } = signed(secret, { name: 'Path Lead', email: 'path@example.com' });
    const id = (await request(app).post(`/api/v1/ingest/${tenantId}/${deploymentId}`).set('content-type', 'application/json').set('x-camplo-signature', sig).send(raw)).body.lead_id;
    const members = (await owner.get('/api/team/members')).body as Array<{ id: string; email: string; role: string }>;
    const sarah = members.find((m) => m.email.startsWith('sarah'))!;
    const kofi = members.find((m) => m.email.startsWith('kofi'))!;
    const b = await owner.post(`/api/leads/${id}/assign`).send({ assigneeId: sarah.id });
    expect(b.body.assignmentPath).toBe('B');
    const kofiAgent = await login(kofi.email);
    expect((await kofiAgent.post(`/api/leads/${id}/respond`)).status).toBe(404); // not visible to other members
    const c = await owner.post(`/api/leads/${id}/assign`).send({ assigneeId: kofi.id });
    expect(c.body.assignmentPath).toBe('C');
    expect(c.body.reassignedAt).toBeTruthy();
    const tunde = members.find((m) => m.role === 'admin')!;
    const admin = await login(tunde.email);
    expect((await admin.post(`/api/leads/${id}/assign`).send({ assigneeId: sarah.id })).status).toBe(403); // only owner overrides
    const k = await kofiAgent.post(`/api/leads/${id}/respond`);
    expect(k.status).toBe(200);
    expect(k.body.respondedBy).toBe(kofi.id);
  });

  it('magic-link acknowledgment is single-use', async () => {
    const { raw, sig } = signed(secret, { name: 'Ack Lead' });
    const id = (await request(app).post(`/api/v1/ingest/${tenantId}/${deploymentId}`).set('content-type', 'application/json').set('x-camplo-signature', sig).send(raw)).body.lead_id;
    const [u] = await db.select().from(s.users).where(eq(s.users.email, DEMO_EMAIL));
    const token = new URL((await createAckToken(db, tenantId, id, u.id)).replace('/#/', '/')).searchParams.get('token')!;
    expect((await request(app).get(`/api/leads/acknowledge/preview?token=${token}`)).body.state).toBe('ok');
    expect((await request(app).post('/api/leads/acknowledge').send({ token })).body.state).toBe('done');
    expect((await request(app).post('/api/leads/acknowledge').send({ token })).body.state).toBe('already');
  });
});

describe('notes are permanent', () => {
  it('author can edit within 2h; others cannot; there is no delete', async () => {
    const [c] = await db.select().from(s.campaigns).where(and(eq(s.campaigns.tenantId, tenantId), eq(s.campaigns.name, 'Black Friday 2026')));
    const n = (await owner.post(`/api/campaigns/${c.id}/notes`).send({ content: 'First note' })).body;
    expect(n.editable).toBe(true);
    expect((await owner.patch(`/api/notes/${n.id}`).send({ content: 'Edited note' })).body.editedAt).toBeTruthy();
    const tunde = await login('tunde@northbeam.demo');
    expect((await tunde.patch(`/api/notes/${n.id}`).send({ content: 'hijack' })).status).toBe(403);
    expect((await owner.delete(`/api/notes/${n.id}`)).status).toBe(404);
    await db.update(s.notes).set({ createdAt: new Date(Date.now() - 3 * 3600_000) }).where(eq(s.notes.id, n.id));
    expect((await owner.patch(`/api/notes/${n.id}`).send({ content: 'too late' })).status).toBe(403);
  });
});

describe('campaigns', () => {
  it('enforces the 3-pin limit', async () => {
    const list = (await owner.get('/api/campaigns')).body as Array<{ id: string; pinned: boolean }>;
    const unpinned = list.find((c) => !c.pinned)!;
    const r = await owner.post(`/api/campaigns/${unpinned.id}/pin`);
    expect(r.status).toBe(409);
    expect(r.body.data.reason).toBe('pin_limit_reached');
  });

  it('creates, records budget changes into memory, completes and generates a retrospective', async () => {
    const c = (await owner.post('/api/campaigns').send({ name: 'Test Campaign', budget: 1000, cplThreshold: 50, currency: 'USD' })).body;
    expect(c.status).toBe('active');
    await owner.patch(`/api/campaigns/${c.id}`).send({ dailySpend: 200 });
    const mem = (await owner.get(`/api/campaigns/${c.id}/memory`)).body;
    expect(mem[0].type).toBe('budget');
    expect((await owner.post(`/api/campaigns/${c.id}/complete`)).status).toBe(200);
    await runJob(db, 'retrospective-generation', { tenantId, campaignId: c.id });
    expect((await owner.get(`/api/campaigns/${c.id}/retrospective/status`)).body.generated).toBe(true);
    const retro = (await owner.get(`/api/campaigns/${c.id}/retrospective`)).body;
    expect(retro.aiObservation).toBeTruthy();
    const pdf = await owner.get(`/api/campaigns/${c.id}/retrospective/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
  });

  it('client share view is public and excludes team names', async () => {
    const [c] = await db.select().from(s.campaigns).where(and(eq(s.campaigns.tenantId, tenantId), eq(s.campaigns.name, 'Lekki Property Enquiry — Q3')));
    const { shareUrl } = (await owner.post(`/api/campaigns/${c.id}/share-link`)).body;
    const token = shareUrl.split('/share/')[1];
    const pub = (await request(app).get(`/api/public/campaigns/${token}`)).body;
    expect(pub.campaign_name).toBe(c.name);
    expect(JSON.stringify(pub)).not.toMatch(/Tunde|Sarah|Marcus|Kofi|Amara/);
    await owner.delete(`/api/campaigns/${c.id}/share-link`);
    expect((await request(app).get(`/api/public/campaigns/${token}`)).status).toBe(404);
  });
});

describe('page hosting', () => {
  it('uploads a ZIP, serves it, counts the visit and exposes a signed webhook', async () => {
    const zip = new AdmZip();
    zip.addFile('dist/index.html', Buffer.from('<!doctype html><h1>Hello Camplo</h1>'));
    zip.addFile('dist/app.css', Buffer.from('h1{color:red}'));
    const up = await owner.post('/api/pages/upload').attach('file', zip.toBuffer(), 'hello.zip').field('name', 'hello');
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    const pg = (await owner.get(`/api/pages/${up.body.id}`)).body;
    expect(pg.webhook.url).toContain(`/api/v1/ingest/${tenantId}/`);
    const html = await request(app).get(`/sites/${pg.subdomain}/`);
    expect(html.status).toBe(200);
    expect(html.text).toContain('Hello Camplo');
    expect((await request(app).get(`/sites/${pg.subdomain}/app.css`)).headers['content-type']).toMatch(/text\/css/);
    const a = (await owner.get(`/api/pages/${up.body.id}/analytics`)).body;
    expect(a.daily.at(-1).visits).toBe(1);
    expect((await owner.post(`/api/pages/${up.body.id}/pause`)).status).toBe(200);
    expect((await request(app).get(`/sites/${pg.subdomain}/`)).status).toBe(404);
  });
  it('rejects ZIPs without an index.html', async () => {
    const zip = new AdmZip();
    zip.addFile('readme.txt', Buffer.from('no page'));
    const r = await owner.post('/api/pages/upload').attach('file', zip.toBuffer(), 'bad.zip');
    expect(r.status).toBe(422);
  });
});

describe('team notes', () => {
  it('addressed member reads and acknowledges a time-bound note', async () => {
    const members = (await owner.get('/api/team/members')).body as Array<{ id: string; email: string }>;
    const amara = members.find((m) => m.email.startsWith('amara'))!;
    const n = (await owner.post('/api/team-notes').send({ content: 'Call the VIP back', recipientIds: [amara.id], deadline: new Date(Date.now() + 3600_000).toISOString() })).body;
    expect(n.deadlineStatus).toBe('pending');
    const a = await login(amara.email);
    const mine = (await a.get('/api/team-notes?addressedTo=me')).body;
    expect(mine.find((x: { id: string }) => x.id === n.id).unread).toBe(true);
    await a.post(`/api/team-notes/${n.id}/acknowledge`);
    const after = (await a.get('/api/team-notes?addressedTo=me')).body.find((x: { id: string }) => x.id === n.id);
    expect(after.deadlineStatus).toBe('met');
    expect(after.unread).toBe(false);
  });
});

describe('intelligence', () => {
  it('Level 1 rules create deduplicated alert cards', async () => {
    const [t] = await db.select().from(s.tenants).where(eq(s.tenants.id, tenantId));
    const first = await level1(db, t);
    const second = await level1(db, t);
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
    const feed = (await owner.get('/api/insights')).body;
    expect(feed[0].type).toBe('priority_flag');
  });
  it('chat answers from live data without an AI provider', async () => {
    const r = await owner.post('/api/chat/message').send({ content: 'Which lead is most overdue?' });
    expect(r.status).toBe(200);
    expect(r.body.content).toMatch(/overdue/i);
    const hist = (await owner.get('/api/chat/history')).body.messages;
    expect(hist.at(-1).role).toBe('assistant');
  });
  it('recommendation apply is dormant in v1', async () => {
    const recs = (await owner.get('/api/recommendations')).body;
    expect(recs.length).toBeGreaterThan(0);
    const r = await owner.post(`/api/recommendations/${recs[0].recommendation_id}/apply`);
    expect(r.status).toBe(409);
    expect(recs.some((x: { apply_action: unknown }) => x.apply_action)).toBe(true);
  });
  it('worker isolation is enforced outside the prompt', () => {
    const c = makeContract({ tenantId, capability: 'investigation', objective: 'x' });
    expect(() => enforceContract(c, 1)).not.toThrow();
    expect(() => enforceContract(c, 3)).toThrow(WorkerPolicyError);
    expect(() => enforceContract({ ...c, tools: ['get_team_patterns'] }, 1)).toThrow(WorkerPolicyError);
    expect(() => enforceContract({ ...c, capability: 'execution' }, 1)).toThrow(WorkerPolicyError);
  });
});

describe('tenant isolation', () => {
  it('a second workspace cannot see the first workspace’s data', async () => {
    const r = await request(app).post('/api/auth/signup').send({ name: 'Other Owner', email: 'other@example.com', password: 'password123', workspaceName: 'Other Co', plan: 'growth' });
    expect(r.status).toBe(200);
    const other = await login('other@example.com', 'password123');
    expect((await other.get('/api/campaigns')).body).toEqual([]);
    const [l] = await db.select().from(s.leads).where(eq(s.leads.tenantId, tenantId)).limit(1);
    expect((await other.get(`/api/leads/${l.id}`)).status).toBe(404);
    expect((await other.post(`/api/leads/${l.id}/respond`)).status).toBe(404);
    // Growth plan: retrospective is gated.
    const [c] = await db.select().from(s.campaigns).where(eq(s.campaigns.tenantId, tenantId)).limit(1);
    expect((await other.get(`/api/campaigns/${c.id}/retrospective`)).status).toBe(404);
  });
});
