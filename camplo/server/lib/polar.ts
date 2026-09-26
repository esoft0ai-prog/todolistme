/**
 * Polar.sh checkout (ADL D-NEW-15). With POLAR_ACCESS_TOKEN + a product id (POLAR_PRODUCT_ID_<PLAN> or
 * POLAR_PRODUCT_ID) a checkout session is created through the Polar API; POLAR_CHECKOUT_URL_<PLAN> static links
 * remain as a fallback. The `tenant_id` / `plan` metadata comes back on the webhook, which applies the plan.
 */
import { config } from './config.js';
import { platform } from './platform.js';

export async function createCheckout(o: { plan: string; email: string; tenantId: string }): Promise<string | null> {
  const b = (await platform()).billing;
  const product = b.productIds[o.plan as keyof typeof b.productIds];
  if (b.polarAccessToken && product) {
    const res = await fetch(`${b.polarApiUrl}/v1/checkouts/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${b.polarAccessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        products: [product], customer_email: o.email,
        metadata: { tenant_id: o.tenantId, plan: o.plan },
        success_url: `${config.appUrl}/#/pending`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Polar checkout failed (${res.status})`);
    const j = (await res.json()) as { url?: string };
    if (j.url) return j.url;
  }
  const url = b.checkoutUrls[o.plan as keyof typeof b.checkoutUrls];
  return url ? `${url}?customer_email=${encodeURIComponent(o.email)}&metadata[tenant_id]=${o.tenantId}&metadata[plan]=${o.plan}` : null;
}

/** Map a Polar product back to a plan: configured product ids first, then metadata, then the product name. */
export async function planForProduct(productId: string | undefined, metadataPlan: string | undefined, productName: string | undefined) {
  const ids = (await platform()).billing.productIds;
  for (const p of ['starter', 'growth', 'watchtower', 'agency'] as const) {
    if (productId && ids[p] === productId) return p;
  }
  const m = (metadataPlan ?? '').toLowerCase();
  if (['starter', 'growth', 'watchtower', 'agency'].includes(m)) return m as 'starter' | 'growth' | 'watchtower' | 'agency';
  const n = (productName ?? '').toLowerCase();
  return n.includes('watchtower') ? 'watchtower' : n.includes('growth') ? 'growth' : n.includes('agency') ? 'agency' : n.includes('starter') ? 'starter' : null;
}

/** Super Admin "test connection": a read-only call proving the token (and organization) are valid. */
export async function testPolar(): Promise<{ ok: boolean; error?: string }> {
  const b = (await platform()).billing;
  if (!b.polarAccessToken) return { ok: false, error: 'No Polar access token set.' };
  try {
    const q = b.polarOrganizationId ? `?organization_id=${encodeURIComponent(b.polarOrganizationId)}&limit=1` : '?limit=1';
    const r = await fetch(`${b.polarApiUrl}/v1/products/${q}`, { headers: { Authorization: `Bearer ${b.polarAccessToken}` }, signal: AbortSignal.timeout(10_000) });
    return r.ok ? { ok: true } : { ok: false, error: `Polar answered ${r.status}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
