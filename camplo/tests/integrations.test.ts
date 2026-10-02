/**
 * Integrations: catalog fields, lead webhooks with per-tool signing (Tally, Typeform, token URL), validation,
 * secrets masking and disconnect.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.AUTO_ACTIVATE = 'true';
  process.env.APP_URL = 'http://localhost:4173';
});

import request from 'supertest';
import { createHmac } from 'node:crypto';
import type { Express } from 'express';
import { createApp } from '../server/app.js';

let app: Express;
let owner: request.Agent;

beforeAll(async () => {
  app = createApp();
  const email = `int-${Date.now()}@example.com`;
  await request(app).post('/api/auth/signup').send({ name: 'Ira', email, password: 'longenough1', workspaceName: 'Int Co', plan: 'watchtower' });
  owner = request.agent(app);
  expect((await owner.post('/api/auth/login').send({ email, password: 'longenough1' })).status).toBe(200);
});

type Int = { provider: string; fields: { key: string; required: boolean }[]; status: string; webhooks: { leads: string | null; signingSecret: string | null }; secrets: Record<string, string> };
const getInt = async (p: string) => ((await owner.get('/api/integrations?limit=100')).body.data as Int[]).find((i) => i.provider === p)!;
const hookPath = (url: string) => { const u = new URL(url); return { path: u.pathname, token: u.searchParams.get('token') }; };

describe('integration catalog', () => {
  it('lists every provider with its fields', async () => {
    const list = (await owner.get('/api/integrations?limit=100')).body.data as Int[];
    expect(list.length).toBeGreaterThanOrEqual(20);
    expect((await getInt('mailchimp')).fields.map((f) => f.key)).toEqual(['apiKey', 'audienceId']);
  });

  it('refuses a connection with missing required fields', async () => {
    const r = await owner.post('/api/integrations/mailchimp/connect').send({ fields: { apiKey: 'abc-us21' } });
    expect(r.status).toBe(400);
  });
});

describe('lead webhooks', () => {
  it('Tally: signed submissions create leads, bad signatures are refused', async () => {
    const c = await owner.post('/api/integrations/tally/connect').send({ fields: {} });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const t = await getInt('tally');
    expect(t.status).toBe('connected');
    const { path } = hookPath(t.webhooks.leads!);
    const body = JSON.stringify({ data: { fields: [{ label: 'Name', value: 'Ada' }, { label: 'Email', value: 'ada@example.com' }] } });
    const sig = createHmac('sha256', t.webhooks.signingSecret!).update(body).digest('base64');
    const ok = await request(app).post(path).set('content-type', 'application/json').set('Tally-Signature', sig).send(body);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const bad = await request(app).post(path).set('content-type', 'application/json').set('Tally-Signature', 'nope').send(body);
    expect(bad.status).toBe(401);
  });

  it('Typeform: sha256= base64 signature', async () => {
    await owner.post('/api/integrations/typeform/connect').send({ fields: {} });
    const t = await getInt('typeform');
    const { path } = hookPath(t.webhooks.leads!);
    const body = JSON.stringify({ form_response: { answers: [{ type: 'email', email: 'tf@example.com' }] } });
    const sig = 'sha256=' + createHmac('sha256', t.webhooks.signingSecret!).update(body).digest('base64');
    expect((await request(app).post(path).set('content-type', 'application/json').set('Typeform-Signature', sig).send(body)).status).toBe(201);
  });

  it('token URL works as given; disconnect deactivates the webhook', async () => {
    await owner.post('/api/integrations/instantly/connect').send({ fields: {} });
    const t = await getInt('instantly');
    const { path, token } = hookPath(t.webhooks.leads!);
    expect(token).toBeTruthy();
    const body = { email: 'reply@example.com', name: 'Warm Reply' };
    expect((await request(app).post(`${path}?token=${token}`).send(body)).status).toBe(201);
    expect((await request(app).post(`${path}?token=wrong`).send(body)).status).toBe(401);
    expect((await owner.delete('/api/integrations/instantly')).status).toBe(200);
    expect((await request(app).post(`${path}?token=${token}`).send(body)).status).toBe(404);
  });
});

describe('secrets', () => {
  it('are masked when listed and kept when an edit leaves them blank', async () => {
    const r = await owner.post('/api/integrations/umami/connect').send({ fields: { baseUrl: 'https://umami.example.com', apiKey: 'supersecretvalue123', websiteId: '1d2c3b4a-0000-4000-8000-000000000000' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const u = await getInt('umami');
    expect(Object.values(u.secrets).join(' ')).not.toContain('supersecretvalue123');
    const again = await owner.post('/api/integrations/umami/connect').send({ fields: { baseUrl: 'https://umami.example.com', websiteId: '1d2c3b4a-0000-4000-8000-000000000000' } });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(Object.keys((await getInt('umami')).secrets)).toContain('apiKey');
  });
});
