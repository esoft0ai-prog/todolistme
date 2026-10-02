/**
 * Error monitoring: grouping by fingerprint, browser reports, Super Admin listing/resolve, Sentry DSN parsing.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.AUTO_ACTIVATE = 'true';
  process.env.APP_URL = 'http://localhost:4173';
  process.env.SUPER_ADMIN_EMAIL = 'root@camplo.test';
  process.env.SUPER_ADMIN_PASSWORD = 'correct horse battery';
  process.env.ADMIN_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
});
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import { captureError, fingerprint, sentryTarget } from '../server/lib/monitor.js';
import { totp } from '../server/services/admin.js';

let app: Express;
let admin: string;
const as = (r: request.Test) => r.set('Authorization', `Bearer ${admin}`);

beforeAll(async () => {
  app = createApp();
  const r = await request(app).post('/api/admin/api/login').send({ email: 'root@camplo.test', password: 'correct horse battery', code: totp(process.env.ADMIN_TOTP_SECRET!) });
  admin = r.body.token;
});

describe('grouping', () => {
  it('treats the same error with different ids as one group', () => {
    const a = fingerprint('server', 'Lead 0f8fad5b-d9cb-469f-a165-70867728950e not found after 3 tries', 'GET /api/leads/0f8fad5b-d9cb-469f-a165-70867728950e');
    const b = fingerprint('server', 'Lead 7c9e6679-7425-40de-944b-e07fc1f90ae7 not found after 5 tries', 'GET /api/leads/7c9e6679-7425-40de-944b-e07fc1f90ae7');
    expect(a).toBe(b);
    expect(fingerprint('job', 'boom')).not.toBe(fingerprint('server', 'boom'));
  });
});

describe('capture and Super Admin view', () => {
  it('counts repeats, lists, resolves and reopens on recurrence', async () => {
    await captureError(new Error('Payment provider timed out (attempt 1)'), { source: 'job', route: 'job:billing' });
    await captureError(new Error('Payment provider timed out (attempt 2)'), { source: 'job', route: 'job:billing' });
    const list = await as(request(app).get('/api/admin/api/errors'));
    expect(list.status).toBe(200);
    const row = list.body.data.find((x: { message: string }) => x.message.startsWith('Payment provider timed out'));
    expect(row.count).toBe(2);
    expect(list.body.summary.sentry).toBe(false);

    expect((await as(request(app).post(`/api/admin/api/errors/${row.id}/resolve`).send({}))).status).toBe(200);
    const open = await as(request(app).get('/api/admin/api/errors?status=open'));
    expect(open.body.data.some((x: { id: string }) => x.id === row.id)).toBe(false);

    await captureError(new Error('Payment provider timed out (attempt 3)'), { source: 'job', route: 'job:billing' });
    const again = await as(request(app).get('/api/admin/api/errors?status=open'));
    expect(again.body.data.find((x: { id: string }) => x.id === row.id).count).toBe(3);
  });

  it('accepts browser reports and refuses empty ones; admin routes need a token', async () => {
    const r = await request(app).post('/api/monitor/client-error').send({ message: "TypeError: Cannot read properties of undefined (reading 'name')", stack: 'at dashboard (app.js:400:12)', url: 'http://localhost/#/campaigns' });
    expect(r.status).toBe(204);
    expect((await request(app).post('/api/monitor/client-error').send({})).status).toBe(400);
    const list = await as(request(app).get('/api/admin/api/errors'));
    const row = list.body.data.find((x: { source: string }) => x.source === 'client');
    expect(row.route).toBe('/#/campaigns');
    expect((await request(app).get('/api/admin/api/errors')).status).toBe(401);
  });
});

describe('Sentry', () => {
  it('parses a DSN into the envelope endpoint', () => {
    expect(sentryTarget('https://abc123@o42.ingest.sentry.io/789')).toEqual({ url: 'https://o42.ingest.sentry.io/api/789/envelope/', auth: 'Sentry sentry_version=7, sentry_key=abc123, sentry_client=camplo/1.0' });
    expect(sentryTarget('not a dsn')).toBeNull();
  });
});
