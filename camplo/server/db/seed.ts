/**
 * Demo workspace ("Northbeam Growth") so a fresh database is explorable.
 * Runs only when the database has no tenants and SEED_DEMO !== 'false'.
 * Timestamps are relative to seed time so SLA timers are live.
 */
import { sql } from 'drizzle-orm';
import type { DB } from './client.js';
import * as s from './schema.js';
import { hashPassword } from '../lib/auth.js';
import { createHash } from 'node:crypto';
import { encrypt } from '../lib/crypto.js';
import { config } from '../lib/config.js';

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
export const DEMO_EMAIL = 'marcus@northbeam.demo';
export const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'camplo-demo';

/** Seed tokens are derived from a counter, not random, so every fresh instance builds the same workspace. */
let tokCounter = 0;
function tok(bytes: number): string {
  return createHash('sha256').update(`camplo-demo-token:${tokCounter++}`).digest('base64url').slice(0, Math.ceil((bytes * 4) / 3));
}

/**
 * `deterministic` swaps every `id` default for a counter-derived UUID while seeding. Used for the embedded,
 * per-instance database (e.g. serverless without DATABASE_URL): each instance then holds byte-identical demo
 * rows, so a session issued by one instance resolves on any other.
 */
export async function seedIfEmpty(db: DB, opts: { deterministic?: boolean } = {}) {
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(s.tenants);
  if (Number(n) > 0) return false;
  tokCounter = 0;
  if (!opts.deterministic) { await seedDemo(db); return true; }
  const rows = await db.execute(sql`select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'id' and column_default like 'gen_random_uuid%' order by table_name`);
  const tables = ((rows as unknown as { rows?: Array<{ table_name: string }> }).rows ?? (rows as unknown as Array<{ table_name: string }>)).map((r) => r.table_name);
  await db.execute(sql`create sequence if not exists camplo_seed_seq`);
  await db.execute(sql.raw(`create or replace function camplo_seed_uuid() returns uuid language sql as $$ select (substr(h, 1, 12) || '4' || substr(h, 14, 3) || substr('89ab', ('x' || substr(h, 17, 1))::bit(4)::int % 4 + 1, 1) || substr(h, 18, 15))::uuid from (select md5('camplo-demo:' || nextval('camplo_seed_seq')) as h) v $$`));
  for (const t of tables) await db.execute(sql.raw(`alter table "${t}" alter column id set default camplo_seed_uuid()`));
  try {
    await seedDemo(db);
  } finally {
    for (const t of tables) await db.execute(sql.raw(`alter table "${t}" alter column id set default gen_random_uuid()`));
    await db.execute(sql`drop function if exists camplo_seed_uuid()`);
    await db.execute(sql`drop sequence if exists camplo_seed_seq`);
  }
  return true;
}

export async function seedDemo(db: DB) {
  const now = Date.now();
  const ago = (ms: number) => new Date(now - ms);
  const pw = await hashPassword(DEMO_PASSWORD);

  const [t] = await db.insert(s.tenants).values({
    businessName: 'Northbeam Growth', ownerName: 'Marcus Adeyemi', ownerEmail: DEMO_EMAIL, notificationEmail: DEMO_EMAIL,
    status: 'active', setupComplete: true, stackCheckCompleted: true, hasMarketingStack: true, plan: 'watchtower',
    slaThresholdMinutes: 30, vipSlaThresholdMinutes: 10, vipLeadEnabled: true, activatedAt: ago(90 * DAY), teamSize: '3–10',
  }).returning();
  const T = t.id;

  const people = [
    ['Marcus Adeyemi', DEMO_EMAIL, 'owner'], ['Tunde Omolayo', 'tunde@northbeam.demo', 'admin'], ['Sarah Okafor', 'sarah@northbeam.demo', 'member'],
    ['Amara Nwosu', 'amara@northbeam.demo', 'member'], ['Kofi Mensah', 'kofi@northbeam.demo', 'member'],
  ] as const;
  const U = await db.insert(s.users).values(people.map(([name, email, role], i) => ({
    tenantId: T, name, email, role, passwordHash: pw, joinedAt: ago(80 * DAY), lastActiveAt: ago([2, 6, 24, 180, 1440][i] * MIN),
  }))).returning();
  const [marcus, tunde, sarah, amara, kofi] = U;
  await db.insert(s.users).values({ tenantId: T, name: 'ops', email: 'ops@northbeam.demo', role: 'member', invitedBy: marcus.id, invitationToken: 'seeded', invitationExpiresAt: new Date(now + 5 * DAY), createdAt: ago(2 * DAY) });
  await db.insert(s.aiProviderConfigs).values({ tenantId: T });

  const day = (d: number) => new Date(now - d * DAY).toISOString().slice(0, 10);
  const C = await db.insert(s.campaigns).values([
    { tenantId: T, name: 'Black Friday 2026', ownerId: marcus.id, startDate: day(25), pinned: true, currency: 'NGN', budget: '4500000', dailySpend: '1850000', cplThreshold: '12000',
      description: '<p>Paid social push for the Black Friday bundle. Three landing pages on Meta traffic with Tally forms feeding Twenty CRM.</p><p>Goal: keep speed-to-lead under 5 minutes and CPL inside threshold.</p>' },
    { tenantId: T, name: 'Lekki Property Enquiry — Q3', ownerId: marcus.id, startDate: day(45), pinned: true, currency: 'NGN', budget: '2400000', dailySpend: '980000', cplThreshold: '25000',
      description: '<p>Enquiry funnel for off-plan units. Leads route from GoHighLevel. High ticket — every lead is worth a call inside 5 minutes.</p>' },
    { tenantId: T, name: 'Growth Webinar Series', ownerId: marcus.id, startDate: day(68), pinned: true, currency: 'USD',
      description: '<p>Weekly webinar registrations from Systeme.io. Nurture sequence in Brevo, sales follow-up for attendees only.</p>' },
    { tenantId: T, name: 'Customer Referral Drive', ownerId: marcus.id, startDate: day(9), currency: 'NGN', budget: '600000', dailySpend: '110000', cplThreshold: '15000',
      description: '<p>Referral page shared with existing customers. Low volume, high intent. Typeform capture.</p>' },
    { tenantId: T, name: 'Summer Launch 2026', ownerId: marcus.id, startDate: day(117), status: 'complete', completedAt: ago(26 * DAY), currency: 'USD', budget: '32000', dailySpend: '3200',
      description: '<p>Product launch across Meta and Google. Completed; retrospective generated automatically.</p>' },
  ]).returning();
  const [bf, prop, web, ref, sum] = C;
  const members: Array<[typeof C[number], typeof U]> = [[bf, [marcus, tunde, sarah, kofi]], [prop, [marcus, tunde, amara]], [web, [marcus, amara, kofi]], [ref, [marcus, sarah]], [sum, U]];
  for (const [c, us] of members) await db.insert(s.campaignMembers).values(us.map((u) => ({ tenantId: T, campaignId: c.id, userId: u.id })));

  const html = (title: string) => Buffer.from(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#0B0B0F;color:#E8E8F0;display:grid;place-items:center;min-height:100vh}main{max-width:520px;padding:32px}h1{font-size:34px;margin:0 0 12px}p{color:#8888A8}input,button{width:100%;padding:12px;margin-top:10px;border-radius:8px;border:1px solid #262636;background:#18181F;color:#E8E8F0;font:inherit}button{background:#FF8C00;color:#000;font-weight:600;border:0}</style></head>
<body><main><h1>${title}</h1><p>Demo landing page hosted by Camplo. Submissions post to this page's signed Camplo webhook.</p><form onsubmit="event.preventDefault();this.innerHTML='<p>Thanks — we will be in touch within minutes.</p>'"><input placeholder="Full name" required><input type="email" placeholder="Email" required><button>Get the offer</button></form></main></body></html>`);
  const pageDefs: Array<[string, typeof C[number], number, number | null, number, boolean]> = [
    // name, campaign, deployed days ago, last lead minutes ago (null = never), visits/day, vip
    ['bf-bundle-a', bf, 25, 3, 1200, false], ['bf-bundle-b', bf, 25, 130, 800, false], ['bf-vip-early', bf, 1.3, 132, 250, false],
    ['lekki-offplan', prop, 45, 11, 420, true], ['lekki-brochure', prop, 40, null, 130, true], ['webinar-register', web, 68, 1, 530, false],
    ['refer-a-friend', ref, 9, 47, 60, false], ['summer-main', sum, 117, 40 * 24 * 60, 0, false],
  ];
  const P: Array<typeof s.deployments.$inferSelect> = [];
  for (const [name, c, deployedDays, lastMin, visits, vip] of pageDefs) {
    const [d] = await db.insert(s.deployments).values({
      tenantId: T, campaignId: c.id, name, subdomain: `${name}-${tok(3).toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 4)}`, storagePath: 'pending',
      status: 'ready', storageSizeBytes: 1400, webhookSecretEncrypted: encrypt(tok(24), 'webhook'), deployedAt: ago(deployedDays * DAY), vip,
      servingState: name === 'summer-main' ? 'archived' : name === 'lekki-brochure' ? 'paused' : 'active',
      earlyWarningActive: deployedDays < 3, previousStoragePath: name === 'bf-bundle-b' ? `sites/${T}/prev/` : null, previousDeployedAt: name === 'bf-bundle-b' ? ago(3 * DAY) : null,
    }).returning();
    const prefix = `sites/${T}/${d.id}/v1/`;
    await db.insert(s.storedFiles).values({ path: `${prefix}index.html`, contentType: 'text/html; charset=utf-8', dataBase64: html(name.replace(/-/g, ' ')).toString('base64') });
    await db.update(s.deployments).set({ storagePath: prefix }).where(sql`${s.deployments.id} = ${d.id}`);
    await db.insert(s.webhookSources).values({ tenantId: T, deploymentId: d.id, campaignId: c.id, label: name, sourceSystem: c.id === prop.id ? 'gohighlevel' : c.id === web.id ? 'systeme_io' : c.id === ref.id ? 'typeform' : 'tally',
      lastReceivedAt: lastMin == null ? null : ago(lastMin * MIN), status: lastMin != null && lastMin > 120 ? 'offline' : 'operational' });
    if (visits) {
      const rows = [];
      for (let i = 0; i < Math.min(14, Math.ceil(deployedDays)); i++) rows.push({ tenantId: T, deploymentId: d.id, day: day(i), visits: Math.round(visits * (0.75 + ((i * 37) % 50) / 100)) });
      await db.insert(s.pageVisits).values(rows);
    }
    P.push({ ...d, storagePath: prefix });
  }
  const page = (name: string) => P.find((p) => p.name === name)!;

  // Leads: [name, page, minutes ago, state, responder, response seconds, utm?]
  type St = 'unassigned' | 'assigned' | 'responded';
  const L: Array<[string, string, number, St, typeof U[number] | null, number?]> = [
    ['Sarah Jenkins', 'bf-bundle-a', 3.4, 'unassigned', null], ['Chidi Eze', 'lekki-offplan', 8.2, 'assigned', marcus], ['Folake Ade', 'bf-bundle-a', 41, 'assigned', sarah],
    ['David Mensah', 'bf-bundle-a', 194, 'unassigned', null], ['Ngozi Obi', 'webinar-register', 12, 'responded', amara, 142], ['Ibrahim Musa', 'lekki-offplan', 67, 'assigned', tunde],
    ['Grace Lawal', 'bf-bundle-b', 22, 'responded', tunde, 222], ['Emeka Nnaji', 'refer-a-friend', 95, 'responded', sarah, 310], ['Aisha Bello', 'webinar-register', 140, 'responded', kofi, 188],
    ['Yemi Alade', 'bf-bundle-b', 180, 'responded', sarah, 2710], ['Kwame Asante', 'bf-bundle-a', 1.1, 'unassigned', null], ['Zainab Yusuf', 'webinar-register', 300, 'responded', amara, 96],
    ['Tolu Bakare', 'lekki-offplan', 420, 'responded', marcus, 204], ['Joy Ekpo', 'bf-bundle-a', 510, 'responded', kofi, 1310], ['Segun Arinze', 'webinar-register', 600, 'responded', amara, 120],
    ['Halima Sani', 'bf-bundle-a', 55, 'assigned', kofi], ['Uche Okoro', 'refer-a-friend', 800, 'responded', sarah, 480], ['Bisi Coker', 'webinar-register', 1000, 'responded', kofi, 260],
    ['Femi Kuti', 'bf-bundle-a', 1400, 'responded', tunde, 175], ['Ada Igwe', 'lekki-offplan', 1600, 'responded', tunde, 330],
  ];
  // Bulk history so campaigns have real volume and baselines.
  const first = ['Tobi', 'Kemi', 'Musa', 'Ifeoma', 'Chinedu', 'Bola', 'Esther', 'Obinna', 'Lara', 'Sani', 'Nneka', 'Dayo', 'Hauwa', 'Kunle', 'Precious'];
  const last = ['Adebayo', 'Okeke', 'Balogun', 'Eze', 'Ibrahim', 'Nwachukwu', 'Ogunleye', 'Danjuma', 'Afolabi', 'Chukwu'];
  const bulkPages = ['bf-bundle-a', 'bf-bundle-a', 'bf-bundle-b', 'webinar-register', 'webinar-register', 'webinar-register', 'lekki-offplan', 'refer-a-friend'];
  const responders = [tunde, sarah, amara, kofi, marcus];
  for (let i = 0; i < 260; i++) {
    const minutes = 60 * 26 + ((i * 97) % (60 * 24 * 20));
    const pg = bulkPages[i % bulkPages.length];
    const slow = pg.startsWith('bf-bundle-b') || (i % 11 === 0);
    L.push([`${first[i % first.length]} ${last[(i * 7) % last.length]}`, pg, minutes, i % 29 === 0 ? 'unassigned' : 'responded', i % 29 === 0 ? null : responders[i % responders.length], slow ? 900 + (i % 5) * 600 : 60 + ((i * 53) % 280)]);
  }
  const summerRows: typeof L = [];
  for (let i = 0; i < 120; i++) summerRows.push([`${first[(i + 3) % first.length]} ${last[(i + 2) % last.length]}`, 'summer-main', (27 + (i % 80)) * 24 * 60, 'responded', responders[i % responders.length], 90 + ((i * 41) % 420)]);
  L.push(...summerRows);

  const leadRows = L.map(([fullName, pg, minAgo, st, who, resp], i) => {
    const d = page(pg);
    const received = ago(minAgo * MIN);
    const utm = i % 4 === 3 ? {} : { utmSource: i % 2 ? 'facebook' : 'instagram', utmMedium: 'paid_social', utmCampaign: `${pg.split('-')[0]}_2026`, utmContent: i % 3 ? 'carousel_v2' : 'video_15s', utmTerm: i % 5 === 0 ? 'bundle deal' : null };
    const base = {
      tenantId: T, deploymentId: d.id, campaignId: d.campaignId, fullName, email: `${fullName.toLowerCase().replace(/[^a-z]+/g, '.')}${i}@example.com`,
      phone: `+234 80${(31 + (i % 60)).toString().padStart(2, '0')} ${(412 + i * 7) % 1000} ${1000 + ((i * 37) % 9000)}`,
      sourceSystem: d.campaignId === prop.id ? 'gohighlevel' : d.campaignId === web.id ? 'systeme_io' : d.campaignId === ref.id ? 'typeform' : 'tally',
      sourceIdentifier: `sub_${(98231 + i * 13).toString(36)}`, vip: d.vip, receivedAt: received, createdAt: received,
      hasExternalLifecycleEvents: i % 3 !== 1, ...utm,
      // Historical demo leads already past the SLA were alerted "back then" — don't re-send on every fresh boot.
      slaAlertSentAt: minAgo > (d.vip ? 10 : 30) ? new Date(received.getTime() + (d.vip ? 10 : 30) * MIN) : null,
    };
    if (st === 'responded') return { ...base, status: 'responded' as const, assignmentPath: 'A' as const, assigneeId: who!.id, claimedAt: new Date(received.getTime() + resp! * 1000), respondedAt: new Date(received.getTime() + resp! * 1000), respondedBy: who!.id, slaAlertSentAt: resp! > 1800 ? new Date(received.getTime() + 1800_000) : null };
    if (st === 'assigned') return { ...base, assignmentPath: 'B' as const, assigneeId: who!.id, assignedAt: new Date(received.getTime() + Math.min(4 * MIN, minAgo * MIN * 0.3)) };
    return base;
  });
  const inserted: Array<typeof s.leads.$inferSelect> = [];
  for (let i = 0; i < leadRows.length; i += 100) inserted.push(...await db.insert(s.leads).values(leadRows.slice(i, i + 100)).returning());

  // Assignment history + lifecycle.
  const hist = [], life = [];
  for (const l of inserted) {
    life.push({ tenantId: T, leadId: l.id, event: 'Lead received', source: 'camplo', eventTimestamp: l.receivedAt });
    if (l.assignmentPath === 'B') hist.push({ tenantId: T, leadId: l.id, toAssigneeId: l.assigneeId!, path: 'B' as const, actionedBy: marcus.id, actionedAt: l.assignedAt! });
    if (l.respondedAt) {
      hist.push({ tenantId: T, leadId: l.id, toAssigneeId: l.assigneeId!, path: 'A' as const, actionedBy: l.assigneeId!, actionedAt: l.respondedAt });
      life.push({ tenantId: T, leadId: l.id, event: `Responded — ${U.find((u) => u.id === l.respondedBy)!.name}`, source: 'camplo', eventTimestamp: l.respondedAt });
    }
    if (l.hasExternalLifecycleEvents) {
      const crm = l.sourceSystem === 'gohighlevel' ? 'gohighlevel' : 'twenty_crm';
      const b = (l.respondedAt ?? l.receivedAt).getTime();
      const steps: Array<[number, string, boolean]> = [[7 * MIN, 'Person created', false], [28 * MIN, 'Opportunity created', false], [3.5 * HOUR, 'Opportunity → Meeting', false], [9 * HOUR, 'Appointment booked', true], [19 * HOUR, 'WON', true]];
      const h = inserted.indexOf(l);
      for (const [off, ev, ms] of steps) {
        if (b + off > now) break;
        if (ev === 'WON' && h % 5 !== 0) break;
        if (ev === 'Appointment booked' && h % 2 !== 0) break;
        life.push({ tenantId: T, leadId: l.id, event: ev, source: crm, isMilestone: ms, eventTimestamp: new Date(b + off) });
      }
    }
  }
  for (let i = 0; i < hist.length; i += 200) await db.insert(s.leadAssignmentHistory).values(hist.slice(i, i + 200));
  for (let i = 0; i < life.length; i += 200) await db.insert(s.leadLifecycleEvents).values(life.slice(i, i + 200));
  const byName = (n: string) => inserted.find((l) => l.fullName === n)!;

  // Notes (permanent).
  await db.insert(s.notes).values([
    { tenantId: T, noteType: 'campaign', entityId: bf.id, authorId: tunde.id, content: 'bf-bundle-b form looks broken on iOS Safari — submit button does nothing. Checking with the dev now.', createdAt: ago(40 * MIN) },
    { tenantId: T, noteType: 'campaign', entityId: bf.id, authorId: marcus.id, content: 'Pausing the video ad set until CPL comes back under threshold. Carousel is carrying the campaign.', createdAt: ago(80 * MIN) },
    { tenantId: T, noteType: 'campaign', entityId: bf.id, authorId: sarah.id, content: 'Called 11 leads from yesterday afternoon. 4 want the bundle delivered before Nov 20 — flagging for ops.', createdAt: ago(26 * HOUR) },
    { tenantId: T, noteType: 'meeting', entityId: bf.id, authorId: marcus.id, via: 'Manual', title: 'Weekly campaign sync', meetingDate: ago(30 * HOUR), content: 'Agreed to test a VIP early-access page; Kofi owns the Tally form; revisit budget Friday.', createdAt: ago(30 * HOUR) },
    { tenantId: T, noteType: 'lead', entityId: byName('Folake Ade').id, authorId: sarah.id, content: 'Asked for pricing twice by email. Prefers WhatsApp.', createdAt: ago(35 * MIN) },
    { tenantId: T, noteType: 'campaign', entityId: prop.id, authorId: amara.id, content: 'VIP leads from lekki-offplan want site visits on weekends — we need Saturday cover.', createdAt: ago(5 * HOUR) },
  ]);
  for (const [author, to, content, att, attId, deadlineMs, minAgo] of [
    [marcus, [sarah], 'Please call Folake Ade before 3pm — she asked for pricing twice.', 'lead', byName('Folake Ade').id, 50 * MIN, 35],
    [tunde, [marcus], 'Twenty CRM sync is dropping the phone field for Tally leads. Can we raise it with support?', 'campaign', bf.id, null, 120],
    [marcus, [tunde, amara], 'Great work on response times this week. Let’s keep the Lekki VIP leads under 5 minutes.', null, null, null, 1200],
    [marcus, [kofi], 'Update the bf-vip-early form fields before Friday.', 'campaign', bf.id, -2 * HOUR, 1560],
  ] as const) {
    const [tn] = await db.insert(s.teamNotes).values({
      tenantId: T, authorId: author.id, content, attachmentType: att, attachmentId: attId, createdAt: ago(minAgo * MIN),
      timeBoundDeadline: deadlineMs == null ? null : new Date(now + deadlineMs), timeBoundStatus: deadlineMs == null ? null : deadlineMs < 0 ? 'expired' : 'pending',
    }).returning();
    await db.insert(s.teamNoteRecipients).values(to.map((u) => ({ tenantId: T, teamNoteId: tn.id, userId: u.id, readAt: minAgo > 60 ? ago((minAgo - 30) * MIN) : null })));
  }

  // Integrations (Watchtower: several connected) + cross-tool rules/breaches.
  const [twenty] = await db.insert(s.integrations).values({ tenantId: T, provider: 'twenty_crm', connectionMethod: 'api_key', apiKeyEncrypted: encrypt('twenty_demo_key_7f3a', 'integration'), activeModes: ['receive', 'send', 'query'], status: 'connected', lastVerifiedAt: ago(DAY) }).returning();
  await db.update(s.integrations).set({ webhookUrl: `${config.appUrl}/api/v1/lifecycle/${twenty.id}/${tok(18)}` }).where(sql`${s.integrations.id} = ${twenty.id}`);
  await db.insert(s.integrations).values([
    { tenantId: T, provider: 'tally', connectionMethod: 'webhook', activeModes: ['receive'], status: 'connected', lastVerifiedAt: ago(DAY) },
    { tenantId: T, provider: 'umami', connectionMethod: 'api_key', apiKeyEncrypted: encrypt('umami_demo_key_91c2', 'integration'), activeModes: ['query'], status: 'connected', lastVerifiedAt: ago(DAY) },
    { tenantId: T, provider: 'gohighlevel', connectionMethod: 'api_key', apiKeyEncrypted: encrypt('ghl_demo_key_0b77', 'integration'), activeModes: ['receive', 'send', 'query'], status: 'failed', lastVerifiedAt: ago(2 * DAY) },
  ]);
  const [rule] = await db.insert(s.crossToolSlaRules).values([
    { tenantId: T, integrationId: twenty.id, ruleType: 'not_contacted', thresholdValue: 24, thresholdUnit: 'hours', enabled: true, notificationChannels: ['ai_panel', 'email'] },
    { tenantId: T, integrationId: twenty.id, ruleType: 'not_proposal', thresholdValue: 72, thresholdUnit: 'hours', enabled: true, notificationChannels: ['ai_panel'] },
    { tenantId: T, integrationId: twenty.id, ruleType: 'no_activity', thresholdValue: 7, thresholdUnit: 'days', enabled: false, notificationChannels: ['ai_panel'] },
  ]).returning();
  await db.insert(s.crossToolSlaBreaches).values([
    { tenantId: T, leadId: byName('Grace Lawal').id, integrationId: twenty.id, ruleId: rule.id, breachType: 'not_contacted', hoursExceeded: 3, detectedAt: ago(2 * HOUR) },
    { tenantId: T, leadId: byName('Joy Ekpo').id, integrationId: twenty.id, ruleId: rule.id, breachType: 'not_contacted', hoursExceeded: 11, detectedAt: ago(5 * HOUR) },
  ]);
  const [ib] = await db.insert(s.inboundWebhooks).values({ tenantId: T, sourceLabel: 'Instantly — warm replies', url: 'pending', secretEncrypted: encrypt(tok(24), 'webhook'), campaignId: bf.id, lastReceivedAt: ago(5 * HOUR) }).returning();
  await db.update(s.inboundWebhooks).set({ url: `${config.appUrl}/api/v1/hooks/${ib.id}` }).where(sql`${s.inboundWebhooks.id} = ${ib.id}`);

  // Campaign memory: operator changes with measured outcomes.
  const perf = (lead: number, conv: number, cpl: number | null) => ({ lead_count_7d: lead, avg_response_ms: 260000, acknowledgment_rate: 0.93, cpl, conversion_rate: conv });
  const [ch1, ch2, ch3] = await db.insert(s.campaignChanges).values([
    { tenantId: T, campaignId: bf.id, changeType: 'audience', changeDescription: 'Narrowed audience to 25–44, Lagos + Abuja', changedBy: marcus.id, changedAt: ago(22 * DAY), performanceBefore: perf(120, 0.031, 13100), performanceAfter: perf(131, 0.034, 12200) },
    { tenantId: T, campaignId: bf.id, changeType: 'creative', changeDescription: 'Switched hero creative to 15s video', changedBy: marcus.id, changedAt: ago(16 * DAY), performanceBefore: perf(131, 0.034, 12200), performanceAfter: perf(140, 0.026, 14300) },
    { tenantId: T, campaignId: bf.id, changeType: 'creative', changeDescription: 'Reverted hero creative to carousel', changedBy: marcus.id, changedAt: ago(8 * DAY), performanceBefore: perf(140, 0.026, 14300), performanceAfter: perf(128, 0.033, 12900) },
  ]).returning();

  // Recommendations (L2/L3/L4) with dormant apply_action.
  await db.insert(s.campaignRecommendations).values([
    { tenantId: T, campaignId: bf.id, level: 2, actionText: 'Cut bf-bundle-b spend by 20% until its webhook is fixed', why: 'Conversion on bf-bundle-b halved while spend kept rising.',
      evidence: [{ metric: 'CPL', change: '+28%', period: '14 days' }, { metric: 'bf-bundle-b conversion', change: '9.1% → 4.2%', period: '7 days' }, { metric: 'bf-bundle-a conversion', change: 'stable', period: '7 days' }],
      diagnosis: 'Traffic quality is unchanged (CTR flat). The drop starts at the page, the same day its webhook began dropping submissions.', expectedOutcome: 'Lower lead volume but CPL back under threshold.',
      risk: 'bf-bundle-b still feeds some top-of-funnel volume.', confidence: 'medium', nextStep: 'Reduce by 20% and reassess after 7 days or 100 leads.', whyNow: 'CPL above threshold 5 days running.',
      memoryReferences: [ch2.id, ch3.id], applyAction: { type: 'budget_adjustment', platform: 'meta_ads', adjustment: '-20%', status: 'pending_v2' }, surfacedAt: ago(52 * MIN) },
    { tenantId: T, campaignId: prop.id, level: 3, actionText: 'Test the previous Lekki page positioning against the new variant before changing media', why: 'Lead volume is stable but qualified-lead rate fell 37% after the messaging change.',
      evidence: [{ metric: 'CTR', change: 'unchanged', period: '21 days' }, { metric: 'Page conversion', change: 'unchanged', period: '21 days' }, { metric: 'Qualified-lead rate', change: '−37%', period: '21 days' }],
      diagnosis: 'Traffic → page → lead is healthy; qualification is where it breaks. The new "from ₦15m" positioning attracts browsers rather than buyers.',
      expectedOutcome: 'Qualified-lead rate recovers toward the July baseline.', risk: 'Old positioning produced ~12% fewer enquiries.', confidence: 'high', nextStep: 'Run a 50/50 split for 10 days.', whyNow: 'Three weeks of consistent decline; sample now large enough.',
      memoryReferences: [], applyAction: null, surfacedAt: ago(3 * HOUR) },
    { tenantId: T, campaignId: null, level: 4, actionText: 'Stop optimising for lead volume — reallocate toward referral and webinar channels', why: 'Your highest-volume channel is not your most efficient growth channel.',
      evidence: [{ metric: 'Paid social share of leads', change: '61%', period: '90 days' }, { metric: 'Paid social share of qualified opportunities', change: '28%', period: '90 days' }, { metric: 'Referral + webinar share of qualified opportunities', change: '41%', period: '90 days' }],
      diagnosis: 'Cost per qualified opportunity on paid social is 3.2× referral. Volume masks the inefficiency in weekly reports.', expectedOutcome: 'Fewer total leads, more closed deals per naira.',
      risk: 'Referral volume has a ceiling; paid social still seeds awareness.', confidence: 'medium', nextStep: 'Shift 15% of paid social budget to referral incentives next month.', whyNow: 'Q4 budgets are being set this week.',
      memoryReferences: [ch1.id], applyAction: null, surfacedAt: ago(20 * HOUR) },
    { tenantId: T, campaignId: bf.id, level: 2, actionText: 'Refresh the Black Friday creative', why: 'CTR has plateaued.', evidence: [{ metric: 'CTR', change: 'flat', period: '14 days' }],
      expectedOutcome: 'Higher CTR.', risk: 'May lower lead quality.', confidence: 'low', nextStep: 'Test two new creatives.', whyNow: 'Plateau detected.', memoryReferences: [],
      status: 'dismissed', surfacedAt: ago(5 * DAY), actionedAt: ago(5 * DAY) },
  ]);

  // Insight feed.
  const ins = (x: Omit<typeof s.insights.$inferInsert, 'tenantId'>) => ({ tenantId: T, ...x });
  await db.insert(s.insights).values([
    ins({ campaignId: bf.id, campaignTag: bf.name, type: 'priority_flag', severity: 'red', category: 'SLA', generatedAt: ago(18 * MIN), dedupeKey: `pf:${bf.id}:seed`,
      observation: 'Black Friday is failing at three handoffs at once — this is systemic, not one slow rep.',
      evidence: 'Unclaimed leads past threshold, acknowledged leads missing from Twenty CRM, and bf-bundle-b’s webhook silent for over 2 hours while ads keep spending.' }),
    ins({ campaignId: bf.id, campaignTag: bf.name, type: 'alert', severity: 'red', category: 'SLA', generatedAt: ago(34 * MIN), dedupeKey: 'seed:crm',
      observation: 'Leads acknowledged this week have not been logged in your CRM.', evidence: 'The oldest is 11 hours past your 24-hour CRM threshold. Your CRM rule is "moved to Contacted within 24h".' }),
    ins({ campaignId: bf.id, campaignTag: bf.name, type: 'alert', severity: 'amber', category: 'Spend', generatedAt: ago(52 * MIN), dedupeKey: 'seed:cpl',
      observation: 'CPL on Black Friday has crossed your ₦12,000 threshold for the 5th day running.', evidence: 'Ad CTR is unchanged, so traffic quality is not the cause — conversion on bf-bundle-b fell from 9.1% to 4.2%.' }),
    ins({ campaignId: prop.id, campaignTag: prop.name, type: 'observation', severity: 'amber', category: 'Engagement', generatedAt: ago(2 * HOUR), dedupeKey: 'seed:email',
      observation: 'Lekki leads open the first follow-up email but drop off at step 2.', evidence: 'Step 1 open rate 61%, step 2 open rate 14%. The drop began when the step-2 subject line changed.' }),
    ins({ campaignId: web.id, campaignTag: web.name, type: 'observation', severity: 'blue', category: 'Performance', generatedAt: ago(3 * HOUR), dedupeKey: 'seed:tue',
      observation: 'Webinar registrations peak on Tuesdays between 7 and 9pm.', evidence: '38% of this month’s registrations arrived in that window, yet only one team member is typically online then.' }),
    ins({ campaignId: prop.id, campaignTag: prop.name, type: 'win', severity: 'green', category: 'SLA', generatedAt: ago(4 * HOUR), dedupeKey: 'seed:win',
      observation: 'Tunde responded to a Lekki VIP lead in 3m 42s — inside the 5-minute conversion window.', evidence: 'That lead has already moved to "Meeting booked". Tunde’s best response time this month.' }),
    ins({ campaignId: web.id, campaignTag: web.name, type: 'win', severity: 'green', category: 'Performance', generatedAt: ago(26 * HOUR), dedupeKey: 'seed:conv',
      observation: 'webinar-register now converts at 2.1× your account average.', evidence: 'Registrations vs visits over the last 7 days, compared with the workspace average.' }),
    ins({ campaignId: ref.id, campaignTag: ref.name, type: 'insufficient_evidence', severity: 'blue', category: 'Performance', generatedAt: ago(4 * HOUR), dedupeKey: `ie:${ref.id}`,
      observation: 'Conversion on refer-a-friend has declined 8% — monitoring', evidence: 'The campaign has generated too few leads this period to confidently recommend a change.',
      reassessCondition: '100 additional leads OR 7 days — whichever comes first', reassessAt: new Date(now + 5 * DAY) }),
  ]);

  // Retrospective for the completed campaign (generated synchronously at seed time).
  await db.insert(s.campaignRetrospectives).values({ tenantId: T, campaignId: sum.id });
  const { generateRetrospective } = await import('../services/campaigns.js');
  await generateRetrospective(db, T, sum.id);

  // Logs + notifications + chat.
  const logs: Array<[number, typeof U[number] | null, string]> = [
    [15, tunde, 'Responded to Grace Lawal in 3m 42s'], [40, tunde, 'Tunde Omolayo added a note'], [58, null, 'Webhook on bf-bundle-b stopped receiving events'],
    [120, marcus, 'Assigned Folake Ade to Sarah Okafor'], [300, marcus, 'Logged creative change: paused video ad set'], [1560, sarah, 'Responded to 11 leads'],
    [1620, null, 'Camplo raised a Priority Flag — 3 concurrent SLA breaches'], [3000, kofi, 'Page bf-bundle-b redeployed by Kofi Mensah'], [4440, marcus, 'CPL threshold set to 12000 by Marcus Adeyemi'],
  ];
  await db.insert(s.campaignLogs).values(logs.map(([m, u, d]) => ({ tenantId: T, campaignId: bf.id, actorId: u?.id ?? null, description: d, createdAt: ago(m * MIN) })));
  await db.insert(s.notifications).values([
    { tenantId: T, kind: 'sla_breach', description: 'SLA breached — David Mensah', link: `/leads/${byName('David Mensah').id}`, createdAt: ago(12 * MIN) },
    { tenantId: T, kind: 'webhook_offline', description: 'bf-bundle-b webhook offline', link: '/pages', createdAt: ago(58 * MIN) },
    { tenantId: T, kind: 'insight', description: 'Priority Flag raised on Black Friday 2026', link: `/campaigns/${bf.id}/insights`, createdAt: ago(18 * MIN) },
    { tenantId: T, kind: 'insight', description: 'Tunde responded to a VIP lead in 3m 42s', link: `/campaigns/${prop.id}/insights`, readAt: ago(3 * HOUR), createdAt: ago(4 * HOUR) },
  ]);
  await db.insert(s.chatMessages).values([
    { tenantId: T, userId: marcus.id, role: 'user', content: 'Why did Black Friday CPL jump this week?', createdAt: ago(26 * HOUR) },
    { tenantId: T, role: 'assistant', workloadLevel: 'standard', createdAt: ago(26 * HOUR - 20_000),
      content: `CPL rose about **28%**. Ad CTR is flat, so traffic quality is not the cause. The drop is at the page: [bf-bundle-b](#/pages) conversion fell from 9.1% to 4.2% on the same day its webhook began dropping submissions.\n\nCampaign memory also shows the video creative test (16 days ago) lowered conversion, so I would not refresh creative again yet.` },
  ]);
  await db.insert(s.workspaceLogs).values([{ tenantId: T, actorId: marcus.id, description: 'Workspace created by Marcus Adeyemi', createdAt: ago(90 * DAY) }]);
  return { tenantId: T };
}
