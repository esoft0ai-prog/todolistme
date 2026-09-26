/**
 * Super Admin platform control: branding, pricing & limits, secrets (masked, encrypted, clearable),
 * account edits, and the audit trail.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Imports are hoisted, so the env must be set in a hoisted block before config.ts is evaluated.
vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.AUTO_ACTIVATE = 'true';
  process.env.APP_URL = 'http://localhost:4173';
  process.env.SUPER_ADMIN_EMAIL = 'root@camplo.test';
  process.env.SUPER_ADMIN_PASSWORD = 'correct horse battery';
  process.env.ADMIN_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
});
import request from 'supertest';
import { eq } from 'drizzle-orm';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import { getDatabase, type DB } from '../server/db/client.js';
import * as s from '../server/db/schema.js';
import { outbox, sendMail } from '../server/lib/mailer.js';
import { invalidatePlatform } from '../server/lib/platform.js';
import { totp } from '../server/services/admin.js';
import { DEMO_EMAIL } from '../server/db/seed.js';

let app: Express;
let db: DB;
let admin: string;
const as = (r: request.Test) => r.set('Authorization', `Bearer ${admin}`);

beforeAll(async () => {
  db = (await getDatabase()).db;
  app = createApp();
  const r = await request(app).post('/api/admin/api/login').send({ email: 'root@camplo.test', password: 'correct horse battery', code: totp(process.env.ADMIN_TOTP_SECRET!) });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  admin = r.body.token;
});

describe('Super Admin platform settings', () => {
  it('is closed to everyone else', async () => {
    expect((await request(app).get('/api/admin/api/platform')).status).toBe(401);
    expect((await request(app).patch('/api/admin/api/platform/branding').send({ values: { productName: 'X' } })).status).toBe(401);
  });

  it('renames the product everywhere users see it', async () => {
    const r = await as(request(app).patch('/api/admin/api/platform/branding')).send({ values: { productName: 'Leadwatch', supportEmail: 'help@leadwatch.test' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.sections.branding.values.productName).toBe('Leadwatch');
    expect((await request(app).get('/api/public/platform')).body.productName).toBe('Leadwatch');
    outbox.length = 0;
    await sendMail({ to: 'a@b.test', subject: 'Your Camplo account is active', text: 'Welcome to Camplo.' });
    expect(outbox[0].subject).toBe('Your Leadwatch account is active');
    expect(outbox[0].text).toBe('Welcome to Leadwatch.');
    // null resets a field to the default
    await as(request(app).patch('/api/admin/api/platform/branding')).send({ values: { productName: null } });
    expect((await request(app).get('/api/public/platform')).body.productName).toBe('Camplo');
  });

  it('changes plan prices and limits, enforced immediately', async () => {
    const r = await as(request(app).patch('/api/admin/api/platform/pricing')).send({ values: {
      plans: { starter: { price: 49, limits: { campaigns: 1 } }, growth: { price: 149 } }, addOns: { extraDeploymentMonthly: 9 },
    } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const pub = (await request(app).get('/api/public/platform')).body;
    expect(pub.prices.starter).toBe(49);
    expect(pub.prices.growth).toBe(149);
    expect(pub.prices.watchtower).toBe(347); // untouched plans keep their defaults
    expect(pub.extraDeploymentMonthly).toBe(9);

    const email = `lim-${Date.now()}@example.com`;
    await request(app).post('/api/auth/signup').send({ name: 'Lim', email, password: 'longenough1', workspaceName: 'Lim Co', plan: 'starter' });
    const u = request.agent(app);
    await u.post('/api/auth/login').send({ email, password: 'longenough1' });
    expect((await u.get('/api/workspace/plan')).body.price).toBe(49);
    expect((await u.post('/api/campaigns').send({ name: 'First' })).status).toBe(200);
    const second = await u.post('/api/campaigns').send({ name: 'Second' });
    expect(second.status).toBe(403);
    expect(second.body.reason).toBe('plan_limit');
    expect(second.body.message).toContain('1 active campaigns');
  });

  it('stores payment secrets encrypted, shows them masked, and can clear them', async () => {
    const r = await as(request(app).patch('/api/admin/api/platform/billing')).send({ values: { polarAccessToken: 'polar_oat_supersecret1234', polarOrganizationId: 'org_1' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const b = r.body.sections.billing;
    expect(b.secrets.polarAccessToken).toMatchObject({ set: true, source: 'admin' });
    expect(b.secrets.polarAccessToken.masked).toMatch(/1234$/);
    expect(JSON.stringify(r.body)).not.toContain('supersecret');
    const [row] = await db.select().from(s.platformSettings).where(eq(s.platformSettings.section, 'billing'));
    expect(String(row.value.polarAccessToken)).toMatch(/^integration\./); // sealed with the integration key family
    const cleared = await as(request(app).patch('/api/admin/api/platform/billing')).send({ values: { polarAccessToken: '' } });
    expect(cleared.body.sections.billing.secrets.polarAccessToken.set).toBe(false);
  });

  it('rejects invalid values with a readable message', async () => {
    const r = await as(request(app).patch('/api/admin/api/platform/pricing')).send({ values: { plans: { starter: { price: -5 } } } });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain('plans.starter.price');
  });

  it('records platform changes in the audit log', async () => {
    const r = await as(request(app).get('/api/admin/api/platform'));
    expect(r.body.history.some((h: { action: string }) => h.action === 'platform_pricing')).toBe(true);
    expect(JSON.stringify(r.body.history)).not.toContain('supersecret');
  });
});

describe('Super Admin account editing', () => {
  it('changes plan, owner details and quota, and refuses a duplicate owner email', async () => {
    const [t] = await db.select().from(s.tenants).where(eq(s.tenants.ownerEmail, DEMO_EMAIL));
    const r = await as(request(app).patch(`/api/admin/api/accounts/${t.id}`)).send({ plan: 'agency', businessName: 'Northbeam Global', storageQuotaGb: 20, monthlyFee: 250 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ plan: 'agency', businessName: 'Northbeam Global', storageQuotaGb: 20, monthlyFee: 250 });
    expect(r.body.history[0].action).toBe('account_update');
    const other = (await as(request(app).get('/api/admin/api/accounts')).expect(200)).body.data.find((a: { id: string }) => a.id !== t.id);
    if (other) expect((await as(request(app).patch(`/api/admin/api/accounts/${t.id}`)).send({ ownerEmail: other.ownerEmail })).status).toBe(409);
    invalidatePlatform();
  });
});
