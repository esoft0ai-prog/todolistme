/**
 * Platform settings the Super Admin can change at runtime: branding, plan pricing & limits, payments (Polar),
 * email, AI, Telegram and signup. Each section is one `platform_settings` row whose values override the
 * environment; anything left empty falls back to the env var, so a fresh deploy works from env alone.
 *
 * Secret fields are stored with `encrypt()` (key family per section) and are never returned to a client —
 * `describePlatform()` masks them.
 */
import { eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { platformSettings } from '../db/schema.js';
import { config } from './config.js';
import { decrypt, encrypt, mask, type KeyPurpose } from './crypto.js';
import { DEEP_BUDGET_USD, PLAN_LIMITS, PLAN_PRICE, type Plan } from '../domain/rules.js';

export const PLANS: Plan[] = ['starter', 'growth', 'watchtower', 'agency'];
type Limits = { campaigns: number; deployments: number; members: number; connectedTools: number };

export interface PlatformSettings {
  branding: { productName: string; tagline: string; supportEmail: string; emailFromName: string };
  pricing: {
    currency: string;
    plans: Record<Plan, { price: number; limits: Limits; deepBudgetUsd: number }>;
    addOns: { extraDeploymentMonthly: number };
  };
  billing: {
    polarAccessToken: string; polarWebhookSecret: string; polarOrganizationId: string; polarApiUrl: string;
    productIds: Record<Plan, string>; checkoutUrls: Record<Plan, string>; allowDirectPlanChange: boolean;
  };
  email: { smtpHost: string; smtpPort: number; smtpUser: string; smtpPass: string; fromAddress: string; resendApiKey: string };
  ai: { openRouterApiKey: string; defaultProvider: string; models: Record<'quick' | 'standard' | 'deep' | 'strategic', string> };
  telegram: { botToken: string; webhookSecret: string };
  signup: { autoActivate: boolean; defaultPlan: Plan };
}
export type Section = keyof PlatformSettings;
export const SECTIONS: Section[] = ['branding', 'pricing', 'billing', 'email', 'ai', 'telegram', 'signup'];

/** Fields that are secrets, per section, and the key family that seals them. */
export const SECRETS: Partial<Record<Section, { purpose: KeyPurpose; fields: string[] }>> = {
  billing: { purpose: 'integration', fields: ['polarAccessToken', 'polarWebhookSecret'] },
  email: { purpose: 'integration', fields: ['smtpPass', 'resendApiKey'] },
  ai: { purpose: 'ai', fields: ['openRouterApiKey'] },
  telegram: { purpose: 'telegram', fields: ['botToken', 'webhookSecret'] },
};

const fin = (n: number) => (Number.isFinite(n) ? n : -1); // -1 = unlimited (JSON has no Infinity)
const perPlan = <T>(f: (p: Plan) => T) => Object.fromEntries(PLANS.map((p) => [p, f(p)])) as Record<Plan, T>;

/** Everything as the environment / built-in defaults define it. */
function defaults(): PlatformSettings {
  const smtpFrom = config.emailFrom;
  return {
    branding: { productName: 'Camplo', tagline: 'See everything. Miss nothing.', supportEmail: config.supportEmail, emailFromName: smtpFrom.replace(/\s*<.*$/, '') || 'Camplo' },
    pricing: {
      currency: 'USD',
      plans: perPlan((p) => ({ price: PLAN_PRICE[p], deepBudgetUsd: DEEP_BUDGET_USD[p], limits: Object.fromEntries(Object.entries(PLAN_LIMITS[p]).map(([k, v]) => [k, fin(v)])) as Limits })),
      addOns: { extraDeploymentMonthly: 15 },
    },
    billing: {
      polarAccessToken: config.polarAccessToken, polarWebhookSecret: config.polarWebhookSecret, polarOrganizationId: config.polarOrganizationId,
      polarApiUrl: config.polarApiUrl, productIds: perPlan((p) => config.polarProductId(p)),
      checkoutUrls: perPlan((p) => process.env[`POLAR_CHECKOUT_URL_${p.toUpperCase()}`] ?? ''),
      allowDirectPlanChange: process.env.ALLOW_DIRECT_PLAN_CHANGE === 'true',
    },
    email: {
      smtpHost: config.smtp.host, smtpPort: config.smtp.port, smtpUser: config.smtp.user, smtpPass: config.smtp.pass,
      fromAddress: smtpFrom, resendApiKey: config.resendApiKey,
    },
    ai: { openRouterApiKey: config.openRouterApiKey, defaultProvider: config.defaultAiProvider, models: { ...config.models } },
    telegram: { botToken: config.telegramBotToken, webhookSecret: config.telegramWebhookSecret },
    signup: { autoActivate: process.env.AUTO_ACTIVATE === 'true', defaultPlan: 'growth' },
  };
}

/** Deep-merge: override wins wherever it holds a real value ('' / null keep the default). */
function merge<T>(base: T, over: unknown): T {
  if (over == null || typeof over !== 'object' || Array.isArray(over)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    if (v === '' || v == null) continue;
    const b = out[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) && typeof v === 'object' ? merge(b, v) : v;
  }
  return out as T;
}

let cache: { at: number; value: PlatformSettings; stored: Partial<Record<Section, Record<string, unknown>>> } | null = null;
let dbRef: DB | null = null;
const TTL_MS = 15_000;

export function bindPlatformDb(db: DB) { dbRef = db; }
export function invalidatePlatform() { cache = null; }

async function load(db: DB) {
  const rows = await db.select().from(platformSettings);
  const stored: Partial<Record<Section, Record<string, unknown>>> = {};
  for (const r of rows) {
    const v = { ...r.value };
    for (const f of SECRETS[r.section as Section]?.fields ?? []) {
      if (typeof v[f] === 'string' && v[f]) { try { v[f] = decrypt(v[f] as string); } catch { v[f] = ''; } }
    }
    stored[r.section as Section] = v;
  }
  const base = defaults();
  const value = Object.fromEntries(SECTIONS.map((s) => [s, merge(base[s], stored[s])])) as unknown as PlatformSettings;
  return { value, stored };
}

/** Resolved platform settings (cached for a few seconds so edits reach every instance quickly). */
export async function platform(db?: DB): Promise<PlatformSettings> {
  const d = db ?? dbRef;
  if (!d) return defaults();
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  try {
    const { value, stored } = await load(d);
    cache = { at: Date.now(), value, stored };
    return value;
  } catch {
    return cache?.value ?? defaults(); // table missing during first migration, etc.
  }
}

/** Last resolved value without I/O — for synchronous code paths (e.g. email subject branding). */
export function platformSync(): PlatformSettings { return cache?.value ?? defaults(); }

/** Plan limits with -1 turned back into Infinity. */
export async function planLimits(plan: Plan, db?: DB): Promise<Limits> {
  const l = (await platform(db)).pricing.plans[plan].limits;
  return Object.fromEntries(Object.entries(l).map(([k, v]) => [k, v < 0 ? Infinity : v])) as Limits;
}
export async function planPrice(plan: Plan, db?: DB) { return (await platform(db)).pricing.plans[plan].price; }

/** Super Admin view: resolved values, which fields are overridden, secrets masked. */
export async function describePlatform(db: DB) {
  invalidatePlatform();
  const value = await platform(db);
  const stored = cache?.stored ?? {};
  const base = defaults();
  const out: Record<string, unknown> = {};
  for (const s of SECTIONS) {
    const v = JSON.parse(JSON.stringify(value[s])) as Record<string, unknown>;
    const secrets: Record<string, { set: boolean; masked: string | null; source: 'admin' | 'env' | 'none' }> = {};
    for (const f of SECRETS[s]?.fields ?? []) {
      const val = v[f] as string;
      const fromAdmin = !!(stored[s] && stored[s]![f]);
      secrets[f] = { set: !!val, masked: val ? mask(val) : null, source: fromAdmin ? 'admin' : (base[s] as Record<string, unknown>)[f] ? 'env' : 'none' };
      delete v[f];
    }
    out[s] = { values: v, secrets, overridden: Object.keys(stored[s] ?? {}) };
  }
  return out;
}

/**
 * Save a section. Plain fields replace the stored override; `null` removes an override (back to env).
 * Secret fields: undefined keeps, '' clears the admin value (env applies again), anything else is encrypted.
 */
export async function savePlatformSection(db: DB, section: Section, patch: Record<string, unknown>, adminId: string) {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.section, section));
  const current: Record<string, unknown> = { ...(row?.value ?? {}) };
  const secretSpec = SECRETS[section];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (secretSpec?.fields.includes(k)) {
      if (v === '' || v === null) delete current[k];
      else current[k] = encrypt(String(v), secretSpec.purpose);
      continue;
    }
    if (v === null) delete current[k];
    else current[k] = v;
  }
  await db.insert(platformSettings).values({ section, value: current, updatedBy: adminId, updatedAt: new Date() })
    .onConflictDoUpdate({ target: platformSettings.section, set: { value: current, updatedBy: adminId, updatedAt: new Date() } });
  invalidatePlatform();
  return platform(db);
}

/** Public, non-secret subset for the web client (branding + prices shown on signup/upgrade). */
export async function publicPlatform(db?: DB) {
  const p = await platform(db);
  return {
    productName: p.branding.productName, tagline: p.branding.tagline, supportEmail: p.branding.supportEmail,
    currency: p.pricing.currency, prices: perPlan((pl) => p.pricing.plans[pl].price),
    limits: perPlan((pl) => p.pricing.plans[pl].limits), extraDeploymentMonthly: p.pricing.addOns.extraDeploymentMonthly,
  };
}
