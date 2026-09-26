/**
 * Campaign memory (Level 5). Hindsight by Vectorize is the memory layer
 * (Agent Architecture Part 6): one bank per workspace, campaign scoping via
 * tags. When HINDSIGHT_API_URL is not configured, recall/reflect fall back to
 * the relational memory tables (campaign_changes + campaign_recommendations)
 * so recommendations still reference history.
 *
 * Every retain is logged to hindsight_retain_log whether or not Hindsight is up.
 */
import { and, desc, eq } from 'drizzle-orm';
import { HindsightClient } from '@vectorize-io/hindsight-client';
import type { DB } from '../db/client.js';
import { campaignChanges, campaignRecommendations, hindsightRetainLog } from '../db/schema.js';
import { config } from '../lib/config.js';

export const bankId = (tenantId: string) => `workspace_${tenantId}`;
const campaignTag = (id: string) => `campaign:${id}`;

let client: HindsightClient | null = null;
function hindsight(): HindsightClient | null {
  if (!config.hindsightApiUrl) return null;
  return (client ??= new HindsightClient({ baseUrl: config.hindsightApiUrl, apiKey: config.hindsightApiKey || undefined }));
}

export type RetainEvent =
  | 'lead_arrived' | 'lead_responded' | 'sla_breach' | 'experiment' | 'recommendation'
  | 'lifecycle_event' | 'team_pattern' | 'campaign_event';

export interface MemoryItem { id: string; text: string; when: string; kind: string }

/** Create the workspace bank on tenant activation (idempotent). */
export async function ensureBank(tenantId: string, businessName: string): Promise<void> {
  const h = hindsight();
  if (!h) return;
  try {
    await h.createBank(bankId(tenantId), {
      name: businessName,
      mission: 'Remember campaign experiments, SLA events, lead outcomes and recommendation results for this workspace.',
    });
  } catch (e) {
    console.warn('[hindsight] createBank failed', (e as Error).message);
  }
}

export async function retain(db: DB, tenantId: string, ev: {
  type: RetainEvent; content: string; campaignId?: string | null; entityId?: string | null; timestamp?: Date;
}): Promise<void> {
  const bank = bankId(tenantId);
  await db.insert(hindsightRetainLog).values({
    tenantId, bankId: bank, eventType: ev.type, entityId: ev.entityId ?? null, campaignId: ev.campaignId ?? null,
    contentSummary: ev.content.slice(0, 500),
  });
  const h = hindsight();
  if (!h) return;
  try {
    await h.retain(bank, ev.content, {
      timestamp: (ev.timestamp ?? new Date()).toISOString(),
      context: ev.type,
      metadata: { eventType: ev.type, ...(ev.campaignId ? { campaignId: ev.campaignId } : {}) },
      tags: ev.campaignId ? [campaignTag(ev.campaignId)] : undefined,
      async: true,
    });
  } catch (e) {
    console.warn('[hindsight] retain failed', (e as Error).message);
  }
}

/** Recall memories relevant to a query, optionally scoped to one campaign. */
export async function recall(db: DB, tenantId: string, query: string, campaignId?: string | null): Promise<MemoryItem[]> {
  const h = hindsight();
  if (h) {
    try {
      const r = await h.recall(bankId(tenantId), query, { tags: campaignId ? [campaignTag(campaignId)] : undefined, maxTokens: 2048 });
      return r.results.map((m) => ({ id: m.id, text: m.text, when: m.occurred_start ?? '', kind: m.type ?? 'memory' }));
    } catch (e) {
      console.warn('[hindsight] recall failed, using relational memory', (e as Error).message);
    }
  }
  return relationalMemory(db, tenantId, campaignId);
}

/** Synthesise a mental model from memories (weekly job / before Level 4). */
export async function reflect(db: DB, tenantId: string, query: string, campaignId?: string | null): Promise<string | null> {
  const h = hindsight();
  if (h) {
    try {
      const r = await h.reflect(bankId(tenantId), query, { tags: campaignId ? [campaignTag(campaignId)] : undefined });
      return r.text;
    } catch (e) {
      console.warn('[hindsight] reflect failed', (e as Error).message);
    }
  }
  const items = await relationalMemory(db, tenantId, campaignId);
  if (!items.length) return null;
  const creative = items.filter((i) => /creative/i.test(i.text));
  if (creative.some((i) => /qualified[- ]lead rate [−-]/i.test(i.text))) {
    return 'Creative changes on this campaign have improved CTR but reduced qualified-lead rate. Optimising for CTR here tends to degrade lead quality.';
  }
  return `Based on ${items.length} recorded changes and recommendations, no consistent pattern is established yet.`;
}

async function relationalMemory(db: DB, tenantId: string, campaignId?: string | null): Promise<MemoryItem[]> {
  const cw = campaignId ? and(eq(campaignChanges.tenantId, tenantId), eq(campaignChanges.campaignId, campaignId)) : eq(campaignChanges.tenantId, tenantId);
  const rw = campaignId
    ? and(eq(campaignRecommendations.tenantId, tenantId), eq(campaignRecommendations.campaignId, campaignId))
    : eq(campaignRecommendations.tenantId, tenantId);
  const [changes, recs] = await Promise.all([
    db.select().from(campaignChanges).where(cw).orderBy(desc(campaignChanges.changedAt)).limit(20),
    db.select().from(campaignRecommendations).where(rw).orderBy(desc(campaignRecommendations.surfacedAt)).limit(20),
  ]);
  const out: MemoryItem[] = changes.map((c) => ({
    id: c.id, kind: 'experiment', when: c.changedAt.toISOString(),
    text: `${c.changeType} change: ${c.changeDescription}${c.performanceAfter ? ` → ${describeDelta(c.performanceBefore, c.performanceAfter)}` : ' (outcome pending)'}`,
  }));
  for (const r of recs) {
    if (r.status === 'surfaced') continue;
    out.push({ id: r.id, kind: 'recommendation', when: (r.actionedAt ?? r.surfacedAt).toISOString(), text: `Camplo recommended "${r.actionText}" → ${r.status}` });
  }
  return out.sort((a, b) => b.when.localeCompare(a.when));
}

function describeDelta(b: Record<string, number | null>, a: Record<string, number | null>): string {
  const parts: string[] = [];
  const pct = (k: string, label: string) => {
    if (b[k] && a[k] != null) {
      const d = Math.round(((a[k]! - b[k]!) / b[k]!) * 100);
      parts.push(`${label} ${d >= 0 ? '+' : '−'}${Math.abs(d)}%`);
    }
  };
  pct('lead_count_7d', 'lead volume'); pct('conversion_rate', 'conversion'); pct('cpl', 'CPL'); pct('acknowledgment_rate', 'ack rate');
  return parts.join(', ') || 'no measurable change';
}
