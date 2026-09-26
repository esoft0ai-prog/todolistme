/**
 * Campaign / lead / meeting notes and Team Notes. Notes are permanent — there
 * is deliberately no delete path anywhere in this module. Editing is allowed
 * only by the author within 2 hours (enforced here, server-side).
 */
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { campaigns, leads, notes, teamNoteRecipients, teamNotes, users } from '../db/schema.js';
import { fail, assertFeature, assertRole, type AuthedContext } from '../lib/orpc.js';
import { HOUR, noteEditable, NOTE_EDIT_WINDOW_MS } from '../domain/rules.js';
import { emit, logCampaign, notify } from './effects.js';
import { loadCampaign } from './campaigns.js';
import { loadLead } from './leads.js';
import type { DB } from '../db/client.js';

type Note = typeof notes.$inferSelect;

function serialize(n: Note & { authorName: string | null }, userId: string) {
  const editable = noteEditable(n.createdAt, n.authorId, userId);
  return {
    id: n.id, type: n.noteType, entityId: n.entityId, authorId: n.authorId, authorName: n.authorName ?? 'Unknown', content: n.content,
    title: n.title, meetingDate: n.meetingDate, via: n.via, editedAt: n.editedAt, createdAt: n.createdAt,
    editable, editableUntil: editable ? new Date(n.createdAt.getTime() + NOTE_EDIT_WINDOW_MS) : null,
  };
}

async function list(ctx: AuthedContext, type: 'campaign' | 'lead' | 'meeting', entityId: string) {
  const rows = await ctx.db.select({ n: notes, authorName: users.name }).from(notes).leftJoin(users, eq(users.id, notes.authorId))
    .where(and(eq(notes.tenantId, ctx.tenantId), eq(notes.noteType, type), eq(notes.entityId, entityId))).orderBy(desc(notes.createdAt));
  return rows.map((r) => serialize({ ...r.n, authorName: r.authorName }, ctx.user.id));
}

async function create(ctx: AuthedContext, type: 'campaign' | 'lead' | 'meeting', entityId: string, content: string, extra: { title?: string | null; meetingDate?: string | null } = {}) {
  const text = content.trim();
  if (!text) throw fail.bad('Note cannot be empty.');
  const [n] = await ctx.db.insert(notes).values({
    tenantId: ctx.tenantId, noteType: type, entityId, authorId: ctx.user.id, content: text,
    title: extra.title ?? null, meetingDate: extra.meetingDate ? new Date(extra.meetingDate) : null, via: type === 'meeting' ? 'Manual' : null,
  }).returning();
  return serialize({ ...n, authorName: ctx.user.name }, ctx.user.id);
}

async function edit(ctx: AuthedContext, noteId: string, content: string, scope: { type: 'campaign' | 'lead' | 'meeting'; entityId: string } | null) {
  const [n] = await ctx.db.select().from(notes).where(and(eq(notes.tenantId, ctx.tenantId), eq(notes.id, noteId)));
  if (!n || (scope && (n.entityId !== scope.entityId || (scope.type !== n.noteType && !(scope.type === 'campaign' && n.noteType === 'meeting'))))) throw fail.notFound('Note not found.');
  if (n.authorId !== ctx.user.id) throw fail.forbidden('Only the author can edit a note.');
  if (!noteEditable(n.createdAt, n.authorId, ctx.user.id)) throw fail.forbidden('Notes can only be edited within 2 hours of posting.', 'edit_window_closed');
  if (!content.trim()) throw fail.bad('Note cannot be empty.');
  const [u] = await ctx.db.update(notes).set({ content: content.trim(), editedAt: new Date() }).where(eq(notes.id, noteId)).returning();
  return serialize({ ...u, authorName: ctx.user.name }, ctx.user.id);
}

export async function campaignNotes(ctx: AuthedContext, campaignId: string) { await loadCampaign(ctx, campaignId); return list(ctx, 'campaign', campaignId); }
export async function addCampaignNote(ctx: AuthedContext, campaignId: string, content: string) {
  const c = await loadCampaign(ctx, campaignId);
  const n = await create(ctx, 'campaign', campaignId, content);
  await logCampaign(ctx.db, ctx.tenantId, c.id, ctx.user.id, `${ctx.user.name} added a note`);
  return n;
}
export async function editCampaignNote(ctx: AuthedContext, campaignId: string, noteId: string, content: string) {
  await loadCampaign(ctx, campaignId); return edit(ctx, noteId, content, { type: 'campaign', entityId: campaignId });
}
export async function meetingNotes(ctx: AuthedContext, campaignId: string) { await loadCampaign(ctx, campaignId); return list(ctx, 'meeting', campaignId); }
export async function addMeetingNote(ctx: AuthedContext, campaignId: string, input: { title?: string | null; meetingDate?: string | null; content: string }) {
  await loadCampaign(ctx, campaignId); return create(ctx, 'meeting', campaignId, input.content, input);
}
export async function leadNotes(ctx: AuthedContext, leadId: string) { await loadLead(ctx, leadId); return list(ctx, 'lead', leadId); }
export async function addLeadNote(ctx: AuthedContext, leadId: string, content: string) {
  const l = await loadLead(ctx, leadId);
  const n = await create(ctx, 'lead', leadId, content);
  if (l.campaignId) await logCampaign(ctx.db, ctx.tenantId, l.campaignId, ctx.user.id, `${ctx.user.name} added a note on ${l.fullName}`);
  return n;
}
export async function editLeadNote(ctx: AuthedContext, leadId: string, noteId: string, content: string) {
  await loadLead(ctx, leadId); return edit(ctx, noteId, content, { type: 'lead', entityId: leadId });
}
export const editAnyNote = (ctx: AuthedContext, noteId: string, content: string) => edit(ctx, noteId, content, null);

// ------------------------------------------------------------------ Team Notes (C31)

async function hydrateTeamNotes(ctx: AuthedContext, rows: Array<typeof teamNotes.$inferSelect>) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const recips = await ctx.db.select({ r: teamNoteRecipients, name: users.name }).from(teamNoteRecipients).innerJoin(users, eq(users.id, teamNoteRecipients.userId))
    .where(and(eq(teamNoteRecipients.tenantId, ctx.tenantId), inArray(teamNoteRecipients.teamNoteId, ids)));
  const names = new Map((await ctx.db.select({ id: users.id, name: users.name }).from(users).where(eq(users.tenantId, ctx.tenantId))).map((u) => [u.id, u.name]));
  const leadIds = rows.filter((r) => r.attachmentType === 'lead' && r.attachmentId).map((r) => r.attachmentId!);
  const campIds = rows.filter((r) => r.attachmentType === 'campaign' && r.attachmentId).map((r) => r.attachmentId!);
  const leadNames = new Map(leadIds.length ? (await ctx.db.select({ id: leads.id, name: leads.fullName, cid: leads.campaignId }).from(leads).where(inArray(leads.id, leadIds))).map((l) => [l.id, l]) : []);
  const campNames = new Map(campIds.length ? (await ctx.db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns).where(inArray(campaigns.id, campIds))).map((c) => [c.id, c.name]) : []);
  const now = Date.now();
  return rows.map((t) => {
    const rs = recips.filter((x) => x.r.teamNoteId === t.id);
    const mine = rs.find((x) => x.r.userId === ctx.user.id);
    const lead = t.attachmentType === 'lead' ? leadNames.get(t.attachmentId!) : undefined;
    const editable = noteEditable(t.createdAt, t.authorId, ctx.user.id);
    return {
      id: t.id, authorId: t.authorId, authorName: names.get(t.authorId) ?? 'Unknown', content: t.content, createdAt: t.createdAt, editedAt: t.editedAt,
      recipients: rs.map((x) => ({ userId: x.r.userId, name: x.name, readAt: x.r.readAt, acknowledgedAt: x.r.acknowledgedAt })),
      attachment: t.attachmentType ? { type: t.attachmentType, id: t.attachmentId, name: lead?.name ?? campNames.get(t.attachmentId!) ?? null, campaignId: lead?.cid ?? null } : null,
      deadline: t.timeBoundDeadline, deadlineStatus: t.timeBoundStatus,
      addressedToMe: !!mine, unread: !!mine && !mine.r.readAt, canAcknowledge: !!mine && t.timeBoundStatus === 'pending',
      approaching: t.timeBoundStatus === 'pending' && !!t.timeBoundDeadline && t.timeBoundDeadline.getTime() - now < HOUR,
      editable, editableUntil: editable ? new Date(t.createdAt.getTime() + NOTE_EDIT_WINDOW_MS) : null,
    };
  });
}
export type TeamNoteDTO = Awaited<ReturnType<typeof hydrateTeamNotes>>[number];

/** Ordering (Screen 17): unread+approaching → unread → read+time-bound pending → rest; newest first. */
function orderTeamNotes(list: TeamNoteDTO[]) {
  const rank = (n: TeamNoteDTO) => (n.unread && n.approaching ? 0 : n.unread ? 1 : n.deadlineStatus === 'pending' ? 2 : 3);
  return list.sort((a, b) => rank(a) - rank(b) || b.createdAt.getTime() - a.createdAt.getTime());
}

export async function listTeamNotes(ctx: AuthedContext, opts: { addressedTo?: 'me'; leadId?: string; campaignId?: string } = {}) {
  assertFeature(ctx, 'team_notes');
  const conds = [eq(teamNotes.tenantId, ctx.tenantId)];
  if (opts.leadId) conds.push(eq(teamNotes.attachmentType, 'lead'), eq(teamNotes.attachmentId, opts.leadId));
  if (opts.campaignId) conds.push(eq(teamNotes.attachmentType, 'campaign'), eq(teamNotes.attachmentId, opts.campaignId));
  if (opts.addressedTo === 'me') {
    conds.push(sql`exists (select 1 from ${teamNoteRecipients} r where r.team_note_id = ${teamNotes.id} and r.user_id = ${ctx.user.id})`);
  }
  const rows = await ctx.db.select().from(teamNotes).where(and(...conds)).orderBy(desc(teamNotes.createdAt)).limit(200);
  return orderTeamNotes(await hydrateTeamNotes(ctx, rows));
}

export async function createTeamNote(ctx: AuthedContext, input: {
  content: string; recipientIds: string[]; attachmentType?: 'lead' | 'campaign' | null; attachmentId?: string | null; deadline?: string | null;
}) {
  assertRole(ctx, 'owner', 'admin');
  assertFeature(ctx, 'team_notes');
  if (!input.content.trim()) throw fail.bad('Note cannot be empty.');
  if (!input.recipientIds.length) throw fail.bad('Tag at least one team member.');
  const members = await ctx.db.select({ id: users.id, name: users.name }).from(users)
    .where(and(eq(users.tenantId, ctx.tenantId), inArray(users.id, input.recipientIds), isNull(users.removedAt)));
  if (members.length !== new Set(input.recipientIds).size) throw fail.bad('Unknown team member.');
  if (input.attachmentType === 'lead' && input.attachmentId) await loadLead(ctx, input.attachmentId);
  if (input.attachmentType === 'campaign' && input.attachmentId) await loadCampaign(ctx, input.attachmentId);
  const deadline = input.deadline ? new Date(input.deadline) : null;
  if (deadline && deadline.getTime() < Date.now()) throw fail.bad('Deadline must be in the future.');
  const [n] = await ctx.db.insert(teamNotes).values({
    tenantId: ctx.tenantId, authorId: ctx.user.id, content: input.content.trim(),
    attachmentType: input.attachmentId ? input.attachmentType ?? null : null, attachmentId: input.attachmentId ?? null,
    timeBoundDeadline: deadline, timeBoundStatus: deadline ? 'pending' : null,
  }).returning();
  await ctx.db.insert(teamNoteRecipients).values(members.map((m) => ({ tenantId: ctx.tenantId, teamNoteId: n.id, userId: m.id })));
  for (const m of members) {
    await notify(ctx.db, ctx.tenantId, { userId: m.id, kind: 'team_note', description: `${ctx.user.name} left you a note: ${n.content.slice(0, 80)}`, link: '/team-notes' });
  }
  emit(ctx.tenantId, 'workspace:team-notes', {});
  return (await hydrateTeamNotes(ctx, [n]))[0];
}

export async function editTeamNote(ctx: AuthedContext, id: string, content: string) {
  const [n] = await ctx.db.select().from(teamNotes).where(and(eq(teamNotes.tenantId, ctx.tenantId), eq(teamNotes.id, id)));
  if (!n) throw fail.notFound('Note not found.');
  if (!noteEditable(n.createdAt, n.authorId, ctx.user.id)) throw fail.forbidden('Notes can only be edited by their author within 2 hours of posting.', 'edit_window_closed');
  const [u] = await ctx.db.update(teamNotes).set({ content: content.trim(), editedAt: new Date() }).where(eq(teamNotes.id, id)).returning();
  return (await hydrateTeamNotes(ctx, [u]))[0];
}

async function recipientRow(ctx: AuthedContext, id: string) {
  const [r] = await ctx.db.select().from(teamNoteRecipients).where(and(eq(teamNoteRecipients.tenantId, ctx.tenantId), eq(teamNoteRecipients.teamNoteId, id), eq(teamNoteRecipients.userId, ctx.user.id)));
  if (!r) throw fail.forbidden('This note is not addressed to you.');
  return r;
}

export async function markTeamNoteRead(ctx: AuthedContext, id: string) {
  const r = await recipientRow(ctx, id);
  if (!r.readAt) await ctx.db.update(teamNoteRecipients).set({ readAt: new Date() }).where(eq(teamNoteRecipients.id, r.id));
  return { ok: true };
}

export async function acknowledgeTeamNote(ctx: AuthedContext, id: string) {
  const r = await recipientRow(ctx, id);
  const now = new Date();
  await ctx.db.update(teamNoteRecipients).set({ acknowledgedAt: now, readAt: r.readAt ?? now }).where(eq(teamNoteRecipients.id, r.id));
  await ctx.db.update(teamNotes).set({ timeBoundStatus: 'met' }).where(and(eq(teamNotes.id, id), eq(teamNotes.timeBoundStatus, 'pending')));
  emit(ctx.tenantId, 'workspace:team-notes', {});
  return { ok: true };
}

/** Hourly job: pending → expired once the deadline passes without acknowledgment. */
export async function expireTeamNotes(db: DB) {
  await db.update(teamNotes).set({ timeBoundStatus: 'expired' }).where(and(eq(teamNotes.timeBoundStatus, 'pending'), lt(teamNotes.timeBoundDeadline, new Date())));
}

