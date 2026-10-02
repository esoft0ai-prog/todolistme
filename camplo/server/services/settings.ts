/** Integrations, webhooks, AI provider, Telegram and notification settings (Screen 20). */
import { planLimits, platform } from '../lib/platform.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { CATALOG, catalogEntry, type Mode } from './catalog.js';
import { aiProviderConfigs, inboundWebhooks, integrations, outboundWebhooks, telegramConnections, tenants } from '../db/schema.js';
import { fail, assertRole, type AuthedContext, assertPerm } from '../lib/orpc.js';
import { config } from '../lib/config.js';
import { decrypt, encrypt, mask, randomToken } from '../lib/crypto.js';
import { verifyBot } from '../lib/telegram.js';
import { verifyProvider } from '../ai/router.js';
import { logWorkspace } from './effects.js';
import { campaigns } from '../db/schema.js';

type Provider = (typeof integrations.$inferSelect)['provider'];
export { CATALOG };

type Row = typeof integrations.$inferSelect;
const readSecrets = (r: Row | undefined): Record<string, string> => {
  if (!r?.secretsEncrypted) return r?.apiKeyEncrypted ? { apiKey: decrypt(r.apiKeyEncrypted) } : {};
  try { return JSON.parse(decrypt(r.secretsEncrypted)) as Record<string, string>; } catch { return {}; }
};
const leadsUrl = (id: string, secret: string) => `${config.appUrl}/api/v1/hooks/${id}?token=${encodeURIComponent(secret)}`;

/** Catalog + this workspace's state: settings, masked secrets, webhook URLs and setup steps. */
export async function listIntegrations(ctx: AuthedContext) {
  assertPerm(ctx, 'integrations.manage');
  const rows = await ctx.db.select().from(integrations).where(eq(integrations.tenantId, ctx.tenantId));
  const hookIds = rows.map((r) => r.config?.inboundWebhookId).filter(Boolean) as string[];
  const hooks = hookIds.length ? await ctx.db.select().from(inboundWebhooks).where(and(eq(inboundWebhooks.tenantId, ctx.tenantId), inArray(inboundWebhooks.id, hookIds))) : [];
  return CATALOG.map((c) => {
    const r = rows.find((x) => x.provider === c.provider);
    const sec = readSecrets(r);
    const hook = hooks.find((h) => h.id === r?.config?.inboundWebhookId);
    const hookSecret = hook ? decrypt(hook.secretEncrypted) : null;
    const connected = !c.comingSoon && r?.status === 'connected';
    return {
      provider: c.provider, name: c.name, category: c.category, blurb: c.blurb, methods: c.methods, modes: c.modes, fields: c.fields,
      webhookKinds: c.webhooks, signing: c.signing ?? null, setup: c.setup, docsUrl: c.docsUrl ?? null, comingSoon: !!c.comingSoon,
      id: r?.id ?? null,
      status: c.comingSoon ? 'coming_soon' : r?.status ?? 'not_connected',
      connectionMethod: r?.connectionMethod ?? null, activeModes: r?.activeModes ?? [],
      settings: Object.fromEntries(c.fields.filter((f) => f.type !== 'secret').map((f) => [f.key, r?.config?.[f.key] ?? null])),
      secrets: Object.fromEntries(c.fields.filter((f) => f.type === 'secret').map((f) => [f.key, sec[f.key] ? mask(sec[f.key]) : null])),
      apiKeyMasked: sec.apiKey ? mask(sec.apiKey) : null,
      webhooks: connected ? {
        leads: hook && hookSecret ? leadsUrl(hook.id, hookSecret) : null,
        leadsBase: hook ? `${config.appUrl}/api/v1/hooks/${hook.id}` : null,
        signingSecret: hook && (c.signing === 'tally' || c.signing === 'typeform' || c.signing === 'camplo') ? hookSecret : null,
        lifecycle: c.webhooks.includes('lifecycle') ? r?.webhookUrl ?? null : null,
        campaignId: hook?.campaignId ?? null, lastReceivedAt: hook?.lastReceivedAt ?? null,
      } : null,
      lastVerifiedAt: r?.lastVerifiedAt ?? null,
    };
  });
}

export async function connectIntegration(ctx: AuthedContext, provider: Provider, input: { fields?: Record<string, string | null>; campaignId?: string | null; apiKey?: string | null }) {
  assertPerm(ctx, 'integrations.manage');
  const cat = catalogEntry(provider);
  if (!cat) throw fail.notFound('Unknown integration.');
  if (cat.comingSoon) throw fail.bad(`${cat.name} is coming soon.`);
  const [existing] = await ctx.db.select().from(integrations).where(and(eq(integrations.tenantId, ctx.tenantId), eq(integrations.provider, provider)));
  if (cat.isTool && (!existing || existing.status !== 'connected')) {
    const toolProviders = CATALOG.filter((c) => c.isTool).map((c) => c.provider);
    const [{ n }] = await ctx.db.select({ n: sql<number>`count(*)` }).from(integrations)
      .where(and(eq(integrations.tenantId, ctx.tenantId), eq(integrations.status, 'connected'), inArray(integrations.provider, toolProviders)));
    if (Number(n) >= (await planLimits(ctx.plan, ctx.db)).connectedTools) {
      throw fail.planLimit(ctx.plan === 'starter' ? 'Connected tools are available on Growth.' : 'Growth includes one connected tool. Upgrade to Watchtower for unlimited tools.', ctx.plan === 'starter' ? 'growth' : 'watchtower');
    }
  }
  // Merge submitted fields over what is stored; blank keeps the stored value.
  const given: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...(input.apiKey ? { apiKey: input.apiKey } : {}), ...(input.fields ?? {}) })) if (typeof v === 'string' && v.trim()) given[k] = v.trim();
  const secrets = { ...readSecrets(existing) };
  const settingsCfg: Record<string, string> = { ...(existing?.config ?? {}) };
  for (const f of cat.fields) {
    const v = given[f.key];
    if (v !== undefined) {
      if (f.type === 'url' && !/^https?:\/\/[^\s]+$/.test(v)) throw fail.bad(`${f.label} must be a full URL starting with https://`);
      if (f.type === 'secret') secrets[f.key] = v; else settingsCfg[f.key] = v.replace(/\/+$/, '');
    } else if (f.default && !settingsCfg[f.key] && f.type !== 'secret') settingsCfg[f.key] = f.default;
    const have = f.type === 'secret' ? secrets[f.key] : settingsCfg[f.key];
    if (f.required && !have) throw fail.bad(`${cat.name}: ${f.label} is required.`);
  }
  if (provider === 'gohighlevel' && secrets.apiKey && !settingsCfg.locationId) throw fail.bad('GoHighLevel: add the Location ID to use the API token.');
  if (provider === 'mailchimp' && secrets.apiKey && !/-[a-z]+\d+$/.test(secrets.apiKey)) throw fail.bad('Mailchimp: the API key should end with your data centre, e.g. -us21.');
  if (input.campaignId) {
    const [c] = await ctx.db.select({ id: campaigns.id }).from(campaigns).where(and(eq(campaigns.tenantId, ctx.tenantId), eq(campaigns.id, input.campaignId)));
    if (!c) throw fail.bad('Campaign not found.');
  }
  // Lead webhook (a named inbound webhook) for lead-source tools.
  if (cat.webhooks.includes('leads')) {
    const hookId = settingsCfg.inboundWebhookId;
    const [hook] = hookId ? await ctx.db.select().from(inboundWebhooks).where(and(eq(inboundWebhooks.tenantId, ctx.tenantId), eq(inboundWebhooks.id, hookId))) : [];
    if (hook) {
      await ctx.db.update(inboundWebhooks).set({ status: 'active', ...(input.campaignId !== undefined ? { campaignId: input.campaignId } : {}) }).where(eq(inboundWebhooks.id, hook.id));
    } else {
      const [h] = await ctx.db.insert(inboundWebhooks).values({ tenantId: ctx.tenantId, sourceLabel: cat.name, url: 'pending', secretEncrypted: encrypt(randomToken(24), 'webhook'), campaignId: input.campaignId ?? null }).returning();
      await ctx.db.update(inboundWebhooks).set({ url: `${config.appUrl}/api/v1/hooks/${h.id}` }).where(eq(inboundWebhooks.id, h.id));
      settingsCfg.inboundWebhookId = h.id;
    }
  }
  const hasSecret = Object.keys(secrets).length > 0;
  const method = hasSecret ? 'api_key' : cat.methods.includes('webhook') ? 'webhook' : cat.methods[0];
  const activeModes: Mode[] = cat.modes.filter((m) => (m === 'receive' ? cat.webhooks.length > 0 : m === 'query' ? hasSecret : true));
  const values = {
    tenantId: ctx.tenantId, provider, connectionMethod: method,
    apiKeyEncrypted: secrets.apiKey ? encrypt(secrets.apiKey, 'integration') : null,
    secretsEncrypted: hasSecret ? encrypt(JSON.stringify(secrets), 'integration') : null,
    config: settingsCfg, status: 'connected' as const, activeModes, updatedAt: new Date(),
  };
  const [row] = existing
    ? await ctx.db.update(integrations).set(values).where(eq(integrations.id, existing.id)).returning()
    : await ctx.db.insert(integrations).values({ ...values, webhookUrl: null }).returning();
  if (cat.webhooks.includes('lifecycle') && !row.webhookUrl) {
    await ctx.db.update(integrations).set({ webhookUrl: `${config.appUrl}/api/v1/lifecycle/${row.id}/${randomToken(18)}` }).where(eq(integrations.id, row.id));
  }
  await logWorkspace(ctx.db, ctx.tenantId, ctx.user.id, `Integration ${existing?.status === 'connected' ? 'updated' : 'connected'}: ${cat.name}`);
  return (await listIntegrations(ctx)).find((i) => i.provider === provider);
}

/** Credential check against each provider's API (read-only calls). */
export async function verifyIntegration(ctx: AuthedContext, provider: Provider) {
  assertPerm(ctx, 'integrations.manage');
  const [r] = await ctx.db.select().from(integrations).where(and(eq(integrations.tenantId, ctx.tenantId), eq(integrations.provider, provider)));
  if (!r) throw fail.notFound('Integration not connected.');
  const res = await probe(provider, r.config ?? {}, readSecrets(r));
  await ctx.db.update(integrations).set({ status: res.ok ? 'connected' : 'failed', lastVerifiedAt: new Date() }).where(eq(integrations.id, r.id));
  return { ok: res.ok, status: res.ok ? 'connected' : 'failed', message: res.message };
}

async function probe(provider: Provider, cfg: Record<string, string>, sec: Record<string, string>): Promise<{ ok: boolean; message: string }> {
  const get = async (url: string, headers: Record<string, string> = {}, init: RequestInit = {}) => {
    try {
      const res = await fetch(url, { ...init, headers: { Accept: 'application/json', ...headers, ...(init.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(10_000) });
      return res.ok ? { ok: true, message: 'Credentials accepted.' } : { ok: false, message: `The provider answered ${res.status}. Check the values and try again.` };
    } catch (e) {
      return { ok: false, message: `Could not reach the provider (${(e as Error).message}).` };
    }
  };
  switch (provider) {
    case 'brevo': return get('https://api.brevo.com/v3/account', { 'api-key': sec.apiKey });
    case 'activecampaign': return get(`${cfg.baseUrl}/api/3/users/me`, { 'Api-Token': sec.apiKey });
    case 'mailchimp': {
      const dc = sec.apiKey?.split('-').pop();
      return get(`https://${dc}.api.mailchimp.com/3.0/lists/${encodeURIComponent(cfg.audienceId ?? '')}`, { Authorization: `Basic ${Buffer.from(`camplo:${sec.apiKey}`).toString('base64')}` });
    }
    case 'umami': return get(`${cfg.baseUrl}/websites/${encodeURIComponent(cfg.websiteId)}`, { 'x-umami-api-key': sec.apiKey, Authorization: `Bearer ${sec.apiKey}` });
    case 'meta_ads': return get(`https://graph.facebook.com/v21.0/${encodeURIComponent(cfg.adAccountId)}?fields=name&access_token=${encodeURIComponent(sec.accessToken)}`);
    case 'twenty_crm': return get(`${cfg.baseUrl}/rest/people?limit=1`, { Authorization: `Bearer ${sec.apiKey}` });
    case 'notifuse': return get(`${cfg.baseUrl}/api/workspaces.get?id=${encodeURIComponent(cfg.workspaceId)}`, { Authorization: `Bearer ${sec.apiKey}` });
    case 'systeme_io': return sec.apiKey ? get('https://api.systeme.io/api/contacts?limit=10', { 'X-API-Key': sec.apiKey }) : { ok: true, message: 'Webhook connection — send a test submission to confirm.' };
    case 'gohighlevel': return sec.apiKey ? get(`https://services.leadconnectorhq.com/locations/${encodeURIComponent(cfg.locationId)}`, { Authorization: `Bearer ${sec.apiKey}`, Version: '2021-07-28' }) : { ok: true, message: 'Webhook connection — send a test contact to confirm.' };
    case 'google_ads': {
      try {
        const res = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: cfg.clientId, client_secret: sec.clientSecret, refresh_token: sec.refreshToken, grant_type: 'refresh_token' }), signal: AbortSignal.timeout(10_000),
        });
        return res.ok ? { ok: true, message: 'OAuth credentials accepted.' } : { ok: false, message: `Google rejected the OAuth credentials (${res.status}).` };
      } catch (e) { return { ok: false, message: `Could not reach Google (${(e as Error).message}).` }; }
    }
    default: return { ok: true, message: 'Webhook connection — send a test event to confirm it arrives.' };
  }
}

export async function disconnectIntegration(ctx: AuthedContext, provider: Provider) {
  assertPerm(ctx, 'integrations.manage');
  const [r] = await ctx.db.select().from(integrations).where(and(eq(integrations.tenantId, ctx.tenantId), eq(integrations.provider, provider)));
  if (!r) return { ok: true };
  await ctx.db.update(integrations).set({ status: 'not_connected', apiKeyEncrypted: null, secretsEncrypted: null, oauthAccessTokenEncrypted: null, oauthRefreshTokenEncrypted: null, activeModes: [], updatedAt: new Date() })
    .where(eq(integrations.id, r.id));
  if (r.config?.inboundWebhookId) await ctx.db.update(inboundWebhooks).set({ status: 'inactive' }).where(and(eq(inboundWebhooks.tenantId, ctx.tenantId), eq(inboundWebhooks.id, r.config.inboundWebhookId)));
  await logWorkspace(ctx.db, ctx.tenantId, ctx.user.id, `Integration disconnected: ${catalogEntry(provider)?.name ?? provider}`);
  return { ok: true };
}

// ------------------------------------------------------------------ webhooks

export async function listInbound(ctx: AuthedContext) {
  const rows = await ctx.db.select({ w: inboundWebhooks, campaignName: campaigns.name }).from(inboundWebhooks).leftJoin(campaigns, eq(campaigns.id, inboundWebhooks.campaignId))
    .where(eq(inboundWebhooks.tenantId, ctx.tenantId));
  // Secrets are write-only: shown once at creation, never listed.
  return rows.map(({ w, campaignName }) => ({ id: w.id, sourceLabel: w.sourceLabel, url: w.url, lastReceivedAt: w.lastReceivedAt, status: w.status, campaignId: w.campaignId, campaignName, createdAt: w.createdAt }));
}

export async function createInbound(ctx: AuthedContext, sourceLabel: string, campaignId?: string | null) {
  assertPerm(ctx, 'integrations.manage');
  const secret = randomToken(24);
  const [w] = await ctx.db.insert(inboundWebhooks).values({ tenantId: ctx.tenantId, sourceLabel: sourceLabel.trim(), url: 'pending', secretEncrypted: encrypt(secret, 'webhook'), campaignId: campaignId ?? null }).returning();
  const url = `${config.appUrl}/api/v1/hooks/${w.id}`;
  await ctx.db.update(inboundWebhooks).set({ url }).where(eq(inboundWebhooks.id, w.id));
  return { id: w.id, sourceLabel: w.sourceLabel, url, secret, status: w.status };
}

export async function deleteInbound(ctx: AuthedContext, id: string) {
  assertPerm(ctx, 'integrations.manage');
  await ctx.db.delete(inboundWebhooks).where(and(eq(inboundWebhooks.tenantId, ctx.tenantId), eq(inboundWebhooks.id, id)));
  return { ok: true };
}

export const OUTBOUND_EVENTS = ['lead.responded', 'lead.assigned', 'lead.received', 'campaign.completed', 'sla.breached', 'deployment.ready'] as const;

export async function listOutbound(ctx: AuthedContext) {
  const rows = await ctx.db.select().from(outboundWebhooks).where(eq(outboundWebhooks.tenantId, ctx.tenantId));
  return rows.map((w) => ({ id: w.id, destinationUrl: w.destinationUrl, eventTrigger: w.eventTrigger, lastSentAt: w.lastSentAt, status: w.status, signed: !!w.secretEncrypted }));
}

export async function createOutbound(ctx: AuthedContext, input: { destinationUrl: string; eventTrigger: (typeof OUTBOUND_EVENTS)[number]; secret?: string | null }) {
  assertPerm(ctx, 'integrations.manage');
  let u: URL;
  try { u = new URL(input.destinationUrl); } catch { throw fail.bad('Enter a valid https URL.'); }
  if (u.protocol !== 'https:' && config.env === 'production') throw fail.bad('Outbound webhooks must use https.');
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(u.hostname)) throw fail.bad('Private network destinations are not allowed.');
  const [w] = await ctx.db.insert(outboundWebhooks).values({
    tenantId: ctx.tenantId, destinationUrl: u.toString(), eventTrigger: input.eventTrigger, secretEncrypted: input.secret ? encrypt(input.secret, 'webhook') : null,
  }).returning();
  return { id: w.id, destinationUrl: w.destinationUrl, eventTrigger: w.eventTrigger, status: w.status };
}

export async function deleteOutbound(ctx: AuthedContext, id: string) {
  assertPerm(ctx, 'integrations.manage');
  await ctx.db.delete(outboundWebhooks).where(and(eq(outboundWebhooks.tenantId, ctx.tenantId), eq(outboundWebhooks.id, id)));
  return { ok: true };
}

// ------------------------------------------------------------------ AI provider

async function aiConfigRow(ctx: AuthedContext) {
  const [r] = await ctx.db.select().from(aiProviderConfigs).where(eq(aiProviderConfigs.tenantId, ctx.tenantId));
  if (r) return r;
  const [n] = await ctx.db.insert(aiProviderConfigs).values({ tenantId: ctx.tenantId }).returning();
  return n;
}

export async function getAiProvider(ctx: AuthedContext) {
  assertPerm(ctx, 'ai.manage');
  const r = await aiConfigRow(ctx);
  const { advancedUsage } = await import('../ai/router.js');
  const usage = await advancedUsage(ctx.db, ctx.tenantId, ctx.plan);
  return {
    primary: { provider: r.primaryProvider, modelName: r.primaryModelName, apiKeyMasked: r.primaryApiKeyEncrypted ? mask(decrypt(r.primaryApiKeyEncrypted)) : null, status: r.primaryStatus },
    fallback: { enabled: r.fallbackEnabled, provider: r.fallbackProvider, modelName: r.fallbackModelName, apiKeyMasked: r.fallbackApiKeyEncrypted ? mask(decrypt(r.fallbackApiKeyEncrypted)) : null, status: r.fallbackStatus },
    usingFallback: r.usingFallback, refreshIntervalMinutes: r.refreshIntervalMinutes, eventTriggers: r.eventTriggers,
    camploProvidedAi: !!(await platform(ctx.db)).ai.openRouterApiKey, advancedUsage: Math.min(1, usage),
  };
}

type AiProv = NonNullable<(typeof aiProviderConfigs.$inferSelect)['primaryProvider']>;
export async function patchAiProvider(ctx: AuthedContext, p: {
  primary?: { provider?: AiProv | null; modelName?: string | null; apiKey?: string | null };
  fallback?: { enabled?: boolean; provider?: AiProv | null; modelName?: string | null; apiKey?: string | null };
  refreshIntervalMinutes?: number; eventTriggers?: string[];
}) {
  assertPerm(ctx, 'ai.manage');
  const r = await aiConfigRow(ctx);
  const set: Partial<typeof aiProviderConfigs.$inferInsert> = { updatedAt: new Date() };
  if (p.primary) {
    if (p.primary.provider !== undefined) set.primaryProvider = p.primary.provider;
    if (p.primary.modelName !== undefined) set.primaryModelName = p.primary.modelName?.trim() || null;
    if (p.primary.apiKey !== undefined) { set.primaryApiKeyEncrypted = p.primary.apiKey ? encrypt(p.primary.apiKey.trim(), 'ai') : null; set.primaryStatus = 'not_connected'; }
  }
  if (p.fallback) {
    if (p.fallback.enabled !== undefined) set.fallbackEnabled = p.fallback.enabled;
    if (p.fallback.provider !== undefined) set.fallbackProvider = p.fallback.provider;
    if (p.fallback.modelName !== undefined) set.fallbackModelName = p.fallback.modelName?.trim() || null;
    if (p.fallback.apiKey !== undefined) { set.fallbackApiKeyEncrypted = p.fallback.apiKey ? encrypt(p.fallback.apiKey.trim(), 'ai') : null; set.fallbackStatus = 'not_connected'; }
  }
  if (p.refreshIntervalMinutes !== undefined) set.refreshIntervalMinutes = Math.max(5, Math.round(p.refreshIntervalMinutes));
  if (p.eventTriggers) set.eventTriggers = p.eventTriggers.filter((t) => ['sla_breach', 'webhook_silence', 'lead_batch', 'budget_threshold'].includes(t));
  await ctx.db.update(aiProviderConfigs).set(set).where(eq(aiProviderConfigs.id, r.id));
  return getAiProvider(ctx);
}

export async function verifyAi(ctx: AuthedContext, which: 'primary' | 'fallback') {
  assertPerm(ctx, 'ai.manage');
  const r = await aiConfigRow(ctx);
  const provider = which === 'primary' ? r.primaryProvider : r.fallbackProvider;
  const key = which === 'primary' ? r.primaryApiKeyEncrypted : r.fallbackApiKeyEncrypted;
  const model = which === 'primary' ? r.primaryModelName : r.fallbackModelName;
  if (!provider || !key) throw fail.bad('Choose a provider and enter an API key first.');
  const ok = await verifyProvider(provider, model, decrypt(key));
  await ctx.db.update(aiProviderConfigs).set(which === 'primary' ? { primaryStatus: ok ? 'connected' : 'failed', usingFallback: false } : { fallbackStatus: ok ? 'connected' : 'failed' })
    .where(eq(aiProviderConfigs.id, r.id));
  return { ok, status: ok ? 'connected' : 'failed' };
}

// ------------------------------------------------------------------ Telegram

export async function getTelegram(ctx: AuthedContext) {
  assertPerm(ctx, 'telegram.manage');
  const [t] = await ctx.db.select().from(telegramConnections).where(eq(telegramConnections.tenantId, ctx.tenantId));
  const linkCode = ctx.user.id.replace(/-/g, '');
  const camploBot = (await platform(ctx.db)).telegram.botToken;
  return t
    ? { connected: t.verified, botUsername: t.botUsername, tokenMasked: mask(decrypt(t.botTokenEncrypted)), criticalAlertsEnabled: t.criticalAlertsEnabled, dailyDigestEnabled: t.dailyDigestEnabled, camploBot: false, linkCode }
    : { connected: !!camploBot, botUsername: null, tokenMasked: null, criticalAlertsEnabled: true, dailyDigestEnabled: false, camploBot: !!camploBot, linkCode };
}

export async function verifyTelegram(ctx: AuthedContext, botToken: string) {
  assertPerm(ctx, 'telegram.manage');
  const res = await verifyBot(botToken.trim());
  const values = { botTokenEncrypted: encrypt(botToken.trim(), 'telegram'), botUsername: res.username ?? null, verified: res.ok };
  await ctx.db.insert(telegramConnections).values({ tenantId: ctx.tenantId, ...values })
    .onConflictDoUpdate({ target: telegramConnections.tenantId, set: values });
  if (res.ok) {
    // Register the webhook (with its secret_token) so /start linking and Acknowledge buttons reach Camplo.
    const { registerWebhook } = await import('./telegram.js');
    await registerWebhook(botToken.trim(), ctx.tenantId);
  }
  return { ok: res.ok, botUsername: res.username ?? null };
}

export async function patchTelegram(ctx: AuthedContext, p: { criticalAlertsEnabled?: boolean; dailyDigestEnabled?: boolean }) {
  assertPerm(ctx, 'telegram.manage');
  await ctx.db.update(telegramConnections).set(p).where(eq(telegramConnections.tenantId, ctx.tenantId));
  return getTelegram(ctx);
}

export async function disconnectTelegram(ctx: AuthedContext) {
  assertPerm(ctx, 'telegram.manage');
  await ctx.db.delete(telegramConnections).where(eq(telegramConnections.tenantId, ctx.tenantId));
  return { ok: true };
}

// ------------------------------------------------------------------ notifications

export async function getNotificationSettings(ctx: AuthedContext) {
  return {
    dailyDigest: ctx.tenant.dailySummaryEnabled, dailyDigestTime: ctx.tenant.dailySummaryTime.slice(0, 5),
    slaBreachAlerts: ctx.tenant.notificationPrefs.slaBreach, slaBreachChannel: ctx.tenant.notificationPrefs.slaChannel,
    earlyWarning: ctx.tenant.notificationPrefs.earlyWarning, budgetAlerts: ctx.tenant.notificationPrefs.budget,
    webhookOffline: ctx.tenant.notificationPrefs.webhookOffline, notificationEmail: ctx.tenant.notificationEmail,
  };
}

export async function patchNotificationSettings(ctx: AuthedContext, p: {
  dailyDigest?: boolean; dailyDigestTime?: string; slaBreachAlerts?: boolean; slaBreachChannel?: 'email' | 'telegram' | 'both';
  earlyWarning?: boolean; budgetAlerts?: boolean; webhookOffline?: boolean; notificationEmail?: string;
}) {
  assertPerm(ctx, 'notifications.manage');
  const prefs = { ...ctx.tenant.notificationPrefs };
  if (p.slaBreachAlerts !== undefined) prefs.slaBreach = p.slaBreachAlerts;
  if (p.slaBreachChannel) prefs.slaChannel = p.slaBreachChannel;
  if (p.earlyWarning !== undefined) prefs.earlyWarning = p.earlyWarning;
  if (p.budgetAlerts !== undefined) prefs.budget = p.budgetAlerts;
  if (p.webhookOffline !== undefined) prefs.webhookOffline = p.webhookOffline;
  const set: Partial<typeof tenants.$inferInsert> = { notificationPrefs: prefs, urgentAlertsEnabled: prefs.slaBreach };
  if (p.dailyDigest !== undefined) set.dailySummaryEnabled = p.dailyDigest;
  if (p.dailyDigestTime) { if (!/^\d{2}:\d{2}$/.test(p.dailyDigestTime)) throw fail.bad('Use HH:MM (UTC).'); set.dailySummaryTime = `${p.dailyDigestTime}:00`; }
  if (p.notificationEmail) set.notificationEmail = p.notificationEmail;
  await ctx.db.update(tenants).set(set).where(eq(tenants.id, ctx.tenantId));
  const [t] = await ctx.db.select().from(tenants).where(eq(tenants.id, ctx.tenantId));
  return getNotificationSettings({ ...ctx, tenant: t });
}

/** Link the caller's Telegram chat (they send /start <code> to the bot). */
export async function telegramLinkCode(ctx: AuthedContext) {
  const { linkCodeFor } = await import('./telegram.js');
  return { code: linkCodeFor(ctx.user.id) };
}

