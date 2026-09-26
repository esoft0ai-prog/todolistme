/** Transactional email: SMTP when SMTP_HOST is set (ADL §5), else the Resend HTTP API, else console. */
import type { Transporter } from 'nodemailer';
import { config } from './config.js';
import { platform, type PlatformSettings } from './platform.js';

export interface Mail { to: string; subject: string; text: string; html?: string }
/** Last messages sent — inspected by tests and useful in local dev. */
export const outbox: Mail[] = [];

export async function sendMail(m: Mail): Promise<void> {
  const p = await platform();
  // Branding: the Super Admin's product name replaces "Camplo" in every template.
  const brand = p.branding.productName;
  if (brand && brand !== 'Camplo') {
    const re = /\bCamplo\b/g;
    m = { ...m, subject: m.subject.replace(re, brand), text: m.text.replace(re, brand), html: m.html?.replace(re, brand) };
  }
  outbox.push(m);
  if (outbox.length > 200) outbox.shift();
  const e = p.email;
  const from = /</.test(e.fromAddress) ? e.fromAddress : `${p.branding.emailFromName || brand} <${e.fromAddress}>`;
  if (e.smtpHost) {
    try {
      const t = await smtp(e);
      await t.sendMail({ from, to: m.to, subject: m.subject, text: m.text, html: m.html });
    } catch (err) {
      console.error('[mail] smtp send failed', (err as Error).message);
    }
    return;
  }
  if (!e.resendApiKey) {
    if (config.env !== 'test') console.info(`[mail] to=${m.to} subject="${m.subject}"`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${e.resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: m.to, subject: m.subject, text: m.text, html: m.html }),
  });
  if (!res.ok) console.error(`[mail] send failed ${res.status}`);
}

/** Sends one message and reports failure to the caller (Super Admin "send test email"). */
export async function sendTestMail(to: string): Promise<{ ok: boolean; via: 'smtp' | 'resend' | 'console'; error?: string }> {
  const p = await platform();
  const e = p.email;
  const via = e.smtpHost ? 'smtp' : e.resendApiKey ? 'resend' : 'console';
  const from = /</.test(e.fromAddress) ? e.fromAddress : `${p.branding.emailFromName || p.branding.productName} <${e.fromAddress}>`;
  const msg = { from, to, subject: `${p.branding.productName} test email`, text: 'Email delivery is configured correctly.' };
  try {
    if (via === 'smtp') await (await smtp(e)).sendMail(msg);
    else if (via === 'resend') {
      const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${e.resendApiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(msg) });
      if (!r.ok) return { ok: false, via, error: `Resend answered ${r.status}` };
    }
    return { ok: true, via };
  } catch (err) {
    return { ok: false, via, error: (err as Error).message };
  }
}

let transport: { key: string; t: Transporter } | null = null;
async function smtp(e: PlatformSettings['email']): Promise<Transporter> {
  const key = `${e.smtpHost}|${e.smtpPort}|${e.smtpUser}|${e.smtpPass}`;
  if (transport?.key === key) return transport.t;
  const { createTransport } = await import('nodemailer');
  const t = createTransport({
    host: e.smtpHost, port: e.smtpPort, secure: e.smtpPort === 465,
    ...(e.smtpUser ? { auth: { user: e.smtpUser, pass: e.smtpPass } } : {}),
  });
  transport = { key, t };
  return t;
}

export const emails = {
  resetPassword: (to: string, link: string): Mail => ({
    to, subject: 'Reset your Camplo password',
    text: `Click the link below to choose a new password. This link expires in ${Math.round(config.passwordResetExpirySeconds / 60)} minutes.\n\n${link}`,
  }),
  invite: (to: string, ownerName: string, business: string, link: string): Mail => ({
    to, subject: `You've been invited to ${business} on Camplo`,
    text: `${ownerName} invited you to ${business} on Camplo — the watchtower for your campaigns and leads.\n\nAccept invite: ${link}`,
  }),
  slaAlert: (to: string, leadName: string, deployment: string, minutes: number, ackLink: string): Mail => ({
    to, subject: `Urgent: ${leadName} has not been acknowledged — ${minutes} minutes waiting`,
    text: `${leadName} (from ${deployment}) has been waiting ${minutes} minutes.\n\nAcknowledge now: ${ackLink}\nOpen dashboard: ${config.appUrl}/#/leads`,
  }),
  dailySummary: (to: string, lines: string[], avg: string): Mail => ({
    to, subject: `Camplo Daily Summary — ${lines.length} leads unacknowledged`,
    text: `Unacknowledged leads:\n${lines.join('\n')}\n\nAverage response time today: ${avg}\n\nGo to Inbox: ${config.appUrl}/#/leads`,
  }),
  newLead: (to: string, leadName: string, deployment: string, link: string): Mail => ({
    to, subject: `New lead: ${leadName}`,
    text: `${leadName} just arrived from ${deployment}. The SLA clock is running.\n\nOpen lead: ${link}`,
  }),
  magicLink: (to: string, link: string): Mail => ({
    to, subject: 'Your Camplo sign-in link',
    text: `Click the link below to sign in to Camplo. It works once and expires in ${Math.round(config.magicLinkExpirySeconds / 60)} minutes.\n\n${link}\n\nIf you didn't ask for this, you can ignore this email.`,
  }),
  activated: (to: string): Mail => ({
    to, subject: 'Your Camplo account is active', text: `Your account is active. Set up your account: ${config.appUrl}/#/login`,
  }),
  paymentReceived: (to: string, amount: string): Mail => ({
    to, subject: 'Payment received — your Camplo account is under review',
    text: `We received your payment of ${amount}. Your account is under review and is usually activated within one business day.`,
  }),
};
