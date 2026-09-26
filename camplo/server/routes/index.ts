/**
 * All JSON REST endpoints (Build Spec "Complete API Reference"), defined with
 * oRPC + Zod and served by the OpenAPI handler under /api.
 * Raw endpoints (ingest, SSE, PDF, sites, Polar, Telegram) live in server/app.ts.
 */
import { z } from 'zod';
import { authed, pub } from '../lib/orpc.js';
import * as auth from '../services/auth.js';
import * as ws from '../services/workspace.js';
import * as camp from '../services/campaigns.js';
import * as lead from '../services/leads.js';
import * as note from '../services/notes.js';
import * as page from '../services/pages.js';
import * as sla from '../services/sla.js';
import * as set from '../services/settings.js';
import * as intel from '../services/intelligence.js';
import * as admin from '../services/admin.js';
import { queueDepth } from '../jobs/scheduler.js';
import { bearer } from '../lib/orpc.js';
import { decodeCursor, envelope, pageIn, pageQuery, paginate } from '../lib/paginate.js';

/** P-4: `{ id }` path input plus `limit` / `cursor`. */
const idPage = z.object({ id: z.string().uuid(), ...pageIn });

const id = z.string().uuid();
const idIn = z.object({ id });
const plan = z.enum(['starter', 'growth', 'watchtower', 'agency']);
const money = z.number().nonnegative().nullable();
const aiProv = z.enum(['anthropic', 'openai', 'groq', 'gemini', 'deepseek', 'mistral', 'cohere', 'xai', 'qwen', 'mimo', 'arcee', 'glm', 'minimax', 'kimi', 'bytedance', 'openrouter', 'other']);
const provider = z.enum(['gohighlevel', 'twenty_crm', 'hubspot', 'salesforce', 'activecampaign', 'mailchimp', 'brevo', 'notifuse', 'meta_ads', 'google_ads', 'slack', 'zapier', 'make', 'tally', 'typeform', 'umami', 'instantly', 'apollo', 'lemlist', 'smartlead', 'systeme_io', 'custom']);
const r = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: `/${string}`) => ({ method, path });

// ------------------------------------------------------------------ auth (8)
const authRoutes = {
  signup: pub.route(r('POST', '/auth/signup')).input(z.object({
    name: z.string().min(1).max(255), email: z.string().email(), password: z.string().min(8), workspaceName: z.string().min(1).max(255),
    plan: z.enum(['starter', 'growth', 'watchtower']).default('growth'),
  })).handler(({ input, context }) => auth.signup(context, input)),
  login: pub.route(r('POST', '/auth/login')).input(z.object({ email: z.string().email(), password: z.string().min(1) }))
    .handler(({ input, context }) => auth.login(context, input.email, input.password)),
  magicLink: pub.route(r('POST', '/auth/magic-link')).input(z.object({ email: z.string().email() })).handler(({ input, context }) => auth.requestMagicLink(context.db, input.email)),
  verify: pub.route(r('GET', '/auth/verify')).input(z.object({ token: z.string().min(10) })).handler(({ input, context }) => auth.verifyMagicLink(context, input.token)),
  logout: pub.route(r('POST', '/auth/logout')).handler(({ context }) => auth.logout(context)),
  refresh: pub.route(r('POST', '/auth/refresh')).handler(({ context }) => auth.refresh(context)),
  forgot: pub.route(r('POST', '/auth/forgot-password')).input(z.object({ email: z.string().email() })).handler(({ input, context }) => auth.forgotPassword(context.db, input.email)),
  reset: pub.route(r('POST', '/auth/reset-password')).input(z.object({ token: z.string().min(10), newPassword: z.string().min(8) }))
    .handler(({ input, context }) => auth.resetPassword(context.db, input.token, input.newPassword)),
  me: authed.route(r('GET', '/auth/me')).handler(({ context }) => ({ user: auth.publicUser(context.user), tenant: auth.publicTenant(context.tenant), next: auth.nextRoute(context.tenant) })),
  updateMe: authed.route(r('PATCH', '/auth/me')).input(z.object({ name: z.string().min(1).optional(), theme: z.enum(['dark', 'light']).optional() }))
    .handler(({ input, context }) => ws.updateMe(context, input)),
};

// ------------------------------------------------------------------ workspace (6) + team (9)
const workspaceRoutes = {
  get: authed.route(r('GET', '/workspace')).handler(({ context }) => ws.getWorkspace(context)),
  patch: authed.route(r('PATCH', '/workspace')).input(z.object({
    name: z.string().min(1).optional(), teamSize: z.string().optional(), hasMarketingStack: z.boolean().optional(),
    stackCheckCompleted: z.boolean().optional(), setupComplete: z.boolean().optional(), notificationEmail: z.string().email().optional(),
  })).handler(({ input, context }) => ws.patchWorkspace(context, input)),
  plan: authed.route(r('GET', '/workspace/plan')).handler(({ context }) => ws.planInfo(context)),
  upgrade: authed.route(r('POST', '/workspace/upgrade')).input(z.object({ targetPlan: plan })).handler(({ input, context }) => ws.upgrade(context, input.targetPlan)),
  logo: authed.route(r('POST', '/workspace/logo')).input(z.object({ file: z.instanceof(File) })).handler(({ input, context }) => ws.uploadLogo(context, input.file)),
  removeLogo: authed.route(r('DELETE', '/workspace/logo')).handler(({ context }) => ws.removeLogo(context)),
};
const teamRoutes = {
  members: authed.route(r('GET', '/team/members')).input(pageQuery).handler(async ({ input, context }) => paginate(await ws.listMembers(context), input)),
  member: authed.route(r('GET', '/team/members/{id}')).input(idIn).handler(({ input, context }) => ws.getMember(context, input.id)),
  role: authed.route(r('PATCH', '/team/members/{id}/role')).input(z.object({ id, role: z.enum(['admin', 'member']) })).handler(({ input, context }) => ws.changeRole(context, input.id, input.role)),
  remove: authed.route(r('DELETE', '/team/members/{id}')).input(idIn).handler(({ input, context }) => ws.removeMember(context, input.id)),
  invitations: authed.route(r('GET', '/team/invitations')).input(pageQuery).handler(async ({ input, context }) => paginate(await ws.listInvitations(context), input)),
  invite: authed.route(r('POST', '/team/invitations')).input(z.object({ email: z.string().email(), role: z.enum(['admin', 'member']).default('member') }))
    .handler(({ input, context }) => ws.invite(context, input.email, input.role)),
  resend: authed.route(r('POST', '/team/invitations/{id}/resend')).input(idIn).handler(({ input, context }) => ws.resendInvitation(context, input.id)),
  cancel: authed.route(r('DELETE', '/team/invitations/{id}')).input(idIn).handler(({ input, context }) => ws.cancelInvitation(context, input.id)),
  accept: pub.route(r('POST', '/team/invitations/accept')).input(z.object({ token: z.string().min(10), password: z.string().min(8), name: z.string().optional() }))
    .handler(({ input, context }) => auth.acceptInvitation(context, input.token, input.password, input.name)),
};

// ------------------------------------------------------------------ campaigns (11) + share + logs + retrospective
const campaignInput = z.object({
  name: z.string().trim().min(1).max(100), description: z.string().nullable().optional(), startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  budget: money.optional(), currency: z.string().max(10).optional(), cplThreshold: money.optional(), dailySpend: money.optional(),
});
const campaignRoutes = {
  list: authed.route(r('GET', '/campaigns')).input(pageQuery).handler(async ({ input, context }) => paginate(await camp.listCampaigns(context), input)),
  create: authed.route(r('POST', '/campaigns')).input(campaignInput).handler(({ input, context }) => camp.createCampaign(context, input)),
  get: authed.route(r('GET', '/campaigns/{id}')).input(idIn).handler(({ input, context }) => camp.getCampaign(context, input.id)),
  patch: authed.route(r('PATCH', '/campaigns/{id}')).input(z.object({
    id, name: z.string().trim().min(1).max(100).optional(), description: z.string().nullable().optional(), dailySpend: money.optional(), budget: money.optional(),
    cplThreshold: money.optional(), startDate: z.string().optional(), status: z.enum(['paused', 'active']).optional(),
    change: z.object({ type: z.enum(['budget', 'audience', 'creative', 'messaging', 'page']), description: z.string().min(3).max(500) }).optional(),
  })).handler(({ input: { id: cid, ...rest }, context }) => camp.updateCampaign(context, cid, rest)),
  delete: authed.route(r('DELETE', '/campaigns/{id}')).input(idIn).handler(({ input, context }) => camp.deleteCampaign(context, input.id)),
  complete: authed.route(r('POST', '/campaigns/{id}/complete')).input(idIn).handler(({ input, context }) => camp.completeCampaign(context, input.id)),
  pin: authed.route(r('POST', '/campaigns/{id}/pin')).input(idIn).handler(({ input, context }) => camp.setPinned(context, input.id, true)),
  unpin: authed.route(r('DELETE', '/campaigns/{id}/pin')).input(idIn).handler(({ input, context }) => camp.setPinned(context, input.id, false)),
  health: authed.route(r('GET', '/campaigns/{id}/health')).input(idIn).handler(({ input, context }) => camp.campaignHealth(context, input.id)),
  speed: authed.route(r('GET', '/campaigns/{id}/speed-to-lead')).input(idIn).handler(({ input, context }) => camp.campaignSpeedToLead(context, input.id)),
  cpl: authed.route(r('GET', '/campaigns/{id}/cpl')).input(idIn).handler(({ input, context }) => camp.campaignCplInfo(context, input.id)),
  logs: authed.route(r('GET', '/campaigns/{id}/logs')).input(z.object({ id, from: z.string().optional(), to: z.string().optional(), ...pageIn }))
    .handler(async ({ input, context }) => envelope(await camp.campaignLogsList(context, input.id, input.from, input.to, decodeCursor(input.cursor) ?? undefined, input.limit), 'logs')),
  memory: authed.route(r('GET', '/campaigns/{id}/memory')).input(idPage).handler(async ({ input, context }) => paginate(await camp.memoryTimeline(context, input.id), input)),
  retroStatus: authed.route(r('GET', '/campaigns/{id}/retrospective/status')).input(idIn).handler(({ input, context }) => camp.retrospectiveStatus(context, input.id)),
  retro: authed.route(r('GET', '/campaigns/{id}/retrospective')).input(idIn).handler(({ input, context }) => camp.retrospective(context, input.id)),
  shareGet: authed.route(r('GET', '/campaigns/{id}/share-link')).input(idIn).handler(({ input, context }) => camp.getShareLink(context, input.id)),
  shareCreate: authed.route(r('POST', '/campaigns/{id}/share-link')).input(idIn).handler(({ input, context }) => camp.createShareLink(context, input.id)),
  shareRevoke: authed.route(r('DELETE', '/campaigns/{id}/share-link')).input(idIn).handler(({ input, context }) => camp.revokeShareLink(context, input.id)),
  pages: authed.route(r('GET', '/campaigns/{id}/pages')).input(idPage).handler(async ({ input, context }) => pagesEnvelope(await page.listPages(context, input.id), input)),
  leads: authed.route(r('GET', '/campaigns/{id}/leads')).input(z.object({
    id, status: z.enum(['all', 'responded', 'not_responded', 'overdue', 'unassigned']).optional(), assigneeId: z.string().optional(), pageId: z.string().uuid().optional(),
    ...pageIn,
  })).handler(async ({ input, context }) => envelope(await lead.listLeads(context, { ...input, cursor: decodeCursor(input.cursor) ?? undefined, campaignId: input.id, deploymentId: input.pageId }), 'leads')),
  insights: authed.route(r('GET', '/campaigns/{id}/insights')).input(idPage).handler(async ({ input, context }) => paginate(await intel.listInsights(context, input.id), input)),
  recommendations: authed.route(r('GET', '/campaigns/{id}/recommendations')).input(idPage).handler(async ({ input, context }) => paginate(await intel.listRecommendations(context, input.id), input)),
  notes: authed.route(r('GET', '/campaigns/{id}/notes')).input(idPage).handler(async ({ input, context }) => paginate(await note.campaignNotes(context, input.id), input)),
  addNote: authed.route(r('POST', '/campaigns/{id}/notes')).input(z.object({ id, content: z.string().min(1).max(10000) })).handler(({ input, context }) => note.addCampaignNote(context, input.id, input.content)),
  editNote: authed.route(r('PATCH', '/campaigns/{id}/notes/{noteId}')).input(z.object({ id, noteId: id, content: z.string().min(1).max(10000) }))
    .handler(({ input, context }) => note.editCampaignNote(context, input.id, input.noteId, input.content)),
  meetingNotes: authed.route(r('GET', '/campaigns/{id}/meeting-notes')).input(idPage).handler(async ({ input, context }) => paginate(await note.meetingNotes(context, input.id), input)),
  addMeetingNote: authed.route(r('POST', '/campaigns/{id}/meeting-notes')).input(z.object({ id, title: z.string().max(255).nullable().optional(), meetingDate: z.string().nullable().optional(), content: z.string().min(1) }))
    .handler(({ input: { id: cid, ...rest }, context }) => note.addMeetingNote(context, cid, rest)),
  teamNotes: authed.route(r('GET', '/campaigns/{id}/team-notes')).input(idPage).handler(async ({ input, context }) => paginate(await note.listTeamNotes(context, { campaignId: input.id }), input)),
  lifecycleSummary: authed.route(r('GET', '/campaigns/{id}/lifecycle/summary')).input(idIn).handler(({ input, context }) => lead.lifecycleSummary(context, input.id)),
  sla: authed.route(r('GET', '/campaigns/{id}/sla')).input(idIn).handler(async ({ input, context }) => { await camp.loadCampaign(context, input.id); return sla.campaignSla(context, input.id); }),
  slaTrend: authed.route(r('GET', '/campaigns/{id}/sla/trend')).input(z.object({ id, date: z.string().optional() })).handler(async ({ input, context }) => { await camp.loadCampaign(context, input.id); return sla.trend(context, { campaignId: input.id, date: input.date }); }),
  slaTeam: authed.route(r('GET', '/campaigns/{id}/sla/team')).input(idPage).handler(async ({ input, context }) => { await camp.loadCampaign(context, input.id); return paginate(await sla.team(context, input.id), input); }),
};

// ------------------------------------------------------------------ pages (14) + domains
/** D-NEW-24: the pages envelope carries the workspace average conversion rate for benchmarking. */
function pagesEnvelope(r: Awaited<ReturnType<typeof page.listPages>>, input: { limit?: number; cursor?: string }) {
  return { workspace_avg_conversion_rate: r.avgConversionRate, ...paginate(r.pages, input) };
}
const pageRoutes = {
  list: authed.route(r('GET', '/pages')).input(pageQuery).handler(async ({ input, context }) => pagesEnvelope(await page.listPages(context), input)),
  upload: authed.route(r('POST', '/pages/upload')).input(z.object({
    file: z.instanceof(File), name: z.string().max(255).optional(), campaignId: z.string().uuid().optional(), slug: z.string().max(60).optional(), entryFile: z.string().optional(),
  })).handler(({ input, context }) => page.uploadPage(context, input)),
  uploadStatus: authed.route(r('GET', '/pages/upload/{id}/status')).input(idIn).handler(({ input, context }) => page.uploadStatus(context, input.id)),
  get: authed.route(r('GET', '/pages/{id}')).input(idIn).handler(({ input, context }) => page.getPage(context, input.id)),
  patch: authed.route(r('PATCH', '/pages/{id}')).input(z.object({ id, name: z.string().min(1).max(255).optional(), campaignId: z.string().uuid().nullable().optional(), slug: z.string().max(60).optional(), vip: z.boolean().optional() }))
    .handler(({ input: { id: pid, ...rest }, context }) => page.patchPage(context, pid, rest)),
  redeploy: authed.route(r('POST', '/pages/{id}/redeploy')).input(z.object({ id, file: z.instanceof(File) })).handler(({ input, context }) => page.redeploy(context, input.id, input.file)),
  pause: authed.route(r('POST', '/pages/{id}/pause')).input(idIn).handler(({ input, context }) => page.setServingState(context, input.id, 'paused')),
  unpause: authed.route(r('POST', '/pages/{id}/unpause')).input(idIn).handler(({ input, context }) => page.setServingState(context, input.id, 'active')),
  archive: authed.route(r('POST', '/pages/{id}/archive')).input(idIn).handler(({ input, context }) => page.setServingState(context, input.id, 'archived')),
  rollback: authed.route(r('POST', '/pages/{id}/rollback')).input(idIn).handler(({ input, context }) => page.rollback(context, input.id)),
  delete: authed.route(r('DELETE', '/pages/{id}')).input(idIn).handler(({ input, context }) => page.deletePage(context, input.id)),
  domain: authed.route(r('POST', '/pages/{id}/domain')).input(z.object({ id, domainName: z.string().min(3) })).handler(({ input, context }) => page.addDomain(context, input.id, input.domainName)),
  webhookHealth: authed.route(r('GET', '/pages/{id}/webhook-health')).input(idIn).handler(({ input, context }) => page.webhookHealth(context, input.id)),
  webhookTest: authed.route(r('POST', '/pages/{id}/webhook/test')).input(idIn).handler(({ input, context }) => page.testWebhook(context, input.id)),
  analytics: authed.route(r('GET', '/pages/{id}/analytics')).input(idIn).handler(({ input, context }) => page.pageAnalytics(context, input.id)),
};
/** ADL §4 names the page resource `/deployments`; these are the same procedures as `/pages`. */
const deploymentRoutes = {
  list: authed.route(r('GET', '/deployments')).input(pageQuery).handler(async ({ input, context }) => pagesEnvelope(await page.listPages(context), input)),
  create: authed.route(r('POST', '/deployments')).input(z.object({
    file: z.instanceof(File), name: z.string().max(255).optional(), campaignId: z.string().uuid().optional(), slug: z.string().max(60).optional(), entryFile: z.string().optional(),
  })).handler(({ input, context }) => page.uploadPage(context, input)),
  get: authed.route(r('GET', '/deployments/{id}')).input(idIn).handler(({ input, context }) => page.getPage(context, input.id)),
  patch: authed.route(r('PATCH', '/deployments/{id}')).input(z.object({ id, name: z.string().min(1).max(255).optional(), campaignId: z.string().uuid().nullable().optional(), slug: z.string().max(60).optional(), vip: z.boolean().optional() }))
    .handler(({ input: { id: pid, ...rest }, context }) => page.patchPage(context, pid, rest)),
  delete: authed.route(r('DELETE', '/deployments/{id}')).input(idIn).handler(({ input, context }) => page.deletePage(context, input.id)),
  redeploy: authed.route(r('POST', '/deployments/{id}/redeploy')).input(z.object({ id, file: z.instanceof(File) })).handler(({ input, context }) => page.redeploy(context, input.id, input.file)),
  rollback: authed.route(r('POST', '/deployments/{id}/rollback')).input(idIn).handler(({ input, context }) => page.rollback(context, input.id)),
  analytics: authed.route(r('GET', '/deployments/{id}/analytics')).input(idIn).handler(({ input, context }) => page.pageAnalytics(context, input.id)),
  webhookHealth: authed.route(r('GET', '/deployments/{id}/webhook-health')).input(idIn).handler(({ input, context }) => page.webhookHealth(context, input.id)),
  webhookTest: authed.route(r('POST', '/deployments/{id}/webhook/test')).input(idIn).handler(({ input, context }) => page.testWebhook(context, input.id)),
};
const domainRoutes = {
  list: authed.route(r('GET', '/domains')).input(pageQuery).handler(async ({ input, context }) => paginate(await page.listDomains(context), input)),
  add: authed.route(r('POST', '/domains')).input(z.object({ deployment_id: id, domain_name: z.string().min(3) })).handler(({ input, context }) => page.addDomain(context, input.deployment_id, input.domain_name)),
  verify: authed.route(r('POST', '/domains/{id}/verify')).input(idIn).handler(({ input, context }) => page.verifyDomain(context, input.id)),
  remove: authed.route(r('DELETE', '/domains/{id}')).input(idIn).handler(({ input, context }) => page.removeDomain(context, input.id)),
};

// ------------------------------------------------------------------ leads (10)
const leadRoutes = {
  list: authed.route(r('GET', '/leads')).input(z.object({
    status: z.enum(['all', 'responded', 'not_responded', 'overdue', 'unassigned', 'NOT_RESPONDED', 'RESPONDED']).optional(), campaign_id: z.string().uuid().optional(),
    deployment_id: z.string().uuid().optional(), assigneeId: z.string().optional(), assignee_id: z.string().optional(), q: z.string().max(100).optional(),
    ...pageIn,
  })).handler(async ({ input, context }) => envelope(await lead.listLeads(context, {
    status: input.status?.toLowerCase() as never, campaignId: input.campaign_id, deploymentId: input.deployment_id,
    assigneeId: input.assigneeId ?? input.assignee_id, q: input.q, cursor: decodeCursor(input.cursor) ?? undefined, limit: input.limit,
  }), 'leads')),
  get: authed.route(r('GET', '/leads/{id}')).input(idIn).handler(({ input, context }) => lead.getLead(context, input.id)),
  respond: authed.route(r('POST', '/leads/{id}/respond')).input(idIn).handler(({ input, context }) => lead.respond(context, input.id)),
  assign: authed.route(r('POST', '/leads/{id}/assign')).input(z.object({ id, assigneeId: id })).handler(({ input, context }) => lead.assign(context, input.id, input.assigneeId)),
  lifecycle: authed.route(r('GET', '/leads/{id}/lifecycle')).input(idPage).handler(async ({ input, context }) => paginate(await lead.lifecycle(context, input.id), input)),
  notes: authed.route(r('GET', '/leads/{id}/notes')).input(idPage).handler(async ({ input, context }) => paginate(await note.leadNotes(context, input.id), input)),
  addNote: authed.route(r('POST', '/leads/{id}/notes')).input(z.object({ id, content: z.string().min(1).max(10000) })).handler(({ input, context }) => note.addLeadNote(context, input.id, input.content)),
  editNote: authed.route(r('PATCH', '/leads/{id}/notes/{noteId}')).input(z.object({ id, noteId: id, content: z.string().min(1).max(10000) }))
    .handler(({ input, context }) => note.editLeadNote(context, input.id, input.noteId, input.content)),
  audit: authed.route(r('GET', '/leads/{id}/audit')).input(idPage).handler(async ({ input, context }) => { const a = await lead.audit(context, input.id); const { events, ...rest } = a; return { ...rest, ...paginate(events, input) }; }),
  teamNotes: authed.route(r('GET', '/leads/{id}/team-notes')).input(idPage).handler(async ({ input, context }) => { await lead.loadLead(context, input.id); return paginate(await note.listTeamNotes(context, { leadId: input.id }), input); }),
  ackPreview: pub.route(r('GET', '/leads/acknowledge/preview')).input(z.object({ token: z.string().min(10) })).handler(({ input, context }) => lead.ackPreview(context.db, input.token)),
  acknowledge: pub.route(r('POST', '/leads/acknowledge')).input(z.object({ token: z.string().min(10) })).handler(({ input, context }) => lead.acknowledge(context.db, input.token)),
};
const noteRoutes = {
  edit: authed.route(r('PATCH', '/notes/{id}')).input(z.object({ id, content: z.string().min(1).max(10000) })).handler(({ input, context }) => note.editAnyNote(context, input.id, input.content)),
};

// ------------------------------------------------------------------ SLA (10)
const slaRoutes = {
  live: authed.route(r('GET', '/sla/live')).handler(({ context }) => sla.live(context)),
  overdue: authed.route(r('GET', '/sla/overdue')).input(z.object({ campaignId: z.string().uuid().optional(), ...pageIn })).handler(async ({ input, context }) => { const o = await sla.overdue(context, input.campaignId); return { count: o.count, ...paginate(o.leads, input) }; }),
  trend: authed.route(r('GET', '/sla/trend')).input(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })).handler(({ input, context }) => sla.trend(context, { date: input.date })),
  team: authed.route(r('GET', '/sla/team')).input(pageQuery).handler(async ({ input, context }) => paginate(await sla.team(context), input)),
  crossTool: authed.route(r('GET', '/sla/cross-tool')).input(pageQuery).handler(async ({ input, context }) => { const b = await sla.crossToolBreaches(context); return { connected: b.connected, ...paginate(b.breaches, input) }; }),
  notify: authed.route(r('POST', '/sla/notify/{leadId}')).input(z.object({ leadId: id })).handler(({ input, context }) => sla.notifyNow(context, input.leadId)),
  config: authed.route(r('GET', '/sla/config')).handler(({ context }) => sla.getConfig(context)),
  patchConfig: authed.route(r('PATCH', '/sla/config')).input(z.object({
    sla_threshold_minutes: z.number().optional(), vip_lead_enabled: z.boolean().optional(), vip_sla_threshold_minutes: z.number().optional(),
    daily_summary_time: z.string().optional(), vipPages: z.array(id).optional(),
    notificationRules: z.array(z.object({ id, notifyEnabled: z.boolean(), notifyChannel: z.enum(['email', 'telegram', 'both']) })).optional(),
  })).handler(({ input, context }) => sla.patchConfig(context, input)),
  crossToolConfig: authed.route(r('GET', '/sla/config/cross-tool')).input(pageQuery).handler(async ({ input, context }) => paginate(await sla.crossToolConfig(context), input)),
  patchCrossTool: authed.route(r('PATCH', '/sla/config/cross-tool')).input(z.object({
    integrationId: id, rules: z.array(z.object({ id, thresholdValue: z.number(), enabled: z.boolean(), notificationChannels: z.array(z.enum(['ai_panel', 'email', 'telegram'])) })),
  })).handler(({ input, context }) => sla.patchCrossTool(context, input.integrationId, input.rules)),
};

// ------------------------------------------------------------------ team notes
const teamNoteRoutes = {
  list: authed.route(r('GET', '/team-notes')).input(z.object({ addressedTo: z.literal('me').optional(), ...pageIn })).handler(async ({ input, context }) => paginate(await note.listTeamNotes(context, { addressedTo: input.addressedTo }), input)),
  create: authed.route(r('POST', '/team-notes')).input(z.object({
    content: z.string().min(1).max(5000), recipientIds: z.array(id).min(1), attachmentType: z.enum(['lead', 'campaign']).nullable().optional(),
    attachmentId: z.string().uuid().nullable().optional(), deadline: z.string().datetime().nullable().optional(),
  })).handler(({ input, context }) => note.createTeamNote(context, input)),
  edit: authed.route(r('PATCH', '/team-notes/{id}')).input(z.object({ id, content: z.string().min(1).max(5000) })).handler(({ input, context }) => note.editTeamNote(context, input.id, input.content)),
  read: authed.route(r('POST', '/team-notes/{id}/read')).input(idIn).handler(({ input, context }) => note.markTeamNoteRead(context, input.id)),
  acknowledge: authed.route(r('POST', '/team-notes/{id}/acknowledge')).input(idIn).handler(({ input, context }) => note.acknowledgeTeamNote(context, input.id)),
};

// ------------------------------------------------------------------ insights / recommendations / chat
const intelRoutes = {
  insights: authed.route(r('GET', '/insights')).input(pageQuery).handler(async ({ input, context }) => paginate(await intel.listInsights(context), input)),
  refresh: authed.route(r('POST', '/insights/refresh')).handler(({ context }) => intel.manualRefresh(context)),
  insight: authed.route(r('GET', '/insights/{id}')).input(idIn).handler(({ input, context }) => intel.getInsight(context, input.id)),
  dismissInsight: authed.route(r('POST', '/insights/{id}/dismiss')).input(idIn).handler(({ input, context }) => intel.dismissInsight(context, input.id)),
  recommendations: authed.route(r('GET', '/recommendations')).input(pageQuery).handler(async ({ input, context }) => paginate(await intel.listRecommendations(context), input)),
  recommendation: authed.route(r('GET', '/recommendations/{id}')).input(idIn).handler(({ input, context }) => intel.getRecommendation(context, input.id)),
  dismissRec: authed.route(r('POST', '/recommendations/{id}/dismiss')).input(idIn).handler(({ input, context }) => intel.dismissRecommendation(context, input.id)),
  applyRec: authed.route(r('POST', '/recommendations/{id}/apply')).input(idIn).handler(({ input, context }) => intel.applyRecommendation(context, input.id)),
  chatHistory: authed.route(r('GET', '/chat/history')).input(pageQuery).handler(async ({ input, context }) => { const h = await intel.chatHistory(context); const { messages, ...rest } = h; return { ...rest, ...paginate(messages, input, { fromEnd: true }) }; }),
  chatMessage: authed.route(r('POST', '/chat/message')).input(z.object({ content: z.string().min(1).max(4000), depth: z.enum(['Economy', 'Standard', 'Deep', 'Frontier']).optional() }))
    .handler(({ input, context }) => intel.chatMessage(context, input.content, input.depth)),
  chatSuggestions: authed.route(r('GET', '/chat/suggestions')).handler(({ context }) => intel.chatSuggestions(context)),
  chatClear: authed.route(r('DELETE', '/chat/history')).handler(({ context }) => intel.clearChat(context)),
};

// ------------------------------------------------------------------ logs, notifications, search, public
const miscRoutes = {
  logs: authed.route(r('GET', '/logs')).input(pageQuery).handler(async ({ input, context }) => paginate(await ws.workspaceLog(context, 1000), input)),
  notifications: authed.route(r('GET', '/notifications')).input(pageQuery).handler(async ({ input, context }) => { const n = await ws.listNotifications(context); return { unreadCount: n.unreadCount, ...paginate(n.notifications, input) }; }),
  readNotification: authed.route(r('POST', '/notifications/{id}/read')).input(z.object({ id: z.union([id, z.literal('all')]) })).handler(({ input, context }) => ws.markNotificationRead(context, input.id)),
  search: authed.route(r('GET', '/search')).input(z.object({ q: z.string().max(100) })).handler(({ input, context }) => ws.search(context, input.q)),
  publicCampaign: pub.route(r('GET', '/public/campaigns/{shareToken}')).input(z.object({ shareToken: z.string() })).handler(({ input, context }) => camp.publicCampaign(context.db, input.shareToken)),
};

// ------------------------------------------------------------------ integrations / settings (17)
const settingsRoutes = {
  integrations: authed.route(r('GET', '/integrations')).input(pageQuery).handler(async ({ input, context }) => paginate(await set.listIntegrations(context), input, { key: (i) => i.provider })),
  connect: authed.route(r('POST', '/integrations/{provider}/connect')).input(z.object({ provider, apiKey: z.string().max(2000).nullable().optional(), method: z.enum(['webhook', 'api_key', 'oauth']).optional() }))
    .handler(({ input, context }) => set.connectIntegration(context, input.provider, input)),
  verify: authed.route(r('POST', '/integrations/{provider}/verify')).input(z.object({ provider })).handler(({ input, context }) => set.verifyIntegration(context, input.provider)),
  disconnect: authed.route(r('DELETE', '/integrations/{provider}')).input(z.object({ provider })).handler(({ input, context }) => set.disconnectIntegration(context, input.provider)),
  aiVerify: authed.route(r('POST', '/integrations/ai/verify')).input(z.object({ which: z.enum(['primary', 'fallback']).default('primary') })).handler(({ input, context }) => set.verifyAi(context, input.which)),
  inbound: authed.route(r('GET', '/webhooks/inbound')).input(pageQuery).handler(async ({ input, context }) => paginate(await set.listInbound(context), input)),
  createInbound: authed.route(r('POST', '/webhooks/inbound')).input(z.object({ sourceLabel: z.string().min(1).max(255), campaignId: z.string().uuid().nullable().optional() }))
    .handler(({ input, context }) => set.createInbound(context, input.sourceLabel, input.campaignId)),
  deleteInbound: authed.route(r('DELETE', '/webhooks/inbound/{id}')).input(idIn).handler(({ input, context }) => set.deleteInbound(context, input.id)),
  outbound: authed.route(r('GET', '/webhooks/outbound')).input(pageQuery).handler(async ({ input, context }) => paginate(await set.listOutbound(context), input)),
  createOutbound: authed.route(r('POST', '/webhooks/outbound')).input(z.object({ destinationUrl: z.string().url(), eventTrigger: z.enum(set.OUTBOUND_EVENTS), secret: z.string().max(500).nullable().optional() }))
    .handler(({ input, context }) => set.createOutbound(context, input)),
  deleteOutbound: authed.route(r('DELETE', '/webhooks/outbound/{id}')).input(idIn).handler(({ input, context }) => set.deleteOutbound(context, input.id)),
  aiProvider: authed.route(r('GET', '/settings/ai-provider')).handler(({ context }) => set.getAiProvider(context)),
  patchAiProvider: authed.route(r('PATCH', '/settings/ai-provider')).input(z.object({
    primary: z.object({ provider: aiProv.nullable().optional(), modelName: z.string().max(255).nullable().optional(), apiKey: z.string().max(2000).nullable().optional() }).optional(),
    fallback: z.object({ enabled: z.boolean().optional(), provider: aiProv.nullable().optional(), modelName: z.string().max(255).nullable().optional(), apiKey: z.string().max(2000).nullable().optional() }).optional(),
    refreshIntervalMinutes: z.number().int().min(5).max(1440).optional(), eventTriggers: z.array(z.string()).optional(),
  })).handler(({ input, context }) => set.patchAiProvider(context, input)),
  telegram: authed.route(r('GET', '/settings/telegram')).handler(({ context }) => set.getTelegram(context)),
  patchTelegram: authed.route(r('PATCH', '/settings/telegram')).input(z.object({ criticalAlertsEnabled: z.boolean().optional(), dailyDigestEnabled: z.boolean().optional() }))
    .handler(({ input, context }) => set.patchTelegram(context, input)),
  verifyTelegram: authed.route(r('POST', '/settings/telegram/verify')).input(z.object({ botToken: z.string().min(10).max(200) })).handler(({ input, context }) => set.verifyTelegram(context, input.botToken)),
  disconnectTelegram: authed.route(r('DELETE', '/settings/telegram')).handler(({ context }) => set.disconnectTelegram(context)),
  settings: authed.route(r('GET', '/settings')).handler(({ context }) => ws.getSettings(context)),
  patchSettings: authed.route(r('PATCH', '/settings')).input(z.object({
    name: z.string().trim().min(1).max(255).optional(), notification_email: z.string().email().optional(),
    urgent_alerts_enabled: z.boolean().optional(), daily_summary_enabled: z.boolean().optional(), daily_summary_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    sla_threshold_minutes: z.number().int().min(1).max(10080).optional(), vip_lead_enabled: z.boolean().optional(), vip_sla_threshold_minutes: z.number().int().min(1).max(10080).optional(),
  })).handler(({ input, context }) => ws.patchSettings(context, input)),
  notifications: authed.route(r('GET', '/settings/notifications')).handler(({ context }) => set.getNotificationSettings(context)),
  patchNotifications: authed.route(r('PATCH', '/settings/notifications')).input(z.object({
    dailyDigest: z.boolean().optional(), dailyDigestTime: z.string().optional(), slaBreachAlerts: z.boolean().optional(),
    slaBreachChannel: z.enum(['email', 'telegram', 'both']).optional(), earlyWarning: z.boolean().optional(), budgetAlerts: z.boolean().optional(),
    webhookOffline: z.boolean().optional(), notificationEmail: z.string().email().optional(),
  })).handler(({ input, context }) => set.patchNotificationSettings(context, input)),
};

// ------------------------------------------------------------------ super admin (8)
const adminAuthed = pub.use(async ({ context, next }) => next({ context: { adminId: await admin.verifyAdminToken(bearer(context.headers)) } }));
const adminRoutes = {
  login: pub.route(r('POST', '/admin/api/login')).input(z.object({ email: z.string().email(), password: z.string(), code: z.string().length(6) }))
    .handler(({ input, context }) => admin.adminLogin(context.db, input.email, input.password, input.code)),
  accounts: adminAuthed.route(r('GET', '/admin/api/accounts')).input(pageQuery).handler(async ({ input, context }) => paginate(await admin.listAccounts(context.db), input)),
  account: adminAuthed.route(r('GET', '/admin/api/accounts/{id}')).input(idIn).handler(({ input, context }) => admin.accountDetail(context.db, input.id)),
  activate: adminAuthed.route(r('POST', '/admin/api/accounts/{id}/activate')).input(idIn).handler(({ input, context }) => admin.setAccountStatus(context.db, context.adminId, input.id, 'active')),
  suspend: adminAuthed.route(r('POST', '/admin/api/accounts/{id}/suspend')).input(idIn).handler(({ input, context }) => admin.setAccountStatus(context.db, context.adminId, input.id, 'suspended')),
  flag: adminAuthed.route(r('POST', '/admin/api/accounts/{id}/flag')).input(idIn).handler(({ input, context }) => admin.setAccountStatus(context.db, context.adminId, input.id, 'flagged')),
  pricing: adminAuthed.route(r('PATCH', '/admin/api/accounts/{id}/pricing')).input(z.object({ id, monthlyFee: z.number().nonnegative() }))
    .handler(({ input, context }) => admin.setAccountPricing(context.db, context.adminId, input.id, input.monthlyFee)),
  note: adminAuthed.route(r('POST', '/admin/api/accounts/{id}/note')).input(z.object({ id, note: z.string().min(1).max(5000) }))
    .handler(({ input, context }) => admin.addAccountNote(context.db, context.adminId, input.id, input.note)),
  regenerateRetro: adminAuthed.route(r('POST', '/admin/api/accounts/{id}/campaigns/{campaignId}/retrospective/regenerate')).input(z.object({ id, campaignId: id }))
    .handler(({ input, context }) => admin.regenerateRetrospective(context.db, context.adminId, input.id, input.campaignId)),
  health: adminAuthed.route(r('GET', '/admin/api/health')).handler(async ({ context }) => admin.systemHealth(context.db, await queueDepth())),
};

export const router = {
  auth: authRoutes, workspace: workspaceRoutes, team: teamRoutes, campaigns: campaignRoutes, pages: pageRoutes, deployments: deploymentRoutes, domains: domainRoutes,
  leads: leadRoutes, notes: noteRoutes, sla: slaRoutes, teamNotes: teamNoteRoutes, intel: intelRoutes, misc: miscRoutes, settings: settingsRoutes, admin: adminRoutes,
};
