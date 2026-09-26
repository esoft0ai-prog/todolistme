/**
 * HTTP application. JSON API via oRPC (OpenAPI handler) under /api; raw
 * endpoints that need the unparsed body, streaming or binary responses are
 * plain Express routes. Hosted landing pages are served from /sites/:subdomain
 * or by Host header ({sub}.PAGES_BASE_DOMAIN / verified custom domains).
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORPCError } from '@orpc/server';
import { OpenAPIHandler } from '@orpc/openapi/node';
import { onError } from '@orpc/server';
import { and, eq, like } from 'drizzle-orm';
import { getDatabase, type DB } from './db/client.js';
import { leads, tenants, users } from './db/schema.js';
import { router } from './routes/index.js';
import { config } from './lib/config.js';
import { hmacHex, safeEqual } from './lib/crypto.js';
import { resolveAuth, toAuthedContext, type BaseContext } from './lib/orpc.js';
import { storageFor } from './lib/storage.js';
import { subscribe } from './rt/hub.js';
import { bindDatabase, maybeSweep, runSweeps } from './jobs/scheduler.js';
import { ingestDeployment, ingestLifecycle, ingestNamed, afterRespond } from './services/leads.js';
import { retrospectivePdf } from './services/campaigns.js';
import { resolveSite, serveSiteFile } from './services/pages.js';
import { handlePolarEvent, ingestErrors, verifyPolarSignature } from './services/admin.js';
import { telegramCall } from './lib/telegram.js';
import { decrypt } from './lib/crypto.js';
import { telegramConnections } from './db/schema.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const orpc = new OpenAPIHandler(router, {
  interceptors: [onError((e) => {
    if (!(e instanceof ORPCError) || e.status >= 500) console.error('[api]', e);
  })],
});

type Req = Request & { rawBody?: Buffer };
const wrap = (fn: (req: Req, res: Response, db: DB) => Promise<unknown>) => async (req: Req, res: Response, next: NextFunction) => {
  try { await fn(req, res, (await getDatabase()).db); } catch (e) { next(e); }
};

function sendError(res: Response, e: unknown) {
  if (e instanceof ORPCError) { res.status(e.status).json(e.toJSON()); return; }
  console.error(e);
  res.status(500).json({ code: 'INTERNAL_SERVER_ERROR', message: 'Something went wrong on our end. Try again in a moment.' });
}

async function authCtx(req: Req, db: DB) {
  const base: BaseContext = { db, headers: req.headers, ip: req.ip ?? '', setCookies: [] };
  return toAuthedContext(base, await resolveAuth(db, req.headers));
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  // Raw routes take UUID path params straight to SQL — reject malformed ids with a 404 instead of a 500.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const p of ['id', 'tenantId', 'deploymentId', 'integrationId']) {
    app.param(p, (_req, res, next, value: string) => (UUID.test(value) ? next() : res.status(404).json({ code: 'NOT_FOUND', message: 'Not found.' })));
  }

  // Security headers for the app shell and API.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  // Bind the DB for inline jobs and run the piggy-back scheduler.
  app.use(async (req, _res, next) => { try { const { db } = await getDatabase(); bindDatabase(db); maybeSweep(db); next(); } catch (e) { next(e); } });

  // ---------------------------------------------------------------- hosted pages by Host header
  app.use(async (req, res, next) => {
    const host = (req.headers['x-forwarded-host'] as string | undefined ?? req.headers.host ?? '').split(':')[0].toLowerCase();
    const appHost = new URL(config.appUrl).hostname;
    if (!host || host === appHost || host === 'localhost' || host.endsWith('.vercel.app')) return next();
    try {
      const { db } = await getDatabase();
      const site = await resolveSite(db, { host });
      if (!site) return next();
      const f = await serveSiteFile(db, site, req.path);
      if (!f) { res.status(404).send('Not found'); return; }
      res.setHeader('Content-Type', f.contentType);
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.send(f.data);
    } catch (e) { next(e); }
  });

  app.get('/sites/:subdomain', (req, res, next) => (req.originalUrl.split('?')[0].endsWith('/') ? next() : res.redirect(301, `/sites/${req.params.subdomain}/`)));
  app.get(/^\/sites\/([a-z0-9-]+)\/(.*)$/, wrap(async (req, res, db) => {
    const [, sub, rest] = req.path.match(/^\/sites\/([a-z0-9-]+)\/(.*)$/) ?? [];
    const site = await resolveSite(db, { subdomain: sub });
    const f = site ? await serveSiteFile(db, site, rest ?? '') : null;
    if (!f) { res.status(404).type('text/plain').send('This page is not available.'); return; }
    res.setHeader('Content-Type', f.contentType);
    res.setHeader('Cache-Control', 'public, max-age=60');
    // Hosted pages are static and isolated from the app origin's APIs.
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.send(f.data);
  }));

  // ---------------------------------------------------------------- raw-body webhooks
  const raw = express.raw({ type: '*/*', limit: '1mb' });
  const parse = (b: Buffer, type: string | undefined): unknown => {
    const text = b.toString('utf8');
    if (type?.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
    try { return JSON.parse(text || '{}'); } catch { return {}; }
  };

  app.post('/api/v1/ingest/:tenantId/:deploymentId', raw, wrap(async (req, res, db) => {
    const body = req.body as Buffer;
    const r = await ingestDeployment(db, String(req.params.tenantId), String(req.params.deploymentId), body, req.header('x-camplo-signature') ?? req.header('x-signature') ?? req.header('tally-signature'), parse(body, req.header('content-type')));
    ingestErrors.record(r.status === 201);
    res.status(r.status).json(r.status === 201 ? { ok: true, lead_id: r.leadId } : { ok: false });
  }));
  app.post('/api/v1/hooks/:id', raw, wrap(async (req, res, db) => {
    const body = req.body as Buffer;
    const r = await ingestNamed(db, String(req.params.id), body, req.header('x-camplo-signature') ?? req.header('x-signature'), parse(body, req.header('content-type')));
    ingestErrors.record(r.status === 201);
    res.status(r.status).json(r.status === 201 ? { ok: true, lead_id: r.leadId } : { ok: false });
  }));
  app.post('/api/v1/lifecycle/:integrationId/:token', raw, wrap(async (req, res, db) => {
    const r = await ingestLifecycle(db, String(req.params.integrationId), String(req.params.token), parse(req.body as Buffer, req.header('content-type')) as Record<string, unknown>);
    res.status(r.status).json({ ok: r.status < 300 });
  }));
  app.post('/api/polar/webhook', raw, wrap(async (req, res, db) => {
    if (!verifyPolarSignature(req.body as Buffer, req.headers)) { res.status(401).json({ ok: false }); return; }
    const r = await handlePolarEvent(db, JSON.parse((req.body as Buffer).toString('utf8')));
    res.json(r);
  }));

  // Telegram inline "Acknowledge" button and /start linking.
  app.post('/api/telegram/:tenantId', express.json(), wrap(async (req, res, db) => {
    const tenantId = String(req.params.tenantId);
    const u = req.body as { callback_query?: { id: string; data?: string; from: { id: number }; message?: { chat: { id: number }; message_id: number } }; message?: { text?: string; chat: { id: number } } };
    const [tg] = await db.select().from(telegramConnections).where(eq(telegramConnections.tenantId, tenantId));
    if (!tg) { res.json({ ok: true }); return; }
    const token = decrypt(tg.botTokenEncrypted);
    if (u.message?.text?.startsWith('/start ')) {
      const code = u.message.text.slice(7).trim();
      const [usr] = await db.select().from(users).where(and(eq(users.tenantId, tenantId), like(users.id, `${code}%`)));
      if (usr) {
        await db.update(users).set({ telegramChatId: String(u.message.chat.id) }).where(eq(users.id, usr.id));
        await telegramCall(token, 'sendMessage', { chat_id: u.message.chat.id, text: `Linked to Camplo as ${usr.name}. You'll get SLA alerts here.` });
      }
    }
    const cq = u.callback_query;
    const m = cq?.data?.match(/^ack:([0-9a-f]{8}):([0-9a-f]{16})$/);
    if (cq && m) {
      const [usr] = await db.select().from(users).where(and(eq(users.tenantId, tenantId), eq(users.telegramChatId, String(cq.message?.chat.id ?? cq.from.id))));
      const [l] = usr ? await db.select().from(leads).where(and(eq(leads.tenantId, tenantId), like(leads.id, `${m[1]}%`))) : [];
      const expected = l && usr ? hmacHex(config.jwtSecret, `acknowledge:${l.id}:${usr.id}:${tenantId}`).slice(0, 16) : '';
      let text = 'This acknowledgment is no longer valid.';
      if (l && usr && safeEqual(expected, m[2])) {
        if (l.status === 'responded') {
          const [by] = l.respondedBy ? await db.select({ name: users.name }).from(users).where(eq(users.id, l.respondedBy)) : [];
          text = `Already acknowledged by ${by?.name ?? 'a teammate'} at ${l.respondedAt!.toISOString().slice(11, 16)} UTC.`;
        } else {
          const now = new Date();
          const claim = !l.assigneeId;
          const [updated] = await db.update(leads).set({ status: 'responded', respondedAt: now, respondedBy: usr.id, ...(claim ? { assigneeId: usr.id, assignmentPath: 'A' as const, claimedAt: now } : {}) })
            .where(and(eq(leads.id, l.id), eq(leads.status, 'not_responded'))).returning();
          if (updated) {
            const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
            await afterRespond(db, t, updated, usr);
            text = `✓ ${usr.name} acknowledged ${l.fullName}.`;
          }
        }
      }
      await telegramCall(token, 'answerCallbackQuery', { callback_query_id: cq.id });
      if (cq.message) await telegramCall(token, 'editMessageText', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text });
    }
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------- SSE (8 channels)
  const sse = (channelOf: (req: Req) => string, snapshot?: (req: Req, db: DB, tenantId: string) => Promise<unknown>, tickMs?: number) => async (req: Req, res: Response) => {
    try {
      const { db } = await getDatabase();
      const ctx = await authCtx(req, db);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (snapshot) send('snapshot', await snapshot(req, db, ctx.tenantId));
      const unsub = subscribe(ctx.tenantId, channelOf(req), (p) => send('update', p));
      const ping = setInterval(() => (tickMs ? send('tick', { now: Date.now() }) : res.write(': ping\n\n')), tickMs ?? 25_000);
      req.on('close', () => { unsub(); clearInterval(ping); });
    } catch (e) { sendError(res, e); }
  };
  app.get('/api/rt/workspace/:name', sse((req) => `workspace:${req.params.name}`));
  app.get('/api/rt/leads/:id/status', sse((req) => `lead:${req.params.id}:status`));
  app.get('/api/rt/leads/:id/timer', sse((req) => `lead:${req.params.id}:status`, async (req, db, tenantId) => {
    const [l] = await db.select({ receivedAt: leads.receivedAt, respondedAt: leads.respondedAt, claimedAt: leads.claimedAt, assignedAt: leads.assignedAt, reassignedAt: leads.reassignedAt, path: leads.assignmentPath })
      .from(leads).where(and(eq(leads.tenantId, tenantId), eq(leads.id, String(req.params.id))));
    return l ?? null;
  }, 1000));
  app.get('/api/rt/pages/:id/webhook', sse((req) => `page:${req.params.id}:webhook`));
  app.get('/api/rt/campaigns/:id/health', sse((req) => `campaign:${req.params.id}:health`));

  // ---------------------------------------------------------------- binary
  app.get('/api/campaigns/:id/retrospective/pdf', async (req, res) => {
    try {
      const { db } = await getDatabase();
      const pdf = await retrospectivePdf(await authCtx(req, db), String(req.params.id));
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${pdf.filename}"`);
      res.send(pdf.data);
    } catch (e) { sendError(res, e); }
  });
  app.get(/^\/api\/files\/(logos\/.+)$/, wrap(async (req, res, db) => {
    const f = await (await storageFor(db)).get(req.path.replace(/^\/api\/files\//, ''));
    if (!f) { res.status(404).end(); return; }
    res.setHeader('Content-Type', f.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(f.data);
  }));

  // Scheduler entry for Vercel Cron / external cron.
  app.get('/api/cron', wrap(async (req, res, db) => {
    const auth = req.header('authorization') ?? '';
    if (!config.cronSecret || auth !== `Bearer ${config.cronSecret}`) { res.status(401).json({ ok: false }); return; }
    await runSweeps(db);
    res.json({ ok: true });
  }));

  app.get('/api/health', wrap(async (_req, res, db) => {
    const { kind } = await getDatabase();
    await db.select({ id: tenants.id }).from(tenants).limit(1);
    res.json({ ok: true, database: kind, ai: !!config.openRouterApiKey, memory: config.hindsightApiUrl ? 'hindsight' : 'relational', queue: config.redisUrl ? 'bullmq' : 'inline' });
  }));

  // ---------------------------------------------------------------- oRPC JSON API
  app.use('/api', async (req, res, next) => {
    try {
      const { db } = await getDatabase();
      const context: BaseContext = { db, headers: req.headers, ip: req.ip ?? '', setCookies: [] };
      const origEnd = res.writeHead.bind(res);
      res.writeHead = ((...args: Parameters<typeof res.writeHead>) => {
        if (context.setCookies.length) res.setHeader('Set-Cookie', context.setCookies);
        return origEnd(...args);
      }) as typeof res.writeHead;
      const { matched } = await orpc.handle(req, res, { prefix: '/api', context });
      if (!matched) res.status(404).json({ code: 'NOT_FOUND', message: 'Not found.' });
    } catch (e) { next(e); }
  });

  // ---------------------------------------------------------------- static app shell (local/dev; Vercel serves public/ directly)
  app.use(express.static(publicDir, { extensions: ['html'] }));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  app.use((e: unknown, _req: Request, res: Response, _next: NextFunction) => sendError(res, e));
  return app;
}

