/**
 * Team controls: owner-only lead assignment, per-teammate permissions, profile pictures, plan changes
 * and removing a teammate.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.AUTO_ACTIVATE = 'true';
  process.env.APP_URL = 'http://localhost:4173';
});

import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import { getDatabase, type DB } from '../server/db/client.js';
import * as s from '../server/db/schema.js';
import { DEMO_EMAIL, DEMO_PASSWORD } from '../server/db/seed.js';

let app: Express;
let db: DB;
let owner: request.Agent;
let tenantId: string;

const login = async (email: string) => {
  const a = request.agent(app);
  expect((await a.post('/api/auth/login').send({ email, password: DEMO_PASSWORD })).status).toBe(200);
  return a;
};
const memberByRole = async (role: 'admin' | 'member') => {
  const [u] = await db.select().from(s.users).where(and(eq(s.users.tenantId, tenantId), eq(s.users.role, role)));
  return u;
};

beforeAll(async () => {
  db = (await getDatabase()).db;
  app = createApp();
  owner = await login(DEMO_EMAIL);
  const [t] = await db.select().from(s.tenants).where(eq(s.tenants.ownerEmail, DEMO_EMAIL));
  tenantId = t.id;
});

describe('lead assignment is owner-only', () => {
  it('refuses admins and members, allows the owner', async () => {
    const admin = await memberByRole('admin');
    const [lead] = await db.select().from(s.leads).where(and(eq(s.leads.tenantId, tenantId), eq(s.leads.status, 'not_responded')));
    const a = await login(admin.email);
    const r = await a.post(`/api/leads/${lead.id}/assign`).send({ assigneeId: admin.id });
    expect(r.status).toBe(403);
    expect(r.body.reason).toBe('owner_only');
    expect((await owner.post(`/api/leads/${lead.id}/assign`).send({ assigneeId: admin.id })).status).toBe(200);
  });
});

describe('per-teammate permissions', () => {
  it('admins start with role defaults; the owner can switch individual permissions', async () => {
    const admin = await memberByRole('admin');
    const a = await login(admin.email);
    const me = (await a.get('/api/auth/me')).body.user;
    expect(me.permissions['campaigns.manage']).toBe(true);
    expect(me.permissions['ai.manage']).toBe(false);
    expect((await a.get('/api/settings/ai-provider')).status).toBe(403);

    // Owner revokes campaign editing and grants AI management for this admin only.
    const r = await owner.patch(`/api/team/members/${admin.id}/permissions`).send({ permissions: { 'campaigns.manage': false, 'ai.manage': true } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.permissions['campaigns.manage']).toBe(false);
    const denied = await a.post('/api/campaigns').send({ name: 'Not allowed' });
    expect(denied.status).toBe(403);
    expect(denied.body.reason).toBe('permission_denied');
    expect((await a.get('/api/settings/ai-provider')).status).toBe(200);

    // null returns a permission to the role default
    await owner.patch(`/api/team/members/${admin.id}/permissions`).send({ permissions: { 'campaigns.manage': null, 'ai.manage': null } });
    expect((await a.get('/api/auth/me')).body.user.permissions['campaigns.manage']).toBe(true);
  });

  it('only the owner can change permissions', async () => {
    const admin = await memberByRole('admin');
    const member = await memberByRole('member');
    const a = await login(admin.email);
    expect((await a.patch(`/api/team/members/${member.id}/permissions`).send({ permissions: { 'pages.delete': true } })).status).toBe(403);
    expect((await owner.patch(`/api/team/members/${member.id}/permissions`).send({ permissions: { 'not.a.permission': true } })).status).toBe(400);
  });
});

describe('profile pictures', () => {
  it('any teammate can upload and remove their own picture, and it is served back', async () => {
    const member = await memberByRole('member');
    const m = await login(member.email);
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    const up = await m.post('/api/auth/me/avatar').attach('file', png, { filename: 'me.png', contentType: 'image/png' });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect(up.body.avatarUrl).toMatch(/^\/api\/files\/avatars\//);
    const file = await request(app).get(up.body.avatarUrl);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    const members = (await owner.get('/api/team/members')).body.data;
    expect(members.find((x: { id: string }) => x.id === member.id).avatarUrl).toBe(up.body.avatarUrl);
    expect((await m.post('/api/auth/me/avatar').attach('file', Buffer.from('hi'), { filename: 'x.txt', contentType: 'text/plain' })).status).toBe(400);
    expect((await m.delete('/api/auth/me/avatar')).body.avatarUrl).toBeNull();
  });
});

describe('subscription', () => {
  it('owner sees plans and usage; teammates cannot change the plan; downgrades over limits are refused', async () => {
    const sub = await owner.get('/api/workspace/subscription');
    expect(sub.status).toBe(200);
    expect(sub.body.plan).toBe('watchtower');
    const starter = sub.body.plans.find((p: { plan: string }) => p.plan === 'starter');
    expect(starter.blockers.length).toBeGreaterThan(0); // demo workspace has more than 3 campaigns
    const admin = await login((await memberByRole('admin')).email);
    expect((await admin.get('/api/workspace/subscription')).status).toBe(403);
    expect((await admin.post('/api/workspace/upgrade').send({ targetPlan: 'growth' })).status).toBe(403);
    const r = await owner.post('/api/workspace/upgrade').send({ targetPlan: 'starter' });
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe('over_plan_limits');
  });

  it('a fresh workspace can downgrade and upgrade freely when billing allows direct changes', async () => {
    const email = `plan-${Date.now()}@example.com`;
    await request(app).post('/api/auth/signup').send({ name: 'Pat', email, password: 'longenough1', workspaceName: 'Plan Co', plan: 'growth' });
    const p = request.agent(app);
    await p.post('/api/auth/login').send({ email, password: 'longenough1' });
    const down = await p.post('/api/workspace/upgrade').send({ targetPlan: 'starter' });
    expect(down.status, JSON.stringify(down.body)).toBe(200);
    expect(down.body.applied).toBe(true);
    expect((await p.get('/api/workspace/plan')).body.plan).toBe('starter');
  });
});

describe('removing a teammate', () => {
  it('signs them out everywhere and returns their open leads to the shared inbox', async () => {
    const member = await memberByRole('member');
    const m = await login(member.email);
    expect((await m.get('/api/auth/me')).status).toBe(200);
    expect((await owner.delete(`/api/team/members/${member.id}`)).status).toBe(200);
    expect((await m.get('/api/auth/me')).status).toBe(401);
    expect((await m.post('/api/auth/refresh')).status).toBe(401);
    const still = await db.select().from(s.leads).where(and(eq(s.leads.assigneeId, member.id), eq(s.leads.status, 'not_responded')));
    expect(still).toHaveLength(0);
  });
});
