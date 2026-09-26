/**
 * Telegram channel (ADL D-NEW-16, P-6): a parallel notification + acknowledgment path. It never replaces email —
 * a failed Telegram delivery falls back to email silently.
 *
 * Bots: a workspace's own bot (telegram_connections) or, when none is connected, the Camplo-wide bot from
 * TELEGRAM_BOT_TOKEN. Webhooks are authenticated with Telegram's secret_token header, derived per bot from
 * TELEGRAM_WEBHOOK_SECRET.
 *
 * Acknowledge buttons: P-6 specifies `acknowledge:{lead_id}:{user_id}:{tenant_id}:{hmac}`. Telegram caps
 * callback_data at 64 bytes, so the button carries `ack:{lead_id hex}:{hmac16}` and the HMAC is computed over that
 * full canonical string — the user comes from the chat that pressed it and the tenant from the lead, so the same
 * three facts are bound by the signature.
 */
import { platform } from '../lib/platform.js';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { deployments, leads, telegramConnections, tenants, users } from '../db/schema.js';
import { config } from '../lib/config.js';
import { decrypt, hmacHex, safeEqual } from '../lib/crypto.js';
import { emails, sendMail } from '../lib/mailer.js';
import { sendAckMessage, telegramCall } from '../lib/telegram.js';

const signingSecret = () => config.magicLinkSigningSecret || config.jwtSecret;
const hex = (uuid: string) => uuid.replace(/-/g, '');
const uuidOf = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;

/** secret_token registered with setWebhook for one bot scope ('global' or a tenant id). */
export async function webhookSecretFor(scope: string): Promise<string> {
  return hmacHex((await platform()).telegram.webhookSecret || config.jwtSecret, `telegram-webhook:${scope}`).slice(0, 48);
}

export function ackSignature(leadId: string, userId: string, tenantId: string): string {
  return hmacHex(signingSecret(), `acknowledge:${leadId}:${userId}:${tenantId}`).slice(0, 16);
}

export function ackCallbackData(leadId: string, userId: string, tenantId: string): string {
  return `ack:${hex(leadId)}:${ackSignature(leadId, userId, tenantId)}`; // 53 bytes
}

/** The bot a workspace sends through: its own verified bot, else the Camplo-wide bot. */
export async function botFor(db: DB, tenantId: string): Promise<{ token: string; scope: string; criticalAlerts: boolean } | null> {
  const [tg] = await db.select().from(telegramConnections).where(and(eq(telegramConnections.tenantId, tenantId), eq(telegramConnections.verified, true)));
  if (tg) return { token: decrypt(tg.botTokenEncrypted), scope: tenantId, criticalAlerts: tg.criticalAlertsEnabled };
  const global = (await platform(db)).telegram.botToken;
  if (global) return { token: global, scope: 'global', criticalAlerts: true };
  return null;
}

/** Register the webhook for a bot so /start linking and Acknowledge buttons reach Camplo. */
export async function registerWebhook(token: string, scope: string) {
  const url = scope === 'global' ? `${config.appUrl}/api/telegram/webhook` : `${config.appUrl}/api/telegram/${scope}`;
  return telegramCall(token, 'setWebhook', { url, secret_token: await webhookSecretFor(scope), allowed_updates: ['message', 'callback_query'] });
}

/** Code a member sends as `/start <code>`: their user id without dashes (unique across workspaces). */
export const linkCodeFor = (userId: string) => hex(userId);

interface Update {
  callback_query?: { id: string; data?: string; from: { id: number }; message?: { chat: { id: number }; message_id: number } };
  message?: { text?: string; chat: { id: number } };
}

/** Handle one Telegram update for a bot scope. The caller has already checked the secret_token header. */
export async function handleUpdate(db: DB, scope: string, u: Update): Promise<void> {
  const token = scope === 'global' ? (await platform(db)).telegram.botToken : (await botFor(db, scope))?.token;
  if (!token) return;

  const start = u.message?.text?.match(/^\/start\s+([0-9a-f]{8,32})$/i);
  if (start && u.message) {
    const code = start[1].toLowerCase();
    const where = code.length === 32 ? eq(users.id, uuidOf(code)) : sql`${users.id}::text like ${`${code}%`}`;
    const scoped = scope === 'global' ? where : and(where, eq(users.tenantId, scope));
    const [usr] = await db.select().from(users).where(and(scoped, isNull(users.removedAt))).limit(2);
    if (usr) {
      await db.update(users).set({ telegramChatId: String(u.message.chat.id) }).where(eq(users.id, usr.id));
      await telegramCall(token, 'sendMessage', { chat_id: u.message.chat.id, text: `Linked to Camplo as ${usr.name}. You'll get lead and SLA alerts here.` });
    } else {
      await telegramCall(token, 'sendMessage', { chat_id: u.message.chat.id, text: 'That link code was not recognised. Copy it again from Camplo → Settings → Telegram.' });
    }
    return;
  }

  const cq = u.callback_query;
  const m = cq?.data?.match(/^ack:([0-9a-f]{32}):([0-9a-f]{16})$/);
  if (!cq || !m) return;
  const leadId = uuidOf(m[1]);
  const [l] = await db.select().from(leads).where(eq(leads.id, leadId));
  const chat = String(cq.message?.chat.id ?? cq.from.id);
  const [usr] = l && (scope === 'global' || scope === l.tenantId)
    ? await db.select().from(users).where(and(eq(users.tenantId, l.tenantId), eq(users.telegramChatId, chat), isNull(users.removedAt)))
    : [];
  let text = 'This acknowledgment is no longer valid.';
  if (l && usr && safeEqual(ackSignature(l.id, usr.id, l.tenantId), m[2])) {
    if (l.status === 'responded') {
      const [by] = l.respondedBy ? await db.select({ name: users.name }).from(users).where(eq(users.id, l.respondedBy)) : [];
      text = `Already acknowledged by ${by?.name ?? 'a teammate'} at ${l.respondedAt!.toISOString().slice(11, 16)} UTC.`;
    } else {
      const now = new Date();
      const claim = !l.assigneeId;
      const [updated] = await db.update(leads).set({ status: 'responded', respondedAt: now, respondedBy: usr.id, ...(claim ? { assigneeId: usr.id, assignmentPath: 'A' as const, claimedAt: now } : {}) })
        .where(and(eq(leads.id, l.id), eq(leads.status, 'not_responded'))).returning();
      if (updated) {
        const [t] = await db.select().from(tenants).where(eq(tenants.id, l.tenantId));
        const { afterRespond } = await import('./leads.js');
        await afterRespond(db, t, updated, usr);
        text = `✓ ${usr.name} acknowledged ${l.fullName}.`;
      } else {
        text = 'Already acknowledged by a teammate.';
      }
    }
  }
  await telegramCall(token, 'answerCallbackQuery', { callback_query_id: cq.id });
  if (cq.message) await telegramCall(token, 'editMessageText', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text });
}

/** Send an Acknowledge message to one user. Returns false when Telegram is unavailable or delivery failed. */
export async function sendLeadMessage(db: DB, tenantId: string, user: typeof users.$inferSelect, leadId: string, text: string): Promise<boolean> {
  if (!user.telegramChatId) return false;
  const bot = await botFor(db, tenantId);
  if (!bot || !bot.criticalAlerts) return false;
  const r = await sendAckMessage(bot.token, user.telegramChatId, text, ackCallbackData(leadId, user.id, tenantId));
  return r.ok;
}

/** Queue `telegram-notifications`, new-lead message: every linked member; email fallback on delivery failure. */
export async function notifyNewLead(db: DB, tenantId: string, leadId: string) {
  const [l] = await db.select().from(leads).where(and(eq(leads.tenantId, tenantId), eq(leads.id, leadId)));
  if (!l || l.status === 'responded') return { sent: 0 };
  const [dep] = l.deploymentId ? await db.select({ name: deployments.name }).from(deployments).where(eq(deployments.id, l.deploymentId)) : [];
  const recipients = await db.select().from(users).where(and(eq(users.tenantId, tenantId), isNull(users.removedAt), sql`${users.telegramChatId} is not null`, eq(users.notifyEnabled, true)));
  let sent = 0;
  for (const u of recipients) {
    if (l.assigneeId && l.assigneeId !== u.id) continue;
    const ok = await sendLeadMessage(db, tenantId, u, l.id, `🆕 New lead: ${l.fullName}${dep ? ` (${dep.name})` : ''}. Tap Acknowledge once you've responded.`);
    if (ok) sent++;
    else await sendMail(emails.newLead(u.email, l.fullName, dep?.name ?? 'webhook', `${config.appUrl}/#/leads/${l.id}`));
  }
  return { sent };
}
