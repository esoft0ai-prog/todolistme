/**
 * The Main Agent — one persistent intelligence interface per workspace,
 * orchestrated with LangGraph.js (Agent Architecture Parts 2–3).
 *
 *   understand ──(simple)──────────────► synthesize ─► END
 *        └──(needs investigation)─► delegate (parallel Workers) ─┘
 *
 * Camplo business rules (who may see what, Worker limits, budgets) live in
 * code outside the graph; the graph only sequences the reasoning. The agent is
 * read-only: it never changes lead state or campaign data.
 */
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { DB } from '../db/client.js';
import type { Plan } from '../domain/rules.js';
import { config } from '../lib/config.js';
import { complete, type Workload } from './router.js';
import { recall, type MemoryItem } from './memory.js';
import { workspaceSnapshot, type CampaignMetric } from './tools.js';
import { makeContract, runWorker, type Capability, type WorkerResult } from './workers.js';

export type Depth = 'Economy' | 'Standard' | 'Deep' | 'Frontier';
const DEPTH_WORKLOAD: Record<Depth, Workload> = { Economy: 'quick', Standard: 'standard', Deep: 'deep', Frontier: 'strategic' };

type Snapshot = Awaited<ReturnType<typeof workspaceSnapshot>>;
type Campaign = CampaignMetric;

const State = Annotation.Root({
  db: Annotation<DB>(),
  tenantId: Annotation<string>(),
  plan: Annotation<Plan>(),
  question: Annotation<string>(),
  depth: Annotation<Depth>(),
  history: Annotation<Array<{ role: 'user' | 'assistant'; content: string }>>(),
  snapshot: Annotation<Snapshot | null>(),
  memories: Annotation<MemoryItem[]>(),
  campaignId: Annotation<string | null>(),
  capabilities: Annotation<Capability[]>(),
  workerResults: Annotation<WorkerResult[]>(),
  answer: Annotation<string>(),
  workload: Annotation<Workload>(),
  investigated: Annotation<boolean>(),
});
type S = typeof State.State;

const INVESTIGATE = /\b(why|diagnos|investigat|root cause|decline|declin|drop|fell|worse|increase|rising|jump|what should i change|recommend|strateg|pattern|improve)\b/i;

/** Step 1–6: understand the request, inspect evidence, decide whether to delegate. */
async function understand(s: S): Promise<Partial<S>> {
  const snapshot = await workspaceSnapshot(s.db, s.tenantId);
  const q = s.question.toLowerCase();
  const camp = (snapshot.campaigns as Campaign[]).find((c) => q.includes(String(c.name).toLowerCase()) || String(c.name).toLowerCase().split(/\s+/).some((w) => w.length > 4 && q.includes(w)));
  const memories = await recall(s.db, s.tenantId, s.question, camp?.id ?? null);
  const caps: Capability[] = [];
  if (INVESTIGATE.test(q) && s.depth !== 'Economy') {
    caps.push('campaign_analysis', 'investigation');
    if (/team|rep|respond|speed|sla/.test(q)) caps.push('investigation');
    if (/note|conversation|customer|said/.test(q)) caps.push('conversation_analysis');
    if (/strateg|channel|overall|fundamental|quarter|budget/.test(q) || s.depth === 'Frontier') caps.push('strategic_analysis');
  }
  return {
    snapshot, memories, campaignId: camp?.id ?? null, capabilities: [...new Set(caps)].slice(0, config.workerMaxConcurrent),
    workload: DEPTH_WORKLOAD[s.depth], investigated: caps.length > 0,
  };
}

/** Step 7–9: create bounded Worker tasks and run independent ones concurrently. */
async function delegate(s: S): Promise<Partial<S>> {
  const budget = s.depth === 'Deep' || s.depth === 'Frontier' ? 'high' : 'medium';
  const campaignName = (s.snapshot?.campaigns as Campaign[] | undefined)?.find((c) => c.id === s.campaignId)?.name ?? null;
  const results = await Promise.all(s.capabilities.map((cap) =>
    runWorker(s.db, s.plan, makeContract({ tenantId: s.tenantId, capability: cap, objective: s.question, campaignId: s.campaignId, campaignName, budget }), 1)));
  return { workerResults: results };
}

const SYSTEM = `You are Camplo Intelligence — the persistent campaign intelligence partner for this workspace.
Rules:
- Be specific and evidenced: cite numbers from CONTEXT, WORKER FINDINGS and MEMORY. Never invent data.
- Say which data sources your answer is based on when sources are missing (see data_sources).
- Reference campaign memory before recommending: never recommend something memory shows already failed.
- You are read-only. You cannot mark leads responded, change campaigns, or send messages. Tell the operator what to do.
- Link entities with markdown: campaigns as [Name](#/campaigns/<id>/overview), leads as [Name](#/campaigns/<campaignId>/leads/<leadId>) when ids are known.
- Keep it tight: short paragraphs, numbered lists for actions, bold for the key number. No preamble.`;

/** Step 10–12: evaluate evidence, synthesise, recommend. */
async function synthesize(s: S): Promise<Partial<S>> {
  const context = {
    workspace: s.snapshot, memory: s.memories.slice(0, 12).map((m) => `${m.when.slice(0, 10)} ${m.text}`),
    worker_findings: (s.workerResults ?? []).map((w) => ({ capability: w.capability, status: w.status, ...w.output })),
  };
  const res = await complete(s.db, {
    tenantId: s.tenantId, plan: s.plan, workload: s.workload, taskType: 'chat', maxTokens: 2000,
    system: `${SYSTEM}\n\nCONTEXT:\n${JSON.stringify(context).slice(0, 60000)}`,
    messages: [...(s.history ?? []).slice(-10), { role: 'user', content: s.question }],
  });
  if (res.completion?.text) {
    const note = res.downgraded ? '\n\n_You have reached the advanced intelligence included in your plan, so this answer used standard intelligence._' : '';
    return { answer: res.completion.text + note, workload: res.downgraded ? 'standard' : s.workload };
  }
  return { answer: deterministicAnswer(s), workload: 'quick' };
}

/** Rule-based answers over live data when no model is configured (Level 0/1 only — never fabricated). */
export function deterministicAnswer(s: Pick<S, 'question' | 'snapshot' | 'memories' | 'workerResults'>): string {
  const snap = s.snapshot!;
  const q = s.question.toLowerCase();
  const camps = snap.campaigns as Campaign[];
  const un = snap.leads.unresponded;
  const overdue = un.filter((l) => l.overdue);
  const link = (c: Campaign) => `[${c.name}](#/campaigns/${c.id}/overview)`;
  const findings = (s.workerResults ?? []).flatMap((w) => w.output.findings);
  const footer = '\n\n_Answered from Camplo\'s live data (rule-based). Connect an AI provider in Settings → AI Provider for deeper investigation._';

  if (/overdue|waiting|most urgent|longest/.test(q)) {
    if (!overdue.length) return `No leads are overdue right now against your ${snap.leads.threshold_minutes}-minute threshold.${footer}`;
    const rows = overdue.slice(0, 8).map((l, i) => `${i + 1}. **${l.name}** — ${l.campaign ?? 'no campaign'} · waiting **${l.waiting}** · ${l.assignee}${l.vip ? ' · VIP' : ''}`);
    return `**${overdue.length} leads are overdue** (threshold ${snap.leads.threshold_minutes} min). Longest first:\n\n${rows.join('\n')}\n\nOpen the Lead Dossier to respond, or use **Notify Now** on the SLA screen.${footer}`;
  }
  if (/cpl|cost per lead|spend|budget/.test(q)) {
    const lines = camps.filter((c) => c.cpl != null).map((c) => `- ${link(c)}: CPL **${c.cpl} ${c.currency}**${c.cpl_threshold != null ? ` (threshold ${c.cpl_threshold}${(c.cpl ?? 0) > c.cpl_threshold ? ' — **above**' : ''})` : ''}`);
    return lines.length ? `Cost per lead by campaign:\n\n${lines.join('\n')}${footer}` : `No campaign has daily spend recorded yet, so CPL can't be calculated. Add daily spend on a campaign's Overview tab.${footer}`;
  }
  const bad = camps.filter((c) => c.health !== 'healthy');
  const offline = snap.webhooks.filter((w) => w.webhook === 'offline');
  const actions: string[] = [];
  if (overdue.length) actions.push(`Respond to the **${overdue.length} overdue leads** — ${overdue[0].name} has waited ${overdue[0].waiting}.`);
  for (const w of offline) actions.push(`Fix the webhook on **${w.page}** — it is offline, so new submissions are not reaching Camplo.`);
  for (const c of bad) actions.push(`${link(c)} is **${c.health}**: lead volume ${c.health_signals.lead_volume}, acknowledgment ${c.health_signals.acknowledgment}, webhook ${c.health_signals.webhook}.`);
  for (const c of camps) if (c.cpl != null && c.cpl_threshold != null && c.cpl > c.cpl_threshold) actions.push(`${link(c)} CPL ${c.cpl} is above your ${c.cpl_threshold} threshold — check page conversion before adding budget.`);
  for (const f of findings) if (!actions.some((a) => a.includes(f.slice(0, 30)))) actions.push(f);
  const mem = s.memories?.[0];
  if (/change|recommend|should i/.test(q) && mem) actions.push(`From campaign memory: ${mem.text}. Factor this in before repeating the same kind of change.`);
  if (!actions.length) return `Nothing needs your attention right now: no overdue leads, all webhooks live and every campaign is healthy.${footer}`;
  return `Here's what needs attention, in order:\n\n${actions.slice(0, 6).map((a, i) => `${i + 1}. ${a}`).join('\n')}${footer}`;
}

const graph = new StateGraph(State)
  .addNode('understand', understand)
  .addNode('delegate', delegate)
  .addNode('synthesize', synthesize)
  .addEdge(START, 'understand')
  .addConditionalEdges('understand', (s: S) => (s.capabilities.length ? 'delegate' : 'synthesize'), ['delegate', 'synthesize'])
  .addEdge('delegate', 'synthesize')
  .addEdge('synthesize', END)
  .compile();

export interface AgentAnswer { answer: string; workload: Workload; investigated: boolean; workers: Array<{ capability: Capability; status: string }> }

export async function askAgent(p: { db: DB; tenantId: string; plan: Plan; question: string; depth?: Depth; history?: Array<{ role: 'user' | 'assistant'; content: string }> }): Promise<AgentAnswer> {
  const out = await graph.invoke({
    db: p.db, tenantId: p.tenantId, plan: p.plan, question: p.question, depth: p.depth ?? 'Standard', history: p.history ?? [],
    snapshot: null, memories: [], campaignId: null, capabilities: [], workerResults: [], answer: '', workload: 'standard', investigated: false,
  });
  return { answer: out.answer, workload: out.workload, investigated: out.investigated, workers: (out.workerResults ?? []).map((w) => ({ capability: w.capability, status: w.status })) };
}
