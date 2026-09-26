/** Integrations, webhooks, AI provider, Telegram and notification settings (Screen 20). */
import { planLimits, platform } from '../lib/platform.js';
import { and, eq, sql } from 'drizzle-orm';
import { aiProviderConfigs, inboundWebhooks, integrations, outboundWebhooks, telegramConnections, tenants } from '../db/schema.js';
import { fail, assertRole, type AuthedContext } from '../lib/orpc.js';
import { config } from '../lib/config.js';
import { decrypt, encrypt, mask, randomToken } from '../lib/crypto.js';
import { verifyBot } from '../lib/telegram.js';
import { PLAN_LIMITS } from '../domain/rules.js';
import { verifyProvider } from '../ai/router.js';
import { logWorkspace } from './effects.js';
import { campaigns } from '../db/schema.js';

type Provider = (typeof integrations.$inferSelect)['provider'];
type Mode = 'receive' | 'send' | 'query';

/** Integration catalog (Design Spec §13 Integrations tab + PRD §11). */
export const CATALOG: Array<{ provider: Provider; name: string; category: string; methods: Array<'webhook' | 'api_key' | 'oauth'>; modes: Mode[]; comingSoon?: boolean; blurb?: string }> = [
  { provider: 'systeme_io', name: 'Systeme.io', category: 'Lead sources', methods: ['webhook', 'api_key'], modes: ['receive', 'query'] },
  { provider: 'gohighlevel', name: 'GoHighLevel', category: 'Lead sources', methods: ['webhook', 'api_key'], modes: ['receive', 'send', 'query'] },
  { provider: 'tally', name: 'Tally', category: 'Lead sources', methods: ['webhook'], modes: ['receive'] },
  { provider: 'typeform', name: 'Typeform', category: 'Lead sources', methods: ['webhook'], modes: ['receive'] },
  { provider: 'custom', name: 'Custom', category: 'Lead sources', methods: ['webhook', 'api_key'], modes: ['receive', 'send'] },
  { provider: 'instantly', name: 'Instantly', category: 'Cold outreach (warm replies)', methods: ['webhook'], modes: ['receive'], blurb: 'Receive warm replies from your Instantly campaigns as Camplo leads. Camplo\'s accountability layer begins the moment a prospect responds.' },
  { provider: 'apollo', name: 'Apollo', category: 'Cold outreach (warm replies)', methods: ['webhook'], modes: ['receive'], blurb: 'Receive warm replies from your Apollo campaigns as Camplo leads. Camplo\'s accountability layer begins the moment a prospect responds.' },
  { provider: 'lemlist', name: 'Lemlist', category: 'Cold outreach (warm replies)', methods: ['webhook'], modes: ['receive'], blurb: 'Receive warm replies from your Lemlist campaigns as Camplo leads.' },
  { provider: 'smartlead', name: 'Smartlead', category: 'Cold outreach (warm replies)', methods: ['webhook'], modes: ['receive'], blurb: 'Receive warm replies from your Smartlead campaigns as Camplo leads.' },
  { provider: 'twenty_crm', name: 'Twenty CRM', category: 'CRM', methods: ['webhook', 'api_key'], modes: ['receive', 'send', 'query'] },
  { provider: 'hubspot', name: 'HubSpot', category: 'CRM', methods: ['oauth'], modes: ['receive', 'query'], comingSoon: true },
  { provider: 'salesforce', name: 'Salesforce', category: 'CRM', methods: ['oauth'], modes: ['receive', 'query'], comingSoon: true },
  { provider: 'umami', name: 'Umami', category: 'Analytics', methods: ['api_key'], modes: ['query'] },
  { provider: 'activecampaign', name: 'ActiveCampaign', category: 'Email platform', methods: ['api_key'], modes: ['query'] },
  { provider: 'mailchimp', name: 'Mailchimp', category: 'Email platform', methods: ['api_key'], modes: ['query'] },
  { provider: 'brevo', name: 'Brevo', category: 'Email platform', methods: ['api_key'], modes: ['query'] },
  { provider: 'notifuse', name: 'Notifuse', category: 'Email platform', methods: ['api_key'], modes: ['query'] },
  { provider: 'meta_ads', name: 'Meta Ads', category: 'Ad platforms', methods: ['api_key'], modes: ['query'] },
  { provider: 'google_ads', name: 'Google Ads', category: 'Ad platforms', methods: ['api_key'], modes: ['query'] },
  { provider: 'slack', name: 'Slack', category: 'Team communication', methods: ['oauth'], modes: ['query'], comingSoon: true },
  { provider: 'zapier', name: 'Zapier', category: 'Automation', methods: ['webhook'], modes: ['receive', 'send'] },
  { provider: 'make', name: 'Make', category: 'Automation', methods: ['webhook'], modes: ['receive', 'send'] },
];

export async function listIntegrations(ctx: AuthedContext) {
  const rows = await ctx.db.select().from(integrations).where(eq(integrations.tenantId, ctx.tenantId));
  return CATALOG.map((c) => {
    const r = rows.find((x) => x.provider === c.provider);
    return {
      ...c, id: r?.id ?? null,
      status: c.comingSoon ? 'coming_soon' : r?.status ?? 'not_connected',
      connectionMethod: r?.connectionMethod ?? null, activeModes: r?.activeModes ?? [],
      apiKeyMasked: r?.apiKeyEncrypted ? mask(decrypt(r.apiKeyEncrypted)) : null,
      webhookUrl: r?.webhookUrl ?? null, lastVerifiedAt: r?.lastVerifiedAt ?? null,
    };
  });
}

export async function connectIntegration(ctx: AuthedContext, provider: Provider, input: { apiKey?: string | null; method?: 'webhook' | 'api_key' | 'oauth' }) {
  assertRole(ctx, 'owner', 'admin');
  const cat = CATALOG.find((c) => c.provider === provider);
  if (!cat) throw fail.notFound('Unknown integration.');
  if (cat.comingSoon) throw fail.bad(`${cat.name} is coming soon.`);
  const [existing] = await ctx.db.select().from(integrations).where(and(eq(integrations.tenantId, ctx.tenantId), eq(integrations.provider, provider)));
  if (!existing || existing.status !== 'connected') {
    const toolCats = ['CRM', 'Email platform', 'Ad platforms', 'Team communication', 'Analytics'];
    if (toolCats.includes(cat.category)) {
      const [{ n }] = await ctx.db.select({ n: sql<number>`count(*)` }).from(integrations)
        .where(and(eq(integrations.tenantId, ctx.tenantId), eq(integrations.status, 'connected'), sql`${integrations.provider} in ('twenty_crm','gohighlevel','hubspot','salesforce','activecampaign','mailchimp','brevo','notifuse','meta_ads','google_ads','slack','umami')`));
      if (Number(n) >= (await planLimits(ctx.plan, ctx.db)).connectedTools) {
        throw fail.planLimit(ctx.plan === 'starter' ? 'Connected tools are available on Growth.' : 'Growth includes one connected tool. Upgrade to Watchtower for unlimited tools.', ctx.plan === 'starter' ? 'growth' : 'watchtower');
      }
    }
  }
  const method = input.method ?? (input.apiKey ? 'api_key' : cat.methods[0]);
  if (method === 'api_key' && !input.apiKey?.trim()) throw fail.bad('Enter an API key.');
  const webhookUrl = cat.methods.includes('webhook') ? existing?.webhookUrl ?? `${config.appUrl}/api/v1/lifecycle/{id}/${randomToken(18)}` : null;
  const activeModes: Mode[] = cat.modes.filter((m) => (m === 'receive' ? cat.methods.includes('webhook') : m === 'query' ? !!input.apiKey || !!existing?.apiKeyEncrypted : true));
  const values = {
    tenantId: ctx.tenantId, provider, connectionMethod: method,
    apiKeyEncrypted: input.apiKey ? encrypt(input.apiKey.trim(), 'integration') : existing?.apiKeyEncrypted ?? null,
    status: 'connected' as const, activeModes, lastVerifiedAt: new Date(), updatedAt: new Date(),
  };
  const [row] = existing
    ? await ctx.db.update(integrations).set(values).where(eq(integrations.id, existing.id)).returning()
    : await ctx.db.insert(integrations).values({ ...values, webhookUrl: null }).returning();
  if (webhookUrl) await ctx.db.update(integrations).set({ webhookUrl: webhookUrl.replace('{id}', row.id) }).where(eq(integrations.id, row.id));
  await logWorkspace(ctx.db, ctx.tenantId, ctx.user.id, `Integration connected: ${cat.name}`);
  return (await listIntegrations(ctx)).find((i) => i.provider === provider);
}

/** Credential check. Provider-specific probes run where an unauthenticated-safe endpoint exists. */
export async function verifyIntegration(ctx: AuthedContext, provider: Provider) {
  const [r] = await ctx.db.select().from(integrations).where(and(eq(integrations.tenantId, ctx.tenantId), eq(integrations.provider, provider)));
  if (!r) throw fail.notFound('Integration not connected.');
  let ok = r.connectionMethod !== 'api_key' || !!r.apiKeyEncrypted;
  if (ok && r.apiKeyEncrypted && provider === 'brevo') {
    const res = await fetch('https://api.brevo.com/v3/account', { headers: { 'api-key': decrypt(r.apiKeyEncrypted) }, signal: AbortSignal.timeout(8000) }).catch(() => null);
    ok = !!res?.ok;
  }
  await ctx.db.update(integrations).set({ status: ok ? 'connected' : 'failed', lastVerifiedAt: new Date() }).where(eq(integrations.id, r.id));
  return { ok, status: ok ? 'connected' : 'failed' };
}

export async function disconnectIntegration(ctx: AuthedContext, provider: Provider) {
  assertRole(ctx, 'owner', 'admin');
  await ctx.db.update(integrations).set({ status: 'not_connected', apiKeyEncrypted: null, oauthAccessTokenEncrypted: null, oauthRefreshTokenEncrypted: null, activeModes: [], updatedAt: new Date() })
    .where(and(eq(integrations.tenantId, ctx.tenantId), eq(integrations.provider, provider)));
  await logWorkspace(ctx.db, ctx.tenantId, ctx.user.id, `Integration disconnected: ${provider}`);
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
  assertRole(ctx, 'owner', 'admin');
  const secret = randomToken(24);
  const [w] = await ctx.db.insert(inboundWebhooks).values({ tenantId: ctx.tenantId, sourceLabel: sourceLabel.trim(), url: 'pending', secretEncrypted: encrypt(secret, 'webhook'), campaignId: campaignId ?? null }).returning();
  const url = `${config.appUrl}/api/v1/hooks/${w.id}`;
  await ctx.db.update(inboundWebhooks).set({ url }).where(eq(inboundWebhooks.id, w.id));
  return { id: w.id, sourceLabel: w.sourceLabel, url, secret, status: w.status };
}

export async function deleteInbound(ctx: AuthedContext, id: string) {
  assertRole(ctx, 'owner', 'admin');
  await ctx.db.delete(inboundWebhooks).where(and(eq(inboundWebhooks.tenantId, ctx.tenantId), eq(inboundWebhooks.id, id)));
  return { ok: true };
}

export const OUTBOUND_EVENTS = ['lead.responded', 'lead.assigned', 'lead.received', 'campaign.completed', 'sla.breached', 'deployment.ready'] as const;

export async function listOutbound(ctx: AuthedContext) {
  const rows = await ctx.db.select().from(outboundWebhooks).where(eq(outboundWebhooks.tenantId, ctx.tenantId));
  return rows.map((w) => ({ id: w.id, destinationUrl: w.destinationUrl, eventTrigger: w.eventTrigger, lastSentAt: w.lastSentAt, status: w.status, signed: !!w.secretEncrypted }));
}

export async function createOutbound(ctx: AuthedContext, input: { destinationUrl: string; eventTrigger: (typeof OUTBOUND_EVENTS)[number]; secret?: string | null }) {
  assertRole(ctx, 'owner', 'admin');
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
  assertRole(ctx, 'owner', 'admin');
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
  assertRole(ctx, 'owner');
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
  assertRole(ctx, 'owner');
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
  assertRole(ctx, 'owner');
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
  assertRole(ctx, 'owner');
  const [t] = await ctx.db.select().from(telegramConnections).where(eq(telegramConnections.tenantId, ctx.tenantId));
  const linkCode = ctx.user.id.replace(/-/g, '');
  const camploBot = (await platform(ctx.db)).telegram.botToken;
  return t
    ? { connected: t.verified, botUsername: t.botUsername, tokenMasked: mask(decrypt(t.botTokenEncrypted)), criticalAlertsEnabled: t.criticalAlertsEnabled, dailyDigestEnabled: t.dailyDigestEnabled, camploBot: false, linkCode }
    : { connected: !!camploBot, botUsername: null, tokenMasked: null, criticalAlertsEnabled: true, dailyDigestEnabled: false, camploBot: !!camploBot, linkCode };
}

export async function verifyTelegram(ctx: AuthedContext, botToken: string) {
  assertRole(ctx, 'owner');
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
  assertRole(ctx, 'owner');
  await ctx.db.update(telegramConnections).set(p).where(eq(telegramConnections.tenantId, ctx.tenantId));
  return getTelegram(ctx);
}

export async function disconnectTelegram(ctx: AuthedContext) {
  assertRole(ctx, 'owner');
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
  assertRole(ctx, 'owner');
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

