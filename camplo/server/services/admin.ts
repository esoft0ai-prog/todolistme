/**
 * Super Admin (Screens 23–25) and Polar.sh billing webhooks. Super admins are
 * not tenant users: they sign in with email + password + TOTP and receive a
 * short-lived admin JWT. They never see lead or deployment content, nor AI keys.
 */
import { platform } from '../lib/platform.js';
import { scheduleSuspensionGrace, SUSPENDED_OFFLINE } from '../jobs/scheduler.js';
import { planForProduct } from '../lib/polar.js';
import { createHmac } from 'node:crypto';
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { SignJWT, jwtVerify } from 'jose';
import type { DB } from '../db/client.js';
import { adminActionLog, aiProviderConfigs, campaignRetrospectives, deployments, leads, superAdmins, tenants, users, webhookSources } from '../db/schema.js';
import { checkPassword, hashPassword } from '../lib/auth.js';
import { config } from '../lib/config.js';
import { decrypt, encrypt, safeEqual } from '../lib/crypto.js';
import { emails, sendMail } from '../lib/mailer.js';
import { fail } from '../lib/orpc.js';
import { ensureBank } from '../ai/memory.js';
import { webhookState } from '../domain/rules.js';

// ------------------------------------------------------------------ TOTP (RFC 6238, SHA-1, 30s, 6 digits)

function base32Decode(s: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) { const v = alphabet.indexOf(c); if (v >= 0) bits += v.toString(2).padStart(5, '0'); }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totp(secretB32: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', base32Decode(secretB32)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}

export function verifyTotp(secretB32: string, code: string): boolean {
  return [-1, 0, 1].some((w) => safeEqual(totp(secretB32, Date.now() + w * 30_000), code.trim()));
}

// ------------------------------------------------------------------ admin auth

const adminSecret = () => new TextEncoder().encode(`${config.jwtSecret}:admin`);

/** Bootstraps the first super admin from SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD / SUPER_ADMIN_TOTP_SECRET. */
export async function ensureSuperAdmin(db: DB) {
  if (!config.superAdminEmail || !config.superAdminPassword) return;
  const [a] = await db.select().from(superAdmins).where(eq(superAdmins.email, config.superAdminEmail));
  if (a) return;
  await db.insert(superAdmins).values({
    email: config.superAdminEmail, passwordHash: await hashPassword(config.superAdminPassword),
    totpSecretEncrypted: config.adminTotpSecret ? encrypt(config.adminTotpSecret) : null,
  });
}

export async function adminLogin(db: DB, email: string, password: string, code: string) {
  await ensureSuperAdmin(db);
  const [a] = await db.select().from(superAdmins).where(eq(superAdmins.email, email));
  if (!a || !(await checkPassword(password, a.passwordHash))) throw fail.unauthorized('Incorrect credentials.');
  if (!a.totpSecretEncrypted || !verifyTotp(decrypt(a.totpSecretEncrypted), code)) throw fail.unauthorized('Incorrect credentials.');
  const token = await new SignJWT({ admin: true }).setProtectedHeader({ alg: 'HS256' }).setSubject(a.id).setIssuedAt().setExpirationTime('2h').sign(adminSecret());
  return { token };
}

export async function verifyAdminToken(token: string | null): Promise<string> {
  if (!token) throw fail.unauthorized();
  try {
    const { payload } = await jwtVerify(token, adminSecret(), { algorithms: ['HS256'] });
    if (payload.admin !== true || !payload.sub) throw new Error('not admin');
    return payload.sub;
  } catch {
    throw fail.unauthorized();
  }
}

// ------------------------------------------------------------------ accounts

export async function listAccounts(db: DB) {
  const rows = await db.select().from(tenants).orderBy(desc(tenants.createdAt));
  const counts = await db.select({ t: leads.tenantId, n: sql<number>`count(*)` }).from(leads).groupBy(leads.tenantId);
  return rows.map((t) => ({
    id: t.id, businessName: t.businessName, ownerName: t.ownerName, ownerEmail: t.ownerEmail, status: t.status, plan: t.plan,
    monthlyFee: t.monthlyFeeOverride == null ? null : Number(t.monthlyFeeOverride), createdAt: t.createdAt, activatedAt: t.activatedAt,
    leadCount: Number(counts.find((c) => c.t === t.id)?.n ?? 0),
  }));
}

export async function accountDetail(db: DB, id: string) {
  const [t] = await db.select().from(tenants).where(eq(tenants.id, id));
  if (!t) throw fail.notFound('Account not found.');
  const [d] = await db.select({ n: sql<number>`count(*)` }).from(deployments).where(eq(deployments.tenantId, id));
  const [l] = await db.select({ n: sql<number>`count(*)` }).from(leads).where(eq(leads.tenantId, id));
  const [ai] = await db.select({ has: sql<boolean>`${aiProviderConfigs.primaryApiKeyEncrypted} is not null` }).from(aiProviderConfigs).where(eq(aiProviderConfigs.tenantId, id));
  const history = await db.select().from(adminActionLog).where(eq(adminActionLog.targetTenantId, id)).orderBy(desc(adminActionLog.createdAt));
  return {
    ...(await listAccounts(db)).find((a) => a.id === id)!, polarCustomerId: t.polarCustomerId, polarSubscriptionId: t.polarSubscriptionId,
    deploymentCount: Number(d.n), leadCount: Number(l.n), aiKeyConfigured: !!ai?.has,
    storageQuotaGb: Math.round((t.storageQuotaBytes / 1024 ** 3) * 10) / 10, storageUsedMb: Math.round(t.storageUsedBytes / 1024 ** 2),
    notificationEmail: t.notificationEmail, slaThresholdMinutes: t.slaThresholdMinutes, setupComplete: t.setupComplete,
    history: history.map((h) => ({ action: h.action, note: h.note, createdAt: h.createdAt })),
  };
}

async function logAdmin(db: DB, adminId: string, action: string, tenantId: string, note?: string) {
  await db.insert(adminActionLog).values({ adminId, action, targetTenantId: tenantId, note: note ?? null });
}

export async function setAccountStatus(db: DB, adminId: string, id: string, status: 'active' | 'suspended' | 'flagged') {
  const [t] = await db.update(tenants).set({
    status, ...(status === 'active' ? { activatedAt: new Date(), suspendedAt: null } : {}), ...(status === 'suspended' ? { suspendedAt: new Date() } : {}),
  }).where(eq(tenants.id, id)).returning();
  if (!t) throw fail.notFound('Account not found.');
  await logAdmin(db, adminId, status === 'active' ? 'activate' : status === 'suspended' ? 'suspend' : 'flag', id);
  if (status === 'active') {
    // Pages taken offline by the suspension grace job come back; their files were never removed (D-2).
    await db.update(deployments).set({ status: 'ready', failureReason: null }).where(and(eq(deployments.tenantId, t.id), eq(deployments.status, 'deleted'), eq(deployments.failureReason, SUSPENDED_OFFLINE)));
    await ensureBank(t.id, t.businessName); await sendMail(emails.activated(t.ownerEmail));
  }
  if (status === 'suspended') await scheduleSuspensionGrace(t.id);
  return { ok: true, status };
}

export async function setAccountPricing(db: DB, adminId: string, id: string, monthlyFee: number) {
  await db.update(tenants).set({ monthlyFeeOverride: monthlyFee.toFixed(2) }).where(eq(tenants.id, id));
  await logAdmin(db, adminId, 'price_change', id, `Monthly fee set to $${monthlyFee.toFixed(2)}`);
  // Polar subscription price update happens via POLAR_ACCESS_TOKEN when configured (not called in tests).
  return { ok: true };
}

export async function addAccountNote(db: DB, adminId: string, id: string, note: string) {
  await logAdmin(db, adminId, 'note', id, note);
  return { ok: true };
}

/** Super Admin can change any account field that isn't lead/page content. */
export async function updateAccount(db: DB, adminId: string, id: string, p: {
  businessName?: string; ownerName?: string; ownerEmail?: string; plan?: 'starter' | 'growth' | 'watchtower' | 'agency';
  storageQuotaGb?: number; monthlyFee?: number | null; notificationEmail?: string;
  slaThresholdMinutes?: number; setupComplete?: boolean;
}) {
  const [t] = await db.select().from(tenants).where(eq(tenants.id, id));
  if (!t) throw fail.notFound('Account not found.');
  const set: Partial<typeof tenants.$inferInsert> = {};
  const changes: string[] = [];
  if (p.businessName !== undefined && p.businessName !== t.businessName) { set.businessName = p.businessName.trim(); changes.push(`name → ${set.businessName}`); }
  if (p.ownerName !== undefined && p.ownerName !== t.ownerName) { set.ownerName = p.ownerName.trim(); changes.push(`owner name → ${set.ownerName}`); }
  if (p.ownerEmail !== undefined && p.ownerEmail.toLowerCase() !== t.ownerEmail) {
    const email = p.ownerEmail.toLowerCase();
    const [dup] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.ownerEmail, email));
    if (dup && dup.id !== id) throw fail.conflict('Another account already uses that owner email.', 'duplicate_email');
    set.ownerEmail = email; changes.push(`owner email → ${email}`);
  }
  if (p.plan !== undefined && p.plan !== t.plan) { set.plan = p.plan; changes.push(`plan ${t.plan} → ${p.plan}`); }
  if (p.storageQuotaGb !== undefined) { set.storageQuotaBytes = Math.round(p.storageQuotaGb * 1024 ** 3); changes.push(`storage quota → ${p.storageQuotaGb} GB`); }
  if (p.monthlyFee !== undefined) { set.monthlyFeeOverride = p.monthlyFee == null ? null : p.monthlyFee.toFixed(2); changes.push(p.monthlyFee == null ? 'fee override removed' : `fee → $${p.monthlyFee.toFixed(2)}`); }
  if (p.notificationEmail !== undefined) { set.notificationEmail = p.notificationEmail; changes.push(`notification email → ${p.notificationEmail}`); }
  if (p.slaThresholdMinutes !== undefined) { set.slaThresholdMinutes = p.slaThresholdMinutes; changes.push(`SLA threshold → ${p.slaThresholdMinutes} min`); }
  if (p.setupComplete !== undefined) { set.setupComplete = p.setupComplete; changes.push(`setup complete → ${p.setupComplete}`); }
  if (!changes.length) return accountDetail(db, id);
  await db.update(tenants).set(set).where(eq(tenants.id, id));
  if (set.ownerEmail) await db.update(users).set({ email: set.ownerEmail }).where(and(eq(users.tenantId, id), eq(users.role, 'owner'), eq(users.email, t.ownerEmail)));
  await logAdmin(db, adminId, 'account_update', id, changes.join('; '));
  return accountDetail(db, id);
}

/** Platform-wide change (no target account) — kept in the same audit log. */
export async function logPlatformChange(db: DB, adminId: string, action: string, note: string) {
  await db.insert(adminActionLog).values({ adminId, action, targetTenantId: null, note });
}

export async function platformHistory(db: DB) {
  const rows = await db.select().from(adminActionLog).where(isNull(adminActionLog.targetTenantId)).orderBy(desc(adminActionLog.createdAt)).limit(50);
  return rows.map((h) => ({ action: h.action, note: h.note, createdAt: h.createdAt }));
}

/** D-NEW-14: retrospectives are permanent; only the Super Admin can explicitly regenerate one. */
export async function regenerateRetrospective(db: DB, adminId: string, tenantId: string, campaignId: string) {
  const [r] = await db.update(campaignRetrospectives).set({ generated: false, generatedAt: null, pdfUrl: null })
    .where(and(eq(campaignRetrospectives.tenantId, tenantId), eq(campaignRetrospectives.campaignId, campaignId))).returning();
  if (!r) throw fail.notFound('No retrospective exists for this campaign.');
  await logAdmin(db, adminId, 'regenerate_retrospective', tenantId, `Campaign ${campaignId}`);
  const { enqueue } = await import('../jobs/scheduler.js');
  await enqueue('retrospective-generation', { tenantId, campaignId });
  return { ok: true, generated: false };
}

export async function systemHealth(db: DB, queueDepth: number) {
  const since = new Date(Date.now() - 24 * 3600_000);
  const startToday = new Date(); startToday.setUTCHours(0, 0, 0, 0);
  const [today] = await db.select({ n: sql<number>`count(*)` }).from(leads).where(gte(leads.receivedAt, startToday));
  const sources = await db.select({ label: webhookSources.label, last: webhookSources.lastReceivedAt, thr: webhookSources.staleThresholdMinutes, tenant: tenants.businessName })
    .from(webhookSources).innerJoin(tenants, eq(tenants.id, webhookSources.tenantId));
  const stale = sources.filter((s) => ['stale', 'offline'].includes(webhookState(s.last, s.thr)));
  return {
    leadsIngestedToday: Number(today.n), ingestionErrorRate24h: ingestErrors.rate(since),
    activeWebhookSources: sources.length - stale.length,
    staleSources: stale.map((s) => ({ deployment_label: s.label, tenant_name: s.tenant, last_received_at: s.last })),
    queueDepth, queueWarning: queueDepth > 100,
  };
}

/** In-process ingestion outcome counter feeding the health screen. */
export const ingestErrors = {
  events: [] as Array<{ at: number; ok: boolean }>,
  record(ok: boolean) { this.events.push({ at: Date.now(), ok }); if (this.events.length > 5000) this.events.shift(); },
  rate(since: Date) {
    const e = this.events.filter((x) => x.at >= since.getTime());
    return e.length ? e.filter((x) => !x.ok).length / e.length : 0;
  },
};

// ------------------------------------------------------------------ Polar.sh webhooks

/**
 * Polar uses Standard Webhooks signing: header `webhook-signature: v1,<base64 hmac>`
 * over `${webhook-id}.${webhook-timestamp}.${body}` with the base64 secret.
 */
export async function verifyPolarSignature(raw: Buffer, headers: Record<string, string | string[] | undefined>): Promise<boolean> {
  const webhookSecret = (await platform()).billing.polarWebhookSecret;
  if (!webhookSecret) return false;
  const id = String(headers['webhook-id'] ?? ''), ts = String(headers['webhook-timestamp'] ?? ''), sig = String(headers['webhook-signature'] ?? '');
  if (!id || !ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const secret = webhookSecret.replace(/^(whsec_|polar_whs_)/, '');
  const key = /^[A-Za-z0-9+/=]+$/.test(secret) ? Buffer.from(secret, 'base64') : Buffer.from(secret);
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${raw.toString('utf8')}`).digest('base64');
  return sig.split(' ').some((s) => safeEqual(s.replace(/^v1,/, ''), expected));
}

export async function handlePolarEvent(db: DB, evt: { type: string; data: any }) {
  const d = evt.data ?? {};
  const email: string | undefined = d.customer?.email ?? d.customer_email ?? d.user?.email;
  const tenantId: string | undefined = d.metadata?.tenant_id ?? d.customer?.metadata?.tenant_id;
  const [t] = tenantId
    ? await db.select().from(tenants).where(eq(tenants.id, tenantId))
    : email ? await db.select().from(tenants).where(eq(tenants.ownerEmail, email.toLowerCase())) : [];
  if (!t) return { handled: false };
  const plan = await planForProduct(d.product_id ?? d.product?.id, d.metadata?.plan, d.product?.name ?? d.subscription?.product?.name);
  switch (evt.type) {
    case 'order.created':
    case 'checkout.created':
      await db.update(tenants).set({ polarOrderId: d.id ?? t.polarOrderId, polarCustomerId: d.customer_id ?? d.customer?.id ?? t.polarCustomerId }).where(eq(tenants.id, t.id));
      if (evt.type === 'order.created') await sendMail(emails.paymentReceived(t.ownerEmail, d.amount ? `$${(d.amount / 100).toFixed(2)}` : 'your plan fee'));
      break;
    case 'subscription.created':
    case 'subscription.updated':
    case 'subscription.active':
      await db.update(tenants).set({ polarSubscriptionId: d.id ?? t.polarSubscriptionId, ...(plan ? { plan } : {}) }).where(eq(tenants.id, t.id));
      break;
    case 'subscription.canceled':
    case 'subscription.cancelled':
      // Suspension at period end is scheduled by the sweep using current_period_end.
      await db.insert(adminActionLog).values({ adminId: 'polar', action: 'cancel_scheduled', targetTenantId: t.id, note: d.current_period_end ?? null });
      break;
    case 'subscription.revoked':
      await db.update(tenants).set({ status: 'suspended', suspendedAt: new Date() }).where(eq(tenants.id, t.id));
      await db.insert(adminActionLog).values({ adminId: 'polar', action: 'suspend', targetTenantId: t.id, note: 'Subscription revoked' });
      await scheduleSuspensionGrace(t.id);
      break;
    default:
      break;
  }
  return { handled: true };
}

