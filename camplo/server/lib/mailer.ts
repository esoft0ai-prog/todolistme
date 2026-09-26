/** Transactional email. Uses the Resend HTTP API when RESEND_API_KEY is set; otherwise logs. */
import { config } from './config.js';

export interface Mail { to: string; subject: string; text: string; html?: string }
/** Last messages sent — inspected by tests and useful in local dev. */
export const outbox: Mail[] = [];

export async function sendMail(m: Mail): Promise<void> {
  outbox.push(m);
  if (outbox.length > 200) outbox.shift();
  if (!config.resendApiKey) {
    if (config.env !== 'test') console.info(`[mail] to=${m.to} subject="${m.subject}"`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.emailFrom, to: m.to, subject: m.subject, text: m.text, html: m.html }),
  });
  if (!res.ok) console.error(`[mail] send failed ${res.status}`);
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
  activated: (to: string): Mail => ({
    to, subject: 'Your Camplo account is active', text: `Your account is active. Set up your account: ${config.appUrl}/#/login`,
  }),
  paymentReceived: (to: string, amount: string): Mail => ({
    to, subject: 'Payment received — your Camplo account is under review',
    text: `We received your payment of ${amount}. Your account is under review and is usually activated within one business day.`,
  }),
};
