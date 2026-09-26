/**
 * Side effects shared by all services: audit logs, notifications, real-time
 * events, memory retention and outbound webhooks. Nothing here throws into the
 * caller — a failed webhook or memory write never fails a user's action.
 */
import { and, eq } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { campaignLogs, notifications, outboundWebhooks, workspaceLogs } from '../db/schema.js';
import { decrypt, hmacHex } from '../lib/crypto.js';
import { emit } from '../rt/hub.js';
import { retain, type RetainEvent } from '../ai/memory.js';

export async function logCampaign(db: DB, tenantId: string, campaignId: string, actorId: string | null, description: string) {
  await db.insert(campaignLogs).values({ tenantId, campaignId, actorId, description });
}

export async function logWorkspace(db: DB, tenantId: string, actorId: string | null, description: string) {
  await db.insert(workspaceLogs).values({ tenantId, actorId, description });
}

export async function notify(db: DB, tenantId: string, n: { userId?: string | null; kind: string; description: string; link?: string }) {
  await db.insert(notifications).values({ tenantId, userId: n.userId ?? null, kind: n.kind, description: n.description, link: n.link ?? null });
  emit(tenantId, 'workspace:notifications', {});
}

export { emit };

export function remember(db: DB, tenantId: string, ev: { type: RetainEvent; content: string; campaignId?: string | null; entityId?: string | null }) {
  void retain(db, tenantId, ev).catch((e) => console.warn('[memory] retain failed', (e as Error).message));
}

export type OutboundEvent = 'lead.received' | 'lead.responded' | 'lead.assigned' | 'campaign.completed' | 'sla.breached' | 'deployment.ready';

/** Fire outbound webhooks for an event. Body signed with HMAC-SHA256 in `X-Camplo-Signature`. */
export function fireOutbound(db: DB, tenantId: string, event: OutboundEvent, data: Record<string, unknown>) {
  void (async () => {
    const hooks = await db.select().from(outboundWebhooks)
      .where(and(eq(outboundWebhooks.tenantId, tenantId), eq(outboundWebhooks.eventTrigger, event), eq(outboundWebhooks.status, 'active')));
    for (const h of hooks) {
      const body = JSON.stringify({ event, occurred_at: new Date().toISOString(), data });
      const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Camplo-Event': event };
      if (h.secretEncrypted) headers['X-Camplo-Signature'] = `sha256=${hmacHex(decrypt(h.secretEncrypted), body)}`;
      try {
        await fetch(h.destinationUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(8000) });
        await db.update(outboundWebhooks).set({ lastSentAt: new Date() }).where(eq(outboundWebhooks.id, h.id));
      } catch (e) {
        console.warn(`[outbound] ${event} → ${h.destinationUrl} failed`, (e as Error).message);
      }
    }
  })().catch(() => {});
}
