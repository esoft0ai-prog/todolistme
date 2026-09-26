/**
 * Cross-tool SLA monitoring (ADL D-NEW-13, queue `cross-tool-sla-check`, Watchtower only).
 *
 * After a lead is acknowledged in Camplo, each enabled rule checks that the lead progressed in the connected tool
 * within its window. Progress evidence is the lead's lifecycle events from that tool (receive mode, matched to the
 * lead through lead_external_mappings or email). A breach is logged once per lead+rule, its hours_exceeded keeps
 * updating, and it resolves itself when the evidence arrives.
 *
 * Aggregate rules (open-rate drop, spend without leads, CPL) need query-mode reads from the provider's API and are
 * not evaluated here yet; they stay configurable so enabling query mode later needs no data-model change.
 */
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import {
  crossToolSlaBreaches, crossToolSlaRules, insights, integrations, leadExternalMappings, leadLifecycleEvents, leads, tenants, users,
} from '../db/schema.js';
import { config } from '../lib/config.js';
import { sendMail } from '../lib/mailer.js';
import { DAY, HOUR, hasFeature, type Plan } from '../domain/rules.js';
import { emit, notify } from './effects.js';

/** Lifecycle evidence that satisfies each per-lead rule; null = any event from the tool counts. */
const EVIDENCE: Record<string, RegExp | null> = {
  not_contacted: /contact|call|reached|replied|reply|email(ed)? sent|meeting|qualified|proposal|won/i,
  not_proposal: /proposal|quote|offer|won/i,
  no_activity: null,
  not_enrolled: /enrol|enroll|sequence|subscribed|automation|journey|campaign added/i,
  no_click: /click/i,
};
const LABEL: Record<string, string> = {
  not_contacted: 'was not moved to Contacted', not_proposal: 'did not reach Proposal Sent', no_activity: 'has no activity logged',
  not_enrolled: 'was not enrolled in a follow-up sequence', no_click: 'has no click recorded',
};

const windowMs = (r: typeof crossToolSlaRules.$inferSelect) => r.thresholdValue * (r.thresholdUnit === 'days' ? DAY : HOUR);

export async function checkCrossToolSla(db: DB, tenantId?: string) {
  const ts = await db.select().from(tenants).where(and(eq(tenants.status, 'active'), tenantId ? eq(tenants.id, tenantId) : undefined));
  let created = 0, resolved = 0;
  for (const t of ts) {
    if (!hasFeature(t.plan as Plan, 'cross_tool_sla')) continue;
    const rules = await db.select({ r: crossToolSlaRules, i: integrations }).from(crossToolSlaRules)
      .innerJoin(integrations, eq(integrations.id, crossToolSlaRules.integrationId))
      .where(and(eq(crossToolSlaRules.tenantId, t.id), eq(crossToolSlaRules.enabled, true), eq(integrations.status, 'connected'),
        inArray(crossToolSlaRules.ruleType, Object.keys(EVIDENCE))));
    for (const { r, i } of rules) {
      const res = await checkRule(db, t, r, i);
      created += res.created; resolved += res.resolved;
    }
  }
  return { created, resolved };
}

async function checkRule(db: DB, t: typeof tenants.$inferSelect, r: typeof crossToolSlaRules.$inferSelect, i: typeof integrations.$inferSelect) {
  const win = windowMs(r);
  const now = Date.now();
  const pattern = EVIDENCE[r.ruleType];
  // Acknowledged leads in the last 30 days that arrived after the tool was connected and whose window has elapsed.
  const candidates = await db.select().from(leads).where(and(
    eq(leads.tenantId, t.id), eq(leads.status, 'responded'), gt(leads.receivedAt, i.createdAt),
    gt(leads.respondedAt, new Date(now - 30 * DAY)), sql`${leads.respondedAt} < ${new Date(now - win)}`,
  )).limit(500);
  if (!candidates.length) return { created: 0, resolved: 0 };
  const ids = candidates.map((l) => l.id);
  const events = await db.select({ leadId: leadLifecycleEvents.leadId, event: leadLifecycleEvents.event, at: leadLifecycleEvents.eventTimestamp })
    .from(leadLifecycleEvents).where(and(eq(leadLifecycleEvents.tenantId, t.id), eq(leadLifecycleEvents.source, i.provider), inArray(leadLifecycleEvents.leadId, ids)));
  const mapped = new Set((await db.select({ id: leadExternalMappings.leadId }).from(leadExternalMappings)
    .where(and(eq(leadExternalMappings.integrationId, i.id), inArray(leadExternalMappings.leadId, ids)))).map((m) => m.id));
  const open = await db.select().from(crossToolSlaBreaches).where(and(eq(crossToolSlaBreaches.ruleId, r.id), inArray(crossToolSlaBreaches.leadId, ids)));
  const byLead = new Map(open.map((b) => [b.leadId, b]));
  let created = 0, resolved = 0;

  for (const l of candidates) {
    const deadline = l.respondedAt!.getTime() + win;
    const satisfied = events.some((e) => e.leadId === l.id && (!pattern || pattern.test(e.event)) && e.at.getTime() <= Math.max(deadline, now));
    const existing = byLead.get(l.id);
    if (satisfied) {
      if (existing && !existing.resolved) {
        await db.update(crossToolSlaBreaches).set({ resolved: true, resolvedAt: new Date() }).where(eq(crossToolSlaBreaches.id, existing.id));
        resolved++;
      }
      continue;
    }
    const hoursExceeded = Math.max(1, Math.floor((now - deadline) / HOUR));
    if (existing) {
      if (!existing.resolved && existing.hoursExceeded !== hoursExceeded) await db.update(crossToolSlaBreaches).set({ hoursExceeded }).where(eq(crossToolSlaBreaches.id, existing.id));
      continue;
    }
    await db.insert(crossToolSlaBreaches).values({ tenantId: t.id, leadId: l.id, integrationId: i.id, ruleId: r.id, breachType: r.ruleType, hoursExceeded });
    created++;
    await surface(db, t, r, i, l, mapped.has(l.id));
  }
  if (created || resolved) emit(t.id, 'workspace:sla', { crossTool: true });
  return { created, resolved };
}

/** Deliver a new breach on the rule's channels: AI panel card, email (assignee, else owner). Telegram rides the AI panel feed. */
async function surface(db: DB, t: typeof tenants.$inferSelect, r: typeof crossToolSlaRules.$inferSelect, i: typeof integrations.$inferSelect, l: typeof leads.$inferSelect, mapped: boolean) {
  const tool = i.provider.replace(/_/g, ' ');
  const window = `${r.thresholdValue} ${r.thresholdUnit}`;
  const text = `${l.fullName} ${LABEL[r.ruleType]} in ${tool} within ${window} of being acknowledged.`;
  await notify(db, t.id, { userId: l.assigneeId, kind: 'sla_breach', description: `Cross-tool SLA: ${text}`, link: `/leads/${l.id}` });
  if (r.notificationChannels.includes('ai_panel')) {
    await db.insert(insights).values({
      tenantId: t.id, campaignId: l.campaignId, type: 'alert', severity: 'amber', category: 'SLA', dedupeKey: `xtool:${r.id}:${l.id}`,
      observation: text,
      evidence: mapped ? `Camplo has ${tool}'s contact for this lead but no matching activity arrived.` : `No record of this lead has arrived from ${tool} — it may never have reached the tool.`,
    });
    emit(t.id, 'workspace:insights', {});
  }
  if (r.notificationChannels.includes('email')) {
    const [to] = l.assigneeId ? await db.select().from(users).where(and(eq(users.id, l.assigneeId), isNull(users.removedAt))) : [];
    await sendMail({ to: to?.email ?? t.notificationEmail, subject: `Cross-tool SLA breach — ${l.fullName}`, text: `${text}\n\nOpen lead: ${config.appUrl}/#/leads/${l.id}` });
  }
}
